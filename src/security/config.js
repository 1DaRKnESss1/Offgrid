// Налаштування й білі списки. Користувач редагує data/settings.json;
// усе, що не пройшло перевірку, відкидається з поясненням, а не «якось працює».
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, SETTINGS_FILE, DATA_DIR } from '../paths.js';

const KEY_RE = /^[a-z][a-z0-9_]{0,30}$/;
const EXT_RE = /^\.[a-z0-9]{1,8}$/;
// Типи, які ніколи не можна відкривати, навіть якщо їх дописали в налаштування
const NEVER_OPEN = new Set(['.exe', '.bat', '.cmd', '.com', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf',
  '.wsh', '.msi', '.msp', '.scr', '.lnk', '.url', '.reg', '.hta', '.cpl', '.dll', '.jar', '.pif', '.appx', '.msix',
  '.sys', '.inf', '.scf', '.chm', '.application', '.gadget', '.iso', '.img', '.vhd', '.vhdx', '.py', '.pyw', '.sh']);
// Читати вміст можна лише з простих текстових форматів
const TEXT_TYPES = new Set(['.txt', '.md', '.csv', '.log', '.json', '.xml', '.ini', '.yml', '.yaml']);
const CONFIRM_MODES = new Set(['never', 'tainted', 'always']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// "~/Desktop" -> реальна папка користувача (з урахуванням перенесення в OneDrive)
export function expandFolder(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    const rest = p.slice(2);
    const candidates = [path.join(os.homedir(), rest), path.join(os.homedir(), 'OneDrive', rest)];
    return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
  }
  return path.isAbsolute(p) ? path.resolve(p) : null;
}

function isLoopbackUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

function isPlainExe(exe) {
  if (typeof exe !== 'string' || !/\.exe$/i.test(exe)) return false;
  if (/["<>|*?\r\n]/.test(exe)) return false;
  // або проста назва з системного PATH, або повний шлях; жодних відносних шляхів і аргументів
  return path.isAbsolute(exe) ? true : /^[\w.-]+\.exe$/i.test(exe);
}

/** Перевіряє сирі налаштування. Повертає { config, warnings }. */
export function validateConfig(raw, defaults) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const cfg = {};

  cfg.model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : defaults.model;

  cfg.ollamaUrl = defaults.ollamaUrl;
  if (raw.ollamaUrl !== undefined) {
    if (isLoopbackUrl(raw.ollamaUrl)) cfg.ollamaUrl = String(raw.ollamaUrl).replace(/\/+$/, '');
    else warn(`ollamaUrl «${raw.ollamaUrl}» не локальна адреса — використано ${defaults.ollamaUrl}`);
  }

  cfg.hotkey = typeof raw.hotkey === 'string' && raw.hotkey.trim() ? raw.hotkey.trim() : defaults.hotkey;
  cfg.speakReplies = typeof raw.speakReplies === 'boolean' ? raw.speakReplies : defaults.speakReplies;

  cfg.apps = {};
  for (const [key, a] of Object.entries(raw.apps ?? {})) {
    if (!KEY_RE.test(key)) { warn(`Програма «${key}»: ключ має бути латиницею (a-z, 0-9, _)`); continue; }
    if (!a || !isPlainExe(a.exe)) { warn(`Програма «${key}»: exe має бути назвою .exe або повним шляхом без аргументів`); continue; }
    if (path.isAbsolute(a.exe) && !fs.existsSync(a.exe)) { warn(`Програма «${key}»: файл ${a.exe} не знайдено`); continue; }
    const app = { name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 40) : key, exe: a.exe };
    if (a.process !== undefined) {
      if (typeof a.process === 'string' && /^[\w.-]+\.exe$/i.test(a.process)) app.process = a.process;
      else warn(`Програма «${key}»: process має бути назвою процесу на кшталт Notepad.exe — закривати її не можна буде`);
    }
    cfg.apps[key] = app;
  }

  cfg.folders = {};
  for (const [key, f] of Object.entries(raw.folders ?? {})) {
    if (!KEY_RE.test(key)) { warn(`Папка «${key}»: ключ має бути латиницею (a-z, 0-9, _)`); continue; }
    const full = expandFolder(f?.path);
    if (!full) { warn(`Папка «${key}»: шлях має бути повним або починатися з ~/`); continue; }
    if (path.parse(full).root === full) { warn(`Папка «${key}»: корінь диска цілком дозволяти не можна`); continue; }
    const rel = path.relative(full, DATA_DIR);
    if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      warn(`Папка «${key}»: вона містить службові дані асистента — пропущено`); continue;
    }
    cfg.folders[key] = { name: typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 40) : key, path: full };
  }

  const exts = (list, label, extraCheck) => {
    const out = new Set();
    for (const e of Array.isArray(list) ? list : []) {
      const ext = String(e).toLowerCase();
      if (!EXT_RE.test(ext)) warn(`${label}: «${e}» не схоже на розширення файлу`);
      else if (NEVER_OPEN.has(ext)) warn(`${label}: ${ext} — виконуваний тип, його дозволити не можна`);
      else if (extraCheck && !extraCheck(ext)) warn(`${label}: ${ext} не текстовий формат — пропущено`);
      else out.add(ext);
    }
    return out;
  };
  cfg.fileTypes = exts(raw.fileTypes, 'fileTypes');
  cfg.readableTypes = exts(raw.readableTypes, 'readableTypes', (e) => TEXT_TYPES.has(e));

  cfg.confirm = {};
  for (const [tool, mode] of Object.entries(raw.confirm ?? {})) {
    if (CONFIRM_MODES.has(mode)) cfg.confirm[tool] = mode;
    else warn(`confirm.${tool}: дозволені значення never, tainted, always`);
  }
  return { config: cfg, warnings };
}

/** Читає налаштування; при першому запуску створює data/settings.json з типових. */
export function loadConfig() {
  const defaults = readJson(DEFAULT_CONFIG);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let raw = defaults;
  const warnings = [];
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.copyFileSync(DEFAULT_CONFIG, SETTINGS_FILE);
  } else {
    try {
      // верхні ключі з файлу користувача повністю замінюють типові: так зі списку можна й прибирати
      raw = { ...defaults, ...readJson(SETTINGS_FILE) };
    } catch (e) {
      warnings.push(`settings.json не читається (${e.message}) — використано типові налаштування`);
    }
  }
  const res = validateConfig(raw, defaults);
  return { config: res.config, warnings: [...warnings, ...res.warnings] };
}
