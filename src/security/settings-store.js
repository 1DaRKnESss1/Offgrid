// Зміна налаштувань із панелі. Кожна зміна:
//   1) читає data/settings.json, 2) вносить ОДНУ правку, 3) проганяє результат через ту саму перевірку,
//   що й при запуску (validateConfig), 4) записує файл лише якщо правку прийнято.
// Так через панель неможливо дозволити те, що не можна дозволити вручну.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, SETTINGS_FILE } from '../paths.js';
import { validateConfig, resolveExe, expandFolder, isValidHotkey, FILE_TYPE_GROUPS, OPENABLE, READABLE } from './config.js';

const KEY_RE = /^[a-z][a-z0-9_]{0,30}$/;
const MAX_ITEMS = 60;
const MISSING = 'Файл settings.json зник. Натисни «Перечитати налаштування» в меню іконки в треї — він створиться знову.';
const BROKEN = 'Файл settings.json зіпсовано. Виправ його вручну: меню іконки в треї → «Відкрити налаштування».';
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const own = (obj, key) => typeof key === 'string' && isObject(obj) && Object.hasOwn(obj, key);

function readRaw() {
  if (!fs.existsSync(SETTINGS_FILE)) throw new Error('missing');
  const raw = readJson(SETTINGS_FILE);
  if (!isObject(raw)) throw new Error('not an object');
  return raw;
}

function writeRaw(raw) {
  // спершу тимчасовий файл, потім заміна: обірваний запис не залишить зіпсованих налаштувань
  const tmp = SETTINGS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* нічого прибирати */ }
    throw new Error('Не вдалося записати settings.json — можливо, файл лише для читання або відкритий в іншій програмі.');
  }
}

function cleanName(name, fallback) {
  const n = typeof name === 'string' ? name.replace(/[\x00-\x1f]/g, '').trim().slice(0, 40) : '';
  return n || fallback;
}

// Назва -> ключ латиницею, унікальний у межах розділу
function makeKey(name, taken, fallback) {
  let base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '').slice(0, 24);
  if (!KEY_RE.test(base)) base = fallback;
  let key = base;
  for (let i = 2; own(taken, key); i++) key = `${base}_${i}`;
  return key;
}

function section(raw, name, kind) {
  if (raw[name] === undefined) raw[name] = kind === 'list' ? [] : {};
  const okType = kind === 'list' ? Array.isArray(raw[name]) : isObject(raw[name]);
  if (!okType) throw new Error(`Розділ «${name}» у settings.json записано неправильно — виправ його вручну.`);
  return raw[name];
}

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Чи прийняла перевірка щойно додане? Якщо ні — повертаємо її пояснення.
const accepted = (kind, key) => (config, warnings) => (Object.hasOwn(config[kind], key)
  ? null
  : (warnings.find((w) => w.includes(`«${key}»`)) ?? 'Перевірка не прийняла цей запис.').replace(`«${key}»: `, ''));

/** Правки. Кожна змінює raw і може повернути функцію перевірки результату. Помилки — через throw. */
export const changes = {
  addApp(raw, { exe }) {
    if (typeof exe !== 'string' || !/\.exe$/i.test(exe)) throw new Error('Потрібен файл програми з розширенням .exe');
    const apps = section(raw, 'apps', 'map');
    if (Object.keys(apps).length >= MAX_ITEMS) throw new Error('Забагато програм у списку');
    if (Object.values(apps).some((a) => samePath(resolveExe(a?.exe) ?? a?.exe, exe))) throw new Error('Ця програма вже є у списку');
    const base = path.basename(exe);
    const key = makeKey(base.replace(/\.exe$/i, ''), apps, 'app');
    apps[key] = { name: cleanName(base.replace(/\.exe$/i, ''), key), exe: path.resolve(exe) };
    return accepted('apps', key);
  },
  updateApp(raw, { key, name, closable }) {
    const apps = section(raw, 'apps', 'map');
    if (!own(apps, key) || !isObject(apps[key])) throw new Error('Такої програми немає у списку');
    const app = apps[key];
    if (name !== undefined) app.name = cleanName(name, key);
    if (closable === true) {
      if (typeof app.exe !== 'string') throw new Error('У цієї програми не вказано файл');
      if (!app.process) app.process = path.basename(app.exe);
      // назву процесу з пробілом чи іншими незвичними знаками перевірка відкине — тоді нічого не записуємо
      return (config) => (config.apps[key]?.process ? null : 'Цю програму асистент закривати не зможе: назва її файлу містить незвичні символи.');
    }
    if (closable === false) delete app.process;
    return null;
  },
  removeApp(raw, { key }) {
    const apps = section(raw, 'apps', 'map');
    if (!own(apps, key)) throw new Error('Такої програми немає у списку');
    delete apps[key];
    return null;
  },
  addFolder(raw, { dir }) {
    if (typeof dir !== 'string' || !/^[a-zA-Z]:[\\/]/.test(dir)) throw new Error('Потрібна папка на локальному диску');
    const folders = section(raw, 'folders', 'map');
    if (Object.keys(folders).length >= MAX_ITEMS) throw new Error('Забагато папок у списку');
    if (Object.values(folders).some((f) => samePath(expandFolder(f?.path) ?? f?.path, dir))) throw new Error('Ця папка вже є у списку');
    const base = path.basename(path.resolve(dir));
    const key = makeKey(base, folders, 'folder');
    folders[key] = { name: cleanName(base, key), path: path.resolve(dir) };
    return accepted('folders', key);
  },
  updateFolder(raw, { key, name }) {
    const folders = section(raw, 'folders', 'map');
    if (!own(folders, key) || !isObject(folders[key])) throw new Error('Такої папки немає у списку');
    folders[key].name = cleanName(name, key);
    return null;
  },
  removeFolder(raw, { key }) {
    const folders = section(raw, 'folders', 'map');
    if (!own(folders, key)) throw new Error('Такої папки немає у списку');
    delete folders[key];
    return null;
  },
  setFileType(raw, { ext, list, on }) {
    const allowed = list === 'readableTypes' ? READABLE : list === 'fileTypes' ? OPENABLE : null;
    if (!allowed) throw new Error('Невідомий список типів');
    if (typeof ext !== 'string' || !allowed.has(ext)) throw new Error('Цей тип файлів дозволити не можна');
    const types = section(raw, list, 'list');
    const rest = types.filter((t) => String(t).toLowerCase() !== ext);
    raw[list] = on === true ? [...rest, ext] : rest;
    return null;
  },
  setWake(raw, { enabled, name }) {
    if (raw.wake !== undefined && !isObject(raw.wake)) throw new Error('Розділ «wake» у settings.json записано неправильно — виправ його вручну.');
    const wake = raw.wake ?? (raw.wake = {});
    if (typeof enabled === 'boolean') wake.enabled = enabled;
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('Ім\'я не може бути порожнім');
      wake.name = name.trim().slice(0, 24);
    }
    const want = wake.name;
    return (config, warnings) => (name === undefined || config.wake.name === want
      ? null : (warnings.find((w) => w.startsWith('wake.name')) ?? 'Таке ім\'я не годиться.').replace('wake.name: ', '').replace(' — відгук на ім\'я вимкнено', ''));
  },
  setHotkey(raw, { hotkey }) {
    if (!isValidHotkey(hotkey)) throw new Error('Потрібне сполучення з Ctrl, Alt або Win і однієї клавіші, наприклад Ctrl + Shift + Space');
    raw.hotkey = hotkey;
    return null;
  },
};

export { isValidHotkey };

/** Вносить одну правку. Повертає { ok: true } або { ok: false, error }. */
export function editSettings(change, payload, toolModes = null) {
  if (!own(changes, change)) return { ok: false, error: 'Невідома зміна налаштувань' };
  let raw;
  try { raw = readRaw(); } catch (e) { return { ok: false, error: e.message === 'missing' ? MISSING : BROKEN }; }
  try {
    const verify = changes[change](raw, isObject(payload) ? payload : {});
    const { config, warnings } = validateConfig(raw, readJson(DEFAULT_CONFIG), toolModes);
    const problem = verify ? verify(config, warnings) : null;
    if (problem) return { ok: false, error: problem };
    writeRaw(raw);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Те, що показує екран налаштувань: записи з файлу плюс позначка, чи прийняла їх перевірка.
 * config — чинні (вже перевірені) налаштування.
 */
export function settingsView(config, warnings = []) {
  let raw = null;
  try { raw = readRaw(); } catch { /* зіпсований файл: показуємо чинні налаштування без можливості редагувати */ }
  const entries = (name) => (raw && isObject(raw[name]) ? raw[name] : config[name]);
  const text = (v, max = 260) => (typeof v === 'string' ? v.slice(0, max) : '');

  const hidden = (name) => Math.max(0, Object.keys(entries(name)).length - MAX_ITEMS);
  const apps = Object.entries(entries('apps')).slice(0, MAX_ITEMS).map(([key, a]) => {
    const valid = Object.hasOwn(config.apps, key);
    return {
      key,
      name: text(valid ? config.apps[key].name : a?.name, 40) || key,
      exe: text(valid ? config.apps[key].exe : a?.exe),
      closable: valid ? !!config.apps[key].process : false,
      valid,
    };
  });
  const folders = Object.entries(entries('folders')).slice(0, MAX_ITEMS).map(([key, f]) => {
    const valid = Object.hasOwn(config.folders, key);
    return { key, name: text(valid ? config.folders[key].name : f?.name, 40) || key, path: text(valid ? config.folders[key].path : f?.path), valid };
  });
  const fileGroups = FILE_TYPE_GROUPS.map((g) => ({
    title: g.title,
    types: g.types.map((ext) => ({ ext, open: config.fileTypes.has(ext) })),
  }));
  const readable = [...READABLE].map((ext) => ({ ext, read: config.readableTypes.has(ext) }));
  return { editable: raw !== null, brokenMessage: raw === null ? BROKEN : null, moreApps: hidden('apps'), moreFolders: hidden('folders'), apps, folders, fileGroups, readable, hotkey: config.hotkey, warnings,
    flags: { speakReplies: !!config.speakReplies, followUp: !!config.followUp, yieldToOtherApps: !!config.yieldToOtherApps },
    wake: { enabled: !!config.wake?.enabled, name: config.wake?.name ?? '' },
    idleUnloadMinutes: config.idleUnloadMinutes, voice: !!config.speech?.enabled };
}
