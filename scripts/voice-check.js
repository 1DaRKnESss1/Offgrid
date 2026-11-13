// Перевірка якісного голосу через той самий клієнт і ті самі налаштування, що й у застосунку.
// Запускає сервіс голосу й озвучує кілька фраз (звук іде на колонки).
//   node scripts/voice-check.js ["своя фраза"]
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadConfig } = await import('../src/security/config.js');
const { Speech, VOICE_SCRIPT } = await import('../src/speech/client.js');

const { config, warnings } = loadConfig();
if (warnings.length) console.log('Зауваги до налаштувань:', warnings);
const v = config.speech?.voice;
console.log('Озвучення відповідей:', config.speakReplies ? 'увімкнене' : 'ВИМКНЕНЕ (кнопка 🔊)');
console.log('Рушій за налаштуваннями:', v?.engine ?? 'голос вимкнено');
if (v?.engine !== 'omnivoice') { console.log('Якісний голос не вибрано або для нього чогось бракує — говорить Piper.'); process.exit(1); }

const voice = new Speech({ onStatus: (s) => console.log(`[стан] ${s.status}${s.error ? ': ' + s.error : ''}`) });
const t0 = performance.now();
await voice.start({ enabled: true, python: v.python }, {
  script: VOICE_SCRIPT,
  env: { HF_HOME: v.modelDir, OFFGRID_VOICE_PROMPT: v.prompt ?? '', OFFGRID_VOICE_INSTRUCT: v.instruct ?? '',
    OFFGRID_VOICE_SPEED: String(v.speed), OFFGRID_VOICE_STEPS: String(v.steps) },
});
let failed = !voice.ready;
try {
  if (!voice.ready) throw new Error('сервіс голосу не запустився');
  console.log(`Сервіс готовий за ${((performance.now() - t0) / 1000).toFixed(1)} с (пристрій: ${voice.device})`);
  const phrases = process.argv[2] ? [process.argv[2]] : ['Привіт, це новий голос Offgrid.', 'Якщо ти це чуєш, усе працює.'];
  const t = performance.now();
  for (const p of phrases) console.log(`  прийнято: ${await voice.say(p)} — «${p}»`);
  const done = await voice.finishSpeaking();
  console.log(`Договорено за ${((performance.now() - t) / 1000).toFixed(1)} с:`, done);
  console.log('Звільнив відеопам\'ять:', await voice.sleep());
} catch (e) {
  failed = true;
  console.log('ПОМИЛКА:', e.message);
} finally {
  await voice.stop();
}
console.log(failed ? 'ПРОВАЛ' : 'УСПІХ');
process.exit(failed ? 1 : 0);
