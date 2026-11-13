// Тести голосової частини, які не потребують ні моделей, ні мікрофона. Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp', `speech-test-${process.pid}`);
process.env.OFFGRID_DATA = path.join(TMP, 'data');

const { validateConfig } = await import('../src/security/config.js');
const { cleanForSpeech, limitForSpeech, Speech } = await import('../src/speech/client.js');

const defaults = JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
const voiceFile = path.join(TMP, 'voice.onnx');
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(voiceFile, 'x');
// справжній python.exe може бути не встановлений там, де запускають тести, — беремо будь-який наявний .exe
const good = { enabled: true, python: 'notepad.exe', whisperDir: TMP, whisperModel: 'medium', liveModel: 'small', piperVoice: voiceFile, speed: 1 };
const speechOf = (speech) => validateConfig({ ...defaults, speech }, defaults);

test('голос: правильні налаштування приймаються, шляхи стають повними', () => {
  const { config } = speechOf(good);
  assert.equal(config.speech.enabled, true);
  assert.ok(path.isAbsolute(config.speech.python));
  assert.equal(config.speech.piperVoice, voiceFile);
  assert.equal(config.speech.liveModel, 'small');
});

test('голос: помилка в налаштуваннях вимикає голос із поясненням, а не ламає застосунок', () => {
  const bad = [
    { ...good, python: 'нема-такого.exe' },
    { ...good, python: 'python.exe -c "import os"' },
    { ...good, python: '..\\evil.exe' },
    { ...good, whisperDir: path.join(TMP, 'нема') },
    { ...good, whisperDir: '\\\\server\\share' },
    { ...good, piperVoice: path.join(TMP, 'нема.onnx') },
    { ...good, piperVoice: path.join(TMP, 'voice.txt') },
    { ...good, whisperModel: '../../щось' },
    { ...good, whisperModel: 'medium; calc' },
    'увімкнути',
  ];
  for (const speech of bad) {
    const { config, warnings } = speechOf(speech);
    assert.equal(config.speech.enabled, false, JSON.stringify(speech));
    assert.equal(warnings.length, 1, JSON.stringify(speech));
  }
  // вимкнено навмисно — без зауваг
  const off = speechOf({ ...good, enabled: false });
  assert.equal(off.config.speech.enabled, false);
  assert.equal(off.warnings.length, 0);
  // дрібні помилки не вимикають голос
  const minor = speechOf({ ...good, speed: 9, liveModel: 'a b' });
  assert.equal(minor.config.speech.enabled, true);
  assert.equal(minor.config.speech.speed, 1);
  assert.equal(minor.config.speech.liveModel, '');
  assert.equal(minor.warnings.length, 2);
});

test('голос: перед озвученням прибирається розмітка, посилання й емодзі', () => {
  assert.equal(cleanForSpeech('**Готово!** Відкрив `блокнот` 🙂'), 'Готово! Відкрив блокнот');
  assert.equal(cleanForSpeech('Дивись https://example.com/a?b=c тут'), 'Дивись посилання тут');
  assert.equal(cleanForSpeech('# Заголовок\n- пункт'), 'Заголовок - пункт');
  assert.equal(cleanForSpeech(null), '');
});

test('голос: задовгий текст обрізається по межі речення', () => {
  const text = 'Перше речення. ' + 'Друге речення трохи довше! ' + 'х'.repeat(200);
  assert.equal(limitForSpeech(text, 60), 'Перше речення. Друге речення трохи довше!');
  assert.equal(limitForSpeech('коротко', 60), 'коротко');
  assert.ok(limitForSpeech('слово '.repeat(100), 50).length <= 50);
});

test('голос: якщо сервіс падає під час запуску, стан стає «failed» з поясненням, а не висить', async () => {
  // замість Python запускаємо node з крихітним скриптом, який одразу завершується з помилкою
  const script = path.join(TMP, 'crash.js');
  fs.writeFileSync(script, "console.error('немає пакета piper'); process.exit(3);");
  const statuses = [];
  const speech = new Speech({ onStatus: (s) => statuses.push(s) });
  await speech.start({ ...good, python: process.execPath }, { script, interpreterArgs: [] });
  assert.deepEqual(statuses.map((s) => s.status), ['starting', 'failed']);
  assert.match(statuses[1].error, /код 3/);
  assert.match(statuses[1].error, /немає пакета piper/);
  assert.equal(speech.child, null);
});

test('голос: сервіс стартує, повідомляє порт, а новий start() зупиняє попередній процес', async () => {
  // фальшивий сервіс: друкує рядок READY і живе, доки відкритий stdin (як справжній)
  const script = path.join(TMP, 'fake.js');
  fs.writeFileSync(script, "console.log('READY http://127.0.0.1:45678'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));");
  const speech = new Speech();
  await speech.start({ ...good, python: process.execPath }, { script, interpreterArgs: [] });
  assert.equal(speech.status, 'ready');
  assert.equal(speech.base, 'http://127.0.0.1:45678');
  const first = speech.child;
  const gone = new Promise((resolve) => first.once('exit', resolve));
  // два запуски поспіль: перший має відступити, не лишивши процесу
  const a = speech.start({ ...good, python: process.execPath }, { script, interpreterArgs: [] });
  const b = speech.start({ ...good, python: process.execPath }, { script, interpreterArgs: [] });
  await Promise.all([a, b, gone]);
  assert.equal(speech.status, 'ready');
  assert.notEqual(speech.child, first);
  const last = speech.child;
  const stopped = new Promise((resolve) => last.once('exit', resolve));
  await speech.stop();
  await stopped;
  assert.equal(speech.status, 'off');
  assert.equal(speech.child, null);
});

test('голос: без запущеного сервісу клієнт відмовляє зрозуміло й нічого не запускає', async () => {
  const statuses = [];
  const speech = new Speech({ onStatus: (s) => statuses.push(s.status) });
  await speech.start({ enabled: false });
  assert.equal(speech.ready, false);
  assert.deepEqual(statuses, ['off']);
  assert.equal(speech.child, null);
  await assert.rejects(() => speech.listen(), /недоступний/);
  assert.deepEqual(await speech.speak('привіт'), { interrupted: false, skipped: true });
  speech.cancel();
  speech.stopListening();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------- Якісний голос (OmniVoice) ----------
test('якісний голос: вмикається лише коли є все потрібне, інакше тихо лишається простий', () => {
  fs.mkdirSync(TMP, { recursive: true });
  const py = path.join(TMP, 'python.exe');
  const pt = path.join(TMP, 'voice.pt');
  const onnx = path.join(TMP, 'voice.onnx');
  for (const f of [py, pt, onnx]) fs.writeFileSync(f, 'x');
  const base = { ...good, piperVoice: onnx };
  const full = { engine: 'auto', python: py, modelDir: TMP, prompt: pt, instruct: 'male, low pitch', speed: 1.2, steps: 8 };
  const voiceOf = (voice) => validateConfig({ ...defaults, speech: { ...base, voice } }, defaults);

  const ok = voiceOf(full);
  assert.equal(ok.config.speech.voice.engine, 'omnivoice');
  assert.equal(ok.config.speech.voice.prompt, pt);
  assert.equal(ok.config.speech.voice.steps, 8);
  assert.equal(ok.warnings.length, 0);

  // «auto» без середовища чи моделі — простий голос і жодних зауваг (на іншому ПК це нормальний стан)
  for (const broken of [{ ...full, python: path.join(TMP, 'нема.exe') }, { ...full, modelDir: path.join(TMP, 'нема') },
    { ...full, prompt: path.join(TMP, 'нема.pt'), instruct: '' }]) {
    const r = voiceOf(broken);
    assert.equal(r.config.speech.voice.engine, 'piper', JSON.stringify(broken));
    assert.equal(r.warnings.length, 0, JSON.stringify(broken));
  }
  // якщо якісний голос вимагали явно — пояснюємо, чому його немає
  const must = voiceOf({ ...full, engine: 'omnivoice', python: path.join(TMP, 'нема.exe') });
  assert.equal(must.config.speech.voice.engine, 'piper');
  assert.equal(must.warnings.length, 1);
  assert.equal(voiceOf({ ...full, engine: 'piper' }).config.speech.voice.engine, 'piper');

  // без відбитка годиться опис; небезпечні чи безглузді значення не проходять
  assert.equal(voiceOf({ ...full, prompt: '' }).config.speech.voice.prompt, null);
  assert.equal(voiceOf({ ...full, prompt: '' }).config.speech.voice.engine, 'omnivoice');
  assert.equal(voiceOf({ ...full, prompt: '', instruct: 'male"; rm -rf' }).config.speech.voice.engine, 'piper');
  assert.equal(voiceOf({ ...full, python: 'python.exe -c evil' }).config.speech.voice.engine, 'piper');
  assert.equal(voiceOf({ ...full, python: '\\server\share\python.exe' }).config.speech.voice.engine, 'piper');
  const odd = voiceOf({ ...full, speed: 9, steps: 1000 });
  assert.equal(odd.config.speech.voice.speed, 1.1);
  assert.equal(odd.config.speech.voice.steps, 16);
  assert.equal(odd.warnings.length, 2);
  fs.rmSync(TMP, { recursive: true, force: true });
});
