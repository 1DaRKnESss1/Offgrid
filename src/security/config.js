// Налаштування й білі списки. Користувач редагує data/settings.json.
// Правило: помилка в налаштуваннях ніколи не РОЗШИРЮЄ дозволи. Усе, що не пройшло перевірку,
// відкидається з поясненням; зіпсований файл не повертає типові списки.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, SETTINGS_FILE, DATA_DIR } from '../paths.js';
import { isInside } from './pathguard.js';

const KEY_RE = /^[a-z][a-z0-9_]{0,30}$/;
const DRIVE_PATH = /^[a-zA-Z]:\\/;
// Відкривати можна лише типи з цього переліку: документи, зображення, звук, відео, простий текст.
// Це «білий» перелік: усе інше (програми, скрипти, ярлики, веб-сторінки, архіви) дозволити не можна.
export const FILE_TYPE_GROUPS = [
  { title: 'Документи', types: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.epub', '.djvu'] },
  { title: 'Текст', types: ['.txt', '.md', '.csv', '.log', '.json', '.xml', '.ini', '.yml', '.yaml'] },
  { title: 'Зображення', types: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic'] },
  { title: 'Звук', types: ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac'] },
  { title: 'Відео', types: ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv'] },
];
export const OPENABLE = new Set(FILE_TYPE_GROUPS.flatMap((g) => g.types));
// Читати вміст можна лише з простих текстових форматів
export const READABLE = new Set(['.txt', '.md', '.csv', '.log', '.json', '.xml', '.ini', '.yml', '.yaml']);
const CONFIRM_MODES = ['never', 'content', 'tainted', 'always'];
const KNOWN_KEYS = new Set(['model', 'ollamaUrl', 'hotkey', 'speakReplies', 'speech', 'apps', 'folders', 'fileTypes', 'readableTypes', 'confirm']);

const WINDIR = process.env.SystemRoot ?? 'C:\\Windows';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// "~/Desktop" -> реальна папка користувача (з урахуванням перенесення в OneDrive)
export function expandFolder(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    const rest = p.slice(2);
    if (!rest.trim()) return null;
    const candidates = [path.join(os.homedir(), rest), path.join(os.homedir(), 'OneDrive', rest)];
    return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
  }
  return /^[a-zA-Z]:[\\/]/.test(p) ? path.resolve(p) : null;
}

function isLoopbackUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' && !url.username && !url.password && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// Назва .exe -> повний шлях. Поточну папку не переглядаємо ніколи: інакше підкинутий туди calc.exe
// запустився б замість справжнього.
export function resolveExe(exe) {
  if (typeof exe !== 'string' || !/\.exe$/i.test(exe) || /["<>|*?\r\n]/.test(exe)) return null;
  if (DRIVE_PATH.test(exe)) return exists(exe) ? path.resolve(exe) : null;
  if (!/^[\w.-]+\.exe$/i.test(exe)) return null; // без відносних шляхів і аргументів
  const dirs = [path.join(WINDIR, 'System32'), WINDIR, ...String(process.env.PATH ?? '').split(';')];
  for (const dir of dirs) {
    if (!DRIVE_PATH.test(dir)) continue;
    const candidate = path.join(dir, exe);
    if (exists(candidate)) return candidate;
  }
  return null;
}

// Папки, які не можна дозволяти цілком: там система, програми й чужі секрети
function forbiddenFolder(real) {
  const eq = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const within = (parent) => parent && (eq(real, parent) || isInside(real, parent));
  if (path.parse(real).root.toLowerCase() === real.toLowerCase()) return 'корінь диска цілком дозволяти не можна';
  if (eq(real, os.homedir())) return 'усю папку користувача дозволяти не можна — обери конкретну папку в ній';
  if (within(WINDIR) || within(process.env.ProgramFiles) || within(process.env['ProgramFiles(x86)']) || within(process.env.ProgramData)
    || within(path.join(os.homedir(), 'AppData'))) return 'системні папки дозволяти не можна';
  if (eq(real, DATA_DIR) || isInside(DATA_DIR, real) || isInside(real, DATA_DIR)) return 'вона містить службові дані асистента';
  return null;
}

const MODEL_NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/i;

// Голос. Якщо щось не так — голос вимикається з поясненням, а текстовий режим працює далі.
function validateSpeech(raw, warn) {
  const off = { enabled: false };
  if (raw === undefined) return off;
  if (!isObject(raw)) { warn('Розділ «speech» записано неправильно — голос вимкнено'); return off; }
  if (raw.enabled === false) return off;
  const python = resolveExe(raw.python);
  if (!python) { warn(`speech.python: «${raw.python}» не знайдено — голос вимкнено`); return off; }
  const dir = typeof raw.whisperDir === 'string' && DRIVE_PATH.test(path.resolve(raw.whisperDir)) ? path.resolve(raw.whisperDir) : null;
  if (!dir || !fs.existsSync(dir)) { warn(`speech.whisperDir: папку «${raw.whisperDir}» не знайдено — голос вимкнено`); return off; }
  const voice = typeof raw.piperVoice === 'string' && DRIVE_PATH.test(path.resolve(raw.piperVoice)) && /\.onnx$/i.test(raw.piperVoice)
    ? path.resolve(raw.piperVoice) : null;
  if (!voice || !fs.existsSync(voice)) { warn(`speech.piperVoice: файл голосу «${raw.piperVoice}» не знайдено — голос вимкнено`); return off; }
  if (typeof raw.whisperModel !== 'string' || !MODEL_NAME.test(raw.whisperModel)) { warn('speech.whisperModel: потрібна назва моделі, наприклад medium — голос вимкнено'); return off; }
  let liveModel = '';
  if (typeof raw.liveModel === 'string' && raw.liveModel) {
    if (MODEL_NAME.test(raw.liveModel)) liveModel = raw.liveModel;
    else warn('speech.liveModel: некоректна назва — текст наживо вимкнено');
  }
  let speed = 1.0;
  if (raw.speed !== undefined) {
    if (typeof raw.speed === 'number' && raw.speed >= 0.5 && raw.speed <= 2) speed = raw.speed;
    else warn('speech.speed: потрібне число від 0.5 до 2 — використано 1.0');
  }
  return { enabled: true, python, whisperDir: dir, whisperModel: raw.whisperModel, liveModel, piperVoice: voice, speed };
}

/**
 * Перевіряє сирі налаштування. Повертає { config, warnings }.
 * toolModes — { назва інструмента: типовий режим підтвердження } для перевірки розділу confirm.
 */
export function validateConfig(raw, defaults, toolModes = null) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const cfg = {};
  if (!isObject(raw)) raw = {};

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warn(`Невідомий параметр «${key}» — перевір, чи немає одруківки`);
  }

  cfg.model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : defaults.model;

  cfg.ollamaUrl = defaults.ollamaUrl;
  if (raw.ollamaUrl !== undefined) {
    if (isLoopbackUrl(raw.ollamaUrl)) cfg.ollamaUrl = String(raw.ollamaUrl).replace(/\/+$/, '');
    else warn(`ollamaUrl «${raw.ollamaUrl}» не локальна адреса — використано ${defaults.ollamaUrl}`);
  }

  cfg.hotkey = typeof raw.hotkey === 'string' && raw.hotkey.trim() ? raw.hotkey.trim() : defaults.hotkey;
  cfg.speakReplies = typeof raw.speakReplies === 'boolean' ? raw.speakReplies : defaults.speakReplies;
  // голос — не білий список: якщо розділу в файлі користувача немає, беремо типовий
  cfg.speech = validateSpeech(raw.speech === undefined ? defaults.speech : raw.speech, warn);

  // Білі списки: якщо розділу немає або він не того типу — список ПОРОЖНІЙ, а не типовий
  const section = (key, check, empty) => {
    if (raw[key] === undefined) { warn(`У налаштуваннях немає розділу «${key}» — цей список порожній`); return empty; }
    if (!check(raw[key])) { warn(`Розділ «${key}» записано неправильно — цей список порожній`); return empty; }
    return raw[key];
  };

  cfg.apps = {};
  for (const [key, a] of Object.entries(section('apps', isObject, {}))) {
    if (!KEY_RE.test(key)) { warn(`Програма «${key}»: ключ має бути латиницею (a-z, 0-9, _)`); continue; }
    const exe = resolveExe(a?.exe);
    if (!exe) { warn(`Програма «${key}»: «${a?.exe}» не знайдено. Потрібна назва .exe із системних папок або повний шлях, без аргументів`); continue; }
    const app = { name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 40) : key, exe };
    if (a.process !== undefined) {
      if (typeof a.process === 'string' && /^[\w.-]+\.exe$/i.test(a.process)) app.process = a.process;
      else warn(`Програма «${key}»: process має бути назвою процесу на кшталт Notepad.exe — закривати її не можна буде`);
    }
    cfg.apps[key] = app;
  }

  cfg.folders = {};
  for (const [key, f] of Object.entries(section('folders', isObject, {}))) {
    if (!KEY_RE.test(key)) { warn(`Папка «${key}»: ключ має бути латиницею (a-z, 0-9, _)`); continue; }
    const full = expandFolder(f?.path);
    if (!full) { warn(`Папка «${key}»: шлях має починатися з літери диска або з ~/`); continue; }
    let real;
    try {
      real = fs.realpathSync(full);
      if (!fs.statSync(real).isDirectory()) throw new Error();
    } catch { warn(`Папка «${key}»: ${full} не існує — пропущено`); continue; }
    if (!DRIVE_PATH.test(real)) { warn(`Папка «${key}»: мережеві папки не підтримуються`); continue; }
    const why = forbiddenFolder(real);
    if (why) { warn(`Папка «${key}»: ${why} — пропущено`); continue; }
    cfg.folders[key] = { name: typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 40) : key, path: real };
  }

  const exts = (key, allowedSet, what) => {
    const out = new Set();
    for (const e of section(key, Array.isArray, [])) {
      const ext = String(e).toLowerCase();
      if (allowedSet.has(ext)) out.add(ext);
      else warn(`${key}: «${e}» ${what}`);
    }
    return out;
  };
  cfg.fileTypes = exts('fileTypes', OPENABLE, 'не можна дозволити — дозволяються лише документи, зображення, звук і відео');
  cfg.readableTypes = exts('readableTypes', READABLE, 'не можна читати — лише прості текстові формати');

  cfg.confirm = {};
  if (raw.confirm !== undefined && !isObject(raw.confirm)) warn('Розділ «confirm» записано неправильно — його проігноровано');
  for (const [tool, mode] of Object.entries(isObject(raw.confirm) ? raw.confirm : {})) {
    if (!CONFIRM_MODES.includes(mode)) { warn(`confirm.${tool}: дозволені значення — ${CONFIRM_MODES.join(', ')}`); continue; }
    if (toolModes) {
      if (!Object.hasOwn(toolModes, tool)) { warn(`confirm.${tool}: такого інструмента немає — перевір назву`); continue; }
      if (CONFIRM_MODES.indexOf(mode) < CONFIRM_MODES.indexOf(toolModes[tool])) {
        warn(`confirm.${tool}: «${mode}» слабше за типове «${toolModes[tool]}» — підтвердження можна лише посилювати`);
        continue;
      }
    }
    cfg.confirm[tool] = mode;
  }
  return { config: cfg, warnings };
}

/** Змінює один простий параметр у settings.json, не чіпаючи решти (для вимикача озвучення в панелі). */
export function saveSetting(key, value) {
  if (key !== 'speakReplies' || typeof value !== 'boolean') return false;
  try {
    const raw = readJson(SETTINGS_FILE);
    if (!isObject(raw)) return false;
    raw[key] = value;
    // спершу тимчасовий файл, потім заміна: обірваний запис не залишить зіпсованих налаштувань
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, SETTINGS_FILE);
    return true;
  } catch { return false; }
}

/**
 * Читає налаштування; при першому запуску створює data/settings.json з типових.
 * Якщо файл зіпсовано: лишаємо попередні чинні налаштування (previous), а на старті — порожні білі списки.
 */
export function loadConfig({ previous = null, toolModes = null } = {}) {
  const defaults = readJson(DEFAULT_CONFIG);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_FILE)) fs.copyFileSync(DEFAULT_CONFIG, SETTINGS_FILE);

  let raw;
  try {
    raw = readJson(SETTINGS_FILE);
    if (!isObject(raw)) throw new Error('очікується об\'єкт у фігурних дужках');
  } catch (e) {
    const problem = `settings.json не читається (${e.message})`;
    if (previous) return { config: previous, warnings: [`${problem} — залишено попередні налаштування`] };
    const safe = validateConfig({ apps: {}, folders: {}, fileTypes: [], readableTypes: [] }, defaults, toolModes);
    return { config: safe.config, warnings: [`${problem} — білі списки порожні, доки файл не виправлено`] };
  }
  return validateConfig(raw, defaults, toolModes);
}
