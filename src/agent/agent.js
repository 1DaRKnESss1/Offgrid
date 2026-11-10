// Агент: одне повідомлення користувача -> кілька кроків «модель ↔ інструменти» -> відповідь.
import { chat } from './ollama.js';
import { systemPrompt } from './prompt.js';
import { toolSchemas, TOOL_LABELS } from '../tools/index.js';
import { executeTool, toolMessageContent } from '../security/policy.js';

const MAX_STEPS = 6;
const MAX_CALLS_PER_STEP = 4;
const MAX_TURNS_KEPT = 10;
const MAX_INPUT_CHARS = 2000;
const IDLE_RESET_MS = 15 * 60 * 1000;

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
    this.reset();
  }

  reset() {
    this.messages = [];
    this.tainted = false;
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
    const mark = this.messages.length;
    const session = {
      config: this.config,
      os: this.os,
      signal,
      confirm: this.confirm,
      get tainted() { return self.tainted; },
      set tainted(v) { if (v && !self.tainted) { self.tainted = true; self.emit({ type: 'tainted', value: true }); } },
    };

    try {
      this.messages.push({ role: 'user', content: input });
      const tools = toolSchemas(this.config);

      for (let step = 0; step < MAX_STEPS; step++) {
        this.emit({ type: 'state', state: 'thinking' });
        const message = await chat(this.config, [{ role: 'system', content: systemPrompt(this.config) }, ...this.messages], tools, signal);
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, MAX_CALLS_PER_STEP) : [];
        this.messages.push({ role: 'assistant', content: message.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (calls.length === 0) return String(message.content ?? '').trim() || 'Не маю відповіді.';

        this.emit({ type: 'state', state: 'executing' });
        for (const call of calls) {
          const name = call?.function?.name;
          const { result, untrusted } = signal.aborted
            ? { result: { ok: false, error: 'Скасовано користувачем' }, untrusted: false }
            : await executeTool(name, call?.function?.arguments, session);
          this.emit({ type: 'tool', name: String(name), ok: !!result.ok, text: result.ok ? (result.message ?? TOOL_LABELS[name] ?? '') : (result.error ?? '') });
          this.messages.push({ role: 'tool', tool_name: String(name), content: toolMessageContent(result, untrusted) });
        }
        if (signal.aborted) throw new Error('Скасовано');
      }
      const giveUp = 'Не вдалося виконати запит за кілька кроків.';
      this.messages.push({ role: 'assistant', content: giveUp });
      return giveUp;
    } catch (e) {
      // невдалий хід прибираємо з історії, щоб обірвані виклики не плутали модель далі
      this.messages.length = Math.min(mark, this.messages.length);
      throw e;
    } finally {
      this.busy = false;
      this.abort = null;
      this.lastUsed = Date.now();
    }
  }
}
