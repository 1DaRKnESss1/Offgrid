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

speech.start(config.speech);
for (let i = 0; i < 240 && speech.status === 'starting'; i++) await sleep(500);
if (!speech.ready) { console.error('Мовний сервіс не запустився:', speech.error); process.exit(1); }
console.log(`Сервіс готовий (${speech.device}). Імена: ${names.join(', ')}`);

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

try {
  if (process.argv.includes('--say')) {
    console.log(`Скажи протягом 30 с: «${config.wake.name}, котра година»…`);
    const timer = setTimeout(() => speech.stopWaiting(), 30_000);
    const res = await speech.waitForWake(names);
    clearTimeout(timer);
    console.log(res.cancelled ? 'Ім\'я не прозвучало.' : `Почув ім\'я. Команда: «${res.text}»`);
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
