// Перевірка режиму «відгук на ім'я» на живому мовному сервісі (без звуку з колонок):
//   node scripts/wake-check.js           — очікування вмикається, зупиняється й не заважає звичайному запису
//   node scripts/wake-check.js --say     — чекає 30 с, доки ти назвеш асистента на ім'я, і показує, що почув
// Мікрофон на час перевірки ввімкнено; усе, що сказано без імені, сервіс відкидає.
import { loadConfig } from '../src/security/config.js';
import { TOOL_MODES } from '../src/security/policy.js';
import { Speech } from '../src/speech/client.js';

const { config } = loadConfig({ toolModes: TOOL_MODES });
const names = [config.wake.name, ...config.wake.aliases];
const speech = new Speech({ onStatus: () => {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// у режимі --say сервіс показує й фрази без імені — лише тут, для перевірки; застосунок цього не вмикає
if (process.argv.includes('--say')) process.env.OFFGRID_WAKE_DEBUG = '1';
speech.start(config.speech);
for (let i = 0; i < 240 && speech.status === 'starting'; i++) await sleep(500);
if (!speech.ready) { console.error('Мовний сервіс не запустився:', speech.error); process.exit(1); }
console.log(`Сервіс готовий (${speech.device}). Імена: ${names.join(', ')}`);

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

try {
  if (process.argv.includes('--hear')) {
    // показує, як розпізнавання записує ім'я з твого голосу (щоб додати ці варіанти в aliases)
    for (let i = 1; i <= 6; i++) {
      console.log(`${i}/6. Скажи: «${config.wake.name}, котра година»…`);
      const t = Date.now();
      const events = [];
      const heard = await speech.listen((e) => { if (e.type !== 'partial' && !events.includes(e.type)) events.push(e.type); }, { waitSeconds: 8 });
      console.log(`     почув: «${heard.text ?? ''}»  (${((Date.now() - t) / 1000).toFixed(1)} с; події: ${events.join(', ') || 'жодної'}; ${JSON.stringify(heard)})`);
    }
  } else if (process.argv.includes('--say')) {
    // двічі: коли розпізнавання на відеокарті, і коли воно вивантажене (як уві сні) — тоді слухає мала модель
    for (const asleep of [false, true]) {
      if (asleep) await speech.sleep();
      console.log(`\n${asleep ? 'УВІ СНІ (мала модель на процесорі)' : 'ЗВИЧАЙНИЙ СТАН (відеокарта)'}: протягом 25 с кілька разів скажи «${config.wake.name}, котра година»`);
      const until = Date.now() + 25_000;
      while (Date.now() < until) {
        let stopping = null;
        const timer = setTimeout(() => { stopping = speech.stopWaiting(); }, Math.max(0, until - Date.now()));
        const res = await speech.waitForWake(names, (e) => console.log(`   почув${e.accurate ? '' : ' (мала модель)'}: «${e.text}» — ім'я ${e.found ? 'Є' : 'немає'}`));
        clearTimeout(timer);
        await stopping; // мікрофон має справді звільнитися, перш ніж слухати знову
        if (!res.cancelled) console.log(`   => відгукнувся б. Команда: «${res.text}»`);
        if (asleep) await speech.sleep().catch(() => {});
      }
    }
  } else {
    for (const asleep of [false, true]) {
      if (asleep) check(await speech.sleep() !== undefined, 'розпізнавання вивантажено (як уві сні)');
      const waiting = speech.waitForWake(names);
      await sleep(1500);
      check(speech.waiting, `очікування імені триває${asleep ? ' і вві сні' : ''}`);
      const t = Date.now();
      await speech.stopWaiting();
      const res = await waiting;
      check(res.cancelled === true, `очікування зупинено за ${Date.now() - t} мс`);
      // одразу після зупинки звичайний запис має початися, а не відмовити «вже слухаю»
      const listening = speech.listen(() => {}, { waitSeconds: 2 });
      await sleep(300);
      speech.cancel();
      const heard = await listening.catch((e) => ({ error: e.message }));
      check(!heard.error, `звичайний запис після очікування${heard.error ? ': ' + heard.error : ''}`);
      await sleep(300);
    }
  }
} finally {
  await speech.stop();
}
process.exit(failed ? 1 : 0);
