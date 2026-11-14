// Міст між панеллю і логікою застосунку. Панель не має доступу ні до диска, ні до системи:
// усе, що вона може, — надіслати один із запитів нижче на локальний сервер застосунку й отримувати події.
// (Раніше цю роль виконував preload-скрипт Electron; набір можливостей той самий.)
'use strict';

(() => {
  const post = async (name, body) => {
    const res = await fetch(`/api/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`Запит «${name}» не вдався (${res.status})`);
    return res.json();
  };
  const fire = (name, body) => { post(name, body).catch(() => { /* подія про помилку прийде окремо */ }); };

  window.offgrid = Object.freeze({
    ask: (text) => fire('ask', { text: String(text) }),
    listen: () => fire('listen'),
    setSpeak: (value) => fire('set-speak', { value: value === true }),
    cancel: () => fire('cancel'),
    answerConfirm: (id, allow) => fire('confirm', { id: String(id), allow: allow === true || allow === 'conversation' || allow === 'always' ? allow : false }),
    newChat: () => fire('new-chat'),
    hide: () => fire('hide'),
    show: () => fire('show'),
    control: (action) => post('control', { action: String(action) }),
    timer: (payload) => post('timer', payload),
    scenario: (action, name) => post('scenario', { action: String(action), name: String(name) }),
    ready: () => post('ready'),
    settings: (action, payload) => post('settings', { action: String(action), payload }),
    log: () => post('log'),
    pingOllama: () => post('ping'),
    captureHotkey: (on) => fire('capture-hotkey', { on: on === true }),
    onEvent: (handler) => {
      const source = new EventSource('/events');
      source.onmessage = (e) => {
        let event;
        try { event = JSON.parse(e.data); } catch { return; }
        handler(event);
      };
    },
  });
})();
