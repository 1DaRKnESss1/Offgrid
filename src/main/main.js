// Головний процес Offgrid: трей, панель, гаряча клавіша, зв'язок панелі з агентом.
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, shell, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA_DIR, ELECTRON_DATA, SETTINGS_FILE, LOG_FILE, NOTES_DIR } from '../paths.js';
import { loadConfig, saveSetting } from '../security/config.js';
import { TOOL_MODES } from '../security/policy.js';
import { logAction } from '../security/log.js';
import { Agent } from '../agent/agent.js';
import { ping } from '../agent/ollama.js';
import { nodeOs } from '../tools/util.js';
import { Speech } from '../speech/client.js';
import { iconPng } from './icon.js';

const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).toString();
const PRELOAD = path.join(ROOT, 'src', 'preload', 'preload.cjs');
const WIDTH = 400, HEIGHT = 540, MARGIN = 12;
const CONFIRM_TIMEOUT_MS = 60_000;
const AUTO_HIDE_MS = 9_000;
const ERROR_SHOWN_MS = 5_000;
const FALLBACK_HOTKEYS = ['Control+Shift+Space', 'Alt+Shift+Space', 'Control+Alt+O'];
const SHOT = process.env.OFFGRID_SHOT; // лише для розробки: зберегти знімок панелі й вийти

// Службові дані Electron теж тримаємо всередині проєкту, а не в %APPDATA%
fs.mkdirSync(ELECTRON_DATA, { recursive: true });
app.setPath('userData', ELECTRON_DATA);
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
let turnCancelled = false; // користувач зупинив поточний хід (Esc, ■, «Нова розмова»)
let speech = null;
let speechConfigKey = '';
const pendingConfirms = new Map();

const STATE_LABELS = {
  idle: 'Очікує', listening: 'Слухає', thinking: 'Думає', executing: 'Виконує',
  confirming: 'Чекає дозволу', speaking: 'Говорить', error: 'Помилка',
};

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
    tray.setToolTip(`Offgrid — ${STATE_LABELS[state].toLowerCase()}`);
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
  if (state === 'listening') speech.stopListening();
  else if (state === 'speaking') speech.cancel();
  else if (turnActive) showPanel({ focus: false });
  else if (speech?.ready) startListening();
  else togglePanel();
}

// Панель, показана без фокусу (відповідь прийшла, поки ти працюєш в іншому вікні), згодом ховається сама
function scheduleAutoHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (win?.isVisible() && !win.isFocused() && (state === 'idle' || state === 'error') && pendingConfirms.size === 0) win.hide();
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
    if ((state === 'idle' || state === 'error') && pendingConfirms.size === 0 && !SHOT) hidePanel();
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
  if (speech && (key !== speechConfigKey || (announce && speech.status === 'failed'))) { speechConfigKey = key; speech.start(config.speech); }
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
    { label: 'Озвучувати відповіді', type: 'checkbox', checked: !!config?.speakReplies, enabled: !!config?.speech?.enabled, click: (item) => setSpeakReplies(item.checked) },
    { type: 'separator' },
    { label: 'Відкрити налаштування (settings.json)', click: () => shell.openPath(SETTINGS_FILE) },
    { label: 'Перечитати налаштування', click: () => { applyConfig({ announce: true }); showPanel(); } },
    { label: 'Відкрити журнал дій', click: () => (fs.existsSync(LOG_FILE) ? shell.openPath(LOG_FILE) : shell.openPath(DATA_DIR)) },
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
  if (quitting || !win || win.isDestroyed()) return; // застосунок уже закривається
  send({ type: 'busy', value: false });
  if (state !== 'error') setState('idle');
  if (!win.isFocused()) { showPanel({ focus: false }); scheduleAutoHide(); }
}

function setSpeakReplies(value) {
  config.speakReplies = value === true;
  if (!saveSetting('speakReplies', config.speakReplies)) send({ type: 'notice', text: 'Не вдалося зберегти налаштування озвучення — воно діятиме до перезапуску.' });
  if (!config.speakReplies && state === 'speaking') speech?.cancel();
  send({ type: 'speak-setting', value: config.speakReplies });
  rebuildTrayMenu();
}

// Один хід розмови: запит до моделі, відповідь у панель і (якщо ввімкнено) голосом
async function runTurn(text) {
  const generation = agent.generation;
  const current = () => generation === agent.generation; // false, якщо посеред ходу почали нову розмову
  try {
    const reply = await agent.ask(text);
    if (!current()) return;
    send({ type: 'assistant', text: reply });
    if (config.speakReplies && speech?.ready && !turnCancelled && !SHOT) { // у режимі знімка для розробки мовчимо
      setState('speaking');
      try { await speech.speak(reply); } catch (e) { if (current()) send({ type: 'notice', text: `Не вдалося озвучити: ${e.message}` }); }
    }
  } catch (e) {
    denyAllConfirms();
    if (!current()) return;
    if (e.message === 'Скасовано') send({ type: 'stopped' }); else showError(e.message);
  } finally {
    endTurn();
  }
}

function startTextTurn(text) {
  if (turnActive) { send({ type: 'soft', text: 'Зачекай, я ще виконую попередній запит.' }); return; }
  turnActive = true;
  turnCancelled = false;
  send({ type: 'busy', value: true });
  runTurn(text);
}

// Голосовий хід: слухаємо до паузи, показуємо текст наживо, далі — як звичайний запит
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
  setState('listening');
  showPanel({ focus: false });
  const generation = agent.generation;
  let heard;
  try {
    heard = await speech.listen((event) => {
      if (event.type === 'partial') send({ type: 'partial', text: event.text });
      else if (event.type === 'speech') send({ type: 'partial', text: '' });
      else if (event.type === 'recognizing') setState('thinking');
    });
  } catch (e) {
    send({ type: 'partial-end' });
    showError(e.message);
    endTurn();
    return;
  }
  send({ type: 'partial-end' });
  // turnCancelled ловить і скасування, що прийшло в останню мить, коли текст уже розпізнано
  if (generation !== agent.generation || turnCancelled || heard.cancelled || !heard.text) {
    if (generation === agent.generation && !turnCancelled && !heard.cancelled) send({ type: 'soft', text: 'Нічого не почув.' });
    endTurn();
    return;
  }
  send({ type: 'user', text: heard.text });
  await runTurn(heard.text);
}

// Приймаємо повідомлення лише від власної сторінки панелі
const trusted = (event) => event.senderFrame?.url === INDEX_URL && event.sender === win?.webContents;

function registerIpc() {
  ipcMain.handle('offgrid:ready', async (e) => {
    if (!trusted(e)) return null;
    const ollama = await ping(config); // спершу чекаємо, потім збираємо знімок стану — інакше він застаріє
    return {
      state, busy: turnActive, hotkey: activeHotkey, model: config.model, warnings, speakReplies: config.speakReplies,
      voice: { status: speech?.status ?? 'off', error: speech?.error ?? null }, ollama,
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
}

// ---------- Знімок для розробки ----------
async function devScreenshot() {
  showPanel();
  await new Promise((r) => setTimeout(r, 400));
  for (let i = 0; i < 360 && speech?.status === 'starting'; i++) await new Promise((r) => setTimeout(r, 500));
  const phrase = process.env.OFFGRID_SHOT_ASK;
  if (phrase) {
    // справжній наскрізний запит: панель -> IPC -> агент -> модель -> панель
    await win.webContents.executeJavaScript(`document.getElementById('input').value = ${JSON.stringify(phrase)}; document.getElementById('form').requestSubmit();`);
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 240 && (turnActive || pendingConfirms.size > 0); i++) await new Promise((r) => setTimeout(r, 500));
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
app.on('will-quit', () => { globalShortcut.unregisterAll(); speech?.stop(); });
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
      if (event.type === 'state') { if (pendingConfirms.size === 0) setState(event.state); } else send(event);
    },
  });

  speech = new Speech({ onStatus: (s) => { send({ type: 'voice', status: s.status, error: s.error }); } });

  registerIpc();
  createWindow();
  createTray();
  applyConfig(); // тут же запускається мовний сервіс, якщо голос увімкнено
  logAction({ tool: 'app', args: {}, decision: 'auto', ok: true, message: 'Offgrid запущено' });

  win.webContents.once('did-finish-load', () => {
    if (SHOT) devScreenshot(); else showPanel();
  });
});
