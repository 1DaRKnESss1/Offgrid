// Тести оболонки без Electron: сервер панелі, розбір гарячої клавіші, час словами, «сказав, але не зробив».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

process.env.OFFGRID_DATA ??= new URL('./.tmp/app-test/data', import.meta.url).pathname.slice(1);
const { PanelServer } = await import('../src/app/server.js');
const { parseHotkey } = await import('../src/app/host.js');
const { timeInWords } = await import('../src/tools/system.js');
const { announcesIntent } = await import('../src/agent/tone.js');
const { Agent } = await import('../src/agent/agent.js');
const { validateConfig } = await import('../src/security/config.js');
const defaults = JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));

// Запит до сервера «як є», з довільними заголовками (fetch не дає підмінити Host і Origin)
function raw(port, { method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; if (res.headers['content-type']?.startsWith('text/event-stream')) { resolve({ status: res.statusCode, headers: res.headers, data, res }); } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('сервер панелі: без ключа не віддає ні сторінку, ні події, ні команди', async () => {
  const calls = [];
  const server = new PanelServer({ ask: async (b) => { calls.push(b); return true; }, ready: async () => ({ ok: 1 }) });
  const url = new URL(await server.listen());
  const port = Number(url.port);
  const host = `127.0.0.1:${port}`;
  try {
    for (const path of ['/', '/app.js', '/events']) assert.equal((await raw(port, { path, headers: { host } })).status, 403, path);
    assert.equal((await raw(port, { method: 'POST', path: '/api/ask', headers: { host, 'content-type': 'application/json' }, body: '{"text":"x"}' })).status, 403);
    assert.equal((await raw(port, { path: '/?k=' + 'a'.repeat(64), headers: { host } })).status, 403);
    assert.equal(calls.length, 0);

    // правильний ключ: він міняється на cookie, а з адреси зникає
    const first = await raw(port, { path: url.pathname + url.search, headers: { host } });
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, '/');
    const cookie = first.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const auth = { host, cookie: cookie.split(';')[0] };

    const page = await raw(port, { path: '/', headers: auth });
    assert.equal(page.status, 200);
    assert.match(page.data, /<title>Offgrid<\/title>/);
    assert.match(page.data, /connect-src 'self'/);
    assert.equal((await raw(port, { path: '/bridge.js', headers: auth })).status, 200);
    // нічого поза переліком файлів панелі
    for (const path of ['/../package.json', '/..%2f..%2fpackage.json', '/data/settings.json', '/app.js/../../../package.json', '/index.html']) {
      assert.equal((await raw(port, { path, headers: auth })).status, 404, path);
    }

    const ok = await raw(port, { method: 'POST', path: '/api/ask', headers: { ...auth, 'content-type': 'application/json' }, body: '{"text":"привіт"}' });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, [{ text: 'привіт' }]);

    // із cookie, але не «своїм» запитом: чужий сайт, підмінене ім'я, не JSON, невідома команда, завелике тіло
    const post = (extra, body = '{}', path = '/api/ask') => raw(port, { method: 'POST', path, headers: { ...auth, 'content-type': 'application/json', ...extra }, body });
    assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ host: `evil.example:${port}` })).status, 403);
    assert.equal((await post({ 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post({}, '{}', '/api/format-disk')).status, 404);
    assert.equal((await post({}, '{}', '/api/__proto__')).status, 404);
    assert.equal((await post({}, 'не json')).status, 400);
    assert.equal((await post({}, JSON.stringify({ text: 'x'.repeat(70_000) }))).status, 413);
    assert.equal(calls.length, 1);

    // події доходять лише до панелі
    const stream = await raw(port, { path: '/events', headers: auth });
    assert.equal(stream.status, 200);
    const got = new Promise((resolve) => stream.res.on('data', (d) => { if (String(d).includes('state')) resolve(String(d)); }));
    server.broadcast({ type: 'state', state: 'thinking' });
    assert.match(await got, /data: \{"type":"state","state":"thinking"\}/);
    stream.res.destroy();
  } finally { server.close(); }
});

test('гаряча клавіша: назви з налаштувань перетворюються на коди Windows', () => {
  assert.deepEqual(parseHotkey('Control+Shift+Space'), { mods: 2 | 4, vk: 0x20 });
  assert.deepEqual(parseHotkey('Alt+F9'), { mods: 1, vk: 0x78 });
  assert.deepEqual(parseHotkey('Control+Alt+O'), { mods: 3, vk: 0x4f });
  assert.deepEqual(parseHotkey('Super+Alt+1'), { mods: 9, vk: 0x31 });
  for (const bad of ['Space', 'Control+Control+A', 'Control+Escape', 'Hyper+A', 'Control+', '', null, 'Control+Shift']) {
    assert.equal(parseHotkey(bad), null, String(bad));
  }
});

test('час словами складає код, а не модель', () => {
  assert.equal(timeInWords(13, 33), 'тринадцята тридцять три');
  assert.equal(timeInWords(9, 0), 'дев\'ята рівно');
  assert.equal(timeInWords(0, 5), 'нуль нуль п\'ять');
  assert.equal(timeInWords(23, 59), 'двадцять третя п\'ятдесят дев\'ять');
  assert.equal(timeInWords(16, 50), 'шістнадцята п\'ятдесят');
  assert.equal(timeInWords(7, 10), 'сьома десять');
});

test('«сказав, але не зробив»: намір розпізнається, справжні відповіді — ні', () => {
  const names = ['get_time', 'write_note', 'open_app', 'open_website'];
  // приклади з реального користування
  const intent = [
    ['Потрібно дізнатися час. Запитую у системи.', false],
    ['Блокнот відкрито. Щоб дізнатися поточний час, використаю інструмент get_time.', true],
    ['Поточний час — 22:31. Щоб записати це в блокноті, використаю інструмент запису нотатки.', true],
    ['Якщо просять відкрити YouTube — використаю open_website з адресою https://www.youtube.com.', false],
    ['Зроблю тихіше.', false],
    ['Зараз зменшу гучність на 20%.', false],
    ['Шукаю файли, що містять слово «звіт» у папці Документи.', false],
    ['Відкриваю блокнот.', false],
  ];
  for (const [text, did] of intent) assert.equal(announcesIntent(text, names, did), true, text);
  const answer = [
    ['Блокнот відкрито.', true],
    ['Відкриваю youtube.com', true],                    // після виклику інструмента це звіт, а не намір
    ['Зараз тринадцята тридцять три, п\'ятниця.', true],
    ['Можу записати це як нотатку. Записати?', false],  // уточнення в користувача
    ['Я цього не зроблю, бо це небезпечно.', false],    // відмова
    ['Привіт! Усе добре, працюю.', false],
    ['Знайшов два файли. Який відкрити?', true],
    ['Я не вмію керувати яскравістю екрана.', false],
    ['Гучність зменшено приблизно на 20%.', true],
  ];
  for (const [text, did] of answer) assert.equal(announcesIntent(text, names, did), false, text);
});

test('агент: якщо модель лише пообіцяла, він один раз вимагає виконати — і відкинута репліка не лишає слідів', async () => {
  const bodies = [];
  let step = 0;
  const line = (o) => JSON.stringify(o) + '\n';
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      step++;
      res.writeHead(200);
      if (step === 1) res.write(line({ message: { content: 'Потрібно дізнатися час. Запитую у системи.' } }));
      else if (step === 2) res.write(line({ message: { content: '', tool_calls: [{ function: { name: 'get_time', arguments: {} } }] } }));
      else if (step === 3) res.write(line({ message: { content: 'Зараз тринадцята тридцять три.' } }));
      else res.write(line({ message: { content: 'Зараз перевірю ще раз.' } })); // другий раз поспіль уже не підганяємо
      res.end(line({ message: { content: '' }, done: true }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    const { config } = validateConfig({ ...defaults, ollamaUrl: `http://127.0.0.1:${fake.address().port}`, speech: { enabled: false }, apps: {}, folders: {} }, defaults);
    const events = [];
    const agent = new Agent({ config, os: {}, confirm: async () => false, emit: (e) => events.push(e) });
    assert.equal(await agent.ask('котра година?'), 'Зараз тринадцята тридцять три.');
    assert.equal(bodies.length, 3);
    // у другому запиті модель бачить свою репліку і вимогу діяти
    const second = bodies[1].messages;
    assert.equal(second.at(-2).content, 'Потрібно дізнатися час. Запитую у системи.');
    assert.match(second.at(-1).content, /Виклич потрібний інструмент/);
    // …а в третьому й в історії цього вже немає
    assert.ok(!bodies[2].messages.some((m) => /Запитую у системи|Виклич потрібний інструмент/.test(String(m.content))));
    assert.ok(!agent.messages.some((m) => /Запитую у системи|Виклич потрібний інструмент/.test(String(m.content))));
    // відкинуту репліку панель прибирає
    assert.ok(events.some((e) => e.type === 'reply-reset'));
    assert.equal(events.filter((e) => e.type === 'tool').length, 1);

    // якщо модель і після вимоги лише обіцяє — приймаємо як є, а не зациклюємось
    step = 0;
    bodies.length = 0;
    const stubborn = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => { step++; res.writeHead(200); res.end(line({ message: { content: 'Зараз перевірю.' } }) + line({ message: { content: '' }, done: true })); });
    });
    await new Promise((r) => stubborn.listen(0, '127.0.0.1', r));
    const cfg2 = validateConfig({ ...defaults, ollamaUrl: `http://127.0.0.1:${stubborn.address().port}`, speech: { enabled: false }, apps: {}, folders: {} }, defaults).config;
    const agent2 = new Agent({ config: cfg2, os: {}, confirm: async () => false });
    try {
      // на загальне прохання впертій моделі лишаємо останнє слово після однієї вимоги
      assert.equal(await agent2.ask('зроби щось корисне'), 'Зараз перевірю.');
      assert.equal(step, 2);
      // а там, де інструмент потрібен напевно (час), його викликає сам код — і лише раз
      step = 0;
      const seen = [];
      const agent3 = new Agent({ config: cfg2, os: {}, confirm: async () => false, emit: (e) => { if (e.type === 'tool') seen.push(e.name); } });
      await agent3.ask('котра година?');
      assert.deepEqual(seen, ['get_time']);
      assert.equal(step, 3);
    } finally { stubborn.close(); }
  } finally {
    fake.close();
    fs.rmSync(new URL('./.tmp/app-test', import.meta.url), { recursive: true, force: true });
  }
});

// ---------- Додано за результатами рев'ю ----------
const { isValidHotkey } = await import('../src/security/config.js');
const { Resources } = await import('../src/agent/resources.js');

test('сервер панелі: ключ діє один раз, а далі потрібен секрет із cookie', async () => {
  const got = [];
  const server = new PanelServer({ ask: async (b) => { got.push(b.text); return true; } });
  const url = new URL(await server.listen());
  const port = Number(url.port);
  const host = `127.0.0.1:${port}`;
  try {
    const first = await raw(port, { path: url.pathname + url.search, headers: { host } });
    assert.equal(first.status, 302);
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    const key = url.searchParams.get('k');
    // той, хто підгледів адресу запуску, нічого з нею не зробить: ключ уже використано…
    assert.equal((await raw(port, { path: url.pathname + url.search, headers: { host } })).status, 403);
    // …а сам ключ не є секретом cookie
    assert.ok(!cookie.includes(key));
    const post = (headers, body = '{"text":"x"}') => raw(port, { method: 'POST', path: '/api/ask', headers: { host, 'content-type': 'application/json', ...headers }, body });
    assert.equal((await post({ cookie: `offgrid=${key}` })).status, 403);
    assert.equal((await post({ cookie: 'offgrid=' + 'a'.repeat(64) })).status, 403);
    assert.equal((await post({ cookie, origin: 'null' })).status, 403);
    assert.equal(got.length, 0);

    // кирилиця, розірвана між двома шматками мережевого пакета, збирається без «�»
    const body = Buffer.from(JSON.stringify({ text: 'відкрий блокнот і запиши нотатку' }));
    const cut = body.indexOf(Buffer.from('б')) + 1; // посеред двобайтової літери
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/ask',
        headers: { host, cookie, 'content-type': 'application/json', 'content-length': body.length } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.write(body.subarray(0, cut));
      setTimeout(() => req.end(body.subarray(cut)), 30);
    });
    assert.equal(status, 200);
    assert.deepEqual(got, ['відкрий блокнот і запиши нотатку']);
  } finally { server.close(); }
});

test('«вимога виконати» не перетворює пропозицію, уточнення чи відмову на дію', () => {
  const names = ['get_time', 'write_note'];
  for (const [text, did] of [
    ['Якщо хочеш, запишу це в нотатки.', false],
    ['Яку нотатку відкрити? Скажи назву, і я відкрию.', false],
    ['Не можу: спершу дозволь, тоді відкрию.', false],
    ['Я вмію таке: відкрию програму, знайду файл, запишу нотатку.', false],
    ['Гаразд, закрию пізніше, якщо скажеш.', true],
    ['Готово, час я отримав через get_time: тринадцята тридцять три.', true],
    ['Я запитую час у системі — чекати треба?', false],
  ]) assert.equal(announcesIntent(text, names, did), false, text);
});

test('гаряча клавіша з файлу налаштувань перевіряється так само суворо, як із панелі', () => {
  assert.equal(isValidHotkey('Control+Shift+Space'), true);
  for (const bad of ['Shift+A', 'A', 'Control+Control+A', 'Alt+Tab', 'whatever']) {
    const { config, warnings } = validateConfig({ ...defaults, hotkey: bad }, defaults);
    assert.equal(config.hotkey, defaults.hotkey, bad);
    assert.ok(warnings.some((w) => w.startsWith('hotkey:')), bad);
  }
  assert.equal(validateConfig({ ...defaults, hotkey: 'Alt+F9' }, defaults).config.hotkey, 'Alt+F9');
});

test('сон після простою: якщо момент був невдалий, спроба повторюється сама', async () => {
  let now = 0, id = 0;
  const jobs = new Map();
  const timers = {
    setTimeout: (fn, ms) => { jobs.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: (i) => jobs.delete(i),
    setInterval: () => 0, clearInterval: () => {},
  };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const next = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      jobs.delete(next[0]); now = next[1].at;
      await next[1].fn();
      await new Promise((r) => setImmediate(r));
    }
    now = end;
  };
  let busy = true, released = 0;
  const res = new Resources({ getConfig: () => ({ idleUnloadMinutes: 5 }), isBusy: () => busy, release: async () => { released++; },
    readVram: async () => null, timers });
  res.touch();
  await advance(5 * 60_000 + 1000);   // час вийшов, але відкрито діалог
  assert.equal(res.asleep, false);
  busy = false;                        // діалог закрили, нових розмов не було
  await advance(6 * 60_000);
  assert.equal(res.asleep, true, 'мав заснути без нової розмови');
  assert.equal(released, 1);
});
