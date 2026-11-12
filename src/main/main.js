// Головний процес Offgrid: трей, панель, гаряча клавіша, зв'язок панелі з агентом.
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, shell, session, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA_DIR, ELECTRON_DATA, SETTINGS_FILE, LOG_FILE, NOTES_DIR } from '../paths.js';
import { loadConfig, saveSetting } from '../security/config.js';
import { TOOL_MODES } from '../security/policy.js';
import { logAction, readLog } from '../security/log.js';
import { editSettings, settingsView, isValidHotkey } from '../security/settings-store.js';
import { Agent } from '../agent/agent.js';
import { ping, setGpuLayers, unloadModel, preloadModel } from '../agent/ollama.js';
import { decideGpuLayers, readVram } from '../agent/gpu.js';
import { Resources } from '../agent/resources.js';
import { nodeOs } from '../tools/util.js';
import { Speech } from '../speech/client.js';
import { SentenceSplitter } from '../speech/sentences.js';
import { finalTail } from '../agent/tone.js';
import { iconPng } from './icon.js';

const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).toString();
const PRELOAD = path.join(ROOT, 'src', 'preload', 'preload.cjs');
const WIDTH = 400, HEIGHT = 540, MARGIN = 12;
const CONFIRM_TIMEOUT_MS = 60_000;
const AUTO_HIDE_MS = 9_000;
const ERROR_SHOWN_MS = 5_000;
const FOLLOW_UP_WAIT_S = 5; // скільки чекати на продовження розмови після відповіді
// Стільки разів поспіль асистент слухає «продовження» сам. Далі потрібна клавіша: так розмова не може
// тривати без кінця, якщо в кімнаті говорить телевізор, а людини поруч немає.
const MAX_FOLLOW_UPS = 4;
const FALLBACK_HOTKEYS = ['Control+Shift+Space', 'Alt+Shift+Space', 'Control+Alt+O'];
const SHOT = process.env.OFFGRID_SHOT; // лише для розробки: зберегти знімок панелі й вийти

// Службові дані Electron теж тримаємо всередині проєкту, а не в %APPDATA%
// (режим знімка для розробки має власну папку, щоб не конфліктувати із запущеним застосунком)
const USER_DATA = SHOT ? `${ELECTRON_DATA}-dev` : ELECTRON_DATA;
fs.mkdirSync(USER_DATA, { recursive: true });
app.setPath('userData', USER_DATA);
// Відеопам'яті впритул через модель — панель малюється на процесорі
if (!SHOT) app.disableHardwareAcceleration();
app.setAppUserModelId('local.offgrid.assistant');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null, tray = null, agent = null;
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
  if (win && !win.isDestroyed()) win.webContents.send('offgrid:event', event);
}

function setState(next) {
  if (state === next) return;
  state = next;
  send({ type: 'state', state });
  if (tray) {
    tray.setImage(nativeImage.createFromBuffer(iconPng(state), { scaleFactor: 2 }));
    tray.setToolTip(trayTip());
  }
}

// ---------- Панель ----------
function placeWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds({ x: area.x + area.width - WIDTH - MARGIN, y: area.y + area.height - HEIGHT - MARGIN, width: WIDTH, height: HEIGHT });
}

function showPanel({ focus = true } = {}) {
  clearTimeout(hideTimer);
  placeWindow();
  if (focus) { win.show(); win.focus(); send({ type: 'focus-input' }); } else if (!win.isVisible()) win.showInactive();
}

function hidePanel() {
  clearTimeout(hideTimer);
  if (win?.isVisible()) win.hide();
}

function togglePanel() {
  if (win.isVisible() && win.isFocused()) hidePanel(); else showPanel();
}

// Гаряча клавіша: з голосом — «говорити / досить / замовкни», без голосу — показати або сховати панель
function onHotkey() {
  if (dialogOpen) return; // відкрито вікно вибору файлу — розмову зараз не починаємо
  if (state === 'listening') {
    // під час «продовження», поки ти ще мовчиш, клавіша означає «слухай мене», а не «досить»
    if (listeningAuto && !heardSpeech) { listenNext = true; speech.cancel(); } else speech.stopListening();
  }
  // перебити відповідь (навіть якщо модель її ще дописує): замовкнути й одразу слухати
  else if (state === 'speaking' || (turnActive && turnSpoke)) { listenNext = true; agent.cancel(); speech.cancel(); }
  else if (turnActive) showPanel({ focus: false });
  else if (speech?.ready) startListening();
  else togglePanel();
}

// Панель, показана без фокусу (відповідь прийшла, поки ти працюєш в іншому вікні), згодом ховається сама
function scheduleAutoHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (win?.isVisible() && !win.isFocused() && (state === 'idle' || state === 'error') && pendingConfirms.size === 0 && !dialogOpen) win.hide();
  }, AUTO_HIDE_MS);
}

function createWindow() {
  win = new BrowserWindow({
    width: WIDTH, height: HEIGHT,
    show: false, frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: '#202020',
    title: 'Offgrid',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !!process.env.OFFGRID_DEVTOOLS,
    },
  });
  win.setMenu(null);
  // Панель показує лише власну локальну сторінку: жодних переходів, нових вікон чи дозволів
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('blur', () => {
    // панель втратила фокус посеред запису нової клавіші — повертаємо гарячу клавішу на місце
    if (hotkeySuspended) { hotkeySuspended = false; applyConfig(); send({ type: 'capture-end' }); }
    if ((state === 'idle' || state === 'error') && pendingConfirms.size === 0 && !dialogOpen && !SHOT) hidePanel();
  });
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); hidePanel(); }
  });
  win.loadFile(INDEX_HTML);
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

  // Якщо обрана клавіша зайнята іншою програмою, беремо першу вільну із запасних і чесно про це кажемо
  globalShortcut.unregisterAll();
  activeHotkey = null;
  for (const key of [config.hotkey, ...FALLBACK_HOTKEYS.filter((k) => k !== config.hotkey)]) {
    let ok = false;
    try { ok = globalShortcut.register(key, onHotkey); } catch { ok = false; }
    if (ok) { activeHotkey = key; break; }
  }
  if (!activeHotkey) warnings.push(`Гарячу клавішу «${config.hotkey}» не вдалося зареєструвати. Відкривай панель клацанням по іконці в треї або зміни hotkey у налаштуваннях`);
  else if (activeHotkey !== config.hotkey) warnings.push(`Клавіша «${config.hotkey}» зайнята іншою програмою, тому зараз працює «${activeHotkey}». Змінити можна в налаштуваннях (hotkey)`);

  // мовний сервіс перезапускаємо лише тоді, коли змінилися саме його налаштування
  const key = JSON.stringify(config.speech);
  // …або коли він не запустився чи впав: «Перечитати налаштування» дає йому ще одну спробу
  // у режимі знімка для розробки моделі мовлення не вантажимо, якщо не просили справжній запит
  const skipSpeech = SHOT && !process.env.OFFGRID_SHOT_ASK;
  if (speech && !skipSpeech && (key !== speechConfigKey || (announce && speech.status === 'failed'))) { speechConfigKey = key; speech.start(config.speech); }
  else if (announce) planGpu(); // інші програми могли звільнити чи зайняти відеопам'ять
  resources?.touch();
  rebuildTrayMenu();

  // при старті панель сама забирає це через offgrid:ready
  if (announce) {
    send({ type: 'notice', text: warnings.length ? 'Налаштування перечитано, є зауваги:' : 'Налаштування перечитано.' });
    send({ type: 'config', hotkey: activeHotkey, model: config.model, speakReplies: config.speakReplies, warnings });
  }
}

// ---------- Трей ----------
function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(iconPng('idle'), { scaleFactor: 2 }));
  tray.setToolTip('Offgrid — очікує');
  tray.on('click', togglePanel);
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Показати панель', click: () => showPanel() },
    { label: 'Нова розмова', click: () => newChat() },
    resources?.asleep
      ? { label: 'Спить — пам\'ять звільнено', enabled: false }
      : { label: 'Звільнити відеопам\'ять (заснути)', click: () => { resources?.sleep('manual'); } },
    { label: 'Озвучувати відповіді', type: 'checkbox', checked: !!config?.speakReplies, enabled: !!config?.speech?.enabled, click: (item) => setSpeakReplies(item.checked) },
    { type: 'separator' },
    { label: 'Налаштування…', click: () => { showPanel(); send({ type: 'open-view', view: 'settings' }); } },
    { label: 'Журнал дій…', click: () => { showPanel(); send({ type: 'open-view', view: 'log' }); } },
    { type: 'separator' },
    { label: 'Відкрити файл налаштувань (settings.json)', click: () => shell.openPath(SETTINGS_FILE) },
    { label: 'Перечитати налаштування', click: () => { applyConfig({ announce: true }); showPanel(); } },
    { label: 'Відкрити файл журналу', click: () => (fs.existsSync(LOG_FILE) ? shell.openPath(LOG_FILE) : shell.openPath(DATA_DIR)) },
    { label: 'Відкрити папку нотаток', click: () => { fs.mkdirSync(NOTES_DIR, { recursive: true }); shell.openPath(NOTES_DIR); } },
    { type: 'separator' },
    { label: 'Вийти', click: () => { quitting = true; app.quit(); } },
  ]));
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
  speech?.cancel(); // зупиняє і запис, і озвучення
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
  if (quitting || !win || win.isDestroyed()) return; // застосунок уже закривається
  send({ type: 'busy', value: false });
  if (state !== 'error') setState('idle');
  if (!win.isFocused()) { showPanel({ focus: false }); scheduleAutoHide(); }
}

function setSpeakReplies(value) {
  config.speakReplies = value === true;
  logAction({ tool: 'settings', args: { change: 'speakReplies', on: config.speakReplies }, decision: 'user', ok: true });
  if (!saveSetting('speakReplies', config.speakReplies)) send({ type: 'notice', text: 'Не вдалося зберегти налаштування озвучення — воно діятиме до перезапуску.' });
  if (!config.speakReplies && (state === 'speaking' || turnSpoke)) speech?.cancel();
  send({ type: 'speak-setting', value: config.speakReplies });
  rebuildTrayMenu();
}

// Підбирає, скільки шарів моделі асистента вмістити у відеопам'ять поруч з усім іншим (див. agent/gpu.js).
// Викликається, коли мовний сервіс запустився чи зупинився, і після «Перечитати налаштування».
function planGpu({ force = false, reserveSpeech = false } = {}) {
  if (gpuPlan) return gpuPlan;
  if ((turnActive && !force) || quitting || resources?.asleep || (SHOT && !process.env.OFFGRID_SHOT_ASK)) return null;
  gpuPlan = (async () => {
    try {
      // поки мовний сервіс ще вантажиться й може зайняти відеокарту — лишаємо під нього місце
      // (або щойно прокинувся й ще не повернув свою модель на відеокарту)
      const pending = reserveSpeech || (speech?.status === 'starting' && config.speech?.enabled && config.speech.device !== 'cpu');
      const plan = await decideGpuLayers(config, { reserveMb: pending ? 1300 : 0 });
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
      await planGpu({ force: true, reserveSpeech: speech?.ready && speech.device === 'gpu' });
      preloadModel(config); // у фоні: поки ти говориш, модель уже вантажиться
    } finally { waking = null; }
  })();
  return waking;
}

function onSleepChange(asleep, why) {
  if (quitting) return;
  if (tray) tray.setToolTip(trayTip());
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
async function runTurn(text, { voice = false } = {}) {
  const generation = agent.generation;
  const current = () => generation === agent.generation; // false, якщо посеред ходу почали нову розмову
  const mayTalk = () => (config.speakReplies || process.env.OFFGRID_SHOT_SOUND) && speech?.ready
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
    speech?.cancel(); // те, що вже звучить, без нашого нагляду лишати не можна
    if (current()) send({ type: 'notice', text: `Не вдалося озвучити: ${e.message}` });
  };
  const enqueue = (sentence) => {
    if (speechBroken || !mayTalk()) return;
    turnSpoke = true;
    const mine = epoch;
    queue = queue.then(async () => {
      if (speechBroken || turnCancelled || listenNext || mine !== epoch || !current()) return;
      if (await speech.say(sentence)) said = true;
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
      if (turnSpoke) speech?.cancel();
      if (current()) send({ type: 'reply-reset' });
    },
  };

  try {
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
      setState('speaking');
      await queue;
      if (!speechBroken) {
        try { interrupted = (await speech.finishSpeaking()).interrupted; } catch (e) { breakSpeech(e); }
      }
    }
    if (!current() || turnCancelled) return false;
    if (listenNext) return true;                       // відповідь перебито гарячою клавішею
    return voice && said && !interrupted && !speechBroken && config.followUp; // розмова голосом триває
  } catch (e) {
    denyAllConfirms();
    if (turnSpoke) speech?.cancel();
    if (!current()) return false;
    if (listenNext && !turnCancelled) return true;     // перебито клавішею, поки модель ще дописувала відповідь
    if (e.message === 'Скасовано') send({ type: 'stopped' }); else showError(e.message);
    return false;
  } finally {
    replySink = null;
    turnSpoke = false;
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
      if (!(await runTurn(heard.text, { voice: true }))) return;
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
    const res = await dialog.showOpenDialog(win, kind === 'exe'
      ? { title: 'Яку програму дозволити асистенту?', properties: ['openFile'], filters: [{ name: 'Програми', extensions: ['exe'] }] }
      : { title: 'Яку папку дозволити асистенту?', properties: ['openDirectory'] });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  } finally {
    dialogOpen = false;
    if (!quitting && win && !win.isDestroyed()) { win.show(); win.focus(); }
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
  if (result.ok) {
    applyConfig();
    send({ type: 'config', hotkey: activeHotkey, model: config.model, speakReplies: config.speakReplies, warnings: [] });
  }
  return result;
}

function changeHotkey(hotkey) {
  hotkeySuspended = false;
  if (!isValidHotkey(hotkey)) { applyConfig(); return { ok: false, error: 'Потрібне сполучення з Ctrl, Alt або Win і однієї клавіші, наприклад Ctrl + Shift + Space' }; }
  // спершу перевіряємо, чи Windows віддасть нам це сполучення, і лише тоді записуємо
  globalShortcut.unregisterAll();
  let free = false;
  try { free = globalShortcut.register(hotkey, onHotkey); } catch { free = false; }
  if (!free) {
    applyConfig(); // повертаємо попередню клавішу
    return { ok: false, error: 'Це сполучення вже зайняте іншою програмою або Windows. Спробуй інше.' };
  }
  const result = changeSettings('setHotkey', { hotkey });
  if (!result.ok) applyConfig(); // запис не вдався — повертаємо попередню клавішу, а не лишаємо незбережену
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
    result = changeHotkey(data.hotkey);
  } else if (SIMPLE_CHANGES.has(action)) {
    result = changeSettings(action, data);
  } else if (action !== 'get') {
    result = { ok: false, error: 'Невідома дія' };
  }
  return { ...result, view: settingsView(config, warnings), activeHotkey };
}

// Приймаємо повідомлення лише від власної сторінки панелі
const trusted = (event) => event.senderFrame?.url === INDEX_URL && event.sender === win?.webContents;

function registerIpc() {
  ipcMain.handle('offgrid:ready', async (e) => {
    if (!trusted(e)) return null;
    return {
      state, busy: turnActive, asleep: !!resources?.asleep, hotkey: activeHotkey, model: config.model, warnings, speakReplies: config.speakReplies,
      voice: { status: speech?.status ?? 'off', error: speech?.error ?? null },
    };
  });
  ipcMain.on('offgrid:ask', (e, text) => {
    if (trusted(e) && typeof text === 'string' && text.trim()) startTextTurn(text);
  });
  ipcMain.on('offgrid:listen', (e) => {
    if (!trusted(e)) return;
    if (state === 'listening') speech.stopListening(); else startListening();
  });
  ipcMain.on('offgrid:set-speak', (e, value) => { if (trusted(e)) setSpeakReplies(value === true); });
  ipcMain.on('offgrid:cancel', (e) => { if (trusted(e)) cancelAll(); });
  ipcMain.on('offgrid:confirm', (e, id, allow) => {
    if (!trusted(e)) return;
    pendingConfirms.get(id)?.finish(allow === true);
  });
  ipcMain.on('offgrid:new-chat', (e) => { if (trusted(e)) newChat(); });
  ipcMain.on('offgrid:hide', (e) => { if (trusted(e)) hidePanel(); });
  ipcMain.handle('offgrid:settings', (e, action, payload) => (trusted(e) && typeof action === 'string' ? handleSettings(action, payload) : null));
  ipcMain.handle('offgrid:ping', (e) => (trusted(e) ? ping(config) : false));
  ipcMain.handle('offgrid:log', (e) => (trusted(e) ? readLog(150) : []));
  // Поки користувач записує нове сполучення, чинну гарячу клавішу знімаємо: інакше її натискання
  // почало б розмову замість того, щоб потрапити в поле запису
  ipcMain.on('offgrid:capture-hotkey', (e, on) => {
    if (!trusted(e)) return;
    if (on === true && !turnActive) { hotkeySuspended = true; globalShortcut.unregisterAll(); }
    else if (hotkeySuspended) { hotkeySuspended = false; applyConfig(); }
  });
}

// ---------- Знімок для розробки ----------
async function devScreenshot() {
  showPanel();
  await new Promise((r) => setTimeout(r, 400));
  for (let i = 0; i < 360 && speech?.status === 'starting' && process.env.OFFGRID_SHOT_ASK; i++) await new Promise((r) => setTimeout(r, 500));
  const phrase = process.env.OFFGRID_SHOT_ASK;
  if (phrase) {
    // справжній наскрізний запит: панель -> IPC -> агент -> модель -> панель
    await win.webContents.executeJavaScript(`document.getElementById('input').value = ${JSON.stringify(phrase)}; document.getElementById('form').requestSubmit();`);
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 240 && (turnActive || pendingConfirms.size > 0); i++) await new Promise((r) => setTimeout(r, 500));
  } else if (process.env.OFFGRID_SHOT_VIEW) {
    const [view, tab] = process.env.OFFGRID_SHOT_VIEW.split(':');
    send({ type: 'open-view', view, tab });
    await new Promise((r) => setTimeout(r, Number(process.env.OFFGRID_SHOT_WAIT) || 600));
  } else {
    send({ type: 'demo' });
  }
  await new Promise((r) => setTimeout(r, 400));
  try {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(SHOT, image.toPNG());
  } catch (e) {
    console.error('Знімок не вдався:', e.message);
  }
  quitting = true;
  app.quit();
}

// ---------- Запуск ----------
app.on('second-instance', () => showPanel());
app.on('window-all-closed', () => { /* застосунок живе в треї */ });
app.on('will-quit', () => { globalShortcut.unregisterAll(); resources?.stop(); speech?.stop(); });
// Жодне вікно застосунку не має права щось відкривати чи кудись переходити
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.whenReady().then(() => {
  if (!gotLock) return; // друга копія: перша вже працює, ця лише завершується
  // Панель не ходить у мережу взагалі: дозволені лише власні локальні файли
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = details.url.startsWith('file:') || details.url.startsWith('devtools:');
    cb({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const os = {
    ...nodeOs,
    openPath: async (p) => (await shell.openPath(p)) === '',
    openUrl: async (url) => { try { await shell.openExternal(url); return true; } catch { return false; } },
  };
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
      if (s.status !== 'starting') planGpu();
    },
  });

  resources = new Resources({
    getConfig: () => config,
    isBusy: () => turnActive || !!gpuPlan || !!waking || dialogOpen || quitting,
    release: async () => { await unloadModel(config); await speech?.sleep().catch(() => false); },
    readVram,
    onChange: onSleepChange,
  });

  registerIpc();
  createWindow();
  createTray();
  applyConfig(); // тут же запускається мовний сервіс, якщо голос увімкнено
  if (!SHOT) resources.start();
  if (!SHOT) logAction({ tool: 'app', args: {}, decision: 'auto', ok: true, message: 'Offgrid запущено' });

  win.webContents.once('did-finish-load', () => {
    if (SHOT) devScreenshot(); else showPanel();
  });
});
