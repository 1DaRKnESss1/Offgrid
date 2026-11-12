// Клієнт мовного сервісу: запускає speech/speech_server.py і розмовляє з ним через 127.0.0.1.
// Сервіс сам обирає вільний порт і отримує одноразовий токен; без токена він не відповідає нікому.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ROOT } from '../paths.js';

const SCRIPT = path.join(ROOT, 'speech', 'speech_server.py');
const START_TIMEOUT_MS = 180_000; // перше завантаження моделей із диска буває довгим
const LISTEN_TIMEOUT_MS = 90_000;
const MAX_SPEAK_CHARS = 1200;
const SAY_DONE_TIMEOUT_MS = 240_000; // сервіс озвучує щонайбільше 1500 символів на відповідь

/** Прибирає те, що голос не має зачитувати: розмітку, посилання, емодзі, зайві пробіли. */
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' посилання ')
    .replace(/[*_#`>|~^\\[\]{}<]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Задовгий текст обрізаємо по межі речення, а не посеред слова. */
export function limitForSpeech(text, max = MAX_SPEAK_CHARS) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  return (end > max * 0.4 ? head.slice(0, end + 1) : head.slice(0, head.lastIndexOf(' '))).trim();
}

export class Speech {
  /** onStatus({ status: 'off' | 'starting' | 'ready' | 'failed', error? }) */
  constructor({ onStatus = () => {} } = {}) {
    this.onStatus = onStatus;
    this.status = 'off';
    this.error = null;
    this.child = null;
    this.base = null;
    this.token = null;
    this.listening = null; // AbortController поточного запису
    this.device = 'cpu';
    this.startId = 0;      // зростає з кожним start()/stop(): застарілий запуск бачить це й відступає
  }

  get ready() { return this.status === 'ready'; }

  #set(status, error = null) {
    this.status = status;
    this.error = error;
    this.onStatus({ status, error });
  }

  #kill(child) {
    try { child.stdin?.end(); } catch { /* вже закрито */ }
    try { child.kill(); } catch { /* вже завершився */ }
  }

  #dropChild() {
    const child = this.child;
    this.child = null;
    this.base = null;
    this.listening?.abort();
    if (child) this.#kill(child);
  }

  // script та interpreterArgs підміняються лише в тестах
  async start(cfg, { script = SCRIPT, interpreterArgs = ['-u'] } = {}) {
    const id = ++this.startId;
    this.#dropChild();
    if (!cfg?.enabled) { this.#set('off'); return; }
    this.#set('starting');
    this.token = randomBytes(24).toString('hex');

    let child;
    try {
      child = spawn(cfg.python, [...interpreterArgs, script], {
        cwd: path.dirname(script),
        windowsHide: true,
        shell: false,
        // stdin лишаємо відкритим: сервіс завершується сам, щойно він закриється (тобто коли зникне застосунок)
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          OFFGRID_SPEECH_PORT: '0', // сервіс сам займе вільний порт і повідомить його в рядку READY
          OFFGRID_SPEECH_TOKEN: this.token,
          OFFGRID_WHISPER_DIR: cfg.whisperDir,
          OFFGRID_WHISPER_MODEL: cfg.whisperModel,
          OFFGRID_WHISPER_LIVE_MODEL: cfg.liveModel ?? '',
          OFFGRID_WHISPER_DEVICE: cfg.device ?? 'auto',
          OFFGRID_WHISPER_GPU_MODEL: cfg.gpuModel ?? 'large-v3-turbo',
          OFFGRID_PIPER_VOICE: cfg.piperVoice,
          OFFGRID_SPEECH_SPEED: String(cfg.speed ?? 1),
        },
      });
    } catch (e) {
      if (id === this.startId) this.#set('failed', `Не вдалося запустити Python: ${e.message}`);
      return;
    }
    this.child = child;
    let exited = false;
    let errTail = '';
    let out = '';

    // Чекаємо на рядок «READY http://127.0.0.1:<порт>» або на завершення процесу
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: 'Мовний сервіс не встиг запуститися' }), START_TIMEOUT_MS);
      const done = (value) => { clearTimeout(timer); resolve(value); };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        if (out === null) return;
        out = (out + d).slice(-2000);
        const m = out.match(/READY http:\/\/127\.0\.0\.1:(\d{2,5})(?: stt=(gpu|cpu))?[^\n]*\n/);
        if (m) { out = null; done({ port: Number(m[1]), device: m[2] ?? 'cpu' }); }
      });
      child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-800); });
      child.once('error', (e) => done({ error: `Не вдалося запустити Python: ${e.message}` }));
      child.once('exit', (code) => {
        exited = true;
        const last = errTail.trim().split(/\r?\n/).pop() ?? '';
        done({ error: `Мовний сервіс завершився під час запуску (код ${code}). ${last}`.trim() });
      });
    });

    if (id !== this.startId) { this.#kill(child); return; } // за цей час сервіс зупинили або запустили знову
    if (result.error || exited) {
      this.#kill(child);
      this.child = null;
      this.#set('failed', result.error ?? 'Мовний сервіс завершився під час запуску');
      return;
    }
    this.base = `http://127.0.0.1:${result.port}`;
    this.device = result.device; // 'gpu', якщо розпізнавання працює на відеокарті
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.base = null;
      this.listening?.abort();
      this.#set('failed', 'Мовний сервіс несподівано зупинився');
    });
    this.#set('ready');
  }

  async stop() {
    this.startId++;
    this.#dropChild();
    if (this.status !== 'off') this.#set('off');
  }

  #post(route, body, signal) {
    return fetch(this.base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Offgrid-Token': this.token },
      body: JSON.stringify(body ?? {}),
      signal,
    });
  }

  /**
   * Слухає мікрофон до паузи. onEvent отримує { type: 'listening' | 'speech' | 'recognizing' | 'partial', text? }.
   * Повертає { text } (порожній, якщо нічого не сказано), { cancelled: true } або кидає помилку.
   */
  async listen(onEvent = () => {}, { waitSeconds, strict = false } = {}) {
    if (!this.ready) throw new Error('Голос зараз недоступний');
    if (this.listening) throw new Error('Я вже слухаю');
    const abort = new AbortController();
    this.listening = abort;
    try {
      const body = { ...(Number.isFinite(waitSeconds) ? { wait_s: waitSeconds } : {}), ...(strict ? { strict: true } : {}) };
      const res = await this.#post('/listen', body, AbortSignal.any([abort.signal, AbortSignal.timeout(LISTEN_TIMEOUT_MS)]));
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Мовний сервіс: помилка ${res.status}`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'final') return { text: String(event.text ?? '').trim(), sttSeconds: event.stt_s };
          if (event.type === 'cancelled') return { cancelled: true };
          if (event.type === 'error') throw new Error(String(event.error ?? 'Помилка мовного сервісу'));
          if (event.type === 'partial') onEvent({ type: 'partial', text: String(event.text ?? '') });
          else if (['listening', 'speech', 'recognizing'].includes(event.type)) onEvent({ type: event.type });
        }
      }
      throw new Error('Мовний сервіс обірвав запис');
    } catch (e) {
      if (abort.signal.aborted) return { cancelled: true };
      if (e.name === 'TimeoutError') { this.#post('/cancel').catch(() => {}); throw new Error('Запис тривав надто довго'); }
      throw e;
    } finally {
      this.listening = null;
    }
  }

  /** Закінчити запис зараз і розпізнати сказане. */
  stopListening() {
    if (this.listening && this.ready) this.#post('/stop').catch(() => {});
  }

  /** Звільнити відеопам'ять: розпізнавання вивантажується з відеокарти й повернеться саме з наступним записом. */
  async sleep() {
    if (!this.ready || this.device !== 'gpu') return false;
    const res = await this.#post('/sleep', {}, AbortSignal.timeout(15_000));
    const data = await res.json().catch(() => ({}));
    return !!data.freed;
  }

  /** Скасувати запис і замовкнути. Запис скасовується одразу, не чекаючи відповіді сервісу. */
  cancel() {
    this.listening?.abort();
    if (this.ready) this.#post('/cancel').catch(() => {});
  }

  /**
   * Додає речення до озвучення й не чекає, доки воно прозвучить. Речення звучать одне за одним без пауз.
   * Повертає false, якщо сервіс більше не бере текст (ліміт довжини відповіді).
   */
  async say(text) {
    const clean = cleanForSpeech(text);
    if (!this.ready || !clean) return false;
    const res = await this.#post('/say', { text: clean }, AbortSignal.timeout(10_000));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error ?? `Мовний сервіс: помилка ${res.status}`);
    return data.accepted !== false;
  }

  /** Речень більше не буде: чекає, доки все договорено. Повертає { interrupted }. */
  async finishSpeaking() {
    if (!this.ready) return { interrupted: false };
    try {
      const res = await this.#post('/say-done', {}, AbortSignal.timeout(SAY_DONE_TIMEOUT_MS));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error ?? `Мовний сервіс: помилка ${res.status}`);
      return { interrupted: !!data.interrupted };
    } catch (e) {
      if (this.ready) this.#post('/cancel').catch(() => {});
      throw e.name === 'TimeoutError' ? new Error('озвучення тривало надто довго') : e;
    }
  }

  /** Озвучує текст. Повертає { interrupted } або кидає помилку. */
  async speak(text) {
    const clean = limitForSpeech(cleanForSpeech(text));
    if (!this.ready || !clean) return { interrupted: false, skipped: true };
    // запас часу залежить від довжини тексту: синтез + саме звучання
    const timeout = 30_000 + clean.length * 250;
    try {
      const res = await this.#post('/speak', { text: clean }, AbortSignal.timeout(timeout));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error ?? `Мовний сервіс: помилка ${res.status}`);
      return { interrupted: !!data.interrupted };
    } catch (e) {
      // що б не сталося — сервіс має замовкнути, інакше він говоритиме далі вже без нашого відома
      if (this.ready) this.#post('/cancel').catch(() => {});
      throw e.name === 'TimeoutError' ? new Error('озвучення тривало надто довго') : e;
    }
  }
}
