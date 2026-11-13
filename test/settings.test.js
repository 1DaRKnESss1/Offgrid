// Тести зміни налаштувань із панелі. Запуск: npm test
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp', `settings-${process.pid}`);
process.env.OFFGRID_DATA = path.join(TMP, 'data');

const { loadConfig } = await import('../src/security/config.js');
const { editSettings, settingsView, isValidHotkey } = await import('../src/security/settings-store.js');
const { TOOL_MODES } = await import('../src/security/policy.js');
const { SETTINGS_FILE } = await import('../src/paths.js');

const docs = path.join(TMP, 'Мої документи');
const more = path.join(TMP, 'photos');
const notepad = path.join(process.env.SystemRoot, 'System32', 'notepad.exe');
const raw = () => JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
const load = () => loadConfig({ toolModes: TOOL_MODES });

before(() => { fs.mkdirSync(docs, { recursive: true }); fs.mkdirSync(more, { recursive: true }); });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    model: 'qwen3.5:9b', hotkey: 'Control+Shift+Space', speakReplies: true, speech: { enabled: false },
    apps: { notepad: { name: 'Блокнот', exe: 'notepad.exe', process: 'Notepad.exe' } },
    folders: { docs: { name: 'Документи', path: docs } },
    fileTypes: ['.txt', '.pdf'], readableTypes: ['.txt'], confirm: {},
  }, null, 2));
});

test('програми: додати, перейменувати, дозволити закривати, прибрати', () => {
  const write = path.join(process.env.SystemRoot, 'System32', 'write.exe');
  const exe = fs.existsSync(write) ? write : path.join(process.env.SystemRoot, 'explorer.exe');
  assert.deepEqual(editSettings('addApp', { exe }, TOOL_MODES), { ok: true });
  const key = Object.keys(raw().apps).find((k) => k !== 'notepad');
  assert.match(key, /^[a-z][a-z0-9_]*$/);
  assert.equal(load().config.apps[key].exe.toLowerCase(), exe.toLowerCase());
  assert.equal(load().config.apps[key].process, undefined); // закривати нову програму за замовчуванням не можна

  assert.equal(editSettings('addApp', { exe }, TOOL_MODES).ok, false); // вдруге ту саму — ні
  assert.equal(editSettings('updateApp', { key, name: '  Моя програма  ', closable: true }, TOOL_MODES).ok, true);
  assert.equal(load().config.apps[key].name, 'Моя програма');
  assert.equal(load().config.apps[key].process, path.basename(exe));
  assert.equal(editSettings('updateApp', { key, closable: false }, TOOL_MODES).ok, true);
  assert.equal(load().config.apps[key].process, undefined);
  assert.equal(editSettings('removeApp', { key }, TOOL_MODES).ok, true);
  assert.deepEqual(Object.keys(load().config.apps), ['notepad']);
});

test('програми: те, що не пройшло б перевірку вручну, не проходить і через панель', () => {
  const before = fs.readFileSync(SETTINGS_FILE, 'utf8');
  for (const exe of [path.join(TMP, 'нема.exe'), 'calc.exe /c evil', '\\\\server\\share\\a.exe', path.join(docs, 'readme.txt'), '', null, 42]) {
    const res = editSettings('addApp', { exe }, TOOL_MODES);
    assert.equal(res.ok, false, String(exe));
    assert.ok(res.error.length > 0);
  }
  for (const key of ['__proto__', 'constructor', 'нема', '', null]) {
    assert.equal(editSettings('removeApp', { key }, TOOL_MODES).ok, false, String(key));
    assert.equal(editSettings('updateApp', { key, name: 'x' }, TOOL_MODES).ok, false, String(key));
  }
  assert.equal(editSettings('formatDisk', {}, TOOL_MODES).ok, false);
  assert.equal(editSettings('__proto__', {}, TOOL_MODES).ok, false);
  assert.equal(fs.readFileSync(SETTINGS_FILE, 'utf8'), before); // файл не змінився
});

test('програми: ту саму програму не додати вдруге, навіть якщо в списку вона записана короткою назвою', () => {
  const res = editSettings('addApp', { exe: notepad }, TOOL_MODES);
  assert.equal(res.ok, false);
  assert.match(res.error, /вже є/);
  assert.deepEqual(Object.keys(raw().apps), ['notepad']);
});

test('програми: «можна закривати» не записується, якщо назву процесу відкине перевірка', () => {
  const odd = path.join(TMP, 'my app++.exe');
  fs.writeFileSync(odd, 'x');
  assert.equal(editSettings('addApp', { exe: odd }, TOOL_MODES).ok, true);
  const key = Object.keys(raw().apps).find((k) => k !== 'notepad');
  const before = fs.readFileSync(SETTINGS_FILE, 'utf8');
  const res = editSettings('updateApp', { key, closable: true }, TOOL_MODES);
  assert.equal(res.ok, false);
  assert.match(res.error, /закривати не зможе/);
  assert.equal(fs.readFileSync(SETTINGS_FILE, 'utf8'), before);
  assert.equal(load().warnings.length, 0);
});

test('зміна не чіпає чужого: невідомі параметри й сусідні записи лишаються як були', () => {
  const data = raw();
  data.myNote = { keep: [1, 2, 3] };
  data.apps.ghost = { name: 'Привид', exe: 'C:\\нема\\ghost.exe' };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data));
  assert.equal(editSettings('addFolder', { dir: more }, TOOL_MODES).ok, true);
  const after = raw();
  assert.deepEqual(after.myNote, { keep: [1, 2, 3] });
  assert.deepEqual(after.apps.ghost, data.apps.ghost);
  assert.deepEqual(after.apps.notepad, data.apps.notepad);
  assert.equal(fs.existsSync(SETTINGS_FILE + '.tmp'), false);
});

test('розділ, записаний неправильно, панель не переписує', () => {
  const data = raw();
  data.folders = ['не', 'те'];
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data));
  const before = fs.readFileSync(SETTINGS_FILE, 'utf8');
  assert.equal(editSettings('addFolder', { dir: more }, TOOL_MODES).ok, false);
  assert.equal(fs.readFileSync(SETTINGS_FILE, 'utf8'), before);
  fs.rmSync(SETTINGS_FILE);
  assert.match(editSettings('addFolder', { dir: more }, TOOL_MODES).error, /зник/);
});

test('папки: додати й прибрати; системні, неіснуючі й мережеві — відмова з поясненням', () => {
  assert.equal(editSettings('addFolder', { dir: more }, TOOL_MODES).ok, true);
  const key = Object.keys(raw().folders).find((k) => k !== 'docs');
  assert.equal(load().config.folders[key].name, 'photos');
  assert.equal(editSettings('addFolder', { dir: more }, TOOL_MODES).ok, false);
  assert.equal(editSettings('updateFolder', { key, name: 'Фото' }, TOOL_MODES).ok, true);
  assert.equal(load().config.folders[key].name, 'Фото');

  const before = fs.readFileSync(SETTINGS_FILE, 'utf8');
  for (const dir of ['C:\\', process.env.SystemRoot, process.env.USERPROFILE, path.join(TMP, 'нема'), '\\\\server\\share', TMP, 'Documents', null]) {
    const res = editSettings('addFolder', { dir }, TOOL_MODES);
    assert.equal(res.ok, false, String(dir));
    assert.ok(res.error.length > 5, String(dir));
  }
  assert.equal(fs.readFileSync(SETTINGS_FILE, 'utf8'), before);

  assert.equal(editSettings('removeFolder', { key }, TOOL_MODES).ok, true);
  assert.deepEqual(Object.keys(load().config.folders), ['docs']);
});

test('папка з кириличною назвою отримує коректний ключ', () => {
  fs.rmSync(SETTINGS_FILE);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ apps: {}, folders: {}, fileTypes: [], readableTypes: [] }));
  assert.equal(editSettings('addFolder', { dir: docs }, TOOL_MODES).ok, true);
  const [key] = Object.keys(raw().folders);
  assert.equal(key, 'folder');
  assert.equal(load().config.folders.folder.name, 'Мої документи');
});

test('типи файлів: лише з дозволеного переліку', () => {
  assert.equal(editSettings('setFileType', { ext: '.png', list: 'fileTypes', on: true }, TOOL_MODES).ok, true);
  assert.equal(editSettings('setFileType', { ext: '.pdf', list: 'fileTypes', on: false }, TOOL_MODES).ok, true);
  assert.equal(editSettings('setFileType', { ext: '.md', list: 'readableTypes', on: true }, TOOL_MODES).ok, true);
  const { config } = load();
  assert.deepEqual([...config.fileTypes].sort(), ['.png', '.txt']);
  assert.deepEqual([...config.readableTypes].sort(), ['.md', '.txt']);
  for (const [ext, list] of [['.exe', 'fileTypes'], ['.html', 'fileTypes'], ['.lnk', 'fileTypes'], ['.pdf', 'readableTypes'], ['.txt', 'apps'], ['.txt', '__proto__'], [null, 'fileTypes']]) {
    assert.equal(editSettings('setFileType', { ext, list, on: true }, TOOL_MODES).ok, false, `${ext} ${list}`);
  }
  assert.deepEqual([...load().config.fileTypes].sort(), ['.png', '.txt']);
});

test('гаряча клавіша: приймаються лише сполучення з модифікатором', () => {
  for (const ok of ['Control+Shift+Space', 'Alt+F9', 'Control+Alt+Shift+K', 'Super+Alt+1']) assert.equal(isValidHotkey(ok), true, ok);
  for (const bad of ['Space', 'A', 'Control+Shift', 'Control+Alt+Delete; calc', 'Control+Escape', '', null, 'Control+Control+Control+Control+A',
    'Shift+A', 'Shift+Space', 'Control+Control+A', 'Alt+Tab', 'Alt+F4', 'Hyper+A', 'Control+Alt+Shift+Super+A']) {
    assert.equal(isValidHotkey(bad), false, String(bad));
  }
  assert.equal(editSettings('setHotkey', { hotkey: 'Alt+F9' }, TOOL_MODES).ok, true);
  assert.equal(load().config.hotkey, 'Alt+F9');
  assert.equal(editSettings('setHotkey', { hotkey: 'F9' }, TOOL_MODES).ok, false);
  assert.equal(load().config.hotkey, 'Alt+F9');
});

test('зіпсований файл налаштувань панель не перезаписує', () => {
  fs.writeFileSync(SETTINGS_FILE, '{ "apps": { oops');
  const res = editSettings('addFolder', { dir: more }, TOOL_MODES);
  assert.equal(res.ok, false);
  assert.match(res.error, /зіпсовано/);
  assert.equal(fs.readFileSync(SETTINGS_FILE, 'utf8'), '{ "apps": { oops');
  const { config, warnings } = load();
  const view = settingsView(config, warnings);
  assert.equal(view.editable, false);
  assert.ok(view.brokenMessage);
});

test('екран налаштувань показує й записи, які не пройшли перевірку', () => {
  const data = raw();
  data.apps.ghost = { name: 'Привид', exe: 'C:\\нема\\ghost.exe' };
  data.folders.gone = { name: 'Зникла', path: path.join(TMP, 'нема') };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data));
  const { config, warnings } = load();
  const view = settingsView(config, warnings);
  assert.deepEqual(view.apps.map((a) => [a.key, a.valid]), [['notepad', true], ['ghost', false]]);
  assert.deepEqual(view.folders.map((f) => [f.key, f.valid]), [['docs', true], ['gone', false]]);
  assert.equal(view.apps[0].closable, true);
  assert.equal(view.apps[0].exe.toLowerCase(), notepad.toLowerCase());
  assert.equal(view.fileGroups.flatMap((g) => g.types).filter((t) => t.open).length, 2);
  assert.equal(view.editable, true);
  // зіпсований запис можна прибрати з панелі
  assert.equal(editSettings('removeApp', { key: 'ghost' }, TOOL_MODES).ok, true);
  assert.equal(editSettings('removeFolder', { key: 'gone' }, TOOL_MODES).ok, true);
  assert.equal(load().warnings.length, 0);
});

test('відгук на ім\'я: вимкнений, доки користувач не ввімкне; ім\'я перевіряється', () => {
  assert.equal(load().config.wake.enabled, false);
  assert.equal(load().config.wake.name, 'Офгрід');
  assert.deepEqual(editSettings('setWake', { enabled: true }, TOOL_MODES), { ok: true });
  assert.deepEqual(editSettings('setWake', { name: 'Джарвіс' }, TOOL_MODES), { ok: true });
  const cfg = load().config;
  assert.equal(cfg.wake.enabled, true);
  assert.equal(cfg.wake.name, 'Джарвіс');
  assert.equal(cfg.speech.enabled ? cfg.speech.wakeName : 'Джарвіс', 'Джарвіс');
  assert.equal(settingsView(cfg).wake.name, 'Джарвіс');
  // надто коротке чи зі сторонніми знаками ім'я не записується
  for (const bad of ['я', 'ок', '', '   ', 'ім"я; rm', '..']) assert.equal(editSettings('setWake', { name: bad }, TOOL_MODES).ok, false, bad);
  assert.equal(raw().wake.name, 'Джарвіс');
  // зіпсований уручну запис не вмикає режим
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...raw(), wake: { enabled: 'yes', name: 5 } }));
  assert.equal(load().config.wake.enabled, false);
});
