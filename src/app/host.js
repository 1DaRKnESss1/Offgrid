// Нативна оболонка застосунку: вікно панелі, іконка в треї, глобальна клавіша, системні діалоги.
// Це окремий процес PowerShell (shell/host.ps1) — те, чим раніше був Electron. Він складається лише з
// компонентів, яким Windows уже довіряє, тому Smart App Control його не блокує.
// Тут — керування ним: команди йдуть рядками JSON у його stdin, події повертаються рядками з stdout.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../paths.js';

const SCRIPT = path.join(ROOT, 'shell', 'host.ps1');
const LIBS = path.join(ROOT, 'shell', 'webview2');
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const START_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 15_000;

// Назви клавіш у налаштуваннях -> коди Windows
const MODS = { Alt: 1, Control: 2, Shift: 4, Super: 8 };
const KEYS = { Space: 0x20, Tab: 0x09, Insert: 0x2d, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Left: 0x25, Up: 0x26, Right: 0x27, Down: 0x28 };

/** «Control+Shift+Space» -> { mods, vk } або null. */
export function parseHotkey(accelerator) {
  if (typeof accelerator !== 'string') return null;
  const parts = accelerator.split('+');
  const key = parts.pop();
  let mods = 0;
  for (const m of parts) {
    if (!Object.hasOwn(MODS, m) || (mods & MODS[m])) return null;
    mods |= MODS[m];
  }
  let vk = null;
  if (/^[A-Z0-9]$/.test(key)) vk = key.charCodeAt(0);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(key)) vk = 0x6f + Number(key.slice(1));
  else if (Object.hasOwn(KEYS, key)) vk = KEYS[key];
  return mods && vk ? { mods, vk } : null;
}

export function shellInstalled() {
  return ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']
    .every((f) => fs.existsSync(path.join(LIBS, f)));
}

/**
 * Події: 'hotkey', 'tray-click', 'menu' (id), 'blur', 'focus', 'shown', 'hidden', 'moved' ({x, y}), 'exit' (code).
 */
export class Host extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.visible = false;
    this.focused = false;
    this.pending = new Map(); // id -> { resolve, timer }
    this.nextId = 1;
  }

  /** Запускає оболонку й чекає, доки панель завантажить сторінку. */
  start({ url, dataDir, width, height, spot = null }) {
    return new Promise((resolve, reject) => {
      if (!shellInstalled()) return reject(new Error('Немає бібліотек WebView2. Виконай: powershell -ExecutionPolicy Bypass -File scripts\\setup-webview2.ps1'));
      fs.mkdirSync(dataDir, { recursive: true });
      // адреса панелі містить одноразовий ключ, тому йде не в командний рядок (його бачать інші програми),
      // а першою командою через stdin
      const child = spawn(POWERSHELL, ['-NoProfile', '-NoLogo', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
        '-DataDir', dataDir, '-Width', String(width), '-Height', String(height)],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      // якщо оболонка зникла, запис у її stdin дав би необроблену помилку й звалив би застосунок замість чистого виходу
      child.stdin.on('error', () => {});
      this.place(spot); // ще до показу: острівець з'являється одразу на своєму місці
      this.#send({ c: 'navigate', url });
      let started = false;
      let errTail = '';
      const timer = setTimeout(() => { if (!started) { this.#kill(); reject(new Error('Оболонка не встигла запуститися')); } }, START_TIMEOUT_MS);

      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buffer += d;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.t === 'ready' && !started) {
            started = true;
            clearTimeout(timer);
            if (msg.ok) resolve({ browser: msg.browser }); else reject(new Error('Панель не змогла завантажити свою сторінку'));
          } else if (msg.t === 'fatal' && !started) {
            started = true;
            clearTimeout(timer);
            this.#kill();
            reject(new Error(`Оболонка не запустилась: ${msg.error}`));
          } else this.#onMessage(msg);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-600); });
      child.once('error', (e) => { clearTimeout(timer); if (!started) { started = true; reject(new Error(`Не вдалося запустити PowerShell: ${e.message}`)); } });
      child.once('exit', (code) => {
        clearTimeout(timer);
        this.child = null;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false }); }
        this.pending.clear();
        if (!started) { started = true; reject(new Error(`Оболонка завершилась під час запуску (код ${code}). ${errTail.trim().split(/\r?\n/).pop() ?? ''}`.trim())); }
        this.emit('exit', code);
      });
    });
  }

  #onMessage(msg) {
    switch (msg.t) {
      case 'reply': {
        const p = this.pending.get(msg.id);
        if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); p.resolve(msg); }
        break;
      }
      case 'shown': this.visible = true; this.emit('shown'); break;
      case 'hidden': this.visible = false; this.focused = false; this.emit('hidden'); break;
      case 'focus': this.focused = true; this.emit('focus'); break;
      case 'blur': this.focused = false; this.emit('blur'); break;
      case 'hotkey': this.emit('hotkey'); break;
      case 'hotkey2': this.emit('hotkey2'); break;
      case 'tray-click': this.emit('tray-click'); break;
      case 'menu': this.emit('menu', String(msg.id)); break;
      case 'moved': if (Number.isInteger(msg.x) && Number.isInteger(msg.y)) this.emit('moved', { x: msg.x, y: msg.y }); break;
      default: break; // 'error' та інше — оболонка сама продовжує працювати
    }
  }

  #send(cmd) {
    if (!this.child?.stdin.writable) return false;
    try { this.child.stdin.write(JSON.stringify(cmd) + '\n'); return true; } catch { return false; }
  }

  #ask(cmd, timeout = REPLY_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); resolve({ ok: false }); }, timeout) : null;
      this.pending.set(id, { resolve, timer });
      if (!this.#send({ ...cmd, id })) { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false }); }
    });
  }

  #kill() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.end(); } catch { /* вже закрито */ }
    try { child.kill(); } catch { /* вже завершився */ }
  }

  /** Острівець і так завжди на екрані; focus: true віддає йому клавіатуру (панель розкрито, користувач друкуватиме). */
  show({ focus = true } = {}) { this.#send({ c: 'show', focus }); }

  /** Поставити вікно на збережене місце ({ x, y }) або, якщо місця немає чи воно поза екранами, — угорі по центру. */
  place(spot) { this.#send({ c: 'place', x: spot?.x ?? null, y: spot?.y ?? null }); }

  /** Іконка (PNG) і підказка в треї. */
  setTray({ icon, tip }) { this.#send({ c: 'tray', icon: icon ? icon.toString('base64') : undefined, tip }); }

  /** Меню трею: [{ id, label, checked?, enabled? } | { separator: true }]. */
  setMenu(items) { this.#send({ c: 'menu', items }); }

  /** Реєструє глобальну клавішу. Повертає true, якщо Windows її віддала. */
  /** slot 1 — клавіша розмови, slot 2 — клавіша диктування (подія 'hotkey2'). */
  async registerHotkey(accelerator, slot = 1) {
    const key = parseHotkey(accelerator);
    if (!key) return false;
    return (await this.#ask({ c: 'hotkey', slot, ...key })).ok === true;
  }

  async unregisterHotkey(slot = 1) { await this.#ask({ c: 'unhotkey', slot }); }

  /** Друкує текст у вікно, що зараз має клавіатуру (не у власне). Жодних Enter чи сполучень — лише знаки. */
  async type(text) { return (await this.#ask({ c: 'type', text: String(text).slice(0, 6000) })).ok === true; }

  /** Текст, виділений у вікні, що зараз має клавіатуру (через буфер обміну). '' — нічого не виділено. */
  async copySelection() { const r = await this.#ask({ c: 'copy' }); return typeof r.text === 'string' ? r.text : ''; }

  async setClipboard(text) { return (await this.#ask({ c: 'clip', text: String(text) })).ok === true; }

  /** Системне вікно вибору програми ('exe') або папки ('dir'). Повертає шлях або null. */
  async pick(kind, title) {
    const res = await this.#ask({ c: 'pick', kind, title }, 0); // без тайм-ауту: користувач обирає скільки хоче
    return typeof res.path === 'string' && res.path ? res.path : null;
  }

  /** Відкриває файл, папку чи адресу програмою за замовчуванням. */
  async open(target) { return (await this.#ask({ c: 'open', target })).ok === true; }

  /** Знімок панелі у файл PNG (для розробки). */
  async shot(file) { return (await this.#ask({ c: 'shot', path: file }, 20_000)).ok === true; }

  /** Знімок екрана, на якому зараз миша, у файл PNG (не ширший за max пікселів). Повертає { ok, w, h }. */
  async screen(file, max) { return this.#ask({ c: 'screen', path: file, max }, 20_000); }

  /** Натискає медіа-клавішу (пауза, трек, гучність) times разів. Інших клавіш оболонка не натискає. */
  async key(vk, times = 1) { return (await this.#ask({ c: 'key', vk, times })).ok === true; }

  /**
   * Керування плеєрами напряму: 'pause' | 'play' | 'toggle' | 'next' | 'previous' | 'status'.
   * Повертає { ok, players, playing: [назви програм], already, unsupported }.
   */
  async media(action) { return this.#ask({ c: 'media', action }, 12_000); }

  /**
   * Гучність окремої програми в мікшері Windows. names — частини назв процесів; delta — на скільки відсотків
   * змінити (±); mute — перемкнути «без звуку». Без names лише повертає, які програми зараз мають звук.
   * Повертає { changed: [{ name, level, muted }], all: [назви] }.
   */
  async appVolume(names, delta = 0, mute = false) {
    const r = await this.#ask({ c: 'appvol', names: names ?? null, delta, mute });
    const part = (key) => (new RegExp(`${key}=([^;]*)`).exec(String(r.result ?? ''))?.[1] ?? '').split(',').filter(Boolean);
    return {
      changed: part('changed').map((e) => { const [name, lv] = e.split(':'); return { name, level: parseInt(lv, 10), muted: /m$/.test(lv ?? '') }; }),
      all: part('all'),
    };
  }

  /** Сигнал таймера (стандартний звук Windows). */
  async sound() { return (await this.#ask({ c: 'sound' })).ok === true; }

  /** Згорнути всі вікна (restore: false) або повернути їх. */
  async desktop(restore) { return (await this.#ask({ c: 'desktop', restore: restore === true })).ok === true; }

  stop() {
    this.#send({ c: 'quit' });
    setTimeout(() => this.#kill(), 1500).unref();
  }
}
