// Керування комп'ютером і таймери. Модель тут лише обирає дію зі списку — саму дію виконує код (оболонка
// натискає медіа-клавішу, згортає вікна тощо). Два інструменти з переліком дій замість десятка окремих:
// так їхній опис займає менше місця в контексті моделі.
// Режим підтвердження — tainted: після того, як асистент читав файли, сайти чи екран, заблокувати комп'ютер
// або поставити нагадування «за чиїмось проханням із тексту» можна лише з дозволу користувача.
import { msUntil, formatLeft } from '../app/timers.js';
import { str } from './util.js';

export const PC_ACTIONS = {
  pause: 'поставити на паузу все, що зараз грає (музику, відео в браузері)',
  play: 'продовжити відтворення того, що було на паузі',
  next_track: 'наступний трек',
  previous_track: 'попередній трек',
  minimize_all: 'згорнути всі вікна (показати робочий стіл)',
  restore_windows: 'повернути згорнуті вікна',
  screenshot: 'зберегти знімок екрана у файл',
  lock: 'заблокувати комп\'ютер',
};

const clock = (due) => new Date(due).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
const span = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} с`;
  if (s < 5400) return `${Math.round(s / 60)} хв`;
  return `${Math.floor(s / 3600)} год ${Math.round((s % 3600) / 60)} хв`;
};

export default [
  {
    name: 'control_pc',
    confirm: 'tainted',
    schema: () => ({
      description: 'Керує комп\'ютером: пауза й відтворення музики та відео в будь-якій програмі, перемикання треків, вікна, знімок екрана у файл, блокування. Гучність — окремим інструментом change_volume.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: Object.keys(PC_ACTIONS), description: Object.entries(PC_ACTIONS).map(([k, v]) => `${k} — ${v}`).join('; ') } },
        required: ['action'],
      },
    }),
    describe: ({ action }) => `Керування комп'ютером: ${PC_ACTIONS[action] ?? action}`,
    conversationKey: ({ action }) => (Object.hasOwn(PC_ACTIONS, action) ? action : null), // «на розмову» — саме цю дію
    async precheck({ action }) {
      return Object.hasOwn(PC_ACTIONS, action) ? null : { ok: false, error: 'Такої дії немає' };
    },
    async run({ action }, { os }) {
      if (typeof os.pc !== 'function') return { ok: false, error: 'Керування комп\'ютером зараз недоступне' };
      return os.pc(action);
    },
  },
  {
    name: 'timers',
    confirm: 'tainted',
    schema: () => ({
      description: 'Таймери й нагадування: поставити (set), показати (list), скасувати (cancel). Коли час вийде, асистент скаже про це вголос.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'list', 'cancel'] },
          minutes: { type: 'number', description: 'Через скільки хвилин (для set)' },
          seconds: { type: 'number', description: 'Через скільки секунд (для set, якщо менше хвилини або разом із minutes)' },
          at: { type: 'string', description: 'Або на котру годину, у форматі ГГ:ХХ, наприклад 19:30 (для set)' },
          text: { type: 'string', description: 'Про що нагадати (для set) або який таймер скасувати (для cancel; порожньо — всі)' },
        },
        required: ['action'],
      },
    }),
    describe: ({ action, text }) => (action === 'cancel' ? `Скасувати таймер${text ? ` «${str(text, 120)}»` : 'и'}` : `Поставити нагадування${text ? ` «${str(text, 120)}»` : ''}`),
    conversationKey: ({ action }) => (action === 'list' ? 'list' : null), // переглядати можна, ставити й скасовувати — щоразу з дозволу
    async run({ action, minutes, seconds, at, text }, { os, taint }) {
      const timers = os.timers;
      if (!timers) return { ok: false, error: 'Таймери зараз недоступні' };
      if (action === 'list') {
        const list = timers.list();
        if (list.length === 0) return { ok: true, message: 'Таймерів немає', timers: [] };
        return { ok: true, message: `Таймерів: ${list.length}`,
          // мітку, поставлену після читання стороннього тексту, у нову розмову не повертаємо: користувач побачить її сам, коли час вийде
          timers: list.map((t) => ({ about: t.tainted ? 'нагадування' : (t.label || 'таймер'), at: clock(t.due), left: formatLeft((t.due - Date.now()) / 1000) })) };
      }
      if (action === 'cancel') {
        const gone = timers.cancel(str(text, 120));
        return gone.length ? { ok: true, message: gone.length === 1 ? `Скасовано: ${gone[0].label || 'таймер'}` : `Скасовано таймерів: ${gone.length}` }
          : { ok: false, error: 'Такого таймера немає' };
      }
      if (action !== 'set') return { ok: false, error: 'Невідома дія' };
      const num = (v) => (typeof v === 'string' && v.trim() ? Number(v) : v);
      let ms = (Number.isFinite(num(minutes)) ? num(minutes) * 60_000 : 0) + (Number.isFinite(num(seconds)) ? num(seconds) * 1000 : 0);
      if (!ms && at) {
        ms = msUntil(at);
        if (ms === null) return { ok: false, error: 'Час треба назвати як ГГ:ХХ, наприклад 19:30' };
      }
      if (!ms) return { ok: false, error: 'Не вказано, на коли: потрібні хвилини, секунди або година. Спитай користувача.' };
      const added = timers.add({ ms, label: str(text, 120), tainted: taint > 0 });
      if (!added.ok) return added;
      const what = added.item.label ? `Нагадаю «${added.item.label}»` : 'Таймер поставлено';
      return { ok: true, message: `${what}: через ${span(ms)}, о ${clock(added.item.due)}` };
    },
  },
];
