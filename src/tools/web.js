// Інтернет: асистент лише ВІДКРИВАЄ сторінку в браузері користувача.
// Сам він нічого не завантажує і вмісту сторінок не бачить.
import { str } from './util.js';

const MAX_URL = 500, MAX_QUERY = 300;

function normalizeUrl(input) {
  let u = str(input, MAX_URL + 1);
  if (!u || u.length > MAX_URL) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  let url;
  try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  // лише звичайні імена сайтів: без localhost, IP-адрес та імен внутрішньої мережі
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.') || host.startsWith('[') || /^[\d.]+$/.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|intranet)$/.test(host)) return null;
  if (url.toString().length > MAX_URL) return null;
  return url;
}

/** Адреса без «www.» — так сайт записується в довірені й так порівнюється. */
const siteOf = (url) => url.hostname.toLowerCase().replace(/^www\./, '');
/** Чи сайт (або його піддомен) є в списку довірених. */
export function isTrustedSite(host, list) {
  const h = String(host).toLowerCase().replace(/^www\./, '');
  return [...(list ?? [])].some((t) => h === t || h.endsWith(`.${t}`));
}

// Скільки знаків після назви сайту можна відкрити без запиту. Довірений сайт — це довіра до САЙТУ, а не до
// будь-якої адреси на ньому: у довгому шляху чи рядку запиту можна винести прочитане (сторінки-перенаправлення,
// пошук, заповнені форми). Коротка адреса — головна сторінка, розділ, відео — проходить, довга питає дозволу.
const TRUSTED_TAIL = 60;
export function isTrustedUrl(url, list) {
  if (url.port || url.username || url.password) return false;
  if ((url.pathname + url.search + url.hash).length > TRUSTED_TAIL) return false;
  return isTrustedSite(url.hostname, list);
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
    describe: ({ query }) => `Відкрити в браузері пошук Google: «${str(query, MAX_QUERY)}»`,
    async run({ query }, { os }) {
      const q = str(query, MAX_QUERY);
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
    describe: ({ url }) => {
      const u = normalizeUrl(url);
      return u ? `Відкрити в браузері сайт ${u.hostname} — повна адреса: ${u.toString()}` : `Відкрити в браузері адресу: ${str(url, 200)}`;
    },
    // сайт зі списку довірених відкривається без запиту навіть після читання файлів чи екрана
    trusted: ({ url }, { config }) => { const u = normalizeUrl(url); return !!u && isTrustedUrl(u, config.trustedSites); },
    // «на цю розмову» — лише для цього самого сайту
    conversationKey: ({ url }) => { const u = normalizeUrl(url); return u ? siteOf(u) : null; },
    // кнопка «Завжди для …» у запиті дозволу
    offerAlways: ({ url }, { os }) => {
      const u = normalizeUrl(url);
      if (!u || typeof os.allow !== 'function') return null;
      const host = siteOf(u);
      return { label: host, apply: () => os.allow('addTrustedSite', { host }) };
    },
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
