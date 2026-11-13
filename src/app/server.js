// Локальний сервер панелі: віддає її сторінку, приймає її запити й надсилає їй події.
// Раніше це робив внутрішній канал Electron (IPC); тепер — HTTP на 127.0.0.1.
//
// Захист. Сервер слухає лише цей комп'ютер, на випадковому порту, і відповідає тільки тому, хто має
// одноразовий ключ: панель отримує його в адресі при запуску, далі він живе в cookie. Інша програма чи
// відкрита в браузері сторінка ключа не знає, тож не може ні читати події, ні давати команди.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ROOT } from '../paths.js';

const RENDERER = path.join(ROOT, 'src', 'renderer');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/bridge.js': ['bridge.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/settings.js': ['settings.js', 'text/javascript; charset=utf-8'],
};
const MAX_BODY = 64 * 1024;
const COOKIE = 'offgrid';
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function sameKey(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

export class PanelServer {
  /** handlers: { назва: async (тіло запиту) => відповідь } */
  constructor(handlers) {
    this.handlers = handlers;
    this.token = randomBytes(32).toString('hex');
    this.clients = new Set(); // відкриті потоки подій
    this.server = http.createServer((req, res) => { this.#handle(req, res).catch(() => { try { res.writeHead(500).end(); } catch { /* з'єднання вже закрите */ } }); });
    this.port = 0;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.origin = `http://127.0.0.1:${this.port}`;
        resolve(`${this.origin}/?k=${this.token}`);
      });
    });
  }

  close() {
    for (const res of this.clients) { try { res.end(); } catch { /* вже закрито */ } }
    this.clients.clear();
    this.server.close();
    this.server.closeAllConnections?.();
  }

  /** Надсилає подію панелі. */
  broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) { try { res.write(data); } catch { this.clients.delete(res); } }
  }

  #authorized(req) {
    // запит має прийти саме на нашу адресу (захист від підміни імені сайту) і з нашою cookie
    if (req.headers.host !== `127.0.0.1:${this.port}`) return false;
    const origin = req.headers.origin;
    if (origin && origin !== this.origin) return false;
    const m = String(req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]+)`));
    return !!m && sameKey(m[1], this.token);
  }

  async #handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const deny = (code) => { res.writeHead(code, SECURITY_HEADERS).end(); };

    // Перший запит панелі: ключ в адресі міняється на cookie, а з адреси зникає
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('k')) {
      if (req.headers.host !== `127.0.0.1:${this.port}` || !sameKey(url.searchParams.get('k'), this.token)) return deny(403);
      res.writeHead(302, { ...SECURITY_HEADERS, Location: '/', 'Set-Cookie': `${COOKIE}=${this.token}; HttpOnly; SameSite=Strict; Path=/` });
      return res.end();
    }
    if (!this.#authorized(req)) return deny(403);

    if (req.method === 'GET' && Object.hasOwn(FILES, url.pathname)) {
      const [file, type] = FILES[url.pathname];
      const body = await fs.promises.readFile(path.join(RENDERER, file));
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': body.length });
      return res.end(body);
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return undefined;
    }

    const api = url.pathname.match(/^\/api\/([a-z-]{1,40})$/);
    if (req.method === 'POST' && api && Object.hasOwn(this.handlers, api[1])) {
      // лише JSON: «прості» форми з інших сайтів сюди не пройдуть навіть теоретично
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return deny(415);
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) return deny(413);
      }
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { return deny(400); }
      const result = await this.handlers[api[1]](body && typeof body === 'object' && !Array.isArray(body) ? body : {});
      const out = Buffer.from(JSON.stringify(result ?? null));
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': out.length });
      return res.end(out);
    }
    return deny(404);
  }
}
