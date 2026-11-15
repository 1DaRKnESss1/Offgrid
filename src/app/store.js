// База даних асистента (SQLite, вбудована в Node — окремого сервера немає, усе в одному файлі data/offgrid.db).
// Дві таблиці:
//   facts     — те, що користувач попросив запам'ятати («пароль від Wi-Fi лежить у…»);
//   scenarios — названі послідовності дій («режим гри» = відкрити Steam і Discord).
// Тут лише зберігання й пошук. Хто і коли має право писати — вирішує політика (tools/memory.js, policy.js).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MAX_FACT = 500;
export const MAX_FACTS = 2000;
export const MAX_SCENARIOS = 40;

const clean = (s, max) => String(s ?? '').replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, max);
export const normName = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Слова запиту -> «основи» для пошуку. Українські слова відмінюються («плита», «плиту», «плитою»), тому
// порівнюємо за початком слова; службові слова й надто короткі відкидаємо.
const STOP = new Set(['що', 'який', 'яка', 'яке', 'які', 'про', 'для', 'мене', 'мені', 'мій', 'моя', 'моє', 'мої', 'був', 'була', 'було', 'були',
  'казав', 'казала', 'сказав', 'просив', 'пам', 'памятаєш', 'пам\'ятаєш', 'знаєш', 'нагадай', 'скажи', 'розкажи', 'тебе', 'тобі', 'це', 'той', 'цей', 'там', 'тут', 'коли', 'де']);
export function stems(query) {
  const words = normName(query).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(words.map((w) => (w.length > 5 ? w.slice(0, Math.max(4, w.length - 2)) : w)))].slice(0, 8);
}

export class Store {
  /** file — шлях до бази або ':memory:' (тести, режим знімка). */
  constructor(file = ':memory:') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        steps TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.#migrate();
  }

  // факт, записаний у розмові, де асистент уже читав сторонній текст, позначається: він міг прийти з того тексту
  #migrate() {
    const cols = this.db.prepare('PRAGMA table_info(facts)').all().map((c) => c.name);
    if (!cols.includes('tainted')) this.db.exec('ALTER TABLE facts ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0');
  }

  close() { try { this.db.close(); } catch { /* вже закрита */ } }

  // ---------- пам'ять ----------
  /** Запам'ятовує факт. Той самий текст удруге не дублюється. */
  remember(text, { tainted = false } = {}) {
    const fact = clean(text, MAX_FACT);
    if (fact.length < 3) return { ok: false, error: 'Нема чого запам\'ятовувати' };
    const same = this.db.prepare('SELECT id FROM facts WHERE lower(text) = lower(?)').get(fact);
    if (same) return { ok: true, id: same.id, known: true };
    if (this.db.prepare('SELECT count(*) AS n FROM facts').get().n >= MAX_FACTS) return { ok: false, error: 'Пам\'ять заповнена — спершу щось забудь' };
    const r = this.db.prepare('INSERT INTO facts (text, created_at, tainted) VALUES (?, ?, ?)').run(fact, new Date().toISOString(), tainted ? 1 : 0);
    return { ok: true, id: Number(r.lastInsertRowid) };
  }

  /** Факти, що стосуються запиту (найкращі збіги першими); без запиту — найновіші. */
  recall(query = '', limit = 5, { trustedOnly = false } = {}) {
    const all = this.db.prepare(`SELECT id, text, created_at, tainted FROM facts ${trustedOnly ? 'WHERE tainted = 0' : ''} ORDER BY id DESC`).all();
    const keys = stems(query);
    if (keys.length === 0) return all.slice(0, limit);
    return all
      .map((f) => { const t = normName(f.text); return { f, score: keys.filter((k) => t.includes(k)).length }; })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.f.id - a.f.id)
      .slice(0, limit)
      .map((x) => x.f);
  }

  /** Забуває факти, що збігаються із запитом за всіма його словами. Повертає забуті. */
  forget(query) {
    const keys = stems(query);
    if (keys.length === 0) return [];
    const gone = this.db.prepare('SELECT id, text FROM facts').all().filter((f) => { const t = normName(f.text); return keys.every((k) => t.includes(k)); });
    const del = this.db.prepare('DELETE FROM facts WHERE id = ?');
    for (const f of gone) del.run(f.id);
    return gone;
  }

  factCount() { return this.db.prepare('SELECT count(*) AS n FROM facts').get().n; }

  // ---------- сценарії ----------
  /** steps — уже перевірений список [{ tool, args }]. Сценарій з тією самою назвою замінюється. */
  saveScenario(name, steps) {
    const title = clean(name, 40);
    const key = normName(title);
    if (!key) return { ok: false, error: 'Сценарію потрібна назва' };
    const exists = this.db.prepare('SELECT id FROM scenarios WHERE key = ?').get(key);
    if (!exists && this.db.prepare('SELECT count(*) AS n FROM scenarios').get().n >= MAX_SCENARIOS) return { ok: false, error: 'Забагато сценаріїв' };
    this.db.prepare('INSERT INTO scenarios (name, key, steps, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, steps = excluded.steps')
      .run(title, key, JSON.stringify(steps), new Date().toISOString());
    return { ok: true, name: title, replaced: !!exists };
  }

  listScenarios() {
    return this.db.prepare('SELECT name, steps FROM scenarios ORDER BY name').all().map((s) => ({ name: s.name, steps: JSON.parse(s.steps) }));
  }

  /** Шукає сценарій за назвою: точно, а якщо ні — єдиний, чия назва містить сказане (або навпаки). */
  findScenario(name) {
    const key = normName(name).replace(/^(?:сценарій|режим)\s+/u, '');
    if (!key) return null;
    const all = this.listScenarios();
    const keyOf = (s) => normName(s.name).replace(/^(?:сценарій|режим)\s+/u, '');
    const exact = all.find((s) => keyOf(s) === key);
    if (exact) return exact;
    const close = all.filter((s) => keyOf(s).includes(key) || key.includes(keyOf(s)));
    return close.length === 1 ? close[0] : null;
  }

  deleteScenario(name) {
    const found = this.findScenario(name);
    if (!found) return false;
    this.db.prepare('DELETE FROM scenarios WHERE key = ?').run(normName(found.name));
    return true;
  }
}
