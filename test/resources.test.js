// Тести «сну» асистента: простій, кнопка, поступання іншим програмам. Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.OFFGRID_DATA ??= new URL('./.tmp/res-test/data', import.meta.url).pathname.slice(1);
const { Resources, PRESSURE_CHECKS } = await import('../src/agent/resources.js');
const { validateConfig, saveSetting } = await import('../src/security/config.js');
const { SETTINGS_FILE } = await import('../src/paths.js');
const defaults = JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));

// Керовані таймери: час іде лише тоді, коли тест каже
function fakeTimers() {
  let now = 0, id = 0;
  const jobs = new Map();
  return {
    setTimeout: (fn, ms) => { jobs.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: (i) => jobs.delete(i),
    setInterval: (fn, ms) => { jobs.set(++id, { fn, at: now + ms, every: ms }); return id; },
    clearInterval: (i) => jobs.delete(i),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [key, job] = next;
        now = job.at;
        if (job.every) job.at += job.every; else jobs.delete(key);
        await job.fn();
        await new Promise((r) => setImmediate(r));
      }
      now = end;
    },
    pending: () => jobs.size,
  };
}

function make({ idle = 5, yieldToOtherApps = true, vram = { totalMb: 8151, usedMb: 6900 } } = {}) {
  const env = { config: { idleUnloadMinutes: idle, yieldToOtherApps }, busy: false, vram, released: 0, changes: [], timers: fakeTimers() };
  env.res = new Resources({
    getConfig: () => env.config,
    isBusy: () => env.busy,
    release: async () => { env.released++; },
    readVram: async () => env.vram,
    onChange: (asleep, why) => env.changes.push([asleep, why]),
    timers: env.timers,
  });
  return env;
}

test('сон після простою: пам\'ять звільняється через заданий час і лише раз', async () => {
  const e = make({ idle: 5 });
  e.res.touch();
  await e.timers.advance(4 * 60_000);
  assert.equal(e.res.asleep, false);
  await e.timers.advance(61_000);
  assert.equal(e.res.asleep, true);
  assert.equal(e.released, 1);
  assert.deepEqual(e.changes, [[true, 'idle']]);
  await e.timers.advance(60 * 60_000);
  assert.equal(e.released, 1);
});

test('кожна розмова відсуває сон; 0 хвилин — не засинати ніколи', async () => {
  const e = make({ idle: 5 });
  e.res.touch();
  await e.timers.advance(4 * 60_000);
  e.res.touch(); // щойно поговорили
  await e.timers.advance(4 * 60_000);
  assert.equal(e.res.asleep, false);
  await e.timers.advance(2 * 60_000);
  assert.equal(e.res.asleep, true);

  const never = make({ idle: 0 });
  never.res.touch();
  await never.timers.advance(24 * 60 * 60_000);
  assert.equal(never.res.asleep, false);
  assert.equal(never.released, 0);
});

test('посеред розмови не засинає — ні за часом, ні кнопкою', async () => {
  const e = make({ idle: 1 });
  e.res.touch();
  e.busy = true;
  await e.timers.advance(5 * 60_000);
  assert.equal(e.res.asleep, false);
  assert.equal(await e.res.sleep('manual'), false);
  assert.equal(e.released, 0);
});

test('кнопка «звільнити» і пробудження з командою', async () => {
  const e = make();
  assert.equal(await e.res.sleep('manual'), true);
  assert.equal(e.res.asleep, true);
  assert.equal(await e.res.sleep('manual'), false); // уже спить
  assert.equal(await e.res.wake(), true);            // спав — треба заново ділити відеопам'ять
  assert.equal(await e.res.wake(), false);           // уже не спить
  assert.deepEqual(e.changes, [[true, 'manual'], [false, 'wake']]);
  // після пробудження відлік простою працює знову
  e.res.touch();
  await e.timers.advance(6 * 60_000);
  assert.equal(e.res.asleep, true);
  assert.equal(e.released, 2);
});

test('команда під час засинання дочекається його й розбудить', async () => {
  const e = make();
  let finish;
  e.res.release = () => new Promise((r) => { finish = r; });
  const sleeping = e.res.sleep('manual');
  const waking = e.res.wake();
  finish();
  assert.equal(await sleeping, true);
  assert.equal(await waking, true);
  assert.equal(e.res.asleep, false);
});

test('поступається, коли відеопам\'яті бракує іншій програмі, але не через короткий сплеск', async () => {
  const e = make({ vram: { totalMb: 8151, usedMb: 6900 } });
  e.res.start();
  await e.timers.advance(60_000);
  assert.equal(e.res.asleep, false); // вільно 1,2 ГБ — усе гаразд

  e.vram = { totalMb: 8151, usedMb: 8100 }; // запустили гру
  await e.timers.advance(10_000);
  assert.equal(e.res.asleep, false, 'одного виміру замало');
  e.vram = { totalMb: 8151, usedMb: 6900 }; // сплеск минув
  await e.timers.advance(10_000);
  e.vram = { totalMb: 8151, usedMb: 8100 };
  await e.timers.advance(10_000 * PRESSURE_CHECKS);
  assert.equal(e.res.asleep, true);
  assert.deepEqual(e.changes.at(-1), [true, 'pressure']);
  e.res.stop();
});

test('не поступається, якщо це вимкнено, якщо триває розмова або немає даних про відеопам\'ять', async () => {
  const off = make({ yieldToOtherApps: false, idle: 0, vram: { totalMb: 8151, usedMb: 8140 } });
  off.res.start();
  await off.timers.advance(120_000);
  assert.equal(off.res.asleep, false);
  off.res.stop();

  const busy = make({ idle: 0, vram: { totalMb: 8151, usedMb: 8140 } });
  busy.busy = true;
  busy.res.start();
  await busy.timers.advance(120_000);
  assert.equal(busy.res.asleep, false);
  busy.res.stop();

  const blind = make({ idle: 0, vram: null });
  blind.res.start();
  await blind.timers.advance(120_000);
  assert.equal(blind.res.asleep, false);
  blind.res.stop();
});

test('налаштування: час простою й поступання', () => {
  assert.equal(validateConfig(defaults, defaults).config.idleUnloadMinutes, 5);
  assert.equal(validateConfig(defaults, defaults).config.yieldToOtherApps, true);
  assert.equal(validateConfig({ ...defaults, idleUnloadMinutes: 0, yieldToOtherApps: false }, defaults).config.idleUnloadMinutes, 0);
  for (const bad of [-1, 2.5, 500, '5', null]) {
    const { config, warnings } = validateConfig({ ...defaults, idleUnloadMinutes: bad }, defaults);
    assert.equal(config.idleUnloadMinutes, 5, String(bad));
    assert.ok(warnings.some((w) => w.includes('idleUnloadMinutes')), String(bad));
  }
  fs.mkdirSync(new URL('./.tmp/res-test/data', import.meta.url), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ apps: {}, mine: 1 }));
  assert.equal(saveSetting('idleUnloadMinutes', 10), true);
  assert.equal(saveSetting('yieldToOtherApps', false), true);
  for (const [k, v] of [['idleUnloadMinutes', 999], ['idleUnloadMinutes', '10'], ['yieldToOtherApps', 1], ['model', 'x'], ['__proto__', true]]) {
    assert.equal(saveSetting(k, v), false, `${k}=${v}`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')), { apps: {}, mine: 1, idleUnloadMinutes: 10, yieldToOtherApps: false });
  fs.rmSync(new URL('./.tmp/res-test', import.meta.url), { recursive: true, force: true });
});
