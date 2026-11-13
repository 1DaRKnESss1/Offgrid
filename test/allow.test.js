// Пропозиції розширити білі списки: асистент лише пропонує, вирішує користувач, перевірки ті самі, що в налаштуваннях.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp', `allow-${process.pid}`);
process.env.OFFGRID_DATA = path.join(TMP, 'data');
const { loadConfig } = await import('../src/security/config.js');
const { editSettings } = await import('../src/security/settings-store.js');
const { executeTool, TOOL_MODES, confirmMode } = await import('../src/security/policy.js');
const { ALL_TOOLS } = await import('../src/tools/index.js');
const { matchScore, gameExe } = await import('../src/tools/appfinder.js');
const { SETTINGS_FILE } = await import('../src/paths.js');

const menu = path.join(TMP, 'Start Menu');
const notepad = path.join(process.env.SystemRoot, 'System32', 'notepad.exe');
const calc = path.join(process.env.SystemRoot, 'System32', 'calc.exe');
const load = () => loadConfig({ toolModes: TOOL_MODES }).config;

// «система»: ярлики лежать у тестовій папці, а куди вони ведуть — відповідає заглушка замість PowerShell
let targets = {};
function session({ allow = true, taint = 0 } = {}) {
  const asked = [];
  const s = {
    config: load(),
    taint,
    denied: false,
    asked,
    confirm: async (request) => { asked.push(request); return allow; },
    os: {
      appDirs: [menu],
      run: async (exe, args) => (/powershell/i.test(exe)
        ? { ok: true, stdout: args.slice(args.indexOf('-File') + 2).map((p) => targets[path.basename(p)] ?? '').join('\r\n') }
        : { ok: false, stdout: '' }),
      allow: (change, payload) => { const r = editSettings(change, payload, TOOL_MODES); if (r.ok) s.config = load(); return r; },
    },
  };
  return s;
}

before(() => { fs.mkdirSync(menu, { recursive: true }); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
beforeEach(() => {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ apps: {}, folders: {}, fileTypes: ['.txt'], readableTypes: [] }));
  for (const f of fs.readdirSync(menu)) fs.rmSync(path.join(menu, f), { recursive: true, force: true });
  targets = {};
});
const shortcut = (name, target) => { fs.writeFileSync(path.join(menu, `${name}.lnk`), ''); targets[`${name}.lnk`] = target; };

test('ці інструменти завжди питають дозволу, і налаштуваннями це не послабити', () => {
  for (const name of ['allow_app', 'allow_folder', 'allow_file_type']) {
    const tool = ALL_TOOLS.find((t) => t.name === name);
    assert.equal(tool.confirm, 'always');
    assert.equal(confirmMode(tool, { confirm: { [name]: 'never' } }), 'always');
  }
});

test('програма: шлях знаходить код, користувач бачить його й дозволяє — лише тоді вона в списку', async () => {
  shortcut('Notepad', notepad);
  const s = session();
  const { result } = await executeTool('allow_app', { name: 'notepad' }, s);
  assert.equal(result.ok, true, result.error);
  assert.equal(s.asked.length, 1);
  assert.ok(s.asked[0].summary.includes(notepad), 'у запиті має бути повний шлях');
  assert.equal(s.asked[0].reason, 'always');
  assert.equal(Object.values(load().apps)[0].exe.toLowerCase(), notepad.toLowerCase());
  assert.equal(Object.values(load().apps)[0].name, 'Notepad');
  // удруге — не питаємо: вона вже є
  const again = session();
  assert.equal((await executeTool('allow_app', { name: 'notepad' }, again)).result.ok, false);
  assert.equal(again.asked.length, 0);
});

test('програма: відмова користувача нічого не змінює', async () => {
  shortcut('Notepad', notepad);
  const s = session({ allow: false });
  assert.equal((await executeTool('allow_app', { name: 'Notepad' }, s)).result.ok, false);
  assert.deepEqual(load().apps, {});
});

test('програма: не знайдено — чесна відмова без запиту; кілька схожих — просимо уточнити', async () => {
  const none = session();
  const r1 = await executeTool('allow_app', { name: 'Photoshop' }, none);
  assert.equal(r1.result.ok, false);
  assert.equal(none.asked.length, 0);
  shortcut('Calc Pro', calc);
  shortcut('Calc Lite', notepad);
  const many = session();
  const r2 = await executeTool('allow_app', { name: 'calc' }, many);
  assert.equal(r2.result.ok, false);
  assert.match(r2.result.error, /Calc Pro/);
  assert.equal(many.asked.length, 0);
  assert.deepEqual(load().apps, {});
});

test('програма: ярлик, що веде не на .exe або на видалення програми, не пропонується', async () => {
  shortcut('Tool', path.join(TMP, 'run.bat'));
  shortcut('Uninstall Tool', notepad);
  const s = session();
  assert.equal((await executeTool('allow_app', { name: 'tool' }, s)).result.ok, false);
  assert.equal(s.asked.length, 0);
});

test('якщо асистент уже читав файли, запит дозволу про це попереджає', async () => {
  shortcut('Notepad', notepad);
  const s = session({ taint: 2 });
  await executeTool('allow_app', { name: 'Notepad' }, s);
  assert.match(s.asked[0].summary, /УВАГА/);
});

test('папка: існуюча — з дозволу; системна, неіснуюча й мережева — ні', async () => {
  const docs = path.join(TMP, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  const ok = session();
  assert.equal((await executeTool('allow_folder', { path: docs }, ok)).result.ok, true);
  assert.ok(ok.asked[0].summary.includes(docs));
  assert.equal(Object.values(load().folders)[0].path.toLowerCase(), docs.toLowerCase());

  for (const bad of [path.join(TMP, 'nope'), '\\\\server\\share', '~/Documents', '', 'D:']) {
    const s = session();
    assert.equal((await executeTool('allow_folder', { path: bad }, s)).result.ok, false, bad);
    assert.equal(s.asked.length, 0, bad);
  }
  // системну папку перевірка налаштувань не прийме, навіть якщо користувач натисне «Дозволити»
  const sys = session();
  assert.equal((await executeTool('allow_folder', { path: process.env.SystemRoot }, sys)).result.ok, false);
  assert.equal(Object.keys(load().folders).length, 1);
});

test('тип файлів: лише з дозволеного переліку', async () => {
  const s = session();
  assert.equal((await executeTool('allow_file_type', { ext: 'pdf' }, s)).result.ok, true);
  assert.ok([...load().fileTypes].includes('.pdf'));
  for (const bad of ['.exe', '.bat', '.lnk', '.ps1', '']) {
    const b = session();
    assert.equal((await executeTool('allow_file_type', { ext: bad }, b)).result.ok, false, bad);
    assert.equal(b.asked.length, 0, bad);
  }
  const read = session();
  assert.equal((await executeTool('allow_file_type', { ext: '.pdf', read: true }, read)).result.ok, false, 'pdf не текстовий');
});

test('пошук: оцінка збігу назв і вибір головного файлу гри', () => {
  assert.equal(matchScore('Steam', 'steam'), 3);
  assert.equal(matchScore('Telegram Desktop', 'telegram'), 2);
  assert.equal(matchScore('Visual Studio Code', 'studio'), 1);
  assert.equal(matchScore('Steam', 'discord'), 0);
  assert.equal(matchScore('Steam', 's'), 0);
  const dir = path.join(TMP, 'common', 'Deadlock');
  fs.mkdirSync(path.join(dir, 'game', 'bin', 'win64'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'game', 'bin', 'win64', 'deadlock.exe'), 'x'.repeat(10));
  fs.writeFileSync(path.join(dir, 'game', 'bin', 'win64', 'crashhandler.exe'), 'x'.repeat(5000));
  fs.writeFileSync(path.join(dir, 'installer_setup.exe'), 'x'.repeat(9000));
  assert.equal(path.basename(gameExe({ name: 'Deadlock', dir })), 'deadlock.exe');
});
