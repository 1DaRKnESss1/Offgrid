// Налаштування й білі списки. Користувач редагує data/settings.json.
// Правило: помилка в налаштуваннях ніколи не РОЗШИРЮЄ дозволи. Усе, що не пройшло перевірку,
// відкидається з поясненням; зіпсований файл не повертає типові списки.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, SETTINGS_FILE, DATA_DIR, ROOT } from '../paths.js';
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
// .docx і .pdf читає окремий скрипт (py/doc_text.py), який дістає з них текст
export const READABLE = new Set(['.txt', '.md', '.csv', '.log', '.json', '.xml', '.ini', '.yml', '.yaml', '.docx', '.pdf']);
const CONFIRM_MODES = ['never', 'content', 'tainted', 'always'];
const KNOWN_KEYS = new Set(['model', 'ollamaUrl', 'hotkey', 'dictateHotkey', 'speakReplies', 'followUp', 'wake', 'gpuLayers', 'idleUnloadMinutes', 'yieldToOtherApps', 'speech', 'apps', 'folders', 'fileTypes', 'readableTypes', 'trustedSites', 'confirm']);

const WINDIR = process.env.SystemRoot ?? 'C:\\Windows';

const HOTKEY_KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Tab|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/;
const HOTKEY_MODS = ['Control', 'Alt', 'Shift', 'Super'];
const RESERVED_HOTKEYS = new Set(['Alt+Tab', 'Alt+F4', 'Control+Alt+Tab', 'Alt+Space']);

// Гаряча клавіша: модифікатори без повторів, серед них обов'язково Ctrl, Alt або Win (сам Shift не рахується:
// Shift + A — це просто велика літера, і глобальна клавіша зламала б друк), плюс одна звичайна клавіша.
export function isValidHotkey(hotkey) {
  if (typeof hotkey !== 'string' || hotkey.length > 40) return false;
  const parts = hotkey.split('+');
  const key = parts.pop();
  if (!HOTKEY_KEY.test(key) || parts.length < 1 || parts.length > 3) return false;
  if (new Set(parts).size !== parts.length || !parts.every((m) => HOTKEY_MODS.includes(m))) return false;
  if (!parts.some((m) => m !== 'Shift')) return false;
  return !RESERVED_HOTKEYS.has(hotkey);
}


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
/** Ідентифікатор програми з Microsoft Store: «Видавець.Назва_код!Точка». */
export const isStoreAppId = (id) => typeof id === 'string' && /^[A-Za-z0-9][\w.-]{2,120}_[a-z0-9]{8,20}![\w.-]{1,60}$/.test(id);

/** Ім'я сайту для списку довірених: домен із крапкою, без протоколу, шляху, порту й IP-адрес. */
// Домени, під якими будь-хто може завести власну сторінку: довіряти такому цілком — це довіряти всім.
const SHARED_SITES = new Set(['github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'web.app', 'firebaseapp.com',
  'blogspot.com', 'wordpress.com', 'herokuapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'narod.ru', 'ucoz.ua', 'wixsite.com']);
export const isSiteName = (s) => typeof s === 'string' && s.length <= 100 && /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) && !/^[\d.]+$/.test(s)
  && !/(^|\.)(localhost|local|internal|lan|home|intranet)$/i.test(s)
  && !/^(?:com|co|org|net|gov|edu|ac|in|biz|info|kiev|kyiv|kharkov|kharkiv|lviv|odessa|dp|zp)\.[a-z]{2}$/i.test(s) // «com.ua», «co.uk» — не сайт, а зона
  && !SHARED_SITES.has(s.toLowerCase());

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
  // …і в інший бік: папка, всередині якої лежить домашня папка чи системні (наприклад C:\Users), теж відкриває їх усі
  const holds = (child) => child && isInside(child, real);
  if (holds(os.homedir()) || holds(WINDIR) || holds(process.env.ProgramFiles) || holds(process.env['ProgramFiles(x86)']) || holds(process.env.ProgramData)) {
    return 'у ній лежать системні папки або папка користувача — обери конкретну папку';
  }
  // папка самого асистента, та, що її містить, і папки з його кодом: читати власні програми йому ні до чого
  if (eq(real, ROOT) || isInside(ROOT, real) || ['src', 'shell', 'speech', 'py', 'config', 'scripts'].some((d) => within(path.join(ROOT, d)))) return 'це папка самого асистента';
  if (eq(real, DATA_DIR) || isInside(DATA_DIR, real) || isInside(real, DATA_DIR)) return 'вона містить службові дані асистента';
  return null;
}

const MODEL_NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/i;

// Якісний голос (OmniVoice). Потребує окремого середовища Python, моделі на диску й відеокарти.
// Якщо чогось бракує — тихо лишається простий голос Piper; якщо рушій вимагали явно — з поясненням.
function validateVoice(raw, defaults, warn) {
  const piper = { engine: 'piper' };
  const src = isObject(raw) ? { ...defaults, ...raw } : defaults;
  if (raw !== undefined && !isObject(raw)) warn('speech.voice записано неправильно — використано типові значення');
  if (!isObject(src)) return piper;
  const engine = ['auto', 'piper', 'omnivoice'].includes(src.engine) ? src.engine : 'auto';
  if (src.engine !== undefined && engine !== src.engine) warn('speech.voice.engine: дозволені значення auto, piper, omnivoice');
  if (engine === 'piper') return piper;
  const must = engine === 'omnivoice'; // вимагали явно — тоді про проблему кажемо
  const fail = (why) => { if (must) warn(`Якісний голос недоступний: ${why} — працює простий голос`); return piper; };
  const abs = (p) => (typeof p === 'string' && p.trim() ? path.resolve(ROOT, p) : null);
  const python = abs(src.python);
  if (!python || !/\.exe$/i.test(python) || !DRIVE_PATH.test(python) || !exists(python)) return fail('немає середовища speech\\tts-env');
  const modelDir = abs(src.modelDir);
  if (!modelDir || !DRIVE_PATH.test(modelDir) || !exists(modelDir)) return fail('не знайдено папку з моделлю');
  let prompt = abs(src.prompt);
  if (prompt && (!DRIVE_PATH.test(prompt) || !/\.pt$/i.test(prompt) || !exists(prompt))) prompt = null;
  let instruct = '';
  if (typeof src.instruct === 'string' && /^[\p{L}\p{N} ,.'-]{1,120}$/u.test(src.instruct.trim())) instruct = src.instruct.trim();
  if (!prompt && !instruct) return fail('немає ні відбитка голосу, ні його опису');
  let speed = 1.1;
  if (typeof src.speed === 'number' && src.speed >= 0.5 && src.speed <= 1.5) speed = src.speed;
  else if (src.speed !== undefined) warn('speech.voice.speed: потрібне число від 0.5 до 1.5 — використано 1.1');
  let steps = 16;
  if (Number.isInteger(src.steps) && src.steps >= 4 && src.steps <= 64) steps = src.steps;
  else if (src.steps !== undefined) warn('speech.voice.steps: потрібне ціле число від 4 до 64 — використано 16');
  return { engine: 'omnivoice', python, modelDir, prompt, instruct, speed, steps };
}

// Голос. Якщо щось не так — голос вимикається з поясненням, а текстовий режим працює далі.
function validateSpeech(raw, warn, defaultVoice) {
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
  let device = 'auto';
  if (raw.device !== undefined) {
    if (['auto', 'cpu', 'gpu'].includes(raw.device)) device = raw.device;
    else warn('speech.device: дозволені значення auto, cpu, gpu — використано auto');
  }
  let gpuModel = 'large-v3-turbo';
  if (raw.gpuModel !== undefined) {
    if (typeof raw.gpuModel === 'string' && MODEL_NAME.test(raw.gpuModel)) gpuModel = raw.gpuModel;
    else warn('speech.gpuModel: некоректна назва — використано large-v3-turbo');
  }
  return { enabled: true, python, whisperDir: dir, whisperModel: raw.whisperModel, liveModel, piperVoice: voice, speed, device, gpuModel,
    voice: validateVoice(raw.voice, defaultVoice, warn) };
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

  // клавіша диктування: порожній рядок вимикає її
  cfg.dictateHotkey = typeof defaults.dictateHotkey === 'string' ? defaults.dictateHotkey : '';
  if (raw.dictateHotkey !== undefined) {
    if (raw.dictateHotkey === '' || (typeof raw.dictateHotkey === 'string' && isValidHotkey(raw.dictateHotkey.trim()))) cfg.dictateHotkey = raw.dictateHotkey.trim();
    else warn(`dictateHotkey: «${raw.dictateHotkey}» не годиться — використано ${cfg.dictateHotkey || 'без клавіші'}`);
  }
  cfg.hotkey = defaults.hotkey;
  if (raw.hotkey !== undefined) {
    if (typeof raw.hotkey === 'string' && isValidHotkey(raw.hotkey.trim())) cfg.hotkey = raw.hotkey.trim();
    else warn(`hotkey: «${raw.hotkey}» не годиться — потрібне сполучення з Ctrl, Alt або Win і однієї клавіші; використано ${defaults.hotkey}`);
  }
  cfg.speakReplies = typeof raw.speakReplies === 'boolean' ? raw.speakReplies : defaults.speakReplies;
  // після відповіді голосом кілька секунд слухати продовження без клавіші
  cfg.followUp = typeof raw.followUp === 'boolean' ? raw.followUp : defaults.followUp === true;
  // голос — не білий список: якщо розділу в файлі користувача немає, беремо типовий
  // Відгук на ім'я: мікрофон слухає постійно, розмова починається, коли хтось назве асистента.
  // За замовчуванням вимкнено: вмикати це має сам користувач.
  const NAME = /^[\p{L}\p{N}][\p{L}\p{N} '’-]{1,23}$/u;
  const w = isObject(raw.wake) ? raw.wake : {};
  if (raw.wake !== undefined && !isObject(raw.wake)) warn('wake записано неправильно — відгук на ім\'я вимкнено');
  cfg.wake = { enabled: w.enabled === true, name: defaults.wake?.name ?? 'Офгрід', aliases: [] };
  if (w.name !== undefined) {
    if (typeof w.name === 'string' && NAME.test(w.name.trim()) && w.name.replace(/[^\p{L}\p{N}]/gu, '').length >= 3) cfg.wake.name = w.name.trim();
    else { warn('wake.name: ім\'я має бути словом із 3–24 літер — відгук на ім\'я вимкнено'); cfg.wake.enabled = false; }
  }
  for (const alias of Array.isArray(w.aliases) ? w.aliases.slice(0, 6) : (w.aliases === undefined ? defaults.wake?.aliases ?? [] : [])) {
    if (typeof alias === 'string' && NAME.test(alias.trim())) cfg.wake.aliases.push(alias.trim());
  }
  // скільки шарів моделі класти на відеокарту: "auto" — підібрати під вільну відеопам'ять, або число 0–99
  cfg.gpuLayers = 'auto';
  if (raw.gpuLayers !== undefined && raw.gpuLayers !== 'auto') {
    if (Number.isInteger(raw.gpuLayers) && raw.gpuLayers >= 0 && raw.gpuLayers <= 99) cfg.gpuLayers = raw.gpuLayers;
    else warn('gpuLayers: потрібне "auto" або ціле число від 0 до 99 — використано "auto"');
  }
  // через скільки хвилин без команд звільняти пам'ять (0 — ніколи)
  cfg.idleUnloadMinutes = defaults.idleUnloadMinutes ?? 5;
  if (raw.idleUnloadMinutes !== undefined) {
    if (Number.isInteger(raw.idleUnloadMinutes) && raw.idleUnloadMinutes >= 0 && raw.idleUnloadMinutes <= 240) cfg.idleUnloadMinutes = raw.idleUnloadMinutes;
    else warn('idleUnloadMinutes: потрібне ціле число хвилин від 0 до 240 (0 — не звільняти)');
  }
  // звільняти відеопам'ять, коли її бракує іншій програмі (наприклад, запущено гру)
  cfg.yieldToOtherApps = typeof raw.yieldToOtherApps === 'boolean' ? raw.yieldToOtherApps : defaults.yieldToOtherApps !== false;
  cfg.speech = validateSpeech(raw.speech === undefined ? defaults.speech : raw.speech, warn, defaults.speech?.voice);
  // ім'я підказує розпізнаванню, як його писати (навіть коли відгук на ім'я вимкнено — у розмові його теж називають)
  if (cfg.speech.enabled) cfg.speech.wakeName = cfg.wake.name;

  // Білі списки: якщо розділу немає або він не того типу — список ПОРОЖНІЙ, а не типовий
  const section = (key, check, empty) => {
    if (raw[key] === undefined) { warn(`У налаштуваннях немає розділу «${key}» — цей список порожній`); return empty; }
    if (!check(raw[key])) { warn(`Розділ «${key}» записано неправильно — цей список порожній`); return empty; }
    return raw[key];
  };

  // Довірені сайти: їх асистент відкриває без запиту навіть у «забрудненій» розмові. Лише звичайні імена сайтів.
  cfg.trustedSites = [];
  if (raw.trustedSites !== undefined) {
    if (!Array.isArray(raw.trustedSites)) warn('trustedSites має бути списком адрес сайтів — список довірених порожній');
    else for (const site of raw.trustedSites.slice(0, 100)) {
      if (isSiteName(site)) { if (!cfg.trustedSites.includes(site.toLowerCase())) cfg.trustedSites.push(site.toLowerCase()); }
      else warn(`Довірений сайт «${String(site).slice(0, 60)}»: потрібна адреса на кшталт youtube.com, без https:// і шляху`);
    }
  }

  cfg.apps = {};
  for (const [key, a] of Object.entries(section('apps', isObject, {}))) {
    if (!KEY_RE.test(key)) { warn(`Програма «${key}»: ключ має бути латиницею (a-z, 0-9, _)`); continue; }
    // Програма з Microsoft Store не має файлу, який можна вказати: її запускає Windows за ідентифікатором.
    // Ідентифікатор — лише літери, цифри, крапки, дефіси й один «!»: жодних шляхів, пробілів чи аргументів.
    if (a?.appId !== undefined) {
      if (!isStoreAppId(a.appId) || a.exe !== undefined) { warn(`Програма «${key}»: appId записано неправильно (і разом з exe його вказувати не можна)`); continue; }
      cfg.apps[key] = { name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 40) : key, appId: a.appId };
      continue;
    }
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
  cfg.readableTypes = exts('readableTypes', READABLE, 'не можна читати — лише текстові формати, Word (.docx) і PDF');

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
  const ok = (['speakReplies', 'followUp', 'yieldToOtherApps'].includes(key) && typeof value === 'boolean')
    || (key === 'idleUnloadMinutes' && Number.isInteger(value) && value >= 0 && value <= 240);
  if (!ok) return false;
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
