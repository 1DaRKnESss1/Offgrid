// Документи: знайти за тим, що в них написано, або за часом — і переказати довгий документ цілком.
//
// find_files шукає за назвою; тут пошук за ВМІСТОМ і датою. Діють ті самі межі: лише дозволені папки, лише
// дозволені типи файлів, а заглядати всередину можна тільки тих типів, які дозволено читати (налаштування →
// «Файли» → «Читати вміст»). Усе знайдене й прочитане — сторонній текст із найвищим рівнем недовіри.
import path from 'node:path';
import { str } from './util.js';
import { checkFile } from '../security/pathguard.js';
import { runDocTool, pythonPath } from './doctext.js';

const KINDS = { word: ['.docx', '.doc'], pdf: ['.pdf'], text: ['.txt', '.md', '.csv', '.log', '.json'] };
const WHEN_DAYS = { today: 0, yesterday: 1, week: 7, month: 31 };
const MAX_FOUND = 6;
const SHORT_ENOUGH = 3500; // коротший документ модель прочитає сама, без переказу частинами

const doc = (ctx, job, timeout) => (typeof ctx.os.doc === 'function' ? ctx.os.doc(job, timeout) : runDocTool(pythonPath(ctx.config), job, timeout));

// слова запиту -> початки слів (українські слова відмінюються), без службових
const STOP = new Set(['про', 'для', 'що', 'який', 'яка', 'яке', 'які', 'був', 'була', 'було', 'там', 'десь', 'якийсь', 'якась', 'документ', 'файл', 'текст', 'йшлося', 'написано', 'мій', 'моя', 'мене']);
export function searchWords(about) {
  return [...new Set(String(about ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 5 ? w.slice(0, Math.max(4, w.length - 2)) : w)))].slice(0, 8);
}

/** Початок періоду (секунди), з якого шукати: «сьогодні» — з півночі, «тиждень» — сім діб тому. */
export function sinceFor(when, now = new Date()) {
  if (!Object.hasOwn(WHEN_DAYS, when)) return 0;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - WHEN_DAYS[when]);
  return Math.floor(start.getTime() / 1000);
}

const day = (seconds) => new Date(seconds * 1000).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });

export default [
  {
    name: 'find_documents',
    confirm: 'never',
    untrusted: 'content',
    available: (config) => Object.keys(config.folders).length > 0,
    schema: () => ({
      description: 'Шукає документи (Word, PDF, текстові) у дозволених папках за тим, що в них НАПИСАНО, і/або за часом зміни. '
        + 'Для «був документ про…», «де йшлося про…», «що я завантажив сьогодні», «останні документи». За назвою файлу шукає find_files.',
      parameters: {
        type: 'object',
        properties: {
          about: { type: 'string', description: 'Про що документ — кілька ключових слів. Порожньо, якщо шукають лише за часом' },
          when: { type: 'string', enum: ['any', ...Object.keys(WHEN_DAYS)], description: 'За який час: today, yesterday (з учора), week, month або any' },
          kind: { type: 'string', enum: ['any', ...Object.keys(KINDS)], description: 'Тип документа, якщо його назвали' },
        },
        required: ['about'],
      },
    }),
    async run({ about, when = 'any', kind = 'any' }, ctx) {
      const { config } = ctx;
      const words = searchWords(str(about, 200));
      const since = sinceFor(when);
      if (words.length === 0 && !since) return { ok: false, error: 'Скажи, про що документ або за який час його шукати.' };
      const wanted = Object.hasOwn(KINDS, kind) ? KINDS[kind] : Object.values(KINDS).flat();
      const exts = wanted.filter((e) => config.fileTypes.has(e));
      if (exts.length === 0) return { ok: false, error: 'Документи цього типу не дозволено знаходити (налаштування → «Файли»).' };
      const readExts = exts.filter((e) => config.readableTypes.has(e));
      const r = await doc(ctx, { cmd: 'search', roots: Object.values(config.folders).map((f) => f.path), exts, read_exts: readExts, words, since, limit: MAX_FOUND, budget_s: 25 }, 60_000);
      if (!r.ok) return { ok: false, foreign: true, error: 'Пошук документів не вдався.' };
      // кожен знайдений шлях ще раз проходить звичайну перевірку — як і для будь-якого іншого інструмента
      const found = [];
      for (const item of r.results ?? []) {
        const check = await checkFile(item.path, config.folders, config.fileTypes);
        if (check.ok) found.push({ path: check.path, changed: day(item.modified), ...(item.snippet ? { fragment: str(item.snippet, 200) } : {}) });
      }
      const note = [
        words.length && readExts.length < exts.length ? `Усередину заглядав лише в ${readExts.join(', ') || 'жодні'} — решту типів читати не дозволено, там шукав тільки за назвою` : '',
        r.timed_out ? 'Не встиг переглянути всі файли: показую знайдене серед найновіших' : '',
      ].filter(Boolean).join('. ');
      if (found.length === 0) return { ok: true, found: 0, message: 'Таких документів не знайшов', ...(note ? { note } : {}) };
      return { ok: true, found: found.length, more: Math.max(0, (r.total ?? found.length) - found.length), message: `Знайшов документів: ${found.length}`, documents: found, ...(note ? { note } : {}),
        next: 'fragment — лише уривок. Якщо користувач питає, що написано в документі, або просить переказати — виклич summarize_document з його path (і question), а не відповідай за уривком.' };
    },
  },
  {
    name: 'summarize_document',
    confirm: 'never',
    untrusted: 'content',
    available: (config) => config.readableTypes.size > 0 && Object.keys(config.folders).length > 0,
    schema: () => ({
      description: 'Читає документ ЦІЛКОМ (Word, PDF, текстовий) і переказує його або відповідає на запитання про нього. '
        + 'Для «про що цей документ», «перекажи», «що там сказано про…». Шлях бери з результату find_documents або find_files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Повний шлях до файлу з результату пошуку' },
          question: { type: 'string', description: 'Що саме треба дізнатися з документа; порожньо — загальний переказ' },
        },
        required: ['path'],
      },
    }),
    async run({ path: file, question }, ctx) {
      const { config, os } = ctx;
      const check = await checkFile(file, config.folders, config.readableTypes);
      if (!check.ok) return check;
      const r = await doc(ctx, { cmd: 'text', path: check.path, max_chars: 63000 }, 60_000);
      // текст помилки складає розбирач документа з того, що знайшов у файлі, — моделі його не показуємо;
      // foreign: файл уже відкривали, тож розмова «забруднюється», як і після вдалого читання
      if (!r.ok) return { ok: false, foreign: true, error: `Не вдалося прочитати документ ${path.basename(check.path)}: файл пошкоджений, захищений або не того формату.` };
      const text = String(r.text ?? '').trim();
      const name = path.basename(check.path);
      if (text.length < 20) return { ok: false, foreign: true, error: `У документі ${name} немає тексту, який можна прочитати (можливо, це скан — картинки без текстового шару).` };
      if (text.length <= SHORT_ENOUGH || typeof os.summarize !== 'function') {
        return { ok: true, file: name, message: `Прочитав ${name}`, truncated: text.length > SHORT_ENOUGH, text: text.slice(0, SHORT_ENOUGH) };
      }
      const s = await os.summarize(text, str(question, 300), name);
      if (!s.ok) return s;
      return { ok: true, file: name, message: `Прочитав ${name} (${s.parts} частин)`, whole_document: !r.truncated, ...(r.truncated ? { note: 'Документ дуже довгий: прочитано лише початок (близько 30 сторінок)' } : {}), summary: s.text };
    },
  },
];
