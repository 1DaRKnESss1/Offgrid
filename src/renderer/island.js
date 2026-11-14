// Острівець: маленька «пігулка», яка завжди на екрані й показує, що асистент робить просто зараз.
// Клік розкриває в ній повну панель (розмова, налаштування, журнал). Увесь текст — лише textContent.
// Форму вікна тримає оболонка: сторінка повідомляє їй, яку частину вікна зараз займає острівець,
// а решта вікна «вирізається», і кліки поруч з острівцем доходять до програм під ним.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const body = document.body, island = $('island'), text = $('pill-text');
  const host = window.chrome?.webview;
  const TOP = 8; // відступ острівця від верхнього краю вікна
  // режим -> [ширина, висота, радіус]; ті самі числа стоять у style.css
  const SIZES = {
    idle: [150, 36, 18], hint: [230, 36, 18], listening: [340, 44, 22], busy: [240, 36, 18],
    reply: [390, 66, 26], note: [370, 40, 20], confirm: [390, 136, 28], confirmlong: [400, 236, 28], open: [460, 640, 28],
  };
  const ALLOW_DELAY_MS = 800; // щоб клацання, націлене в інше вікно, не стало дозволом
  const TAIL_CHARS = 105;

  let state = 'idle', open = false, asleep = false, wake = null;
  let confirm = null;      // { id, summary }
  let live = '';           // текст, що розпізнається просто зараз
  let reply = '';          // відповідь, яку модель пише / щойно сказала
  let tool = '';           // остання виконана дія
  let note = null;         // { text, tone } — коротке повідомлення на кілька секунд
  let dictating = false;
  let timers = [];         // [{ id, label, due }] — найближчий показуємо в спокої
  let noteTimer = null, lingerTimer = null, lingering = false, allowTimer = null;

  function mode() {
    if (open) return 'open';
    if (confirm) return confirm.long ? 'confirmlong' : 'confirm';
    if (state === 'listening') return 'listening';
    if (state === 'speaking') return 'reply';
    if (state === 'thinking' || state === 'executing' || state === 'confirming') return reply && state === 'thinking' ? 'reply' : 'busy';
    if (note) return 'note';
    if (lingering && reply) return 'reply';
    return wake?.armed || asleep || timers.length ? 'hint' : 'idle';
  }

  // кінець довгого тексту, з початку слова: острівець показує те, що звучить зараз, а не початок відповіді
  function tail(s) {
    const t = s.replace(/\s+/g, ' ').trim();
    if (t.length <= TAIL_CHARS) return t;
    const cut = t.slice(-TAIL_CHARS);
    return '…' + cut.slice(cut.indexOf(' ') + 1);
  }

  function timerLabel() {
    const t = timers[0];
    const s = Math.max(0, Math.round((t.due - Date.now()) / 1000));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
    const left = hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
    return `${t.label ? t.label.slice(0, 16) : 'Таймер'} · ${left}${timers.length > 1 ? ` (+${timers.length - 1})` : ''}`;
  }

  function label(m) {
    switch (m) {
      case 'listening': return live || (dictating ? 'Диктуй — надрукую, де курсор…' : 'Слухаю…');
      case 'busy': return tool || (state === 'executing' ? 'Виконую…' : 'Думаю…');
      case 'reply': return tail(reply);
      case 'note': return note.text;
      case 'hint': if (timers.length) return timerLabel();
        return asleep && !wake?.armed ? 'Сплю — поклич, і прокинусь' : (asleep ? `Сплю · скажи «${wake.name}»` : `Скажи «${wake.name}»`);
      default: return 'Offgrid';
    }
  }

  // --- форма вікна ---
  let box = [0, 0], shrink = null, shape = '';
  function post(w, h, r, pad) {
    box = [w, h];
    const vw = document.documentElement.clientWidth;
    host?.postMessage({ t: 'box', x: Math.round((vw - w) / 2) - pad, y: TOP - pad, w: w + pad * 2, h: h + pad * 2, r: r + pad });
  }
  function claim(m) {
    if (m === shape) return;
    shape = m;
    const [w, h, r] = SIZES[m];
    clearTimeout(shrink);
    // росте — одразу займаємо більше місце (із запасом на пружинку); меншає — віддаємо зайве, коли рух закінчився
    post(Math.max(w, box[0]), Math.max(h, box[1]), r, 12);
    shrink = setTimeout(() => post(w, h, r, 3), 560);
  }

  function render() {
    const m = mode();
    body.dataset.mode = m;
    body.dataset.tone = m === 'note' ? note.tone : '';
    body.dataset.timer = m === 'hint' && timers.length ? 'on' : '';
    if (m !== 'open' && !m.startsWith('confirm')) text.textContent = label(m);
    $('panel').inert = m !== 'open';
    claim(m);
  }

  function showNote(msg, tone = 'soft', ms = 4500) {
    if (open || !msg) return; // у розкритій панелі це й так видно в розмові
    clearTimeout(noteTimer);
    note = { text: String(msg), tone };
    noteTimer = setTimeout(() => { note = null; render(); }, ms);
    render();
  }

  function linger() {
    clearTimeout(lingerTimer);
    lingering = true;
    lingerTimer = setTimeout(() => { lingering = false; reply = ''; render(); }, Math.min(9000, 2500 + reply.length * 45));
  }

  function showConfirm(event) {
    const wide = event.scope?.conversation === true || !!event.scope?.always;
    confirm = { id: event.id, long: wide || String(event.summary ?? '').length > 95 };
    $('pill-conversation').hidden = event.scope?.conversation !== true;
    $('pill-always').hidden = !event.scope?.always;
    if (event.scope?.always) $('pill-always').textContent = `Завжди для ${event.scope.always}`;
    $('pill-confirm-text').textContent = event.summary;
    const buttons = [$('pill-allow'), $('pill-conversation'), $('pill-always')];
    for (const b of buttons) b.disabled = true;
    clearTimeout(allowTimer);
    allowTimer = setTimeout(() => { for (const b of buttons) b.disabled = false; }, ALLOW_DELAY_MS);
  }

  window.addEventListener('offgrid-event', (e) => {
    const event = e.detail;
    switch (event.type) {
      case 'state': {
        const was = state;
        state = event.state;
        if (state === 'idle' && was !== 'idle' && reply && !open) linger();
        if (state !== 'idle') { lingering = false; clearTimeout(lingerTimer); }
        break;
      }
      case 'panel': open = event.open === true; if (open) { note = null; lingering = false; } break;
      case 'user': reply = ''; tool = ''; live = ''; break;
      case 'partial': live = event.text; break;
      case 'partial-end': live = ''; break;
      case 'reply-delta': reply += event.text; break;
      case 'reply-reset': reply = ''; break;
      case 'assistant': reply = event.text; if (state === 'idle' && !open) linger(); break;
      case 'tool': tool = event.text || event.name || ''; break;
      case 'busy': if (!event.value) tool = ''; break;
      case 'confirm': showConfirm(event); break;
      case 'confirm-done': if (confirm?.id === event.id) confirm = null; break;
      case 'wake': wake = { armed: event.armed === true, name: String(event.name ?? '') }; break;
      case 'asleep': asleep = event.value === true; break;
      case 'dictation': dictating = event.on === true; break;
      case 'timers': timers = Array.isArray(event.list) ? event.list : []; break;
      case 'timer-fired': note = null; open ? null : showNote(event.text, 'warn', 15000); return;
      case 'reset': reply = ''; tool = ''; note = null; confirm = null; lingering = false; break;
      case 'soft': showNote(event.text); return;
      case 'notice': showNote(event.text, 'warn', 6000); return;
      case 'error': showNote(event.text, 'error', 6000); return;
      case 'stopped': showNote('Зупинено', 'soft', 2000); return;
      default: return;
    }
    render();
  });

  $('pill-allow').addEventListener('click', () => { if (confirm) window.offgrid.answerConfirm(confirm.id, true); });
  $('pill-deny').addEventListener('click', () => { if (confirm) window.offgrid.answerConfirm(confirm.id, false); });
  $('pill-conversation').addEventListener('click', () => { if (confirm) window.offgrid.answerConfirm(confirm.id, 'conversation'); });
  $('pill-always').addEventListener('click', () => { if (confirm) window.offgrid.answerConfirm(confirm.id, 'always'); });

  // --- миша: потягнув — вікно рухається, клацнув по пігулці — панель розкривається ---
  // У розкритій панелі тягнути можна лише за заголовок: решта — текст, поля й кнопки.
  let press = null;
  island.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select, textarea, label, a')) return;
    if (open && !e.target.closest('header, .view-head')) return;
    press = { x: e.screenX, y: e.screenY };
  });
  window.addEventListener('mousemove', (e) => {
    if (press && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) { press = null; host?.postMessage({ t: 'drag' }); }
  });
  window.addEventListener('mouseup', () => {
    if (!press) return;
    press = null;
    if (!open) window.offgrid.show();
  });

  setInterval(() => { if (timers.length && body.dataset.mode === 'hint') text.textContent = label('hint'); }, 1000);
  render();
  window.offgrid.ready().then((info) => {
    if (!info) return;
    state = info.state;
    asleep = info.asleep === true;
    wake = info.wake ?? null;
    timers = Array.isArray(info.timers) ? info.timers : [];
    open = info.open === true;
    render();
  }).catch(() => {});
})();
