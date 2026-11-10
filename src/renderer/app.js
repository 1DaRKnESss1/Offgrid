// Панель Offgrid. Увесь текст (від моделі, з файлів, з інструментів) вставляється лише як textContent —
// він ніколи не стає розміткою чи кодом.
'use strict';

const STATE_LABELS = {
  idle: 'Очікує', listening: 'Слухає', thinking: 'Думає', executing: 'Виконує',
  confirming: 'Чекає дозволу', speaking: 'Говорить', error: 'Помилка',
};

const $ = (id) => document.getElementById(id);
const log = $('log'), input = $('input'), form = $('form'), sendBtn = $('send');
const confirmBox = $('confirm');
let busy = false;
let confirmId = null;
let hotkey = null;
let chatId = 0; // зростає з кожною «Новою розмовою»
let allowTimer = null;
const ALLOW_DELAY_MS = 800; // щоб клацання, націлене в інше вікно, не стало дозволом

function setState(state) {
  document.body.dataset.state = state;
  $('state-label').textContent = STATE_LABELS[state] ?? state;
}

function setBusy(value) {
  busy = value;
  sendBtn.textContent = busy ? '■' : '➤';
  sendBtn.title = busy ? 'Зупинити (Esc)' : 'Надіслати (Enter)';
}

function add(kind, text) {
  log.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = kind === 'tool' || kind === 'tool failed' ? kind : `msg ${kind}`;
  el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function showEmpty() {
  log.replaceChildren();
  const el = document.createElement('div');
  el.className = 'empty';
  el.textContent = 'Напиши, що зробити: «відкрий блокнот», «скільки вільного місця на дисках», «запиши список покупок».';
  log.append(el);
}

function setHint(extra) {
  const parts = [];
  if (hotkey) parts.push(`${hotkey.replace('Control', 'Ctrl').replaceAll('+', ' + ')} — показати або сховати`);
  parts.push('Esc — сховати');
  $('hint').textContent = extra ?? parts.join(' · ');
}

function showConfirm(event) {
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
  setHint();
  for (const w of cfg.warnings ?? []) add('notice', w);
}

window.offgrid.onEvent((event) => {
  switch (event.type) {
    case 'state': setState(event.state); break;
    case 'tool': add(event.ok ? 'tool' : 'tool failed', event.text || event.name); break;
    case 'tainted': $('taint').hidden = !event.value; break;
    case 'confirm': showConfirm(event); break;
    case 'confirm-done': if (event.id === confirmId) hideConfirm(); break;
    case 'config': applyConfig(event); break;
    case 'notice': add('notice', event.text); break;
    case 'reset': chatId++; hideConfirm(); showEmpty(); setBusy(false); break;
    case 'focus-input': input.focus(); break;
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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // під час роботи Enter нічого не робить (щоб не зупинити випадково); зупинка — кнопкою ■ або Esc
  if (busy) { if (e.submitter === sendBtn && document.activeElement === sendBtn) window.offgrid.cancel(); return; }
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  add('user', text);
  setBusy(true);
  const chat = chatId;
  try {
    const res = await window.offgrid.ask(text);
    if (chat !== chatId) return; // за цей час почали нову розмову — відповідь уже не потрібна
    if (res.ok) add('assistant', res.text);
    else if (res.cancelled) add('tool failed', 'Зупинено');
    else add('error', res.error ?? 'Невідома помилка');
  } catch (err) {
    if (chat === chatId) add('error', String(err?.message ?? err));
  } finally {
    if (chat === chatId) setBusy(false);
    input.focus();
  }
});

$('confirm-allow').addEventListener('click', () => answerConfirm(true));
$('confirm-deny').addEventListener('click', () => answerConfirm(false));
$('new-chat').addEventListener('click', () => window.offgrid.newChat());
$('close').addEventListener('click', () => window.offgrid.hide());

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (confirmId) answerConfirm(false);
  else if (busy) window.offgrid.cancel();
  else window.offgrid.hide();
});

showEmpty();
setHint();
window.offgrid.ready().then((info) => {
  if (!info) return;
  setState(info.state);
  applyConfig(info);
  if (!info.ollama) add('error', 'Ollama не відповідає. Запусти її — і я запрацюю.');
});
