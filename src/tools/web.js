// Інтернет: асистент лише ВІДКРИВАЄ сторінку в браузері користувача.
// Сам він нічого не завантажує і вмісту сторінок не бачить.
import { str } from './util.js';

function normalizeUrl(input) {
  let u = str(input, 2000);
  if (!u) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  let url;
  try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes('.')) return null; // без localhost та імен внутрішньої мережі
  return url;
}

export default [
  {
    name: 'search_web',
    confirm: 'tainted',
    schema: () => ({
      description: 'Відкриває в браузері сторінку пошуку Google за запитом, щоб користувач сам переглянув результати. Ти результатів не бачиш.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Пошуковий запит, наприклад "Шевченко Мені тринадцятий минало текст"' } },
        required: ['query'],
      },
    }),
    describe: ({ query }) => `Відкрити в браузері пошук Google: «${str(query, 200)}»`,
    async run({ query }, { os }) {
      const q = str(query, 300);
      if (!q) return { ok: false, error: 'Порожній пошуковий запит' };
      const url = 'https://www.google.com/search?q=' + encodeURIComponent(q);
      return (await os.openUrl(url))
        ? { ok: true, message: `Відкрито пошук «${q}» у браузері. Результати бачить лише користувач` }
        : { ok: false, error: 'Не вдалося відкрити браузер' };
    },
  },
  {
    name: 'open_website',
    confirm: 'tainted',
    schema: () => ({
      description: 'Відкриває сайт у браузері за замовчуванням. Вмісту сайту ти не бачиш.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Адреса сайту, наприклад https://youtube.com' } },
        required: ['url'],
      },
    }),
    describe: ({ url }) => `Відкрити в браузері адресу: ${normalizeUrl(url)?.toString() ?? str(url, 200)}`,
    async run({ url }, { os }) {
      const u = normalizeUrl(url);
      if (!u) return { ok: false, error: 'Некоректна адреса сайту (дозволені лише http і https)' };
      return (await os.openUrl(u.toString()))
        ? { ok: true, message: `Відкриваю ${u.hostname}` }
        : { ok: false, error: 'Не вдалося відкрити браузер' };
    },
  },
];

export { normalizeUrl };
