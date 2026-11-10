// Перевірка мовного сервісу через той самий клієнт, що й у застосунку.
// Запуск: node scripts/speech-check.js          — старт, захист токеном, запис із мікрофона (скажи щось)
//         node scripts/speech-check.js --speak  — ще й озвучити коротку фразу
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.OFFGRID_DATA = path.join(ROOT, 'test', '.tmp', `speech-${process.pid}`);
const { validateConfig } = await import('../src/security/config.js');
const { Speech } = await import('../src/speech/client.js');

const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'default.json'), 'utf8'));
const { config, warnings } = validateConfig(defaults, defaults);
if (warnings.length) console.log('Зауваги до налаштувань:', warnings);
if (!config.speech.enabled) { console.log('Голос вимкнено або налаштовано неправильно.'); process.exit(1); }

const speech = new Speech({ onStatus: (s) => console.log(`[стан] ${s.status}${s.error ? ': ' + s.error : ''}`) });
const t0 = performance.now();
await speech.start(config.speech);
let failed = !speech.ready;
try {
  if (!speech.ready) throw new Error('сервіс не запустився');
  console.log(`Сервіс готовий за ${((performance.now() - t0) / 1000).toFixed(1)} с`);

  const noToken = await fetch(speech.base + '/health');
  const badToken = await fetch(speech.base + '/speak', { method: 'POST', headers: { 'X-Offgrid-Token': 'wrong' }, body: '{"text":"x"}' });
  console.log(`Без токена: ${noToken.status}, з чужим токеном: ${badToken.status} (очікується 403 і 403)`);
  if (noToken.status !== 403 || badToken.status !== 403) failed = true;
  const health = await (await fetch(speech.base + '/health', { headers: { 'X-Offgrid-Token': speech.token } })).json();
  console.log('Стан:', JSON.stringify(health));

  if (process.argv.includes('--speak')) {
    const t = performance.now();
    const said = await speech.speak('Перевірка голосу.');
    console.log(`Озвучено за ${((performance.now() - t) / 1000).toFixed(1)} с`, said);
  }

  console.log('Слухаю мікрофон (до 8 с тиші)…');
  const t = performance.now();
  const stopper = process.argv.includes('--quick') ? setTimeout(() => speech.stopListening(), 2500) : null;
  const heard = await speech.listen((e) => console.log(`  [${e.type}] ${e.text ?? ''}`));
  clearTimeout(stopper);
  console.log(`Результат за ${((performance.now() - t) / 1000).toFixed(1)} с:`, heard);
} catch (e) {
  failed = true;
  console.log('ПОМИЛКА:', e.message);
} finally {
  await speech.stop();
  fs.rmSync(process.env.OFFGRID_DATA, { recursive: true, force: true });
}
console.log(failed ? 'ПРОВАЛ' : 'УСПІХ');
process.exit(failed ? 1 : 0);
