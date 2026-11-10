// Клієнт мовного сервісу: запускає speech/speech_server.py і розмовляє з ним через 127.0.0.1.
// Сервіс отримує одноразовий токен; без нього він не відповідає нікому, крім цього застосунку.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { ROOT } from '../paths.js';

const SCRIPT = path.join(ROOT, 'speech', 'speech_server.py');
const START_TIMEOUT_MS = 180_000; // перше завантаження моделей із диска буває довгим
const SPEAK_TIMEOUT_MS = 120_000;
const LISTEN_TIMEOUT_MS = 90_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Прибирає те, що голос не має зачитувати: розмітку, емодзі, зайві пробіли. */
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' посилання ')
    .replace(/[*_#`>|~^\\[\]{}<]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
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
    this.speaking = false;
  }

  get ready() { return this.status === 'ready'; }

  #set(status, error = null) {
    this.status = status;
    this.error = error;
    this.onStatus({ status, error });
  }

  async start(cfg) {
    await this.stop();
    if (!cfg?.enabled) { this.#set('off'); return; }
    this.#set('starting');
    let port;
    try { port = await freePort(); } catch (e) { this.#set('failed', `Немає вільного порту: ${e.message}`); return; }
    this.token = randomBytes(24).toString('hex');
    this.base = `http://127.0.0.1:${port}`;

    const child = spawn(cfg.python, ['-u', SCRIPT], {
      cwd: path.dirname(SCRIPT),
      windowsHide: true,
      shell: false,
      // stdin лишаємо відкритим: сервіс завершується сам, щойно він закриється (тобто коли зникне застосунок)
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        OFFGRID_SPEECH_PORT: String(port),
        OFFGRID_SPEECH_TOKEN: this.token,
        OFFGRID_WHISPER_DIR: cfg.whisperDir,
        OFFGRID_WHISPER_MODEL: cfg.whisperModel,
        OFFGRID_WHISPER_LIVE_MODEL: cfg.liveModel ?? '',
        OFFGRID_PIPER_VOICE: cfg.piperVoice,
        OFFGRID_SPEECH_SPEED: String(cfg.speed ?? 1),
      },
    });
    this.child = child;
    let tail = '';
    const started = new Promise((resolve) => {
      const timer = setTimeout(() => resolve('Мовний сервіс не встиг запуститися'), START_TIMEOUT_MS);
      const done = (err) => { clearTimeout(timer); resolve(err); };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => { if (d.includes('READY ')) done(null); });
      child.stderr.on('data', (d) => { tail = (tail + d).slice(-600); });
      child.once('error', (e) => done(`Не вдалося запустити Python: ${e.message}`));
      child.once('exit', (code) => done(`Мовний сервіс завершився (код ${code}). ${tail.trim().split(/\r?\n/).pop() ?? ''}`.trim()));
    });
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.listening?.abort();
      if (this.status === 'ready') this.#set('failed', 'Мовний сервіс несподівано зупинився');
    });

    const err = await started;
    if (this.child !== child) return; // за цей час сервіс зупинили або перезапустили
    if (err) { this.#kill(child); this.child = null; this.#set('failed', err); return; }
    this.#set('ready');
  }

  #kill(child) {
    try { child.stdin?.end(); } catch { /* вже закрито */ }
    try { child.kill(); } catch { /* вже завершився */ }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.listening?.abort();
    if (child) this.#kill(child);
    if (this.status !== 'off') this.#set('off');
  }

  async #post(route, body, signal) {
    const res = await fetch(this.base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Offgrid-Token': this.token },
      body: JSON.stringify(body ?? {}),
      signal,
    });
    return res;
  }

  /**
   * Слухає мікрофон до паузи. onEvent отримує { type: 'listening' | 'speech' | 'partial', text? }.
   * Повертає { text } (порожній, якщо нічого не сказано), { cancelled: true } або кидає помилку.
   */
  async listen(onEvent = () => {}) {
    if (!this.ready) throw new Error('Голос зараз недоступний');
    if (this.listening) throw new Error('Я вже слухаю');
    const abort = new AbortController();
    this.listening = abort;
    try {
      const res = await this.#post('/listen', {}, AbortSignal.any([abort.signal, AbortSignal.timeout(LISTEN_TIMEOUT_MS)]));
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
      if (e.name === 'TimeoutError') throw new Error('Запис тривав надто довго');
      throw e;
    } finally {
      this.listening = null;
    }
  }

  /** Закінчити запис зараз і розпізнати сказане. */
  stopListening() {
    if (this.listening && this.ready) this.#post('/stop').catch(() => {});
  }

  /** Скасувати запис і замовкнути. */
  cancel() {
    if (!this.ready) return;
    this.#post('/cancel').catch(() => {});
  }

  /** Озвучує текст. Повертає { interrupted } або кидає помилку. */
  async speak(text) {
    const clean = cleanForSpeech(text);
    if (!this.ready || !clean) return { interrupted: false, skipped: true };
    this.speaking = true;
    try {
      const res = await this.#post('/speak', { text: clean }, AbortSignal.timeout(SPEAK_TIMEOUT_MS));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error ?? `Мовний сервіс: помилка ${res.status}`);
      return { interrupted: !!data.interrupted };
    } finally {
      this.speaking = false;
    }
  }
}
