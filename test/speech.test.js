// Тести голосової частини, які не потребують ні моделей, ні мікрофона. Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp', `speech-test-${process.pid}`);
process.env.OFFGRID_DATA = path.join(TMP, 'data');

const { validateConfig } = await import('../src/security/config.js');
const { cleanForSpeech, Speech } = await import('../src/speech/client.js');

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
