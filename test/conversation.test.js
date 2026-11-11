// Тести «живої розмови»: поділ на речення, прибирання чергових запитань, потокова відповідь моделі.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { SentenceSplitter } = await import('../src/speech/sentences.js');
const { stripFiller, isFiller } = await import('../src/agent/tone.js');
const { chat } = await import('../src/agent/ollama.js');

function split(pieces) {
  const out = [];
  const s = new SentenceSplitter((x) => out.push(x));
  for (const p of pieces) s.push(p);
  s.flush();
  return out;
}

test('речення віддаються, щойно завершені, навіть якщо текст надходить по складах', () => {
  const text = 'Веселка — це оптичне явище. Вона має сім кольорів! А ти бачив подвійну?';
  const out = [];
  const s = new SentenceSplitter((x) => out.push(x));
  for (const ch of text.slice(0, 40)) s.push(ch);
  assert.deepEqual(out, ['Веселка — це оптичне явище.']); // перше речення вже є, хоча відповідь ще пишеться
  for (const ch of text.slice(40)) s.push(ch);
  s.flush();
  assert.deepEqual(out, ['Веселка — це оптичне явище.', 'Вона має сім кольорів!', 'А ти бачив подвійну?']);
});

test('речення: числа з крапкою не ріжуться, короткі вигуки приєднуються до наступного', () => {
  assert.deepEqual(split(['Вільно 12.5 гігабайта з 50. ', 'Цього досить.']), ['Вільно 12.5 гігабайта з 50.', 'Цього досить.']);
  assert.deepEqual(split(['Так. ', 'Блокнот уже відкрито.']), ['Так. Блокнот уже відкрито.']);
  assert.deepEqual(split(['Перший рядок\nДругий довший рядок']), ['Перший рядок', 'Другий довший рядок']);
  assert.deepEqual(split(['', '   ']), []);
  const s = new SentenceSplitter(() => assert.fail('після reset нічого не має озвучуватись'));
  s.push('Зараз відкрию блокнот');
  s.reset();
  s.flush();
});

test('чергове «чим ще допомогти?» прибирається, змістовні запитання лишаються', () => {
  const cut = {
    'Блокнот відкрито. Що ще потрібно?': 'Блокнот відкрито.',
    'Зараз 16:50. Чим ще можу допомогти?': 'Зараз 16:50.',
    'Готово. Що ще треба знати?': 'Готово.',
    'Нема за що! А чим іще можу допомогти?': 'Нема за що!',
    'Записав. Потрібна ще якась допомога?': 'Записав.',
  };
  for (const [from, to] of Object.entries(cut)) assert.equal(stripFiller(from), to, from);
  for (const keep of ['Блокнот відкрито. Що хочеш у ньому написати?', 'Знайшов два файли. Який відкрити?', 'Привіт! Як можу допомогти?',
    'Чим ще можу допомогти?', 'Щеня спить. Що щеня їсть?', 'Не зрозумів. Який саме файл ще раз відкрити?', '', 'Просто текст без запитань.']) {
    assert.equal(stripFiller(keep), keep, keep);
  }
  assert.equal(isFiller('Чим ще можу допомогти?'), true);
  assert.equal(isFiller('Який файл відкрити?'), false);
});

// Підроблена Ollama: віддає рядки JSON так, як справжня
function fakeOllama(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
const line = (obj) => JSON.stringify(obj) + '\n';

test('потокова відповідь: текст надходить шматками, виклики інструментів збираються', async () => {
  let calls = 0;
  const { server, url } = await fakeOllama((req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    if (calls === 1) {
      res.write(line({ message: { role: 'assistant', content: 'При' } }));
      // рядок, розірваний посеред: клієнт має склеїти
      const rest = line({ message: { role: 'assistant', content: 'віт!' } }) + line({ message: { role: 'assistant', content: '' }, done: true });
      res.write(rest.slice(0, 20));
      setTimeout(() => res.end(rest.slice(20)), 20);
    } else {
      res.write(line({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_time', arguments: {} } }] } }));
      res.end(line({ message: { role: 'assistant', content: '' }, done: true }));
    }
  });
  try {
    const config = { ollamaUrl: url, model: 'x' };
    const pieces = [];
    const a = await chat(config, [], [], undefined, (p) => pieces.push(p));
    assert.deepEqual(pieces, ['При', 'віт!']);
    assert.equal(a.content, 'Привіт!');
    assert.deepEqual(a.tool_calls, []);
    const b = await chat(config, [], []);
    assert.equal(b.tool_calls[0].function.name, 'get_time');
  } finally { server.close(); }
});

test('потокова відповідь: збій до першого слова повторюється один раз, після — ні', async () => {
  let calls = 0;
  const { server, url } = await fakeOllama((req, res) => {
    calls++;
    if (calls === 1) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"llama runner process has terminated: exit status 2"}'); return; }
    res.writeHead(200);
    if (calls === 2) { res.end(line({ message: { content: 'Готово.' } }) + line({ message: { content: '' }, done: true })); return; }
    // обрив посеред відповіді: слово вже показано, тож повторювати не можна (інакше текст задвоїться)
    res.end(line({ message: { content: 'Поч' } }));
  });
  try {
    const config = { ollamaUrl: url, model: 'x' };
    const a = await chat(config, [], []);
    assert.equal(a.content, 'Готово.');
    assert.equal(calls, 2);
    const pieces = [];
    await assert.rejects(() => chat(config, [], [], undefined, (p) => pieces.push(p)), /обірвала/);
    assert.deepEqual(pieces, ['Поч']);
    assert.equal(calls, 3);
  } finally { server.close(); }
});

test('потокова відповідь: скасування обриває запит', async () => {
  const { server, url } = await fakeOllama((req, res) => {
    res.writeHead(200);
    res.write(line({ message: { content: 'Довга ' } }));
    // далі мовчимо — клієнт має вийти сам за сигналом скасування
  });
  try {
    const abort = new AbortController();
    const pending = chat({ ollamaUrl: url, model: 'x' }, [], [], abort.signal, () => abort.abort());
    await assert.rejects(() => pending, /Скасовано/);
  } finally { server.closeAllConnections(); server.close(); }
});
