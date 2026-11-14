// Екран «Керування»: те саме, що асистент уміє робити з комп'ютером на прохання, — кнопками. Музика, гучність,
// вікна, таймери. Кожна кнопка надсилає головному процесу назву дії зі сталого переліку; виконує її він.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.offgrid;
  const root = $('control-body');
  let timers = [];
  let scenarios = [];
  let message = '';
  let messageTimer = null;

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, String(v));
    }
    el.append(...children.filter(Boolean));
    return el;
  }

  const left = (due) => {
    const s = Math.max(0, Math.round((due - Date.now()) / 1000));
    const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return hh ? `${hh}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  };

  function say(text) {
    message = text ?? '';
    clearTimeout(messageTimer);
    if (message) messageTimer = setTimeout(() => { message = ''; render(); }, 4000);
    render();
  }

  async function act(action) {
    try { const res = await api.control(action); if (res && res.message) say(res.ok === false ? (res.error ?? 'Не вдалося') : res.message); else if (res?.ok === false) say(res.error ?? 'Не вдалося'); } catch { say('Не вдалося'); }
  }
  async function timer(payload) {
    try { const res = await api.timer(payload); if (res?.ok === false) say(res.error ?? 'Не вдалося'); } catch { say('Не вдалося'); }
  }

  const big = (icon, label, action, extra = '') => h('button', { type: 'button', class: `tile ${extra}`, title: label, 'aria-label': label, onclick: () => act(action) },
    h('span', { class: `ic ${icon}` }), h('span', { class: 'tile-label', text: label }));

  function render() {
    if (document.body.dataset.view !== 'control') return;
    root.replaceChildren(
      h('div', { class: 'group-title', text: 'Музика й відео' }),
      h('div', { class: 'tiles three' }, big('ic-prev', 'Назад', 'previous_track'), big('ic-play', 'Пауза / далі', 'play_pause', 'accent'), big('ic-next', 'Наступний', 'next_track')),
      h('div', { class: 'tiles three' }, big('ic-minus', 'Тихіше', 'volume_down'), big('ic-mute', 'Без звуку', 'mute'), big('ic-plus', 'Гучніше', 'volume_up')),

      h('div', { class: 'group-title', text: 'Вікна й екран' }),
      h('div', { class: 'tiles two' }, big('ic-desktop', 'Згорнути все', 'minimize_all'), big('ic-restore', 'Повернути вікна', 'restore_windows')),
      h('div', { class: 'tiles two' }, big('ic-camera', 'Знімок екрана', 'screenshot'), big('ic-lock', 'Заблокувати', 'lock')),

      h('div', { class: 'group-title', text: 'Таймер' }),
      h('div', { class: 'tiles four' }, ...[1, 5, 10, 25].map((m) => h('button', { type: 'button', class: 'tile small', onclick: () => timer({ action: 'set', minutes: m }) }, `${m} хв`))),
      ...timers.map((t) => h('div', { class: 'timer-row' },
        h('span', { class: 'ic ic-timer' }),
        h('span', { class: 'timer-name', text: t.label || 'Таймер' }),
        h('span', { class: 'timer-left', 'data-due': t.due, text: left(t.due) }),
        h('button', { type: 'button', class: 'icon', title: 'Скасувати', 'aria-label': 'Скасувати таймер', onclick: () => timer({ action: 'cancel', id: t.id }) }, h('span', { class: 'ic ic-x' })))),
      timers.length === 0 ? h('p', { class: 'help', text: 'Або скажи: «нагадай через 20 хвилин вимкнути плиту», «таймер на 5 хвилин», «розбуди о сьомій».' }) : null,

      h('div', { class: 'group-title', text: 'Сценарії' }),
      ...scenarios.map((name) => h('div', { class: 'timer-row' },
        h('span', { class: 'ic ic-play' }),
        h('span', { class: 'timer-name', text: name }),
        h('button', { type: 'button', class: 'run', onclick: async () => { say('Запускаю…'); const r = await api.scenario('run', name).catch(() => null); say(r ? (r.ok === false ? r.error : r.message) : 'Не вдалося'); } }, 'Запустити'),
        h('button', { type: 'button', class: 'icon', title: 'Видалити', 'aria-label': `Видалити сценарій ${name}`, onclick: async () => { await api.scenario('delete', name).catch(() => null); } }, h('span', { class: 'ic ic-x' })))),
      scenarios.length === 0 ? h('p', { class: 'help', text: 'Сценаріїв ще немає. Скажи, наприклад: «створи сценарій режим гри: відкрий Steam і Discord і зроби гучніше» — і підтвердь кнопкою.' }) : null,

      h('div', { class: 'group-title', text: 'Асистент' }),
      h('div', { class: 'tiles two' }, big('ic-moon', 'Звільнити відеопам\'ять', 'sleep'), big('ic-new', 'Нова розмова', 'new_chat')),
      message ? h('div', { class: 'control-message', role: 'status', text: message }) : null,
    );
  }

  window.addEventListener('offgrid-event', (e) => {
    const event = e.detail;
    if (event.type === 'timers') { timers = Array.isArray(event.list) ? event.list : []; render(); }
    if (event.type === 'scenarios') { scenarios = Array.isArray(event.list) ? event.list : []; render(); }
  });
  setInterval(() => { for (const el of root.querySelectorAll('.timer-left')) el.textContent = left(Number(el.dataset.due)); }, 1000); // відлік
  window.offgridControl = { render };
  api.ready().then((info) => { timers = Array.isArray(info?.timers) ? info.timers : []; scenarios = Array.isArray(info?.scenarios) ? info.scenarios : []; render(); }).catch(() => {});

  $('open-control').addEventListener('click', () => window.offgridView.show(window.offgridView.current === 'control' ? 'chat' : 'control'));
  $('control-back').addEventListener('click', () => window.offgridView.show('chat'));
})();
