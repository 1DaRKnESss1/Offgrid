// Тести розподілу відеопам'яті для моделі асистента і пов'язаних налаштувань. Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

process.env.OFFGRID_DATA ??= new URL('./.tmp/gpu-test/data', import.meta.url).pathname.slice(1);
const { planGpuLayers, decideGpuLayers } = await import('../src/agent/gpu.js');
const { validateConfig } = await import('../src/security/config.js');
const { chat, setGpuLayers } = await import('../src/agent/ollama.js');
const defaults = JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));

// Числа з реальних замірів: RTX 5060 Ti 8 ГБ, qwen3.5:9b (файл 6,55 ГБ, 32 шари, повністю у відеопам'яті — 5,6 ГБ)
const card = { totalMb: 8151, fileGb: 6.55, blockCount: 32 };

test('відеопам\'ять: якщо модель вміщається цілком — усі шари на відеокарті', () => {
  assert.equal(planGpuLayers({ ...card, othersMb: 900 }), 99);                    // лише робочий стіл
  assert.equal(planGpuLayers({ ...card, othersMb: 900 + 1200 }), 99);             // ще й розпізнавання мови
  assert.equal(planGpuLayers({ ...card, othersMb: 900, reserveMb: 1300 }), 99);   // розпізнавання ще вантажиться
});

test('відеопам\'ять: якщо тісно — шарів рівно стільки, щоб не переповнити', () => {
  const tight = planGpuLayers({ ...card, othersMb: 2000 + 1200 }); // Discord, браузер і розпізнавання
  assert.ok(tight < 34 && tight >= 20, `очікував 20–33, отримав ${tight}`);
  // заміряно: 30 шарів займають ~4,9 ГБ — план не має вимагати більше, ніж є
  const mbFor = (layers) => 920 + 133 * layers;
  assert.ok(mbFor(tight) <= 8151 - 3200, 'план не вміщається у вільну відеопам\'ять');
  const game = planGpuLayers({ ...card, othersMb: 5700 }); // запущена гра
  assert.ok(game >= 0 && game <= 10, `з грою на відеокарті має лишитись кілька шарів, отримав ${game}`);
  assert.equal(planGpuLayers({ ...card, othersMb: 8000 }), 0);
  // що більше зайнято, то менше шарів — без стрибків у зворотний бік
  let prev = 99;
  for (let others = 0; others <= 8151; others += 250) {
    const n = planGpuLayers({ ...card, othersMb: others });
    assert.ok(n <= prev, `others=${others}: ${n} > ${prev}`);
    prev = n;
  }
});

test('відеопам\'ять: без даних план не вигадується', () => {
  assert.equal(planGpuLayers({ totalMb: NaN, othersMb: 0, fileGb: 6.5, blockCount: 32 }), null);
  assert.equal(planGpuLayers({ totalMb: 8151, othersMb: 0, fileGb: 6.5, blockCount: 0 }), null);
  assert.equal(planGpuLayers({ totalMb: 8151, othersMb: 0, fileGb: undefined, blockCount: 32 }), null);
});

test('налаштування: gpuLayers і пристрій розпізнавання', () => {
  const ok = validateConfig({ ...defaults, gpuLayers: 28 }, defaults);
  assert.equal(ok.config.gpuLayers, 28);
  assert.equal(validateConfig(defaults, defaults).config.gpuLayers, 'auto');
  for (const bad of [-1, 100, 3.5, '28', null, 'max']) {
    const { config, warnings } = validateConfig({ ...defaults, gpuLayers: bad }, defaults);
    assert.equal(config.gpuLayers, 'auto', String(bad));
    assert.ok(warnings.some((w) => w.includes('gpuLayers')), String(bad));
  }
});

test('gpuLayers із налаштувань має перевагу й не чіпає Ollama; число потрапляє в запит', async () => {
  // задане число: рішення миттєве, без жодного звернення до Ollama (адреса навмисно неробоча)
  const fixed = await decideGpuLayers({ gpuLayers: 20, model: 'x', ollamaUrl: 'http://127.0.0.1:9' });
  assert.equal(fixed.layers, 20);
  // Ollama недоступна в режимі auto: план не вигадується, розподіл лишається за нею
  const none = await decideGpuLayers({ gpuLayers: 'auto', model: 'x', ollamaUrl: 'http://127.0.0.1:9' });
  assert.equal(none.layers, null);
  assert.ok(none.note.length > 0);

  // число шарів справді йде в запит до моделі, а null — ні
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200);
      res.end(JSON.stringify({ message: { content: 'ок' } }) + '\n' + JSON.stringify({ message: { content: '' }, done: true }) + '\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const config = { ollamaUrl: `http://127.0.0.1:${server.address().port}`, model: 'x' };
    setGpuLayers(99);
    await chat(config, [], []);
    setGpuLayers(null);
    await chat(config, [], []);
    setGpuLayers(-5); // некоректне значення не має потрапити в запит
    await chat(config, [], []);
    assert.equal(bodies[0].options.num_gpu, 99);
    assert.equal('num_gpu' in bodies[1].options, false);
    assert.equal('num_gpu' in bodies[2].options, false);
  } finally {
    setGpuLayers(null);
    server.close();
    fs.rmSync(new URL('./.tmp/gpu-test', import.meta.url), { recursive: true, force: true });
  }
});
