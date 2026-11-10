// Програми: лише з білого списку в налаштуваннях.
import { TASKLIST, TASKKILL } from './util.js';

async function isRunning(run, processName) {
  // формат CSV: у звичайній таблиці tasklist обрізає довгі назви процесів
  const r = await run(TASKLIST, ['/FI', `IMAGENAME eq ${processName}`, '/FO', 'CSV', '/NH']);
  const wanted = processName.toLowerCase();
  return r.ok && r.stdout.split(/\r?\n/).some((line) => line.split(',')[0].replace(/"/g, '').trim().toLowerCase() === wanted);
}

const closable = (config) => Object.keys(config.apps).filter((k) => config.apps[k].process);

export default [
  {
    name: 'open_app',
    confirm: 'never',
    available: (config) => Object.keys(config.apps).length > 0,
    schema: (config) => ({
      description: 'Відкриває програму на комп\'ютері користувача',
      parameters: {
        type: 'object',
        properties: { app: { type: 'string', enum: Object.keys(config.apps), description: 'Яку програму відкрити' } },
        required: ['app'],
      },
    }),
    describe: ({ app }, { config }) => `Відкрити програму «${config.apps[app]?.name ?? app}»`,
    async run({ app }, { config, os }) {
      const cfg = Object.hasOwn(config.apps, app) ? config.apps[app] : null;
      if (!cfg) return { ok: false, error: `Програми «${app}» немає в списку дозволених` };
      return (await os.launch(cfg.exe))
        ? { ok: true, message: `${cfg.name} відкрито` }
        : { ok: false, error: `Не вдалося запустити ${cfg.name}` };
    },
  },
  {
    name: 'close_app',
    confirm: 'always',
    available: (config) => closable(config).length > 0,
    schema: (config) => ({
      description: 'Закриває програму на комп\'ютері користувача. Користувач сам підтверджує це кнопкою.',
      parameters: {
        type: 'object',
        properties: { app: { type: 'string', enum: closable(config), description: 'Яку програму закрити' } },
        required: ['app'],
      },
    }),
    describe: ({ app }, { config }) => `Закрити програму «${config.apps[app]?.name ?? app}» (незбережене вона може запропонувати зберегти)`,
    // перевіряємо до запиту підтвердження, щоб не питати про те, що й так неможливо
    async precheck({ app }, { config, os }) {
      const cfg = Object.hasOwn(config.apps, app) ? config.apps[app] : null;
      if (!cfg?.process) return { ok: false, error: `Програму «${app}» закривати не дозволено` };
      if (!(await isRunning(os.run, cfg.process))) return { ok: false, error: `${cfg.name} зараз не запущено` };
      return null;
    },
    async run({ app }, { config, os }) {
      const cfg = config.apps[app];
      // без /F: програма закривається «м'яко» і може спитати про збереження
      const r = await os.run(TASKKILL, ['/IM', cfg.process]);
      return r.ok
        ? { ok: true, message: `${cfg.name} закрито` }
        : { ok: false, error: `${cfg.name} запущено, але Windows не дозволила його закрити` };
    },
  },
];
