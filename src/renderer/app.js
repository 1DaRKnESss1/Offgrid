// Панель Offgrid. Увесь текст (від моделі, з файлів, з інструментів, з мікрофона) вставляється лише як
// textContent — він ніколи не стає розміткою чи кодом. Розмовою керує головний процес; панель лише показує події.
'use strict';

const STATE_LABELS = {
  idle: 'Очікує', listening: 'Слухає', thinking: 'Думає', executing: 'Виконує',
  confirming: 'Чекає дозволу', speaking: 'Говорить', error: 'Помилка',
};
const VOICE_TITLES = {
  off: 'Голос вимкнено в налаштуваннях',
  starting: 'Голос завантажується…',
  ready: 'Говорити',
  failed: 'Голос недоступний',
};
const ALLOW_DELAY_MS = 800; // щоб клацання, націлене в інше вікно, не стало дозволом

const $ = (id) => document.getElementById(id);
const log = $('log'), input = $('input'), form = $('form'), sendBtn = $('send'), micBtn = $('mic'), speakBtn = $('speak');
const confirmBox = $('confirm');
let busy = false;
let state = 'idle';
let confirmId = null;
let hotkey = null;
let voice = 'off';
let speakReplies = true;
let allowTimer = null;
let liveEl = null; // бульбашка з текстом, який розпізнається просто зараз

function setState(next) {
  state = next;
  document.body.dataset.state = next;
  $('state-label').textContent = STATE_LABELS[next] ?? next;
  renderControls();
}

function renderControls() {
  sendBtn.textContent = busy ? '■' : '➤';
  sendBtn.title = busy ? 'Зупинити (Esc)' : 'Надіслати (Enter)';
  micBtn.hidden = voice === 'off';
  micBtn.disabled = voice !== 'ready' || (busy && state !== 'listening');
  micBtn.classList.toggle('active', state === 'listening');
  micBtn.title = state === 'listening' ? 'Досить, розпізнавай' : VOICE_TITLES[voice];
  speakBtn.hidden = voice === 'off';
  speakBtn.textContent = speakReplies ? '🔊' : '🔇';
  speakBtn.title = speakReplies ? 'Озвучення відповідей увімкнено — натисни, щоб вимкнути' : 'Озвучення відповідей вимкнено — натисни, щоб увімкнути';
  speakBtn.setAttribute('aria-pressed', String(speakReplies));
}

function setBusy(value) {
  busy = value;
  renderControls();
}

function add(kind, text) {
  log.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = kind === 'tool' || kind === 'tool failed' ? kind : `msg ${kind}`;
  el.textContent = text;
  if (liveEl && el !== liveEl) log.insertBefore(el, liveEl); else log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function showEmpty() {
  liveEl = null;
  log.replaceChildren();
  const el = document.createElement('div');
  el.className = 'empty';
  el.textContent = 'Скажи або напиши, що зробити: «відкрий блокнот», «скільки вільного місця на дисках», «запиши список покупок».';
  log.append(el);
}

function setLive(text) {
  if (!liveEl) {
    log.querySelector('.empty')?.remove();
    liveEl = document.createElement('div');
    liveEl.className = 'msg user live';
    log.append(liveEl);
  }
  liveEl.textContent = text;
  log.scrollTop = log.scrollHeight;
}

function endLive() {
  liveEl?.remove();
  liveEl = null;
}

function setHint() {
  const parts = [];
  if (hotkey) {
    const keys = hotkey.replace('Control', 'Ctrl').replaceAll('+', ' + ');
    parts.push(voice === 'ready' ? `${keys} — говорити` : `${keys} — показати або сховати`);
  }
  parts.push('Esc — зупинити або сховати');
  $('hint').textContent = parts.join(' · ');
}

function showConfirm(event) {
  window.offgridView?.show('chat'); // запит дозволу має бути видно, де б ти не був
  confirmId = event.id;
  $('confirm-summary').textContent = event.summary;
  $('confirm-reason').textContent = event.reason === 'tainted'
    ? 'Питаю, бо в цій розмові я бачив назви чи вміст файлів, а їм не можна довіряти як командам.'
    : 'Таку дію я ніколи не виконую без твого дозволу.';
  // кнопка «Дозволити» вмикається із затримкою
  $('confirm-allow').disabled = true;
  clearTimeout(allowTimer);
  allowTimer = setTimeout(() => { $('confirm-allow').disabled = false; }, ALLOW_DELAY_MS);
  confirmBox.hidden = false;
}

function hideConfirm() {
  confirmId = null;
  confirmBox.hidden = true;
}

function answerConfirm(allow) {
  if (!confirmId) return;
  window.offgrid.answerConfirm(confirmId, allow);
  hideConfirm();
}

function applyConfig(cfg) {
  hotkey = cfg.hotkey;
  if (typeof cfg.speakReplies === 'boolean') speakReplies = cfg.speakReplies;
  setHint();
  renderControls();
  for (const w of cfg.warnings ?? []) add('notice', w);
}

function applyVoice(event) {
  const was = voice;
  voice = event.status;
  if (voice === 'failed' && was !== 'failed') add('notice', `Голос недоступний: ${event.error ?? 'невідома помилка'}. Текстові команди працюють.`);
  setHint();
  renderControls();
}

window.offgrid.onEvent((event) => {
  switch (event.type) {
    case 'state': setState(event.state); break;
    case 'busy': setBusy(event.value); if (event.value && window.offgridView?.current !== 'chat') window.offgridView.show('chat'); break;
    case 'user': endLive(); add('user', event.text); break;
    case 'assistant': add('assistant', event.text); break;
    case 'error': add('error', event.text); break;
    case 'stopped': add('tool failed', 'Зупинено'); break;
    case 'soft': add('tool failed', event.text); break;
    case 'partial': setLive(event.text); break;
    case 'partial-end': endLive(); break;
    case 'tool': add(event.ok ? 'tool' : 'tool failed', event.text || event.name); break;
    case 'tainted': $('taint').hidden = !event.value; break;
    case 'confirm': showConfirm(event); break;
    case 'confirm-done': if (event.id === confirmId) hideConfirm(); break;
    case 'config': applyConfig(event); break;
    case 'voice': applyVoice(event); break;
    case 'speak-setting': speakReplies = event.value; renderControls(); break;
    case 'notice': add('notice', event.text); break;
    case 'reset': hideConfirm(); showEmpty(); setBusy(false); break;
    case 'focus-input': if ((window.offgridView?.current ?? 'chat') === 'chat') input.focus(); break;
    case 'capture-end': window.offgridView?.captureEnded(); break;
    case 'open-view': window.offgridView?.show(event.view, { tab: event.tab }); break;
    case 'demo': // лише для знімка під час розробки
      add('user', 'закрий блокнот');
      add('tool', 'Блокнот відкрито');
      add('assistant', 'Блокнот відкрито. Закрити його зараз?');
      $('taint').hidden = false;
      setState('confirming');
      showConfirm({ id: 'demo', summary: 'Закрити програму «Блокнот» (незбережене вона може запропонувати зберегти)', reason: 'always' });
      break;
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  // під час роботи Enter нічого не робить (щоб не зупинити випадково); зупинка — кнопкою ■ або Esc
  if (busy) { if (e.submitter === sendBtn && document.activeElement === sendBtn) window.offgrid.cancel(); return; }
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  add('user', text);
  window.offgrid.ask(text);
});

micBtn.addEventListener('click', () => window.offgrid.listen());
speakBtn.addEventListener('click', () => window.offgrid.setSpeak(!speakReplies));
$('confirm-allow').addEventListener('click', () => answerConfirm(true));
$('confirm-deny').addEventListener('click', () => answerConfirm(false));
$('new-chat').addEventListener('click', () => window.offgrid.newChat());
$('close').addEventListener('click', () => window.offgrid.hide());

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (confirmId) answerConfirm(false);
  else if (window.offgridView && window.offgridView.current !== 'chat') window.offgridView.show('chat');
  else if (busy) window.offgrid.cancel();
  else window.offgrid.hide();
});

showEmpty();
setHint();
renderControls();
window.offgrid.ready().then((info) => {
  if (!info) return;
  setState(info.state);
  setBusy(!!info.busy);
  applyVoice(info.voice);
  applyConfig(info);
  if (!info.ollama) add('error', 'Ollama не відповідає. Запусти її — і я запрацюю.');
});
