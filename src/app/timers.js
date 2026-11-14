// Таймери й нагадування. Тут лише облік і годинник; що робити, коли час вийшов (сказати, показати), вирішує
// той, хто створив об'єкт. Список зберігається у файлі, тож таймери переживають перезапуск застосунку:
// ті, чий час минув, поки застосунок був закритий, спрацьовують одразу після запуску.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_TIMERS = 20;
export const MIN_MS = 1000;
export const MAX_MS = 7 * 24 * 3600_000;
const MAX_DELAY = 2 ** 31 - 1; // довше setTimeout не вміє — тоді будимось раніше й чекаємо далі

/** «19:30» -> скільки мілісекунд до найближчої такої години (сьогодні або завтра), або null. */
export function msUntil(clock, now = new Date()) {
  const m = /^\s*(\d{1,2})[:.\s](\d{2})\s*$/.exec(String(clock ?? ''));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const due = new Date(now);
  due.setHours(h, min, 0, 0);
  if (due <= now) due.setDate(due.getDate() + 1);
  return due - now;
}

/** 95 -> «1:35», 3725 -> «1:02:05». */
export function formatLeft(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export class Timers {
  /** onFire(item, { late }) — час вийшов; onChange(list) — список змінився. now і clock підміняються в тестах. */
  constructor({ file = null, onFire = () => {}, onChange = () => {}, now = () => Date.now(), clock = globalThis } = {}) {
    Object.assign(this, { file, onFire, onChange, now, clock });
    this.items = [];
    this.handle = null;
  }

  /** Читає збережені таймери й заводить годинник. Прострочені спрацьовують одразу. */
  start() {
    if (this.file) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.items = (Array.isArray(saved) ? saved : [])
          .filter((t) => t && typeof t.id === 'string' && Number.isFinite(t.due))
          .slice(0, MAX_TIMERS)
          .map((t) => ({ id: t.id, label: typeof t.label === 'string' ? t.label.slice(0, 120) : '', due: t.due }));
      } catch { this.items = []; }
    }
    this.#tick(true);
  }

  stop() { this.clock.clearTimeout(this.handle); this.handle = null; }

  list() { return [...this.items].sort((a, b) => a.due - b.due); }

  /** Додає таймер. Повертає { ok, item } або { ok: false, error }. */
  add({ ms, label = '' }) {
    if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return { ok: false, error: 'Таймер можна поставити на час від секунди до семи днів' };
    if (this.items.length >= MAX_TIMERS) return { ok: false, error: 'Забагато таймерів одночасно — спершу скасуй якийсь' };
    const item = { id: randomUUID(), label: String(label ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 120), due: this.now() + Math.round(ms) };
    this.items.push(item);
    this.#changed();
    return { ok: true, item };
  }

  /** Скасовує за id, за словами з назви або (без аргументу) всі. Повертає скасовані. */
  cancel(match) {
    const q = typeof match === 'string' ? match.trim().toLowerCase() : '';
    const gone = this.items.filter((t) => !q || t.id === match || t.label.toLowerCase().includes(q));
    if (gone.length === 0) return [];
    this.items = this.items.filter((t) => !gone.includes(t));
    this.#changed();
    return gone;
  }

  #changed() {
    this.#save();
    this.onChange(this.list());
    this.#tick(false);
  }

  #save() {
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.items)); } catch { /* не збереглось — діятиме до закриття */ }
  }

  #tick(late) {
    this.clock.clearTimeout(this.handle);
    this.handle = null;
    const now = this.now();
    const due = this.items.filter((t) => t.due <= now);
    if (due.length) {
      this.items = this.items.filter((t) => t.due > now);
      this.#save();
      this.onChange(this.list());
      for (const item of due) { try { this.onFire(item, { late }); } catch { /* один збій не має зупиняти решту */ } }
    }
    if (this.items.length === 0) return;
    const next = Math.min(...this.items.map((t) => t.due));
    this.handle = this.clock.setTimeout(() => this.#tick(false), Math.min(MAX_DELAY, Math.max(50, next - this.now())));
    this.handle?.unref?.();
  }
}
