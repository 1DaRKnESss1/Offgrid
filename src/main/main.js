// Головний процес Offgrid: трей, панель, гаряча клавіша, зв'язок панелі з агентом.
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, shell, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA_DIR, ELECTRON_DATA, SETTINGS_FILE, LOG_FILE, NOTES_DIR } from '../paths.js';
import { loadConfig } from '../security/config.js';
import { logAction } from '../security/log.js';
import { Agent } from '../agent/agent.js';
import { ping } from '../agent/ollama.js';
import { nodeOs } from '../tools/util.js';
import { iconPng } from './icon.js';

const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).toString();
const PRELOAD = path.join(ROOT, 'src', 'preload', 'preload.cjs');
const WIDTH = 400, HEIGHT = 540, MARGIN = 12;
const CONFIRM_TIMEOUT_MS = 60_000;
const AUTO_HIDE_MS = 9_000;
const FALLBACK_HOTKEYS = ['Control+Shift+Space', 'Alt+Shift+Space', 'Control+Alt+O'];
const SHOT = process.env.OFFGRID_SHOT; // лише для розробки: зберегти знімок панелі й вийти

// Службові дані Electron теж тримаємо всередині проєкту, а не в %APPDATA%
fs.mkdirSync(ELECTRON_DATA, { recursive: true });
app.setPath('userData', ELECTRON_DATA);
// Відеопам'яті впритул через модель — панель малюється на процесорі
if (!SHOT) app.disableHardwareAcceleration();
app.setAppUserModelId('local.offgrid.assistant');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null, tray = null, agent = null;
let config = null, warnings = [];
let state = 'idle';
let hideTimer = null;
let activeHotkey = null;
let quitting = false;
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

// Панель, показана без фокусу (відповідь прийшла, поки ти працюєш в іншому вікні), згодом ховається сама
function scheduleAutoHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (win?.isVisible() && !win.isFocused() && state === 'idle' && pendingConfirms.size === 0) win.hide();
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
    if (state === 'idle' && pendingConfirms.size === 0 && !SHOT) hidePanel();
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
  const loaded = loadConfig();
  config = loaded.config;
  warnings = loaded.warnings;
  agent?.setConfig(config);

  // Якщо обрана клавіша зайнята іншою програмою, беремо першу вільну із запасних і чесно про це кажемо
  globalShortcut.unregisterAll();
  activeHotkey = null;
  for (const key of [config.hotkey, ...FALLBACK_HOTKEYS.filter((k) => k !== config.hotkey)]) {
    let ok = false;
    try { ok = globalShortcut.register(key, togglePanel); } catch { ok = false; }
    if (ok) { activeHotkey = key; break; }
  }
  if (!activeHotkey) warnings.push(`Гарячу клавішу «${config.hotkey}» не вдалося зареєструвати. Відкривай панель клацанням по іконці в треї або зміни hotkey у налаштуваннях`);
  else if (activeHotkey !== config.hotkey) warnings.push(`Клавіша «${config.hotkey}» зайнята іншою програмою, тому зараз працює «${activeHotkey}». Змінити можна в налаштуваннях (hotkey)`);

  // при старті панель сама забирає це через offgrid:ready
  if (announce) {
    send({ type: 'notice', text: warnings.length ? 'Налаштування перечитано, є зауваги:' : 'Налаштування перечитано.' });
    send({ type: 'config', hotkey: activeHotkey, model: config.model, warnings });
  }
}

// ---------- Трей ----------
function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(iconPng('idle'), { scaleFactor: 2 }));
  tray.setToolTip('Offgrid — очікує');
  tray.on('click', togglePanel);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Показати панель', click: () => showPanel() },
    { label: 'Нова розмова', click: () => newChat() },
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
  agent.cancel();
  denyAllConfirms();
  agent.reset();
  send({ type: 'reset' });
  if (state === 'error') setState('idle');
}

async function handleAsk(text) {
  if (agent.busy) return { ok: false, error: 'Зачекай, я ще виконую попередній запит.' };
  try {
    const reply = await agent.ask(text);
    setState('idle');
    if (!win.isFocused()) { showPanel({ focus: false }); scheduleAutoHide(); }
    return { ok: true, text: reply };
  } catch (e) {
    denyAllConfirms();
    if (e.message === 'Скасовано') { setState('idle'); return { ok: false, cancelled: true }; }
    setState('error');
    return { ok: false, error: e.message };
  }
}

// Приймаємо повідомлення лише від власної сторінки панелі
const trusted = (event) => event.senderFrame?.url === INDEX_URL && event.sender === win?.webContents;

function registerIpc() {
  ipcMain.handle('offgrid:ready', async (e) => {
    if (!trusted(e)) return null;
    return { state, hotkey: activeHotkey, model: config.model, warnings, ollama: await ping(config) };
  });
  ipcMain.handle('offgrid:ask', (e, text) => {
    if (!trusted(e) || typeof text !== 'string') return { ok: false, error: 'Некоректний запит' };
    return handleAsk(text);
  });
  ipcMain.on('offgrid:cancel', (e) => { if (trusted(e)) { agent.cancel(); denyAllConfirms(); } });
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
  const phrase = process.env.OFFGRID_SHOT_ASK;
  if (phrase) {
    // справжній наскрізний запит: панель -> IPC -> агент -> модель -> панель
    await win.webContents.executeJavaScript(`document.getElementById('input').value = ${JSON.stringify(phrase)}; document.getElementById('form').requestSubmit();`);
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 240 && (agent.busy || pendingConfirms.size > 0); i++) await new Promise((r) => setTimeout(r, 500));
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
app.on('will-quit', () => globalShortcut.unregisterAll());
// Жодне вікно застосунку не має права щось відкривати чи кудись переходити
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.whenReady().then(() => {
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
  const loaded = loadConfig();
  config = loaded.config;
  agent = new Agent({
    config,
    os,
    confirm: askConfirm,
    emit: (event) => {
      if (event.type === 'state') { if (pendingConfirms.size === 0) setState(event.state); } else send(event);
    },
  });

  registerIpc();
  createWindow();
  createTray();
  applyConfig();
  logAction({ tool: 'app', args: {}, decision: 'auto', ok: true, message: 'Offgrid запущено' });

  win.webContents.once('did-finish-load', () => {
    if (SHOT) devScreenshot(); else showPanel();
  });
});
