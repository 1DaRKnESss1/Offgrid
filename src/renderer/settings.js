// Екрани «Налаштування» і «Журнал». Панель лише показує й просить; кожну зміну перевіряє та записує
// головний процес. Файли й папки обираються системним вікном вибору, а не текстом.
// Увесь текст вставляється як textContent.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.offgrid;
  const views = { chat: $('view-chat'), settings: $('view-settings'), log: $('view-log') };
  const TABS = [['apps', 'Програми'], ['folders', 'Папки'], ['files', 'Файли'], ['other', 'Інше']];
  const TOOL_NAMES = {
    app: 'Застосунок', settings: 'Налаштування', open_app: 'Відкрити програму', close_app: 'Закрити програму',
    get_time: 'Час', get_system_info: 'Стан системи', change_volume: 'Гучність', open_folder: 'Відкрити папку',
    find_files: 'Пошук файлів', list_folder: 'Перегляд папки', open_file: 'Відкрити файл', read_text_file: 'Прочитати файл',
    write_note: 'Записати нотатку', list_notes: 'Список нотаток', read_note: 'Прочитати нотатку', delete_note: 'Видалити нотатку',
    search_web: 'Пошук в інтернеті', open_website: 'Відкрити сайт',
  };
  const DECISIONS = {
    auto: ['виконано', 'ok'], confirmed: ['з твого дозволу', 'ok'], user: ['змінено тобою', 'ok'],
    denied: ['ти відхилив', 'bad'], 'auto-denied': ['відхилено', 'bad'], rejected: ['відмовлено', 'bad'],
    error: ['помилка', 'bad'], cancelled: ['скасовано', 'bad'],
  };

  let current = 'chat';
  let tab = 'apps';
  let view = null;         // дані екрана налаштувань від головного процесу
  let activeHotkey = null;
  let message = '';        // остання помилка зміни
  let capturing = false;   // чекаємо на нове сполучення клавіш
  let busy = false;
  let queued = null;       // одна зміна, що чекає, поки завершиться попередня

  // Маленький помічник для побудови елементів без innerHTML
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, String(v));
    }
    el.append(...children.filter(Boolean));
    return el;
  }

  const prettyKeys = (acc) => (acc ? acc.replace('Control', 'Ctrl').replace('Super', 'Win').replaceAll('+', ' + ') : 'не задано');

  function setCapturing(value) {
    if (capturing === value) return;
    capturing = value;
    api.captureHotkey(value);
  }

  function show(name, options = {}) {
    if (!views[name]) return;
    current = name;
    setCapturing(false);
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
    document.body.dataset.view = name;
    if (name === 'settings') { if (options.tab) tab = options.tab; message = ''; request('get'); }
    else if (name === 'log') loadLog();
    else $('input').focus();
  }
  window.offgridView = { show, get current() { return current; }, captureEnded() { capturing = false; render(); } };

  async function request(action, payload) {
    // зміни не губимо: якщо попередня ще виконується, остання натиснута чекає своєї черги
    if (busy) { queued = [action, payload]; return; }
    busy = true;
    try {
      const res = await api.settings(action, payload);
      if (!res) return;
      view = res.view ?? view;
      activeHotkey = res.activeHotkey ?? null;
      message = res.ok === false ? (res.error ?? 'Не вдалося змінити налаштування') : '';
    } catch (e) {
      message = String(e?.message ?? e);
    } finally {
      busy = false;
      if (queued) { const [a, p] = queued; queued = null; request(a, p); } else render();
    }
  }

  // ---------- Налаштування ----------
  function renderApps() {
    const rows = view.apps.map((a) => h('div', { class: a.valid ? 'item' : 'item invalid' },
      h('div', { class: 'item-head' },
        h('input', { class: 'item-name', type: 'text', maxlength: 40, value: a.name, 'aria-label': 'Назва програми', disabled: !view.editable || !a.valid,
          onchange: (e) => request('updateApp', { key: a.key, name: e.target.value }) }),
        h('button', { type: 'button', class: 'icon', title: 'Прибрати зі списку', 'aria-label': `Прибрати ${a.name}`, disabled: !view.editable,
          onclick: () => request('removeApp', { key: a.key }) }, '✕')),
      h('div', { class: 'item-path', text: a.exe || 'файл не вказано', title: a.exe }),
      a.valid
        ? h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: a.closable, disabled: !view.editable,
            onchange: (e) => request('updateApp', { key: a.key, closable: e.target.checked }) }),
          h('span', { text: 'можна закривати (завжди з твого дозволу)' }))
        : h('div', { class: 'item-bad', text: 'Не пройшла перевірку — асистент її не бачить' })));
    return [
      h('p', { class: 'help', text: 'Асистент може відкривати лише ці програми.' }),
      ...rows,
      view.moreApps ? h('p', { class: 'help', text: `Ще ${view.moreApps} записів не показано — їх видно лише у файлі налаштувань.` }) : null,
      h('button', { type: 'button', class: 'add', disabled: !view.editable, onclick: () => request('addApp') }, '+ Додати програму…'),
    ];
  }

  function renderFolders() {
    const rows = view.folders.map((f) => h('div', { class: f.valid ? 'item' : 'item invalid' },
      h('div', { class: 'item-head' },
        h('input', { class: 'item-name', type: 'text', maxlength: 40, value: f.name, 'aria-label': 'Назва папки', disabled: !view.editable || !f.valid,
          onchange: (e) => request('updateFolder', { key: f.key, name: e.target.value }) }),
        h('button', { type: 'button', class: 'icon', title: 'Прибрати зі списку', 'aria-label': `Прибрати ${f.name}`, disabled: !view.editable,
          onclick: () => request('removeFolder', { key: f.key }) }, '✕')),
      h('div', { class: 'item-path', text: f.path || 'шлях не вказано', title: f.path }),
      f.valid ? null : h('div', { class: 'item-bad', text: 'Не пройшла перевірку — асистент її не бачить' })));
    return [
      h('p', { class: 'help', text: 'Асистент шукає, відкриває й читає файли лише в цих папках (разом із вкладеними).' }),
      ...rows,
      view.moreFolders ? h('p', { class: 'help', text: `Ще ${view.moreFolders} записів не показано — їх видно лише у файлі налаштувань.` }) : null,
      h('button', { type: 'button', class: 'add', disabled: !view.editable, onclick: () => request('addFolder') }, '+ Додати папку…'),
    ];
  }

  function chip(ext, on, list) {
    return h('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), disabled: !view.editable,
      onclick: () => request('setFileType', { ext, list, on: !on }) }, ext);
  }

  function renderFiles() {
    return [
      h('p', { class: 'help', text: 'Типи файлів, які асистент може знаходити й відкривати. Програми, скрипти й ярлики дозволити не можна.' }),
      ...view.fileGroups.flatMap((g) => [
        h('div', { class: 'group-title', text: g.title }),
        h('div', { class: 'chips' }, ...g.types.map((t) => chip(t.ext, t.open, 'fileTypes'))),
      ]),
      h('div', { class: 'group-title', text: 'Читати вміст' }),
      h('p', { class: 'help', text: 'Текст із цих файлів потрапляє до моделі. Після читання частина дій потребує твого дозволу.' }),
      h('div', { class: 'chips' }, ...view.readable.map((t) => chip(t.ext, t.read, 'readableTypes'))),
    ];
  }

  function renderOther() {
    const differs = activeHotkey && activeHotkey !== view.hotkey;
    return [
      h('div', { class: 'group-title', text: 'Гаряча клавіша' }),
      h('div', { class: 'hotkey-row' },
        h('span', { class: 'hotkey', text: capturing ? 'Натисни нове сполучення…' : prettyKeys(activeHotkey ?? view.hotkey) }),
        h('button', { type: 'button', disabled: !view.editable,
          onclick: () => { setCapturing(!capturing); message = ''; render(); } }, capturing ? 'Скасувати' : 'Змінити')),
      h('p', { class: 'help', text: capturing
        ? 'Утримуй Ctrl, Alt або Win (можна разом із Shift) і натисни клавішу. Esc — скасувати.'
        : differs ? `У налаштуваннях записано ${prettyKeys(view.hotkey)}, але вона зайнята іншою програмою.`
          : !activeHotkey ? 'Жодну клавішу не вдалося зареєструвати — обери іншу.' : 'Нею ти починаєш говорити, зупиняєш запис і перебиваєш відповідь.' }),
      view.voice ? h('div', { class: 'group-title', text: 'Розмова' }) : null,
      view.voice ? h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: view.flags.speakReplies, onchange: (e) => request('setFlag', { key: 'speakReplies', on: e.target.checked }) }),
        h('span', { text: 'Відповідати голосом' })) : null,
      view.voice ? h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: view.flags.followUp, onchange: (e) => request('setFlag', { key: 'followUp', on: e.target.checked }) }),
        h('span', { text: 'Після відповіді слухати продовження без клавіші' })) : null,
      view.voice ? h('p', { class: 'help', text: 'Асистент слухає ще 5 секунд після своєї відповіді. Якщо ти мовчиш — розмова закінчується. Працює лише в розмові голосом і коли відповіді озвучуються.' }) : null,
      h('div', { class: 'group-title', text: 'Ресурси комп\'ютера' }),
      h('label', { class: 'check' },
        h('span', { text: 'Звільняти пам\'ять після простою:' }),
        h('select', { 'aria-label': 'Через скільки хвилин простою звільняти пам\'ять', disabled: !view.editable,
          onchange: (e) => request('setIdleMinutes', { minutes: Number(e.target.value) }) },
          ...[[1, '1 хв'], [2, '2 хв'], [5, '5 хв'], [10, '10 хв'], [30, '30 хв'], [0, 'ніколи']]
            .concat([1, 2, 5, 10, 30, 0].includes(view.idleUnloadMinutes) ? [] : [[view.idleUnloadMinutes, `${view.idleUnloadMinutes} хв`]])
            .map(([value, label]) => h('option', { value, selected: value === view.idleUnloadMinutes }, label)))),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: view.flags.yieldToOtherApps, disabled: !view.editable,
          onchange: (e) => request('setFlag', { key: 'yieldToOtherApps', on: e.target.checked }) }),
        h('span', { text: 'Поступатися відеопам\'яттю іншим програмам (іграм)' })),
      h('p', { class: 'help', text: 'Коли асистент «спить», модель і розпізнавання не займають відеокарту. Прокидається сам із першою командою: перша відповідь тоді довша на кілька секунд. Заснути одразу можна з меню іконки в треї.' }),
      h('div', { class: 'group-title', text: 'Файл налаштувань' }),
      h('p', { class: 'help', text: 'Усе з цього екрана зберігається в data/settings.json. Модель, голос і посилене підтвердження для окремих дій поки змінюються лише там: меню іконки в треї → «Відкрити налаштування».' }),
    ];
  }

  function render() {
    if (current !== 'settings') return;
    const root = $('settings-body');
    if (!view) { root.replaceChildren(h('p', { class: 'help', text: 'Завантажую…' })); return; }
    const body = tab === 'apps' ? renderApps() : tab === 'folders' ? renderFolders() : tab === 'files' ? renderFiles() : renderOther();
    const keep = root.querySelector('.tab-body')?.scrollTop ?? 0;
    root.replaceChildren(...[
      h('div', { class: 'tabs', role: 'tablist' }, ...TABS.map(([id, title]) => h('button', {
        type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(id === tab),
        onclick: () => { tab = id; setCapturing(false); message = ''; render(); } }, title))),
      view.brokenMessage ? h('div', { class: 'msg notice', text: view.brokenMessage }) : null,
      message ? h('div', { class: 'msg error', role: 'alert', text: message }) : null,
      ...(view.warnings ?? []).slice(0, 6).map((w) => h('div', { class: 'msg notice', text: w })),
      h('div', { class: 'tab-body' }, ...body.filter(Boolean)),
    ].filter(Boolean));
    root.querySelector('.tab-body').scrollTop = keep;
  }

  // Запис нового сполучення клавіш. Працює «на перехопленні», щоб Esc тут не закривав екран.
  const KEY_NAMES = { Space: 'Space', Tab: 'Tab', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
  document.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { setCapturing(false); render(); return; }
    const code = e.code;
    const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^F\d{1,2}$/.test(code) ? code : KEY_NAMES[code];
    if (!key) return; // натиснуто лише модифікатор або непридатну клавішу — чекаємо далі
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    if (!mods.some((m) => m !== 'Shift')) { message = 'Додай Ctrl, Alt або Win — без них клавіша заважала б друкувати.'; render(); return; }
    capturing = false; // гарячу клавішу поверне (або замінить) головний процес під час збереження
    request('setHotkey', { hotkey: [...mods.slice(0, 3), key].join('+') });
  }, true);

  // ---------- Журнал ----------
  function formatTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })} ${time}`;
  }

  function describeArgs(args) {
    if (!args || typeof args !== 'object') return '';
    return Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ').slice(0, 220);
  }

  async function loadLog() {
    const root = $('log-body');
    root.replaceChildren(h('p', { class: 'help', text: 'Завантажую…' }));
    let entries = [];
    try { entries = (await api.log()) ?? []; } catch { /* покажемо порожній журнал */ }
    if (current !== 'log') return;
    if (entries.length === 0) { root.replaceChildren(h('p', { class: 'help', text: 'Журнал поки порожній.' })); return; }
    root.replaceChildren(
      h('p', { class: 'help', text: `Останні дії асистента (${entries.length}), найновіші зверху. Повний журнал — у файлі data/actions.log.` }),
      ...entries.map((entry) => {
        try { return renderEntry(entry); } catch { return null; } // кривий рядок журналу просто пропускаємо
      }).filter(Boolean),
    );
  }

  function renderEntry(entry) {
    const known = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null);
    const [label, kind] = known(DECISIONS, entry.decision) ?? [String(entry.decision ?? '').slice(0, 30), 'bad'];
    const failed = entry.ok === false && kind === 'ok';
    const detail = entry.ok === false ? entry.error : entry.message;
    const args = describeArgs(entry.args);
    return h('div', { class: 'entry' },
      h('div', { class: 'entry-head' },
        h('span', { class: 'entry-time', text: formatTime(entry.time) }),
        h('span', { class: 'entry-tool', text: known(TOOL_NAMES, entry.tool) ?? String(entry.tool ?? '').slice(0, 40) }),
        h('span', { class: `badge ${failed ? 'bad' : kind}`, text: failed ? 'не вдалося' : label })),
      detail ? h('div', { class: 'entry-detail', text: String(detail).slice(0, 400) }) : null,
      args ? h('div', { class: 'entry-args', text: args }) : null);
  }

  $('open-settings').addEventListener('click', () => show(current === 'settings' ? 'chat' : 'settings'));
  $('open-log').addEventListener('click', () => show(current === 'log' ? 'chat' : 'log'));
  $('settings-back').addEventListener('click', () => show('chat'));
  $('log-back').addEventListener('click', () => show('chat'));
  $('log-refresh').addEventListener('click', loadLog);
})();
