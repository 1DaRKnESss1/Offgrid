// Пропозиції розширити білі списки: програми, папки, типи файлів.
// Асистент НЕ може додати щось сам. Кожен із цих інструментів лише готує пропозицію, а рішення приймає
// користувач кнопкою в острівці — завжди, хоч би які були налаштування підтвердження. Запис робить той самий
// код, що й екран налаштувань, із тими самими перевірками: системну папку, скрипт чи мережевий шлях він не прийме.
import fs from 'node:fs';
import path from 'node:path';
import { expandFolder, resolveExe, OPENABLE, READABLE } from '../security/config.js';
import { findApps } from './appfinder.js';
import { str } from './util.js';

const KNOWN_FOLDERS = { downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop', pictures: 'Pictures', music: 'Music', videos: 'Videos' };
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
// якщо в цій розмові асистент уже читав чужий текст, прохання могло прийти звідти, а не від користувача
const warn = (ctx) => (ctx.taint > 0 ? ' УВАГА: у цій розмові я читав файли чи сайти — дозволяй, лише якщо просив про це сам.' : '');
const unavailable = { ok: false, error: 'Зміна списків зараз недоступна. Користувач може зробити це сам: налаштування в панелі.' };

function apply(ctx, change, payload, done) {
  if (typeof ctx.os.allow !== 'function') return unavailable;
  const res = ctx.os.allow(change, payload);
  return res.ok ? { ok: true, message: done } : { ok: false, error: res.error ?? 'Не вдалося змінити налаштування' };
}

export default [
  {
    name: 'allow_app',
    confirm: 'always',
    schema: () => ({
      description: 'Пропонує користувачеві додати встановлену програму чи гру до списку дозволених (він підтверджує кнопкою). '
        + 'Шлях до програми знаходить система за назвою. Викликай, коли користувач просить дозволити, додати чи запам\'ятати програму.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Назва програми так, як вона пишеться насправді: Steam, Discord, Telegram, Deadlock' } },
        required: ['name'],
      },
    }),
    async precheck({ name }, ctx) {
      const query = str(name, 60);
      if (query.length < 2) return { ok: false, error: 'Потрібна назва програми' };
      const found = await findApps(query, { run: ctx.os.run, ...(ctx.os.appDirs ? { dirs: ctx.os.appDirs } : {}) });
      if (found.length === 0) {
        return { ok: false, error: `Програму «${query}» не знайшов ні в меню «Пуск», ні серед ігор Steam. Скажи користувачеві, що він може додати її сам: налаштування → «Програми» → «Додати програму…».` };
      }
      const best = found.filter((f) => f.score === found[0].score);
      if (best.length > 1) {
        return { ok: false, error: `Знайшов кілька схожих: ${best.map((f) => `«${f.name}»`).join(', ')}. Спитай користувача, яку саме, і виклич інструмент ще раз із точною назвою.` };
      }
      const app = best[0];
      const has = Object.entries(ctx.config.apps).find(([, a]) => samePath(resolveExe(a.exe) ?? a.exe, app.exe));
      if (has) return { ok: false, error: `Програма «${has[1].name}» уже є в списку дозволених.` };
      ctx.proposal = app;
      return null;
    },
    describe: (args, ctx) => `Додати до дозволених програм «${ctx.proposal.name}» — ${ctx.proposal.exe} (знайдено: ${ctx.proposal.source}). `
      + `Після цього я зможу відкривати її без запитань.${warn(ctx)}`,
    async run(args, ctx) {
      const { name, exe } = ctx.proposal;
      return apply(ctx, 'addApp', { exe, name }, `«${name}» додано до дозволених програм. Відкрити її можна наступною командою.`);
    },
  },
  {
    name: 'allow_folder',
    confirm: 'always',
    schema: () => ({
      description: 'Пропонує користувачеві додати папку до списку дозволених для пошуку, відкриття й читання файлів (він підтверджує кнопкою).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: `Повний шлях до папки (наприклад D:\\Projects) або одна з назв: ${Object.keys(KNOWN_FOLDERS).join(', ')}` } },
        required: ['path'],
      },
    }),
    async precheck({ path: asked }, ctx) {
      const raw = str(asked, 260);
      const known = KNOWN_FOLDERS[raw.toLowerCase()];
      const dir = known ? expandFolder(`~/${known}`) : expandFolder(raw);
      if (!dir || raw.startsWith('~')) return { ok: false, error: 'Потрібен повний шлях до папки на локальному диску, наприклад D:\\Projects. Якщо користувач його не назвав — спитай.' };
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { /* немає такої */ }
      if (!isDir) return { ok: false, error: `Папки ${dir} не існує.` };
      const has = Object.values(ctx.config.folders).find((f) => samePath(f.path, dir));
      if (has) return { ok: false, error: `Папка «${has.name}» уже є в списку дозволених.` };
      ctx.proposal = { dir };
      return null;
    },
    describe: (args, ctx) => `Додати до дозволених папок ${ctx.proposal.dir} разом з усіма вкладеними. `
      + `Після цього я зможу шукати, відкривати й читати файли в ній.${warn(ctx)}`,
    async run(args, ctx) {
      return apply(ctx, 'addFolder', { dir: ctx.proposal.dir }, `Папку ${ctx.proposal.dir} додано до дозволених.`);
    },
  },
  {
    name: 'allow_file_type',
    confirm: 'always',
    schema: () => ({
      description: 'Пропонує користувачеві дозволити тип файлів: знаходити й відкривати їх, а з read=true — ще й читати їхній текст (він підтверджує кнопкою).',
      parameters: {
        type: 'object',
        properties: {
          ext: { type: 'string', description: 'Розширення з крапкою, наприклад .pdf' },
          read: { type: 'boolean', description: 'true — дозволити також читати вміст (лише для текстових типів)' },
        },
        required: ['ext'],
      },
    }),
    async precheck({ ext, read }, ctx) {
      let e = str(ext, 12).toLowerCase();
      if (e && !e.startsWith('.')) e = `.${e}`;
      const list = read === true ? 'readableTypes' : 'fileTypes';
      if (!(read === true ? READABLE : OPENABLE).has(e)) {
        return { ok: false, error: read === true ? `Читати вміст файлів ${e || 'цього типу'} не можна дозволити.` : `Тип ${e || 'без назви'} дозволити не можна: програми, скрипти та ярлики заборонені, а решту типів див. у налаштуваннях → «Файли».` };
      }
      if ([...ctx.config[list]].includes(e)) return { ok: false, error: `Тип ${e} уже дозволено.` };
      ctx.proposal = { ext: e, list };
      return null;
    },
    describe: (args, ctx) => (ctx.proposal.list === 'readableTypes'
      ? `Дозволити читати вміст файлів ${ctx.proposal.ext}: їхній текст потраплятиме до моделі.`
      : `Дозволити знаходити й відкривати файли ${ctx.proposal.ext}.`) + warn(ctx),
    async run(args, ctx) {
      const { ext, list } = ctx.proposal;
      return apply(ctx, 'setFileType', { ext, list, on: true }, list === 'readableTypes' ? `Тепер можу читати файли ${ext}.` : `Тип ${ext} дозволено.`);
    },
  },
];
