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

// ---------- Додано за результатами рев'ю етапу 4 ----------
const { finalTail } = await import('../src/agent/tone.js');

test('запитання по суті, що містять «ще», не вважаються черговими', () => {
  for (const keep of [
    'Файл не знайдено. Чи шукати ще в папці Завантаження?',
    'Відкрив звіт. Чи відкрити ще один файл?',
    'Гучність 40. Чи зробити ще тихіше?',
    'Записав молоко. Що ще записати до списку?',
    'Не вийшло. Як ще можна спробувати?',
    'Знайшов три файли. Чи показати ще?',
  ]) assert.equal(stripFiller(keep), keep, keep);
  for (const [from, to] of [
    ['Гучність зменшено. Чим ще можу тобі допомогти?', 'Гучність зменшено.'],
    ['Усе записав. Що ще тебе цікавить?', 'Усе записав.'],
    ['Готово. Чи потрібна ще допомога?', 'Готово.'],
  ]) assert.equal(stripFiller(from), to, from);
});

test('озвучується те саме, що показано: прибраний хвіст не звучить навіть після короткого речення', () => {
  // коротке «Готово.» зливається з наступним реченням — хвіст має зникнути й з озвучення
  const say = (raw) => {
    const said = [];
    let held = [];
    const s = new SentenceSplitter((x) => { said.push(...held); held = []; if (x.endsWith('?')) held.push(x); else said.push(x); });
    for (const ch of raw) s.push(ch);
    s.flush();
    const tail = finalTail(held, raw, stripFiller(raw));
    if (tail) said.push(tail);
    return said.join(' ');
  };
  assert.equal(say('Готово. Що ще потрібно?'), 'Готово.');
  assert.equal(say('Привіт! Чим ще можу допомогти?'), 'Привіт!');
  assert.equal(say('Блокнот відкрито, можеш писати. Чим ще можу допомогти?'), 'Блокнот відкрито, можеш писати.');
  assert.equal(say('Знайшов два файли зі звітом. Який із них відкрити?'), 'Знайшов два файли зі звітом. Який із них відкрити?');
  assert.equal(say('Чим ще можу допомогти?'), 'Чим ще можу допомогти?'); // єдине речення лишається і на екрані, і в озвученні
  assert.equal(say('Котру з двох нотаток прочитати? Першу чи другу?'), 'Котру з двох нотаток прочитати? Першу чи другу?');
});

test('речення: крапка після скорочення — не кінець речення', () => {
  assert.deepEqual(split(['Це на вул. Шевченка, буд. 5, біля парку. ', 'Іти близько 10 хв. пішки.']),
    ['Це на вул. Шевченка, буд. 5, біля парку.', 'Іти близько 10 хв. пішки.']);
  assert.deepEqual(split(['Зараз 16:50. ', 'Сьогодні середа.']), ['Зараз 16:50.', 'Сьогодні середа.']);
});

// Агент із підробленою Ollama: що саме він надсилає моделі та що лишає в історії
test('агент: нагадування про інструменти йде лише в запит і лише до останньої репліки користувача', async () => {
  process.env.OFFGRID_DATA ??= new URL('./.tmp/conv-test/data', import.meta.url).pathname.slice(1);
  const fs = await import('node:fs');
  const { Agent } = await import('../src/agent/agent.js');
  const { validateConfig } = await import('../src/security/config.js');
  const defaults = JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
  const bodies = [];
  let step = 0;
  const { server, url } = await fakeOllama((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      step++;
      res.writeHead(200);
      if (step === 1) {
        // текст перед викликом інструмента — «вступ», який треба прибрати з екрана
        res.write(line({ message: { content: 'Зараз гляну. ' } }));
        res.write(line({ message: { content: '', tool_calls: [{ function: { name: 'get_time', arguments: {} } }] } }));
      } else if (step === 2) {
        res.write(line({ message: { content: 'Зараз 16:50. Чим ще можу допомогти?' } }));
      } else {
        res.write(line({ message: { content: 'Будь ласка.' } }));
      }
      res.end(line({ message: { content: '' }, done: true }));
    });
  });
  try {
    const { config } = validateConfig({ ...defaults, ollamaUrl: url, speech: { enabled: false }, apps: {}, folders: {} }, defaults);
    const events = [];
    const agent = new Agent({ config, os: {}, confirm: async () => false, emit: (e) => events.push(e) });
    const reply = await agent.ask('котра година?');
    assert.equal(reply, 'Зараз 16:50.');
    // крок 1 і крок 2: нагадування є в останній репліці користувача
    for (const b of bodies) {
      const users = b.messages.filter((m) => m.role === 'user');
      assert.match(users.at(-1).content, /Нагадування асистенту/);
      assert.equal(b.stream, true);
    }
    // в історії — чистий текст без нагадування і без чергового запитання
    assert.equal(agent.messages[0].content, 'котра година?');
    assert.equal(agent.messages.at(-1).content, 'Зараз 16:50.');
    assert.ok(agent.messages.every((m) => !String(m.content).includes('Нагадування асистенту')));
    const types = events.map((e) => e.type);
    assert.ok(types.indexOf('reply-reset') > types.indexOf('reply-delta'), 'після вступу перед інструментом має бути reply-reset');
    assert.equal(events.filter((e) => e.type === 'tool')[0].name, 'get_time');
    // друга репліка: нагадування переїжджає на неї, зі старої зникає
    step = 2;
    await agent.ask('дякую');
    const users = bodies.at(-1).messages.filter((m) => m.role === 'user');
    assert.equal(users.length, 2);
    assert.ok(!users[0].content.includes('Нагадування асистенту'));
    assert.ok(users[1].content.includes('Нагадування асистенту'));
  } finally {
    server.close();
    fs.rmSync(new URL('./.tmp/conv-test', import.meta.url), { recursive: true, force: true });
  }
});

test('потокова відповідь: рядок з помилкою посеред відповіді не губиться', async () => {
  const { server, url } = await fakeOllama((req, res) => {
    res.writeHead(200);
    res.end(line({ message: { content: 'Поч' } }) + line({ error: 'model runner has unexpectedly stopped' }));
  });
  try {
    await assert.rejects(() => chat({ ollamaUrl: url, model: 'x' }, [], [], undefined, () => {}), /Ollama повернула помилку/);
  } finally { server.close(); }
});

test('прощальні фрази закінчують розмову, а звичайні команди — ні', async () => {
  const { isGoodbye } = await import('../src/agent/tone.js');
  for (const t of ['Повернусь потім.', 'Дякую, це все', 'на цьому все', 'Все, дякую!', 'Добре, дякую, більше нічого не треба.', 'Гаразд, бувай', 'Ок, я повернуся пізніше', 'Повернусь по тим.']) assert.equal(isGoodbye(t), true, t);
  for (const t of ['Відкрий блокнот', 'Дякую', 'Це все файли в папці?', 'Запиши: повернусь потім о шостій і зателефоную мамі', 'Все добре, відкрий калькулятор', 'котра година', '']) assert.equal(isGoodbye(t), false, t);
});

test('питання про екран розпізнається, а звичайні команди — ні', async () => {
  const { asksAboutScreen } = await import('../src/agent/tone.js');
  for (const q of ['Що ти у мене бачиш на екрані?', 'в мене зараз на екрані', 'Я кажу, що в мене зараз на екрані.', 'що це за помилка на моніторі', 'подивись на екран', 'Що ти бачиш?', 'прочитай з екрана']) assert.equal(asksAboutScreen(q), true, q);
  for (const q of ['відкрий блокнот', 'котра година', 'подивись, чи є файл звіт', 'знайди екранізацію Дюни', 'зроби тихіше']) assert.equal(asksAboutScreen(q), false, q);
});

test('манера співрозмовника: розкута, ввічлива, роздратована, коротка, з проханням пояснити', async () => {
  const { styleHint } = await import('../src/agent/tone.js');
  assert.match(styleHint('йо бро шо ти там'), /розкуто/);
  assert.match(styleHint('Підкажіть, будь ласка, котра година'), /ввічливо/);
  assert.match(styleHint('та що таке, знову не працює'), /роздратований/);
  assert.match(styleHint('чому ти не відкрив??'), /роздратований/);
  assert.match(styleHint('котра година'), /одним коротким/);
  assert.match(styleHint('поясни, як працює відеопам\'ять'), /пояснення/);
  assert.doesNotMatch(styleHint('поясни, як працює відеопам\'ять'), /одним коротким/);
  assert.equal(styleHint('відкрий блокнот і запиши туди список покупок на завтра'), '');
  // слова всередині інших слів не рахуються: «шо» в «шоколад», «ок» в «окуляри»
  assert.doesNotMatch(styleHint('знайди файл про шоколад і окуляри для роботи'), /розкуто/);
});

test('диктування: вмикається і вимикається лише окремою короткою фразою', async () => {
  const { startsDictation, endsDictation } = await import('../src/agent/tone.js');
  for (const q of ['диктування', 'Диктування.', 'режим диктування', 'увімкни диктування', 'друкуй під диктовку']) assert.equal(startsDictation(q), true, q);
  for (const q of ['запиши нотатку про диктування', 'що таке диктування', 'відкрий блокнот']) assert.equal(startsDictation(q), false, q);
  for (const q of ['кінець диктування', 'Стоп диктування.', 'стоп', 'Кінець.']) assert.equal(endsDictation(q), true, q);
  for (const q of ['на цьому кінець історії', 'стоп-кран зірвали']) assert.equal(endsDictation(q), false, q);
});

test('«зробив» без жодного інструмента — теж порожні слова', async () => {
  const { announcesIntent } = await import('../src/agent/tone.js');
  for (const r of ['Зробив тихіше.', 'Зроблено. Гучність зменшена.', 'Згортаю всі вікна.', 'Перекладу виділений текст англійською.',
    'Готово, поставив таймер.', 'Гаразд, викликаю редагування виділеного тексту для виправлення помилок.']) assert.equal(announcesIntent(r, [], false), true, r);
  // після справжнього виклику інструмента звіт «зробив» — це нормальна відповідь
  for (const r of ['Зробив тихіше.', 'Зроблено. Гучність зменшена.', 'Поставив таймер на 5 хвилин.']) assert.equal(announcesIntent(r, [], true), false, r);
  for (const r of ['Не можу цього зробити.', 'Зараз пів на п\'яту.', 'Можу перекласти, якщо виділиш текст.', 'Що саме згорнути?', 'Привіт. Слухаю.', 'Будь ласка.']) assert.equal(announcesIntent(r, [], false), false, r);
});

test('прохання, де інструмент потрібен напевно: екран, виділений текст, час', async () => {
  const { requiredTool } = await import('../src/agent/tone.js');
  const all = ['edit_selection', 'look_at_screen', 'get_time'];
  assert.equal(requiredTool('переклади виділений текст англійською', all).tool, 'edit_selection');
  assert.equal(requiredTool('що в мене на екрані?', all).tool, 'look_at_screen');
  assert.equal(requiredTool('котра година?', all).tool, 'get_time');
  assert.equal(requiredTool('яке сьогодні число', all).nudge, undefined, 'час питаємо одразу, без нагадування');
  assert.equal(requiredTool('відкрий блокнот', all), null);
  assert.equal(requiredTool('нагадай о котрій годині в мене зустріч, вона записана в нотатках про роботу на цей тиждень', all), null);
  assert.equal(requiredTool('котра година?', []), null, 'інструмента немає — нічого не нав\'язуємо');
});

test('«запам\'ятай…» і «що я казав…» ведуть до пам\'яті напряму', async () => {
  const { requiredTool } = await import('../src/agent/tone.js');
  const r = requiredTool('Запам\'ятай, що пароль від вайфаю на холодильнику', ['memory']);
  assert.deepEqual(r, { tool: 'memory', args: { action: 'remember', text: 'пароль від вайфаю на холодильнику' } });
  assert.equal(requiredTool('що я казав про курсову?', ['memory']).args.action, 'recall');
  assert.equal(requiredTool('ти пам\'ятаєш, де мій пароль?', ['memory']).args.action, 'recall');
  assert.equal(requiredTool('відкрий блокнот', ['memory']), null);
});

test('пам\'ять підтягується до запиту сама, а «запусти <сценарій>» розпізнає код', async () => {
  const { memoryHint, requiredTool } = await import('../src/agent/tone.js');
  const { Store } = await import('../src/app/store.js');
  const store = new Store();
  store.remember('Курсову з мереж треба здати двадцятого грудня');
  assert.match(memoryHint(store, 'коли мені здавати курсову?'), /двадцятого грудня/);
  assert.equal(memoryHint(store, 'відкрий блокнот'), '');
  assert.equal(memoryHint(store, 'дякую'), '');
  assert.equal(memoryHint(null, 'коли здавати курсову'), '');
  store.saveScenario('Режим роботи', [{ tool: 'control_pc', args: { action: 'minimize_all' } }]);
  const find = (n) => store.findScenario(n);
  assert.deepEqual(requiredTool('запусти режим роботи', ['scenario'], { findScenario: find }), { tool: 'scenario', args: { action: 'run', name: 'Режим роботи' }, direct: true });
  assert.equal(requiredTool('Увімкни сценарій роботи.', ['scenario'], { findScenario: find }).args.name, 'Режим роботи');
  assert.equal(requiredTool('запусти калькулятор', ['scenario'], { findScenario: find }), null, 'немає такого сценарію — це звичайна команда');
  store.close();
});

test('музичні команди виконує код: пауза, грай, наступний, попередній — і не плутає їх з іншим', async () => {
  const { requiredTool, isEcho } = await import('../src/agent/tone.js');
  const act = (q) => requiredTool(q, ['control_pc', 'scenario'])?.args.action ?? null;
  for (const q of ['постав на паузу', 'Поставь песню на паузу.', 'Пісню на паузу, яка щас грає.', 'Постав пісню, яка наразі грає, на паузу. Це ти маєш зробити.',
    'вимкни відео', 'зупини музику', 'Вимкни відео мені наразі, як і в Ютубі відкрито.', 'пауза']) assert.equal(act(q), 'pause', q);
  for (const q of ['Я хочу, щоб пісня грала.', 'продовж музику', 'зніми з паузи', 'грай далі', 'увімкни музику']) assert.equal(act(q), 'play', q);
  for (const q of ['наступна пісня', 'перемкни трек', 'наступний']) assert.equal(act(q), 'next_track', q);
  for (const q of ['попередня пісня', 'поверни попередній трек']) assert.equal(act(q), 'previous_track', q);
  for (const q of ['відкрий блокнот', 'зроби гучніше', 'запиши нотатку про музику', 'увімкни калькулятор', 'вимкни комп\'ютер', 'яка пісня найкраща у світі на твою думку?']) assert.equal(act(q), null, q);

  assert.equal(isEcho('Постав на паузу.', 'постав на паузу'), true);
  assert.equal(isEcho('Постав на паузу.', 'Пісню на паузу, яка щас грає.', 'Постав на паузу.'), true, 'повторила свою попередню репліку');
  assert.equal(isEcho('Привіт. Слухаю.', 'привіт'), false);
  assert.equal(isEcho('Так.', 'так'), false, 'надто коротке — не луна');
});

test('гучність теж виконує код; луна з коротким додатком розпізнається', async () => {
  const { requiredTool, isEcho } = await import('../src/agent/tone.js');
  const vol = (q) => requiredTool(q, ['change_volume', 'control_pc'])?.args ?? null;
  assert.deepEqual(vol('зроби гучніше'), { action: 'up', amount: 'medium' });
  assert.deepEqual(vol('трохи тихіше'), { action: 'down', amount: 'small' });
  assert.deepEqual(vol('зроби набагато гучніше'), { action: 'up', amount: 'large' });
  assert.equal(vol('вимкни звук').action, 'mute');
  assert.equal(vol('розкажи тихіше про це і не поспішай, будь ласка, бо я нічого не встигаю зрозуміти'), null);
  assert.equal(isEcho('Добре, зроби гучніше.', 'зроби гучніше'), true);
  assert.equal(isEcho('Зробив гучніше на двадцять відсотків, як ти просив.', 'зроби гучніше'), false);
});
