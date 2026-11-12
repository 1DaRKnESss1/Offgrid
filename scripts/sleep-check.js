// Живий замір «сну»: скільки відеопам'яті звільняється і скільки триває пробудження.
// Запускає справжній мовний сервіс і справжню модель; звуку не відтворює, мікрофон вмикає на кілька секунд.
//   node scripts/sleep-check.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.OFFGRID_DATA = path.join(ROOT, 'test', '.tmp', `sleep-${process.pid}`);
const { validateConfig } = await import('../src/security/config.js');
const { Speech } = await import('../src/speech/client.js');
const { readVram, decideGpuLayers } = await import('../src/agent/gpu.js');
const { setGpuLayers, unloadModel, preloadModel, chat } = await import('../src/agent/ollama.js');

const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'default.json'), 'utf8'));
const { config } = validateConfig(defaults, defaults);
const used = async () => (await readVram())?.usedMb ?? NaN;
const sec = (t) => ((performance.now() - t) / 1000).toFixed(1);
const say = async () => {
  const t = performance.now();
  const m = await chat(config, [{ role: 'user', content: 'скажи одне слово: привіт' }], [], undefined, () => {});
  return `${sec(t)} с («${m.content.trim().slice(0, 30)}»)`;
};

const speech = new Speech();
try {
  await unloadModel(config);
  await new Promise((r) => setTimeout(r, 1500));
  const base = await used();
  console.log(`Без асистента зайнято відеопам'яті: ${base} МБ`);

  await speech.start(config.speech);
  if (!speech.ready) throw new Error(`мовний сервіс не запустився: ${speech.error}`);
  const plan = await decideGpuLayers(config);
  setGpuLayers(plan.layers);
  console.log(`Розпізнавання: ${speech.device === 'gpu' ? 'відеокарта' : 'процесор'}; план: ${plan.note}`);
  console.log(`Перша відповідь (із завантаженням моделі): ${await say()}`);
  console.log(`Друга відповідь: ${await say()}`);
  const awake = await used();
  console.log(`Асистент не спить: ${awake} МБ (його частка ≈ ${awake - base} МБ)`);

  // --- сон ---
  let t = performance.now();
  await unloadModel(config);
  const freed = await speech.sleep();
  await new Promise((r) => setTimeout(r, 1500));
  const asleep = await used();
  console.log(`Заснув за ${sec(t)} с (розпізнавання вивантажено: ${freed}). Зайнято: ${asleep} МБ — звільнено ${awake - asleep} МБ, лишилось зайвих ${asleep - base} МБ`);

  // --- пробудження: як у застосунку — план, завантаження моделі у фоні, одночасно запис ---
  t = performance.now();
  const plan2 = await decideGpuLayers(config, { reserveMb: speech.device === 'gpu' ? 1300 : 0 });
  setGpuLayers(plan2.layers);
  const loading = preloadModel(config);
  const stop = setTimeout(() => speech.stopListening(), 2500);
  const heard = await speech.listen(() => {}, { waitSeconds: 3 });
  clearTimeout(stop);
  console.log(`Запис і розпізнавання після сну: ${sec(t)} с (текст: «${heard.text ?? ''}»)`);
  await loading;
  console.log(`Модель знову в пам'яті через ${sec(t)} с від пробудження; відповідь після цього: ${await say()}`);
  console.log(`Після пробудження зайнято: ${await used()} МБ`);
} catch (e) {
  console.log('ПОМИЛКА:', e.message);
  process.exitCode = 1;
} finally {
  await speech.stop();
  fs.rmSync(process.env.OFFGRID_DATA, { recursive: true, force: true });
}
