// Головний процес Offgrid: уся логіка застосунку. Вікно, трей і гарячу клавішу тримає окрема нативна
// оболонка (shell/host.ps1, керування — host.js), а панель спілкується з цим процесом через локальний
// сервер (server.js). Раніше все це робив Electron; від нього відмовились, бо Smart App Control блокує
// його непідписаний файл.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, SETTINGS_FILE, LOG_FILE, NOTES_DIR } from '../paths.js';
import { loadConfig, saveSetting } from '../security/config.js';
import { TOOL_MODES } from '../security/policy.js';
import { logAction, readLog } from '../security/log.js';
import { editSettings, settingsView, isValidHotkey } from '../security/settings-store.js';
import { Agent } from '../agent/agent.js';
import { ping, setGpuLayers, unloadModel, preloadModel } from '../agent/ollama.js';
import { decideGpuLayers, readVram } from '../agent/gpu.js';
import { Resources } from '../agent/resources.js';
import { nodeOs } from '../tools/util.js';
import { Speech, VOICE_SCRIPT } from '../speech/client.js';
import { SentenceSplitter } from '../speech/sentences.js';
import { finalTail } from '../agent/tone.js';
import { iconPng } from './icon.js';
import { Host } from './host.js';
import { PanelServer } from './server.js';

const WIDTH = 400, HEIGHT = 540;
const CONFIRM_TIMEOUT_MS = 60_000;
const AUTO_HIDE_MS = 9_000;
const ERROR_SHOWN_MS = 5_000;
// Відеопам'ять мовних сервісів (заміряно). Розпізнавання й якісний голос не працюють одночасно, тому ділять
// одне місце по черзі: голосова модель заходить на відеокарту лише щоб говорити (переїзд — 0,3 с).
const STT_VRAM_MB = 1300;            // розпізнавання мови
const VOICE_RESIDENT_MB = 1000;      // службові дані сервісу голосу — зайняті завжди, поки він запущений
const VOICE_MODEL_MB = 1400;         // сама голосова модель, поки говорить
const VOICE_OVER_STT_MB = 200;       // наскільки голосова модель більша за розпізнавання, з яким міняється місцем
const SETTLE_AFTER_TALK_MS = 400; // пауза між власним голосом і записом
const FOLLOW_UP_WAIT_S = 5; // скільки чекати на продовження розмови після відповіді
// Стільки разів поспіль асистент слухає «продовження» сам. Далі потрібна клавіша: так розмова не може
// тривати без кінця, якщо в кімнаті говорить телевізор, а людини поруч немає.
const MAX_FOLLOW_UPS = 4;
const FALLBACK_HOTKEYS = ['Control+Shift+Space', 'Alt+Shift+Space', 'Control+Alt+O'];
const SHOT = process.env.OFFGRID_SHOT; // лише для розробки: зберегти знімок панелі й вийти
// Одна копія застосунку: друга лише просить першу показати панель і виходить
// (режим знімка для розробки має власний канал і папку, щоб не конфліктувати із запущеним застосунком)
const INSTANCE_PIPE = `\\\\.\\pipe\\offgrid-${SHOT ? 'dev' : 'app'}`;
const WEBVIEW_DATA = path.join(DATA_DIR, SHOT ? 'webview2-dev' : 'webview2');

const ui = new Host();
let server = null;
let agent = null;
let config = null, warnings = [];
let state = 'idle';
let hideTimer = null;
let activeHotkey = null;
let quitting = false;
let turnActive = false; // триває запис, запит до моделі або озвучення
let hotkeySuspended = false; // гарячу клавішу тимчасово знято, поки користувач записує нову
let dialogOpen = false; // відкрито системне вікно вибору файлу: панель у цей час не ховаємо
let turnCancelled = false;
let listenNext = false;   // після цього ходу одразу слухати (відповідь перебито гарячою клавішею)
let resources = null;     // «сон»: звільнення пам'яті, коли асистентом не користуються
let waking = null;        // обіцянка поточного пробудження
let gpuPlan = null;       // обіцянка поточного підбору розподілу відеопам'яті (або null)
let replySink = null;     // куди йде текст відповіді, поки модель його пише
let turnSpoke = false;    // у цьому ході вже щось пішло на озвучення
let listeningAuto = false; // зараз іде автоматичне «продовження», а не запис за клавішею
let heardSpeech = false;  // у поточному записі вже почуто мову // користувач зупинив поточний хід (Esc, ■, «Нова розмова»)
let speech = null;
let speechConfigKey = '';
let voice = null;         // сервіс якісного голосу (OmniVoice); якщо його немає — говорить простий голос мовного сервісу
let voiceKey = '';
let replanAfterTurn = false;   // розподіл відеопам'яті треба перерахувати після поточної розмови
let planCountedVoice = false; // останній розподіл відеопам'яті вже врахував місце під якісний голос
let lastTalker = '';      // яким голосом озвучено попередню відповідь
let lastTalkEnd = 0;      // коли асистент востаннє замовк
const pendingConfirms = new Map();

const STATE_LABELS = {
  idle: 'Очікує', listening: 'Слухає', thinking: 'Думає', executing: 'Виконує',
  confirming: 'Чекає дозволу', speaking: 'Говорить', error: 'Помилка',
};

const trayTip = () => (resources?.asleep && state === 'idle'
  ? 'Offgrid — спить, пам\'ять звільнено'
  : `Offgrid — ${STATE_LABELS[state].toLowerCase()}`);

// ---------- Події для панелі ----------
function send(event) {
  server?.broadcast(event);
}

function setState(next) {
  if (state === next) return;
  state = next;
  send({ type: 'state', state });
  ui.setTray({ icon: iconPng(state), tip: trayTip() });
}

// ---------- Панель ----------
function showPanel({ focus = true } = {}) {
  clearTimeout(hideTimer);
  if (focus) { ui.show({ focus: true }); send({ type: 'focus-input' }); } else if (!ui.visible) ui.show({ focus: false });
}

function hidePanel() {
  clearTimeout(hideTimer);
  if (ui.visible) ui.hide();
}

function togglePanel() {
  if (ui.visible && ui.focused) hidePanel(); else showPanel();
}

// Гаряча клавіша: з голосом — «говорити / досить / замовкни», без голосу — показати або сховати панель
function onHotkey() {
  if (dialogOpen) return; // відкрито вікно вибору файлу — розмову зараз не починаємо
  if (state === 'listening') {
    // під час «продовження», поки ти ще мовчиш, клавіша означає «слухай мене», а не «досить»
    if (listeningAuto && !heardSpeech) { listenNext = true; speech.cancel(); } else speech.stopListening();
  }
  // перебити відповідь (навіть якщо модель її ще дописує): замовкнути й одразу слухати
  else if (state === 'speaking' || (turnActive && turnSpoke)) { listenNext = true; agent.cancel(); hush(); }
  else if (turnActive) showPanel({ focus: false });
  else if (speech?.ready) startListening();
  else togglePanel();
}

// Панель, показана без фокусу (відповідь прийшла, поки ти працюєш в іншому вікні), згодом ховається сама
function scheduleAutoHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (ui.visible && !ui.focused && (state === 'idle' || state === 'error') && pendingConfirms.size === 0 && !dialogOpen) ui.hide();
  }, AUTO_HIDE_MS);
}

// Панель втратила фокус: ховаємо її, якщо вона зараз не потрібна
function onBlur() {
  // …а якщо це сталося посеред запису нової клавіші — повертаємо гарячу клавішу на місце
  if (hotkeySuspended) { hotkeySuspended = false; registerHotkeys(); send({ type: 'capture-end' }); }
  if ((state === 'idle' || state === 'error') && pendingConfirms.size === 0 && !dialogOpen && !SHOT) hidePanel();
}

// ---------- Підтвердження небезпечних дій ----------
// Відповідь приходить ЛИШЕ з натискання кнопки в панелі; модель до цього каналу не має доступу.
function askConfirm(request) {
  return new Promise((resolve) => {
    const id = randomUUID();
    const finish = (allow) => {
      const p = pendingConfirms.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      pendingConfirms.delete(id);
      send({ type: 'confirm-done', id, allow });
      setState('executing');
      resolve(allow);
    };
    const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(id, { finish, timer });
    setState('confirming');
    // показуємо без перехоплення фокуса, щоб випадковий Enter в іншому вікні нічого не підтвердив
    showPanel({ focus: false });
    send({ type: 'confirm', id, summary: request.summary, reason: request.reason, timeoutMs: CONFIRM_TIMEOUT_MS });
  });
}

function denyAllConfirms() {
  for (const p of [...pendingConfirms.values()]) p.finish(false);
}

// ---------- Налаштування ----------
function applyConfig({ announce = false } = {}) {
  const loaded = loadConfig({ previous: config, toolModes: TOOL_MODES });
  config = loaded.config;
  warnings = loaded.warnings;
  agent?.setConfig(config);

  registerHotkeys({ announce }); // відповідь оболонки прийде за мить — список зауваг вона доповнить сама

  // мовний сервіс перезапускаємо лише тоді, коли змінилися саме його налаштування
  const key = JSON.stringify(config.speech);
  // …або коли він не запустився чи впав: «Перечитати налаштування» дає йому ще одну спробу
  // у режимі знімка для розробки моделі мовлення не вантажимо, якщо не просили справжній запит
  const skipSpeech = SHOT && !process.env.OFFGRID_SHOT_ASK;
  if (speech && !skipSpeech && (key !== speechConfigKey || (announce && speech.status === 'failed'))) { speechConfigKey = key; speech.start(config.speech); }
  else if (announce) planGpu(); // інші програми могли звільнити чи зайняти відеопам'ять
  syncVoice({ retry: announce });
  resources?.touch();
  rebuildTrayMenu();

}

// Реєструє гарячу клавішу. Якщо обрана зайнята іншою програмою, бере першу вільну із запасних і чесно про це каже.
let hotkeyRun = 0;
async function registerHotkeys({ announce = false, only = null } = {}) {
  const run = ++hotkeyRun; // якщо тим часом почали реєструвати знову — ця спроба застаріла
  const wanted = only ?? config.hotkey;
  let found = null;
  for (const key of only ? [only] : [wanted, ...FALLBACK_HOTKEYS.filter((k) => k !== wanted)]) {
    if (await ui.registerHotkey(key)) { found = key; break; }
    if (run !== hotkeyRun) return found;
  }
  if (run !== hotkeyRun) return found;
  if (only) return found; // пробна реєстрація: стан не чіпаємо, рішення за тим, хто питав
  activeHotkey = found;
  warnings = warnings.filter((w) => !w.startsWith('Гарячу клавішу') && !w.startsWith('Клавіша «'));
  if (!found) warnings.push(`Гарячу клавішу «${wanted}» не вдалося зареєструвати. Відкривай панель клацанням по іконці в треї або зміни її в налаштуваннях`);
  else if (found !== wanted) warnings.push(`Клавіша «${wanted}» зайнята іншою програмою, тому зараз працює «${found}». Змінити можна в налаштуваннях`);
  if (announce) send({ type: 'notice', text: warnings.length ? 'Налаштування перечитано, є зауваги:' : 'Налаштування перечитано.' });
  send({ type: 'config', hotkey: activeHotkey, model: config.model, speakReplies: config.speakReplies, warnings: announce ? warnings : [] });
  return found;
}

// ---------- Трей ----------
// Пункти меню трею: назва -> дія. Саме меню малює оболонка, сюди повертається лише назва натиснутого пункту.
const MENU_ACTIONS = {
  show: () => showPanel(),
  'new-chat': () => newChat(),
  sleep: () => { resources?.sleep('manual'); },
  speak: () => setSpeakReplies(!config.speakReplies),
  settings: () => { showPanel(); send({ type: 'open-view', view: 'settings' }); },
  log: () => { showPanel(); send({ type: 'open-view', view: 'log' }); },
  'open-settings-file': () => ui.open(SETTINGS_FILE),
  reload: () => { applyConfig({ announce: true }); showPanel(); },
  'open-log-file': () => ui.open(fs.existsSync(LOG_FILE) ? LOG_FILE : DATA_DIR),
  'open-notes': () => { fs.mkdirSync(NOTES_DIR, { recursive: true }); ui.open(NOTES_DIR); },
  quit: () => quit(),
};

function rebuildTrayMenu() {
  if (!config) return;
  ui.setMenu([
    { id: 'show', label: 'Показати панель' },
    { id: 'new-chat', label: 'Нова розмова' },
    resources?.asleep
      ? { id: 'asleep', label: 'Спить — пам\'ять звільнено', enabled: false }
      : { id: 'sleep', label: 'Звільнити відеопам\'ять (заснути)' },
    { id: 'speak', label: 'Озвучувати відповіді', checked: !!config.speakReplies, enabled: !!config.speech?.enabled },
    { separator: true },
    { id: 'settings', label: 'Налаштування…' },
    { id: 'log', label: 'Журнал дій…' },
    { separator: true },
    { id: 'open-settings-file', label: 'Відкрити файл налаштувань (settings.json)' },
    { id: 'reload', label: 'Перечитати налаштування' },
    { id: 'open-log-file', label: 'Відкрити файл журналу' },
    { id: 'open-notes', label: 'Відкрити папку нотаток' },
    { separator: true },
    { id: 'quit', label: 'Вийти' },
  ]);
}

// ---------- Голос ----------
// Говорить якісний голос, якщо його сервіс готовий; інакше — простий голос мовного сервісу (запасний).
const talker = () => (voice?.ready ? voice : speech);

/** Замовкнути негайно (обидва голоси) і запам'ятати, коли це сталося. */
function hush() {
  if (voice?.ready) voice.cancel();
  speech?.cancel();
  lastTalkEnd = Date.now();
}

function voiceWanted() {
  const skip = SHOT && !process.env.OFFGRID_SHOT_ASK;
  return !skip && !!config.speech?.enabled && config.speech.voice?.engine === 'omnivoice'
    && (config.speakReplies || !!process.env.OFFGRID_SHOT_SOUND);
}

// Запускає або зупиняє сервіс якісного голосу відповідно до налаштувань. Якщо озвучення вимкнене,
// сервіс не тримаємо взагалі: він займає 2 ГБ відеопам'яті, які тоді дістаються моделі асистента.
function syncVoice({ retry = false } = {}) {
  if (!voice) return;
  const v = config.speech?.voice;
  const key = voiceWanted() ? JSON.stringify(v) : '';
  if (key === voiceKey && !(retry && key && voice.status === 'failed')) return;
  voiceKey = key;
  if (!key) { voice.stop(); return; }
  voice.start({ enabled: true, python: v.python }, {
    script: VOICE_SCRIPT,
    env: {
      HF_HOME: v.modelDir,
      OFFGRID_VOICE_PROMPT: v.prompt ?? '',
      OFFGRID_VOICE_INSTRUCT: v.instruct ?? '',
      OFFGRID_VOICE_SPEED: String(v.speed),
      OFFGRID_VOICE_STEPS: String(v.steps),
    },
  });
}

// ---------- Розмова ----------
function newChat() {
  cancelAll();
  agent.reset();
  send({ type: 'reset' });
  if (state === 'error') setState('idle');
}

function cancelAll() {
  turnCancelled = true; // хід має зупинитися, на якому б кроці він не був
  agent.cancel();
  denyAllConfirms();
  hush(); // зупиняє і запис, і озвучення
}

function showError(text) {
  send({ type: 'error', text });
  setState('error');
  // помилка — не постійний стан: за кілька секунд повертаємось до очікування
  setTimeout(() => { if (state === 'error' && !turnActive) setState('idle'); }, ERROR_SHOWN_MS);
}

function endTurn() {
  turnActive = false;
  resources?.touch(); // відлік простою починається після кожної розмови
  if (replanAfterTurn) { replanAfterTurn = false; planGpu(); }
  if (quitting) return; // застосунок уже закривається
  send({ type: 'busy', value: false });
  if (state !== 'error') setState('idle');
  if (!ui.focused) { showPanel({ focus: false }); scheduleAutoHide(); }
}

function setSpeakReplies(value) {
  config.speakReplies = value === true;
  logAction({ tool: 'settings', args: { change: 'speakReplies', on: config.speakReplies }, decision: 'user', ok: true });
  if (!saveSetting('speakReplies', config.speakReplies)) send({ type: 'notice', text: 'Не вдалося зберегти налаштування озвучення — воно діятиме до перезапуску.' });
  if (!config.speakReplies && (state === 'speaking' || turnSpoke)) hush();
  syncVoice(); // якісний голос запускається лише тоді, коли озвучення ввімкнене
  send({ type: 'speak-setting', value: config.speakReplies });
  rebuildTrayMenu();
}

// Підбирає, скільки шарів моделі асистента вмістити у відеопам'ять поруч з усім іншим (див. agent/gpu.js).
// Викликається, коли мовний сервіс запустився чи зупинився, і після «Перечитати налаштування».
function planGpu({ force = false, reserveSpeech = false } = {}) {
  if (gpuPlan) return gpuPlan;
  // посеред розмови модель не чіпаємо — перерахуємо, щойно розмова закінчиться
  if (turnActive && !force) { replanAfterTurn = true; return null; }
  if ((turnActive && !force) || quitting || resources?.asleep || (SHOT && !process.env.OFFGRID_SHOT_ASK)) return null;
  gpuPlan = (async () => {
    try {
      // поки мовний сервіс ще вантажиться й може зайняти відеокарту — лишаємо під нього місце
      // (або щойно прокинувся й ще не повернув свою модель на відеокарту)
      const pending = reserveSpeech || (speech?.status === 'starting' && config.speech?.enabled && config.speech.device !== 'cpu');
      // якісний голос ще вантажиться або спить (його модель тимчасово не у відеопам'яті)
      // якісний голос: службова частина зайнята постійно (якщо сервіс уже запущений — вона вже врахована
      // серед «іншого»), а модель міняється місцем із розпізнаванням або, якщо те на процесорі, потребує свого
      const sttOnGpu = pending || (speech?.ready && speech.device === 'gpu');
      const voiceComing = voice?.status === 'starting';
      planCountedVoice = voiceComing || !!voice?.ready;
      const forVoice = !planCountedVoice ? 0 : (voiceComing ? VOICE_RESIDENT_MB : 0) + (sttOnGpu ? VOICE_OVER_STT_MB : VOICE_MODEL_MB);
      const plan = await decideGpuLayers(config, { reserveMb: (pending ? STT_VRAM_MB : 0) + forVoice });
      setGpuLayers(plan.layers);
      logAction({ tool: 'app', args: {}, decision: 'auto', ok: true,
        message: `Відеопам'ять: ${plan.note}; розпізнавання мови — ${speech?.ready ? (speech.device === 'gpu' ? 'на відеокарті' : 'на процесорі') : 'вимкнене'}` });
      if (plan.layers !== null && plan.layers < 99 && config.gpuLayers === 'auto') {
        send({ type: 'soft', text: `Відеопам'ять зайнята іншими програмами: ${plan.note}.` });
      }
    } catch { /* розподіл лишається за Ollama */ } finally { gpuPlan = null; }
  })();
  return gpuPlan;
}

// Прокидається перед командою: заново ділить відеопам'ять і завантажує модель, не чекаючи першого запиту.
function wakeUp() {
  if (waking) return waking;
  waking = (async () => {
    try {
      if (!(await resources?.wake())) return;
      syncVoice();          // якщо сервіс голосу зупиняли, щоб звільнити пам'ять, — запускаємо знову
      await planGpu({ force: true, reserveSpeech: speech?.ready && speech.device === 'gpu' });
      preloadModel(config); // у фоні: поки ти говориш, модель уже вантажиться
    } finally { waking = null; }
  })();
  return waking;
}

function onSleepChange(asleep, why) {
  if (quitting) return;
  ui.setTray({ tip: trayTip() });
  rebuildTrayMenu();
  send({ type: 'asleep', value: asleep });
  if (!asleep) return;
  const reasons = { idle: 'простій', manual: 'на прохання користувача', pressure: 'відеопам\'яті бракує іншій програмі' };
  logAction({ tool: 'app', args: {}, decision: 'auto', ok: true, message: `Пам'ять звільнено (${reasons[why] ?? why}). Прокинуся з першою командою` });
  if (why === 'manual') send({ type: 'soft', text: 'Відеопам\'ять звільнено. Прокинуся з першою ж командою.' });
  if (why === 'pressure') send({ type: 'soft', text: 'Іншій програмі бракувало відеопам\'яті — я звільнив свою. Прокинуся з першою ж командою.' });
}

// Один хід розмови: запит до моделі, відповідь у панель і (якщо ввімкнено) голосом.
// Текст відповіді надходить потоком: панель показує його одразу, а кожне завершене речення йде на озвучення,
// тож асистент починає говорити з першого речення. Повертає true, якщо після ходу треба одразу слухати далі.
async function runTurn(text, { byVoice = false } = {}) {
  const generation = agent.generation;
  const current = () => generation === agent.generation; // false, якщо посеред ходу почали нову розмову
  const tts = talker(); // хто говорить у цьому ході — не змінюється посеред відповіді
  const swap = tts === voice && speech?.ready && speech.device === 'gpu'; // голос і розпізнавання міняються місцем
  let voiceUp = false;
  const mayTalk = () => (config.speakReplies || process.env.OFFGRID_SHOT_SOUND) && tts?.ready
    && !turnCancelled && current() && (!SHOT || process.env.OFFGRID_SHOT_SOUND); // у режимі знімка зазвичай мовчимо
  let raw = '';             // текст, який модель написала в поточному кроці
  let held = [];            // речення, які ще не пішли на озвучення (запитання наприкінці притримуємо)
  let epoch = 0;            // зростає, коли вже поставлене в чергу треба відкинути
  let said = false;         // мовний сервіс справді прийняв хоча б одне речення
  let speechBroken = false;
  let queue = Promise.resolve(); // речення йдуть до мовного сервісу строго по черзі
  turnSpoke = false;

  const breakSpeech = (e) => {
    speechBroken = true;
    hush(); // те, що вже звучить, без нашого нагляду лишати не можна
    if (current()) send({ type: 'notice', text: `Не вдалося озвучити: ${e.message}` });
  };
  const enqueue = (sentence) => {
    if (speechBroken || !mayTalk()) return;
    turnSpoke = true;
    const mine = epoch;
    queue = queue.then(async () => {
      if (speechBroken || turnCancelled || listenNext || mine !== epoch || !current()) return;
      if (await tts.say(sentence)) said = true;
    }).catch(breakSpeech);
  };
  // Речення-запитання притримуємо: якщо воно виявиться останнім, остаточний текст вирішить, чи його казати
  // (чергове «чим ще допомогти?» з відповіді прибирається). Решта звучить одразу.
  const onSentence = (sentence) => {
    for (const earlier of held) enqueue(earlier);
    held = [];
    if (sentence.endsWith('?')) held.push(sentence); else enqueue(sentence);
  };
  const splitter = new SentenceSplitter(onSentence);
  replySink = {
    delta(piece) {
      if (!current()) return;
      raw += piece;
      send({ type: 'reply-delta', text: piece });
      splitter.push(piece);
    },
    // текст виявився не відповіддю, а вступом перед викликом інструмента
    reset() {
      splitter.reset();
      held = [];
      raw = '';
      epoch++;
      if (turnSpoke) hush();
      if (current()) send({ type: 'reply-reset' });
    },
  };

  try {
    if (tts === voice && mayTalk()) {
      // розпізнавання своє зробило — звільняє місце, і поки модель думає, туди заходить голос (0,3 с)
      voiceUp = true;
      (swap ? speech.sleep().catch(() => false) : Promise.resolve()).then(() => voice.wake());
    }
    if (waking) await waking;   // асистент прокидається після «сну»
    if (gpuPlan) await gpuPlan; // розподіл відеопам'яті саме підбирається — секунду чекаємо
    const reply = await agent.ask(text);
    replySink = null;
    if (!current()) return false;
    splitter.flush();
    // якщо потоком нічого не надходило (службова відповідь) — озвучуємо її цілком
    const tail = raw ? finalTail(held, raw, reply) : reply;
    held = [];
    if (tail) enqueue(tail);
    send({ type: 'assistant', text: reply });
    let interrupted = false;
    if (turnSpoke) {
      const who = tts === voice ? 'якісний голос (OmniVoice)' : 'простий голос (Piper)';
      if (who !== lastTalker) {
        lastTalker = who;
        logAction({ tool: 'app', args: {}, decision: 'auto', ok: true, message: `Відповіді озвучує ${who}` });
      }
      setState('speaking');
      await queue;
      if (!speechBroken) {
        try { interrupted = (await tts.finishSpeaking()).interrupted; } catch (e) { breakSpeech(e); }
        lastTalkEnd = Date.now();
      }
    }
    if (!current() || turnCancelled) return false;
    if (listenNext) return true;                       // відповідь перебито гарячою клавішею
    return byVoice && said && !interrupted && !speechBroken && config.followUp; // розмова голосом триває
  } catch (e) {
    denyAllConfirms();
    if (turnSpoke) hush();
    if (!current()) return false;
    if (listenNext && !turnCancelled) return true;     // перебито клавішею, поки модель ще дописувала відповідь
    if (e.message === 'Скасовано') send({ type: 'stopped' }); else showError(e.message);
    return false;
  } finally {
    replySink = null;
    turnSpoke = false;
    if (voiceUp) {
      // відповідь договорено: голос повертається у звичайну пам'ять, розпізнавання — на відеокарту
      await voice.sleep().catch(() => false);
      if (swap) speech.wake();
    }
  }
}

async function startTextTurn(text) {
  if (turnActive) { send({ type: 'soft', text: 'Зачекай, я ще виконую попередній запит.' }); return; }
  turnActive = true;
  turnCancelled = false;
  listenNext = false;
  send({ type: 'busy', value: true });
  wakeUp();
  let again = false;
  try { again = await runTurn(text); } finally { endTurn(); }
  if (again && listenNext) startListening();
}

// Голосова розмова: слухаємо до паузи, показуємо текст наживо, відповідаємо — і, якщо ввімкнено «продовження»,
// ще кілька секунд слухаємо далі вже без клавіші. Розмова закінчується, коли ти мовчиш.
async function startListening() {
  if (turnActive) return;
  if (!speech?.ready) {
    showPanel();
    send({ type: 'soft', text: speech?.status === 'starting' ? 'Голос ще завантажується, зачекай кілька секунд.' : 'Голос зараз недоступний.' });
    return;
  }
  turnActive = true;
  turnCancelled = false;
  send({ type: 'busy', value: true });
  wakeUp(); // якщо спав — прокидається у фоні, поки ти говориш
  let autoListens = 0; // скільки разів поспіль слухали без клавіші
  try {
    for (let followUp = false; ; followUp = true) {
      const byKey = listenNext; // цей запис почато клавішею (перебивання), а не автоматичним «продовженням»
      listenNext = false;
      const auto = followUp && !byKey;
      if (!auto) autoListens = 0;
      else if (++autoListens > MAX_FOLLOW_UPS) return;
      listeningAuto = auto;
      heardSpeech = false;
      setState('listening');
      showPanel({ focus: false });
      const generation = agent.generation;
      // якісний голос звучить з іншого процесу, тож паузу після нього витримуємо тут
      const settle = SETTLE_AFTER_TALK_MS - (Date.now() - lastTalkEnd);
      if (settle > 0) await new Promise((r) => setTimeout(r, settle));
      let heard;
      try {
        heard = await speech.listen((event) => {
          if (event.type === 'partial') send({ type: 'partial', text: event.text });
          else if (event.type === 'speech') { heardSpeech = true; send({ type: 'partial', text: '' }); }
          else if (event.type === 'recognizing') setState('thinking');
          // без клавіші початком мови вважаємо лише стійкий звук, а не випадковий клац чи стукіт
        }, auto ? { waitSeconds: FOLLOW_UP_WAIT_S, strict: true } : {});
      } catch (e) {
        send({ type: 'partial-end' });
        showError(e.message);
        return;
      } finally {
        listeningAuto = false;
      }
      send({ type: 'partial-end' });
      // turnCancelled ловить і скасування, що прийшло в останню мить, коли текст уже розпізнано
      if (generation !== agent.generation || turnCancelled) return;
      if (heard.cancelled) {
        if (listenNext) continue; // клавіша під час «продовження»: слухаємо знову, тепер уже як за викликом
        return;
      }
      if (!heard.text) {
        // після відповіді тиша — це просто кінець розмови; на прямий виклик кажемо, що нічого не почули
        if (!auto) send({ type: 'soft', text: 'Нічого не почув.' });
        return;
      }
      send({ type: 'user', text: heard.text });
      if (!(await runTurn(heard.text, { byVoice: true }))) return;
    }
  } finally {
    listeningAuto = false;
    endTurn();
  }
}

function setOption(key, value) {
  if (!saveSetting(key, value)) return { ok: false, error: 'Не вдалося зберегти налаштування.' };
  config[key] = value;
  logAction({ tool: 'settings', args: { change: key, value: String(value) }, decision: 'user', ok: true });
  resources?.touch();
  return { ok: true };
}

function setFollowUp(value) {
  config.followUp = value === true;
  logAction({ tool: 'settings', args: { change: 'followUp', on: config.followUp }, decision: 'user', ok: true });
  return saveSetting('followUp', config.followUp);
}

// ---------- Налаштування з панелі ----------
// Шлях до програми чи папки обирає користувач у системному вікні; панель його не передає.
async function pickPath(kind) {
  dialogOpen = true;
  try {
    return await ui.pick(kind, kind === 'exe' ? 'Яку програму дозволити асистенту?' : 'Яку папку дозволити асистенту?');
  } finally {
    dialogOpen = false;
    if (!quitting) showPanel();
  }
}

function changeSettings(change, payload) {
  const result = editSettings(change, payload, TOOL_MODES);
  // у журнал — лише прості поля з відомими назвами
  const args = { change };
  for (const field of ['key', 'name', 'closable', 'exe', 'dir', 'ext', 'list', 'on', 'hotkey']) {
    if (['string', 'boolean'].includes(typeof payload?.[field])) args[field] = payload[field];
  }
  logAction({ tool: 'settings', args, decision: 'user', ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
  if (result.ok) applyConfig(); // оновлений стан (зокрема клавішу) панель отримає подією
  return result;
}

async function changeHotkey(hotkey) {
  hotkeySuspended = false;
  if (!isValidHotkey(hotkey)) { await registerHotkeys(); return { ok: false, error: 'Потрібне сполучення з Ctrl, Alt або Win і однієї клавіші, наприклад Ctrl + Shift + Space' }; }
  // спершу перевіряємо, чи Windows віддасть нам це сполучення, і лише тоді записуємо
  if (!(await registerHotkeys({ only: hotkey }))) {
    await registerHotkeys(); // повертаємо попередню клавішу
    return { ok: false, error: 'Це сполучення вже зайняте іншою програмою або Windows. Спробуй інше.' };
  }
  const result = changeSettings('setHotkey', { hotkey });
  if (result.ok) activeHotkey = hotkey;
  await registerHotkeys(); // запис не вдався — повертаємо попередню клавішу; вдався — підтверджуємо нову
  return result;
}

const SIMPLE_CHANGES = new Set(['updateApp', 'removeApp', 'updateFolder', 'removeFolder', 'setFileType']);

async function handleSettings(action, payload) {
  let result = { ok: true };
  const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  if (action === 'addApp' || action === 'addFolder') {
    if (dialogOpen) return null;
    const picked = await pickPath(action === 'addApp' ? 'exe' : 'dir');
    if (picked) result = changeSettings(action, action === 'addApp' ? { exe: picked } : { dir: picked });
  } else if (action === 'setFlag') {
    const on = data.on === true;
    if (data.key === 'speakReplies') setSpeakReplies(on);
    else if (data.key === 'followUp') { if (!setFollowUp(on)) result = { ok: false, error: 'Не вдалося зберегти — налаштування діятиме до перезапуску.' }; }
    else if (data.key === 'yieldToOtherApps') result = setOption('yieldToOtherApps', on);
    else result = { ok: false, error: 'Невідомий перемикач' };
  } else if (action === 'setIdleMinutes') {
    result = Number.isInteger(data.minutes) && data.minutes >= 0 && data.minutes <= 240
      ? setOption('idleUnloadMinutes', data.minutes) : { ok: false, error: 'Некоректний час простою' };
  } else if (action === 'setHotkey') {
    result = await changeHotkey(data.hotkey);
  } else if (SIMPLE_CHANGES.has(action)) {
    result = changeSettings(action, data);
  } else if (action !== 'get') {
    result = { ok: false, error: 'Невідома дія' };
  }
  return { ...result, view: settingsView(config, warnings), activeHotkey };
}

// Запити панелі. Сюди доходить лише те, що пройшло перевірку ключа на сервері (server.js).
const API = {
  ready: async () => ({
    state, busy: turnActive, asleep: !!resources?.asleep, hotkey: activeHotkey, model: config.model, warnings,
    speakReplies: config.speakReplies, voice: { status: speech?.status ?? 'off', error: speech?.error ?? null },
  }),
  ask: async ({ text }) => { if (typeof text === 'string' && text.trim()) startTextTurn(text); return true; },
  listen: async () => { if (state === 'listening') speech.stopListening(); else startListening(); return true; },
  'set-speak': async ({ value }) => { setSpeakReplies(value === true); return true; },
  cancel: async () => { cancelAll(); return true; },
  confirm: async ({ id, allow }) => { pendingConfirms.get(String(id))?.finish(allow === true); return true; },
  'new-chat': async () => { newChat(); return true; },
  hide: async () => { hidePanel(); return true; },
  settings: async ({ action, payload }) => (typeof action === 'string' ? handleSettings(action, payload) : null),
  ping: async () => ping(config),
  log: async () => readLog(150),
  // Поки користувач записує нове сполучення, чинну гарячу клавішу знімаємо: інакше її натискання
  // почало б розмову замість того, щоб потрапити в поле запису
  'capture-hotkey': async ({ on }) => {
    if (on === true && !turnActive) { hotkeySuspended = true; hotkeyRun++; await ui.unregisterHotkey(); }
    else if (hotkeySuspended) { hotkeySuspended = false; await registerHotkeys(); }
    return true;
  },
};

// ---------- Знімок для розробки ----------
async function devScreenshot() {
  showPanel();
  await new Promise((r) => setTimeout(r, 600));
  for (let i = 0; i < 360 && (speech?.status === 'starting' || voice?.status === 'starting') && process.env.OFFGRID_SHOT_ASK; i++) await new Promise((r) => setTimeout(r, 500));
  if (gpuPlan) await gpuPlan;
  const phrase = process.env.OFFGRID_SHOT_ASK;
  if (phrase) {
    // справжній запит: агент -> модель -> панель (і голос, якщо ввімкнено)
    send({ type: 'user', text: phrase });
    startTextTurn(phrase);
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 240 && (turnActive || pendingConfirms.size > 0); i++) await new Promise((r) => setTimeout(r, 500));
  } else if (process.env.OFFGRID_SHOT_VIEW) {
    const [view, tab] = process.env.OFFGRID_SHOT_VIEW.split(':');
    send({ type: 'open-view', view, tab });
    await new Promise((r) => setTimeout(r, Number(process.env.OFFGRID_SHOT_WAIT) || 800));
  } else {
    send({ type: 'demo' });
  }
  await new Promise((r) => setTimeout(r, 500));
  if (!(await ui.shot(SHOT))) console.error('Знімок не вдався');
  quit();
}

// ---------- Запуск і вихід ----------
function quit() {
  if (quitting) return;
  quitting = true;
  clearTimeout(hideTimer);
  resources?.stop();
  speech?.stop();
  voice?.stop();
  ui.stop();
  server?.close();
  instanceServer?.close();
  setTimeout(() => process.exit(0), 2500).unref(); // якщо щось не закрилося саме
}

// Єдина копія: якщо канал уже зайнятий, застосунок працює — просимо його показати панель і виходимо
let instanceServer = null;
function claimInstance() {
  return new Promise((resolve) => {
    const srv = net.createServer((socket) => { socket.on('data', () => showPanel()); socket.on('error', () => {}); });
    srv.once('error', () => {
      const client = net.connect(INSTANCE_PIPE, () => { client.end('show'); resolve(false); });
      client.once('error', () => resolve(false));
    });
    srv.listen(INSTANCE_PIPE, () => { instanceServer = srv; resolve(true); });
  });
}

async function start() {
  if (!(await claimInstance())) { console.log('Offgrid уже запущено — показую його панель.'); process.exit(0); }

  // файли, папки й сайти відкриває оболонка — системним механізмом, як подвійне клацання в Провіднику
  const os = { ...nodeOs, openPath: (p) => ui.open(p), openUrl: (url) => ui.open(url) };
  config = loadConfig({ toolModes: TOOL_MODES }).config;
  agent = new Agent({
    config,
    os,
    confirm: askConfirm,
    emit: (event) => {
      if (event.type === 'state') { if (pendingConfirms.size === 0 && state !== 'speaking') setState(event.state); }
      else if (event.type === 'reply-delta') replySink?.delta(event.text);
      else if (event.type === 'reply-reset') replySink?.reset();
      else send(event);
    },
  });

  speech = new Speech({
    onStatus: (s) => {
      send({ type: 'voice', status: s.status, error: s.error });
      // мовний сервіс визначився (зайняв відеокарту чи ні) — тепер можна ділити відеопам'ять для моделі
      // …але якщо сервіс якісного голосу ще вантажиться, чекаємо на нього: посеред завантаження його модель
      // тимчасово лежить у відеопам'яті, і розрахунок вийшов би надто обережним
      if (s.status !== 'starting' && voice?.status !== 'starting') planGpu();
    },
  });

  voice = new Speech({
    onStatus: (s) => {
      if (s.status === 'starting') { if (!resources?.asleep) send({ type: 'soft', text: 'Якісний голос завантажується (близько 20 с) — поки що говорю простим.' }); return; }
      if (s.status === 'ready') {
        logAction({ tool: 'app', args: {}, decision: 'auto', ok: true, message: 'Якісний голос готовий' });
        send({ type: 'soft', text: 'Якісний голос готовий.' });
      }
      if (s.status === 'failed') {
        logAction({ tool: 'app', args: {}, decision: 'error', ok: false, error: `Якісний голос не запустився: ${s.error ?? 'невідома помилка'}` });
        send({ type: 'notice', text: `Якісний голос не запустився (${s.error ?? 'невідома помилка'}). Говорю простим голосом.` });
      }
      if (resources?.asleep) return; // сервіс зупинено, щоб звільнити пам'ять, — ділити її зараз не треба
      // сервіс визначився (його модель уже у звичайній пам'яті) — тепер відеопам'ять можна поділити точно
      if (speech?.status !== 'starting') planGpu();
    },
  });

  resources = new Resources({
    getConfig: () => config,
    isBusy: () => turnActive || !!gpuPlan || !!waking || dialogOpen || quitting
      || speech?.status === 'starting' || voice?.status === 'starting',
    release: async (reason) => {
      await unloadModel(config);
      await speech?.sleep().catch(() => false);
      // Після простою сервіс голосу лишається запущеним (його модель і так у звичайній пам'яті) — так він
      // прокидається миттєво. Якщо ж пам'ять звільняють навмисно чи для іншої програми, зупиняємо його
      // зовсім: це ще близько 1 ГБ відеопам'яті; після пробудження він запуститься знову за ~20 с.
      if (reason === 'idle') await voice?.sleep().catch(() => false);
      else if (voice && voiceKey) { voiceKey = ''; await voice.stop(); }
    },
    readVram,
    onChange: onSleepChange,
  });

  // Сервер панелі та оболонка
  server = new PanelServer(API);
  const url = await server.listen();
  ui.on('hotkey', onHotkey);
  ui.on('tray-click', togglePanel);
  ui.on('menu', (id) => { if (Object.hasOwn(MENU_ACTIONS, id)) MENU_ACTIONS[id](); });
  ui.on('blur', onBlur);
  ui.on('exit', () => { if (!quitting) { console.error('Оболонка несподівано закрилась — завершую роботу.'); quit(); } });
  try {
    await ui.start({ url, dataDir: WEBVIEW_DATA, width: WIDTH, height: HEIGHT });
  } catch (e) {
    console.error(e.message);
    quit();
    return;
  }
  ui.setTray({ icon: iconPng('idle'), tip: trayTip() });
  applyConfig(); // тут же запускаються мовні сервіси й реєструється гаряча клавіша
  if (!SHOT) resources.start();
  if (!SHOT) logAction({ tool: 'app', args: {}, decision: 'auto', ok: true, message: 'Offgrid запущено' });
  if (SHOT) devScreenshot(); else showPanel();
}

process.on('SIGINT', quit);
process.on('SIGTERM', quit);
start();
