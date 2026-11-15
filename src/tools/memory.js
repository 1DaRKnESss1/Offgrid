// Пам'ять і сценарії (зберігаються в базі даних, app/store.js).
//
// Пам'ять. У «забрудненій» розмові (асистент читав файли, сайти, екран) запам'ятати щось можна тільки з дозволу,
// і запит показує весь текст. Але дозвіл — не гарантія, що текст придумав користувач, тому такий факт у базі
// позначається: до наступних розмов він сам не підмішується, а коли його згадують — іде як сторонній текст.
// Факти, записані в чистій розмові, — слова користувача, вони розмову не «забруднюють».
//
// Сценарії — названі послідовності вже наявних дій («режим гри» = відкрити Steam і Discord, зробити гучніше).
// Нічого нового сценарій дозволити не може: кожен крок під час запуску проходить ту саму перевірку, що й
// звичайний виклик (білі списки, підтвердження). Зберегти сценарій можна лише з дозволу користувача — завжди.
import { findTool } from './index.js';
import { str } from './util.js';

/** Що можна класти в сценарій: лише дії, які нічого не читають і не пишуть у файли. */
export const SCENARIO_TOOLS = ['open_app', 'control_pc', 'change_volume', 'timers', 'open_folder', 'open_website'];
const MAX_STEPS = 8;

/** Перевіряє кроки сценарію. Повертає { steps } або { error }. */
export function checkSteps(raw, config) {
  let list = raw;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
  if (!Array.isArray(list) || list.length === 0) return { error: 'Сценарію потрібен хоча б один крок' };
  if (list.length > MAX_STEPS) return { error: `У сценарії може бути щонайбільше ${MAX_STEPS} кроків` };
  const steps = [];
  for (const s of list) {
    const tool = typeof s?.tool === 'string' ? s.tool : '';
    if (!SCENARIO_TOOLS.includes(tool)) return { error: `Крок «${String(tool).slice(0, 30)}» у сценарій додати не можна. Дозволені: ${SCENARIO_TOOLS.join(', ')}` };
    if (!findTool(config, tool)) return { error: `Дія ${tool} зараз недоступна` };
    let args = s.args;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    if (JSON.stringify(args).length > 400) return { error: 'Забагато даних в одному кроці' };
    if (tool === 'timers' && args.action !== 'set') return { error: 'У сценарії таймер можна лише ставити' };
    steps.push({ tool, args });
  }
  return { steps };
}

const sayStep = (step, ctx) => {
  const tool = findTool(ctx.config, step.tool);
  try { return tool?.describe ? tool.describe(step.args, ctx) : step.tool; } catch { return step.tool; }
};

export default [
  {
    name: 'memory',
    confirm: 'tainted',
    schema: () => ({
      description: 'Довга пам\'ять асистента. remember — запам\'ятати те, що сказав користувач; recall — згадати, що він просив запам\'ятати '
        + '(викликай, коли питають «що я казав про…», «де лежить…», «який у мене…»); forget — забути.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['remember', 'recall', 'forget'] },
          text: { type: 'string', description: 'Що запам\'ятати (повним реченням), або про що згадати, або що забути' },
        },
        required: ['action', 'text'],
      },
    }),
    // у запиті — увесь текст, який буде збережено, а не його початок
    describe: ({ action, text }) => (action === 'forget' ? `Забути те, що я пам'ятаю про «${str(text, 500)}»`
      : action === 'recall' ? `Згадати, що я пам'ятаю про «${str(text, 500)}»` : `Запам'ятати назавжди: «${str(text, 500)}»`),
    async run({ action, text }, { os, taint }) {
      const store = os.store;
      if (!store) return { ok: false, error: 'Пам\'ять зараз недоступна' };
      const what = str(text, 500);
      if (action === 'remember') {
        const r = store.remember(what, { tainted: taint > 0 });
        return r.ok ? { ok: true, message: r.known ? 'Це я вже пам\'ятаю' : 'Запам\'ятав' } : r;
      }
      if (action === 'recall') {
        const facts = store.recall(what);
        return facts.length
          // якщо серед згаданого є записане в «забрудненій» розмові — уся відповідь іде як сторонній текст
          ? { ok: true, message: `Згадав: ${facts.length}`, remembered: facts.map((f) => ({ text: f.text, saved: f.created_at.slice(0, 10) })),
            ...(facts.some((f) => f.tainted) ? { untrusted: 'content' } : {}) }
          : { ok: true, message: 'Про це нічого не пам\'ятаю', remembered: [] };
      }
      if (action === 'forget') {
        const gone = store.forget(what);
        return gone.length ? { ok: true, message: `Забув: ${gone.map((f) => f.text).join('; ').slice(0, 200)}` } : { ok: false, error: 'Нічого такого я й не пам\'ятав' };
      }
      return { ok: false, error: 'Невідома дія' };
    },
  },
  {
    name: 'save_scenario',
    confirm: 'always',
    schema: () => ({
      description: 'Зберігає сценарій — названу послідовність дій, яку потім можна запустити однією командою. Користувач підтверджує кнопкою.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Назва сценарію, наприклад «режим гри»' },
          steps: {
            type: 'array',
            description: 'Кроки по порядку',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', enum: SCENARIO_TOOLS },
                args: { type: 'object', description: 'Аргументи цієї дії — такі самі, як при звичайному її виклику' },
              },
              required: ['tool', 'args'],
            },
          },
        },
        required: ['name', 'steps'],
      },
    }),
    async precheck({ name, steps }, ctx) {
      if (!ctx.os.store) return { ok: false, error: 'Сценарії зараз недоступні' };
      if (!str(name, 40)) return { ok: false, error: 'Сценарію потрібна назва' };
      const checked = checkSteps(steps, ctx.config);
      if (checked.error) return { ok: false, error: checked.error };
      ctx.proposal = checked.steps;
      return null;
    },
    describe: ({ name }, ctx) => `Зберегти сценарій «${str(name, 40)}»: ${ctx.proposal.map((s, i) => `${i + 1}) ${sayStep(s, ctx)}`).join('; ')}`,
    async run({ name }, ctx) {
      const r = ctx.os.store.saveScenario(str(name, 40), ctx.proposal);
      if (r.ok) ctx.os.scenariosChanged?.();
      return r.ok ? { ok: true, message: `Сценарій «${r.name}» ${r.replaced ? 'оновлено' : 'збережено'}. Запустити: «запусти ${r.name}»` } : r;
    },
  },
  {
    name: 'scenario',
    confirm: 'tainted',
    schema: () => ({
      description: 'Збережені сценарії: run — запустити за назвою, list — показати всі, delete — видалити.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['run', 'list', 'delete'] }, name: { type: 'string', description: 'Назва сценарію (для run і delete)' } },
        required: ['action'],
      },
    }),
    describe: ({ action, name }) => `${action === 'delete' ? 'Видалити' : 'Запустити'} сценарій «${str(name, 40)}»`,
    async run({ action, name }, ctx) {
      const store = ctx.os.store;
      if (!store) return { ok: false, error: 'Сценарії зараз недоступні' };
      if (action === 'list') {
        const all = store.listScenarios();
        return { ok: true, message: all.length ? `Сценаріїв: ${all.length}` : 'Сценаріїв ще немає', scenarios: all.map((s) => ({ name: s.name, steps: s.steps.length })) };
      }
      const found = store.findScenario(str(name, 40));
      if (!found) return { ok: false, error: `Сценарію «${str(name, 40)}» немає. Є: ${store.listScenarios().map((s) => s.name).join(', ') || 'жодного'}` };
      if (action === 'delete') { store.deleteScenario(found.name); ctx.os.scenariosChanged?.(); return { ok: true, message: `Сценарій «${found.name}» видалено` }; }
      if (action !== 'run') return { ok: false, error: 'Невідома дія' };
      if (typeof ctx.call !== 'function') return { ok: false, error: 'Запустити сценарій зараз не можу' };
      // кожен крок — звичайний виклик інструмента: з білими списками й, де треба, запитом дозволу
      const done = [];
      for (const step of found.steps) {
        const r = SCENARIO_TOOLS.includes(step.tool) ? await ctx.call(step.tool, step.args) : { ok: false, error: 'недозволений крок' };
        done.push(r.ok ? (r.message ?? 'готово') : `не вдалося (${r.error ?? 'помилка'})`);
      }
      const good = done.filter((d) => !d.startsWith('не вдалося')).length;
      return { ok: good > 0, message: `Сценарій «${found.name}»: виконано ${good} з ${done.length}`, steps: done, ...(good ? {} : { error: `Сценарій «${found.name}» не виконався: ${done[0]}` }) };
    },
  },
];
