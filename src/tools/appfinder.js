// Пошук встановленої програми за назвою — щоб асистент міг ЗАПРОПОНУВАТИ додати її до дозволених.
// Шлях до файлу знаходить цей код, а не модель: з ярликів меню «Пуск» і робочого столу та зі списку
// встановлених ігор Steam. Нічого не запускає й нічого не змінює; результат бачить користувач у запиті дозволу.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../paths.js';
import { POWERSHELL, SYSTEM32 } from './util.js';

const SHORTCUTS_SCRIPT = path.join(ROOT, 'shell', 'shortcuts.ps1');
const REG = path.join(SYSTEM32, 'reg.exe');
const NOT_AN_APP = /unins|uninstall|redistributable|видал|readme|help|manual|документ|license|website|support/i;
const NOT_A_GAME_EXE = /unins|crash|redist|setup|install|vc_?redist|dxsetup|dotnet|anticheat|easyanticheat|battleye|helper|report|updater|cef|subprocess|unitycrashhandler|vconsole|^steam/i;
const MAX_FILES = 3000;

export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
const clean = (s) => String(s ?? '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 60);

/** Наскільки назва підходить до запиту: 3 — збіг, 2 — починається з нього, 1 — містить, 0 — ні. */
export function matchScore(name, query) {
  const n = norm(name), q = norm(query);
  if (q.length < 2 || !n) return 0;
  if (n === q) return 3;
  if (n.startsWith(q)) return 2;
  if (n.includes(q) || (n.length >= 4 && q.includes(n))) return 1;
  return 0;
}

function walk(dir, depth, visit, counter = { n: 0 }) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (counter.n >= MAX_FILES) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) walk(full, depth - 1, visit, counter); } else if (e.isFile()) { counter.n++; visit(full, depth); }
  }
}

function shortcutDirs(env) {
  return [
    env.ProgramData && path.join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    env.APPDATA && path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(os.homedir(), 'Desktop'),
    env.PUBLIC && path.join(env.PUBLIC, 'Desktop'),
  ].filter(Boolean);
}

// ---------- Steam ----------
async function steamLibraries(run, env) {
  const roots = new Set();
  const reg = await run(REG, ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
  const m = reg.ok && /SteamPath\s+REG_SZ\s+(.+)/i.exec(reg.stdout);
  if (m) roots.add(path.resolve(m[1].trim()));
  if (env['ProgramFiles(x86)']) roots.add(path.join(env['ProgramFiles(x86)'], 'Steam'));
  const libs = new Set();
  for (const root of roots) {
    libs.add(root);
    try {
      const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const p of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(path.resolve(p[1].replace(/\\\\/g, '\\')));
    } catch { /* бібліотек, крім основної, немає */ }
  }
  return [...libs];
}

function steamGames(libs) {
  const games = [];
  for (const lib of libs) {
    const apps = path.join(lib, 'steamapps');
    let files;
    try { files = fs.readdirSync(apps); } catch { continue; }
    for (const f of files) {
      if (!/^appmanifest_\d+\.acf$/.test(f)) continue;
      try {
        const acf = fs.readFileSync(path.join(apps, f), 'utf8');
        const field = (k) => new RegExp(`"${k}"\\s+"([^"]*)"`).exec(acf)?.[1] ?? '';
        const dir = path.join(apps, 'common', field('installdir'));
        if (field('installdir') && fs.existsSync(dir)) games.push({ id: field('appid'), name: field('name'), dir });
      } catch { /* пошкоджений запис пропускаємо */ }
    }
  }
  return games;
}

/** Головний файл гри в її папці: з назвою, схожою на назву гри, інакше найбільший. */
export function gameExe(game) {
  const found = [];
  walk(game.dir, 4, (file, depth) => {
    if (!/\.exe$/i.test(file) || NOT_A_GAME_EXE.test(path.basename(file))) return;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    const base = norm(path.basename(file, '.exe'));
    const alike = [norm(game.name), norm(path.basename(game.dir))].some((n) => n && (n.includes(base) || base.includes(n)));
    found.push({ file, size, alike, depth });
  });
  found.sort((a, b) => (b.alike - a.alike) || (b.size - a.size));
  return found[0]?.file ?? null;
}

/**
 * Шукає програму за назвою. Повертає [{ name, exe, source, score }], найкращі збіги першими (щонайбільше 8).
 * run(exe, args) — як у ctx.os; env і dirs підміняються в тестах.
 */
export async function findApps(query, { run, env = process.env, dirs = shortcutDirs(env) } = {}) {
  const hits = [];
  const urls = [];
  for (const dir of dirs) {
    walk(dir, 4, (file) => {
      const ext = path.extname(file).toLowerCase();
      if (ext !== '.lnk' && ext !== '.url') return;
      const name = path.basename(file, ext);
      const score = matchScore(name, query);
      if (!score || NOT_AN_APP.test(name)) return;
      (ext === '.lnk' ? hits : urls).push({ name: clean(name), file, score });
    });
  }
  hits.sort((a, b) => b.score - a.score);
  const shortcuts = hits.slice(0, 12);
  const results = [];
  if (shortcuts.length) {
    // куди веде ярлик, знає лише Windows: питаємо її (читання, без запуску)
    const r = await run(POWERSHELL, ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', SHORTCUTS_SCRIPT, ...shortcuts.map((s) => s.file)]);
    const targets = r.ok ? r.stdout.split(/\r?\n/) : [];
    shortcuts.forEach((s, i) => {
      const exe = (targets[i] ?? '').trim();
      if (/\.exe$/i.test(exe) && fs.existsSync(exe) && !NOT_AN_APP.test(path.basename(exe))) results.push({ name: s.name, exe: path.resolve(exe), source: 'меню «Пуск»', score: s.score });
    });
  }

  // ігри Steam: ярлик такої гри — це посилання steam://, а не файл, тож шукаємо в бібліотеках Steam
  const steamIds = new Map();
  for (const u of urls) {
    try {
      const id = /^URL=steam:\/\/rungameid\/(\d+)/mi.exec(fs.readFileSync(u.file, 'utf8'))?.[1];
      if (id) steamIds.set(id, u.score);
    } catch { /* нечитаний ярлик пропускаємо */ }
  }
  let games = [];
  try { games = steamGames(await steamLibraries(run, env)); } catch { /* Steam не встановлено */ }
  for (const game of games) {
    const score = Math.max(matchScore(game.name, query), steamIds.get(game.id) ?? 0);
    if (!score) continue;
    const exe = gameExe(game);
    if (exe) results.push({ name: clean(game.name), exe: path.resolve(exe), source: 'Steam', score });
  }

  const seen = new Set();
  return results
    .sort((a, b) => b.score - a.score)
    .filter((r) => { const k = r.exe.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 8);
}
