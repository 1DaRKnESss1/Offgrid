// Агент: одне повідомлення користувача -> кілька кроків «модель ↔ інструменти» -> відповідь.
import { chat } from './ollama.js';
import { systemPrompt } from './prompt.js';
import { toolSchemas, TOOL_LABELS } from '../tools/index.js';
import { executeTool, toolMessageContent } from '../security/policy.js';
import { stripFiller, announcesIntent, styleHint, requiredTool } from './tone.js';

const MAX_STEPS = 6;
const MAX_CALLS_PER_STEP = 4;
const MAX_TURNS_KEPT = 8;
// Промпт, опис інструментів і нагадування займають близько 3500 з 8192 токенів контексту (виміряно).
// Історії лишаємо ~2200 токенів (приблизно 6000 символів), решта — результати інструментів і сама відповідь.
// Якщо перебрати, Ollama мовчки відріже початок, тобто системний промпт із правилами. Після зміни промпту
// чи набору інструментів варто переміряти.
const HISTORY_BUDGET_CHARS = 6000;
const MAX_INPUT_CHARS = 2000;
const IDLE_RESET_MS = 15 * 60 * 1000;
const CANCELLED = 'Скасовано';
// Якщо модель лише описала намір («зараз перевірю час»), а інструмент не викликала, — один раз на запит кажемо їй діяти
const NUDGE = '(Асистенте, ти лише описав, що збираєшся зробити, але не зробив цього. Виклич потрібний інструмент просто зараз, без пояснень.)';
const REMINDER = '\n\n(Нагадування асистенту: якщо це прохання щось зробити на комп’ютері або дізнатися час, стан системи чи файли — спершу виклич інструмент. Не кажи, що щось зроблено чи відомо, без результату інструмента в цьому ж ході. На привітання, подяку й просту балачку відповідай одразу, без інструментів.)';

export class Agent {
  /**
   * @param {object} deps
   *   config, os — налаштування та шар доступу до системи
   *   confirm(request) -> Promise<boolean> — питає користувача (ніколи модель)
   *   emit(event) — події для інтерфейсу: state, tool, tainted
   */
  constructor({ config, os, confirm, emit = () => {} }) {
    this.config = config;
    this.os = os;
    this.confirm = confirm;
    this.emit = emit;
    this.busy = false;
    this.generation = 0;
    this.reset();
  }

  /** Нова розмова: порожня історія, знята позначка «забруднення». */
  reset() {
    this.generation++; // запит, що ще виконується, побачить зміну й нічого не допише в нову розмову
    this.messages = [];
    this.taint = 0;
    this.lastUsed = Date.now();
    this.emit({ type: 'tainted', value: false });
  }

  setConfig(config) {
    this.config = config;
  }

  cancel() {
    this.abort?.abort();
  }

  // Викидаємо найстаріші репліки цілими ходами, щоб не розірвати пару «виклик — результат»
  #trim() {
    const starts = this.messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
    if (starts.length > MAX_TURNS_KEPT) this.messages = this.messages.slice(starts[starts.length - MAX_TURNS_KEPT]);
    const size = (list) => list.reduce((n, m) => n + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
    while (size(this.messages) > HISTORY_BUDGET_CHARS) {
      const next = this.messages.findIndex((m, i) => i > 0 && m.role === 'user');
      this.messages = next > 0 ? this.messages.slice(next) : [];
    }
  }

  async ask(text) {
    if (this.busy) throw new Error('Асистент ще виконує попередній запит');
    const input = String(text ?? '').trim().slice(0, MAX_INPUT_CHARS);
    if (!input) return '';
    if (Date.now() - this.lastUsed > IDLE_RESET_MS) this.reset();

    this.busy = true;
    this.abort = new AbortController();
    const { signal } = this.abort;
    const self = this;
    this.#trim();
    // Працюємо з власним посиланням на історію: якщо посеред запиту натиснуть «Нова розмова»,
    // цей запит допише хвіст у стару (вже нікому не потрібну) історію, а не в нову.
    const generation = this.generation;
    const messages = this.messages;
    const mark = messages.length;
    const current = () => generation === self.generation;
    const emit = (event) => { if (current()) self.emit(event); };
    const session = {
      // завжди чинні налаштування: якщо посеред запиту зі списку прибрали програму чи папку,
      // наступний же виклик інструмента це врахує
      get config() { return self.config; },
      os: this.os,
      signal,
      confirm: this.confirm,
      denied: false,
      get taint() { return self.taint; },
      set taint(level) {
        if (!current() || level <= self.taint) return;
        const was = self.taint;
        self.taint = level;
        if (was === 0) emit({ type: 'tainted', value: true });
      },
    };

    try {
      messages.push({ role: 'user', content: input });
      const tools = toolSchemas(this.config);
      const toolNames = tools.map((t) => t.function.name);
      let nudge = null;      // слова моделі й наше «роби» — лише для наступного запиту, в історію не потрапляють
      let nudged = false;
      let toolsCalled = 0;

      for (let step = 0; step < MAX_STEPS; step++) {
        emit({ type: 'state', state: 'thinking' });
        let streamed = false;
        // Нагадування додаємо лише в запит (не в історію) і лише до останнього повідомлення користувача:
        // посеред розмови модель інакше схильна «розповісти», що зробила, не викликавши інструмент.
        const last = messages.findLastIndex((m) => m.role === 'user');
        const request = messages.map((m, i) => (i === last ? { ...m, content: m.content + REMINDER + styleHint(m.content) } : m));
        if (nudge) { request.push(...nudge); nudge = null; }
        const message = await chat(this.config, [{ role: 'system', content: systemPrompt(this.config) }, ...request], tools, signal,
          (piece) => { streamed = true; emit({ type: 'reply-delta', text: piece }); });
        if (!current()) throw new Error(CANCELLED);
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, MAX_CALLS_PER_STEP) : [];
        // в історію теж кладемо відповідь без чергового «чим ще допомогти?», щоб модель не вчилася на власній звичці
        const content = calls.length ? (message.content ?? '') : stripFiller(message.content);
        if (calls.length === 0 && !nudged && announcesIntent(content, toolNames, toolsCalled > 0)) {
          // сказано «зроблю», а не зроблено: цю репліку відкидаємо й просимо модель діяти
          nudged = true;
          nudge = [{ role: 'assistant', content }, { role: 'user', content: NUDGE }];
          if (streamed) emit({ type: 'reply-reset' });
          continue;
        }
        // Прохання, для яких інструмент потрібен НАПЕВНО (виділений текст, екран, час): сама модель цього не бачить
        // і не знає. Якщо вона відповіла без інструмента — це вигадка або зайве перепитування. Спершу один раз
        // нагадуємо; якщо не допомогло (або нагадування вже витрачено) — потрібний інструмент викликає сам код.
        const route = calls.length === 0 && toolsCalled === 0 ? requiredTool(input, toolNames) : null;
        if (route && !nudged && route.nudge) {
          nudged = true;
          nudge = [{ role: 'assistant', content }, { role: 'user', content: route.nudge }];
          if (streamed) emit({ type: 'reply-reset' });
          continue;
        }
        if (route) calls.push({ function: { name: route.tool, arguments: route.args } });
        messages.push({ role: 'assistant', content: route ? '' : content, ...(calls.length ? { tool_calls: calls } : {}) });
        if (calls.length === 0) return content || 'Не маю відповіді.';
        // текст перед викликом інструмента — не відповідь, а «вступ»: з екрана його прибираємо
        if (streamed) emit({ type: 'reply-reset' });

        emit({ type: 'state', state: 'executing' });
        for (const call of calls) {
          const name = String(call?.function?.name ?? '');
          toolsCalled++;
          const { result, untrusted } = signal.aborted || !current()
            ? { result: { ok: false, error: 'Скасовано користувачем' }, untrusted: false }
            : await executeTool(name, call?.function?.arguments, session);
          const label = Object.hasOwn(TOOL_LABELS, name) ? TOOL_LABELS[name] : name;
          emit({ type: 'tool', name, ok: !!result.ok, text: result.ok ? (result.message ?? label) : (result.error ?? '') });
          messages.push({ role: 'tool', tool_name: name, content: toolMessageContent(result, untrusted) });
        }
        if (signal.aborted || !current()) throw new Error(CANCELLED);
      }
      const giveUp = 'Не вдалося виконати запит за кілька кроків.';
      messages.push({ role: 'assistant', content: giveUp });
      return giveUp;
    } catch (e) {
      // невдалий хід прибираємо з історії, щоб обірвані виклики не плутали модель далі
      if (current()) messages.length = Math.min(mark, messages.length);
      throw e;
    } finally {
      this.busy = false;
      this.abort = null;
      this.lastUsed = Date.now();
    }
  }
}
