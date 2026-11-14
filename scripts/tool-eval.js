// Перевірка на повторах: чи модель справді викликає інструмент, а не каже «зараз зроблю».
// Запускати після будь-якої зміни системного промпту. Дій на ПК не виконує (заглушки, дані в test/.tmp).
//   node scripts/tool-eval.js [кількість повторів, типово 3]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'test', '.tmp', `eval-${process.pid}`);
process.env.OFFGRID_DATA = path.join(TMP, 'data');

const { validateConfig } = await import('../src/security/config.js');
const { Agent } = await import('../src/agent/agent.js');

const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'default.json'), 'utf8'));
const docs = path.join(TMP, 'docs');
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(docs, 'звіт за жовтень.txt'), 'Продажі зросли на 12 відсотків.');
const { config } = validateConfig({ ...defaults, folders: { documents: { name: 'Документи', path: docs } } }, defaults);

// фраза -> інструмент, який має бути викликаний (null — інструмент не потрібен)
const CASES = [
  ['відкрий блокнот', 'open_app'],
  ['запусти калькулятор', 'open_app'],
  ['знайди файл звіт', 'find_files'],
  ['зроби тихіше', 'change_volume'],
  ['котра година?', 'get_time'],
  ['скільки вільного місця на диску?', 'get_system_info'],
  ['запиши нотатку: купити хліб', 'write_note'],
  ['відкрий ютуб', 'open_website'],
  ['знайди в інтернеті погоду в Харкові', 'search_web'],
  ['відкрий папку документи', 'open_folder'],
  ['постав музику на паузу', 'control_pc'],
  ['вимкни відео, яке зараз грає в ютубі', 'control_pc'],
  ['зроби гучніше', 'change_volume'],
  ['згорни всі вікна', 'control_pc'],
  ['нагадай через десять хвилин зняти чайник', 'timers'],
  ['переклади виділений текст англійською', 'edit_selection'],
  ['виправ помилки у виділеному', 'edit_selection'],
  ['привіт, як справи?', null],
  ['дякую', null],
];

const repeats = Math.max(1, Number(process.argv[2]) || 3);
const os = { pc: async () => ({ ok: true, message: 'ок' }), editSelection: async () => ({ ok: true, message: 'Готово' }), timers: { add: () => ({ ok: true, item: { label: '', due: Date.now() + 60000 } }), list: () => [], cancel: () => [] }, launch: async () => true, run: async () => ({ ok: true, stdout: '' }), openPath: async () => true, openUrl: async () => true, openShellFolder: async () => true };
let pass = 0, total = 0;
const fails = [];
try {
  for (const [phrase, expected] of CASES) {
    let ok = 0;
    for (let i = 0; i < repeats; i++) {
      const called = [];
      const agent = new Agent({ config, os, confirm: async () => true, emit: (e) => { if (e.type === 'tool') called.push(e.name); } });
      let reply = '';
      // непарні повтори — посеред розмови: саме після балачки модель схильна «розповідати» замість діяти
      if (i % 2 === 1) { try { await agent.ask('привіт'); await agent.ask('розкажи коротко, що ти вмієш'); } catch { /* оцінюємо далі */ } called.length = 0; }
      try { reply = await agent.ask(phrase); } catch (e) { reply = `ПОМИЛКА: ${e.message}`; }
      const good = expected ? called.includes(expected) : called.length === 0;
      total++;
      if (good) { ok++; pass++; } else fails.push(`«${phrase}» → [${called.join(', ') || 'без інструмента'}] «${reply.slice(0, 80)}»`);
    }
    console.log(`${ok}/${repeats}  ${phrase}`);
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nРазом: ${pass}/${total}`);
for (const f of fails) console.log('  ✕', f);
process.exit(pass === total ? 0 : 1);
