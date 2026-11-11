// Агент: одне повідомлення користувача -> кілька кроків «модель ↔ інструменти» -> відповідь.
import { chat } from './ollama.js';
import { systemPrompt } from './prompt.js';
import { toolSchemas, TOOL_LABELS } from '../tools/index.js';
import { executeTool, toolMessageContent } from '../security/policy.js';

const MAX_STEPS = 6;
const MAX_CALLS_PER_STEP = 4;
const MAX_TURNS_KEPT = 8;
// Промпт і опис інструментів займають близько 2500 з 4096 токенів контексту. Історії лишаємо ~1100 токенів
// (приблизно 3000 символів), інакше Ollama мовчки відріже початок — тобто системний промпт із правилами.
const HISTORY_BUDGET_CHARS = 3000;
const MAX_INPUT_CHARS = 2000;
const IDLE_RESET_MS = 15 * 60 * 1000;
const CANCELLED = 'Скасовано';

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

      for (let step = 0; step < MAX_STEPS; step++) {
        emit({ type: 'state', state: 'thinking' });
        const message = await chat(this.config, [{ role: 'system', content: systemPrompt(this.config) }, ...messages], tools, signal);
        if (!current()) throw new Error(CANCELLED);
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, MAX_CALLS_PER_STEP) : [];
        messages.push({ role: 'assistant', content: message.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (calls.length === 0) return String(message.content ?? '').trim() || 'Не маю відповіді.';

        emit({ type: 'state', state: 'executing' });
        for (const call of calls) {
          const name = String(call?.function?.name ?? '');
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
