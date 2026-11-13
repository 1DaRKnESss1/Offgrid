// Час, стан системи, гучність.
import fs from 'node:fs/promises';
import os from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { POWERSHELL, SYSTEM32 } from './util.js';

const gb = (b) => +(b / 1024 ** 3).toFixed(1);

const NVIDIA_SMI = path.join(SYSTEM32, 'nvidia-smi.exe');

async function gpuInfo(run) {
  // nvidia-smi ставиться разом із драйвером NVIDIA; якщо його немає — просто без цього поля
  if (!existsSync(NVIDIA_SMI)) return undefined;
  const r = await run(NVIDIA_SMI, ['--query-gpu=name,memory.used,memory.total', '--format=csv,noheader,nounits'], 4000);
  if (!r.ok) return undefined;
  const [name, used, total] = r.stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
  if (!name || !Number.isFinite(+used) || !Number.isFinite(+total)) return undefined;
  return { name, vram_used_gb: +(used / 1024).toFixed(1), vram_total_gb: +(total / 1024).toFixed(1) };
}

// Час словами для вимови: «тринадцята тридцять три». Складає код, а не модель — вона плутала години.
const HOURS = ['нуль', 'перша', 'друга', 'третя', 'четверта', 'п\'ята', 'шоста', 'сьома', 'восьма', 'дев\'ята', 'десята', 'одинадцята',
  'дванадцята', 'тринадцята', 'чотирнадцята', 'п\'ятнадцята', 'шістнадцята', 'сімнадцята', 'вісімнадцята', 'дев\'ятнадцята', 'двадцята',
  'двадцять перша', 'двадцять друга', 'двадцять третя'];
const ONES = ['', 'одна', 'дві', 'три', 'чотири', 'п\'ять', 'шість', 'сім', 'вісім', 'дев\'ять', 'десять', 'одинадцять', 'дванадцять',
  'тринадцять', 'чотирнадцять', 'п\'ятнадцять', 'шістнадцять', 'сімнадцять', 'вісімнадцять', 'дев\'ятнадцять'];
const TENS = ['', '', 'двадцять', 'тридцять', 'сорок', 'п\'ятдесят'];

export function timeInWords(hours, minutes) {
  const h = HOURS[hours] ?? String(hours);
  if (minutes === 0) return `${h} рівно`;
  const m = minutes < 20 ? ONES[minutes] : `${TENS[Math.floor(minutes / 10)]} ${ONES[minutes % 10]}`.trim();
  return `${h} ${minutes < 10 ? 'нуль ' : ''}${m}`;
}

const VOLUME_KEYS = { up: 175, down: 174, mute: 173 };
const VOLUME_STEPS = { small: 5, medium: 10, large: 20 };

export default [
  {
    name: 'get_time',
    confirm: 'never',
    schema: () => ({
      description: 'Повертає поточні дату, час і день тижня на комп\'ютері. Час називай словами з поля time_spoken, нічого в ньому не змінюючи',
      parameters: { type: 'object', properties: {} },
    }),
    run() {
      const now = new Date();
      // готові для вимови поля: з «10.11.2026, 22:23:05» модель складала нісенітниці
      return {
        ok: true,
        time: now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
        time_spoken: timeInWords(now.getHours(), now.getMinutes()),
        date: now.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' }),
        weekday: now.toLocaleDateString('uk-UA', { weekday: 'long' }),
      };
    },
  },
  {
    name: 'get_system_info',
    confirm: 'never',
    schema: () => ({
      description: 'Повертає стан комп\'ютера: оперативна пам\'ять, процесор, відеокарта, час роботи, вільне та загальне місце на кожному диску',
      parameters: { type: 'object', properties: {} },
    }),
    async run(_args, { os: sys }) {
      const disks = [];
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        try {
          const s = await fs.statfs(`${letter}:\\`);
          disks.push({ disk: `${letter}:`, free_gb: gb(s.bavail * s.bsize), total_gb: gb(s.blocks * s.bsize) });
        } catch { /* диска немає */ }
      }
      return {
        ok: true,
        ram_free_gb: gb(os.freemem()),
        ram_total_gb: gb(os.totalmem()),
        cpu: os.cpus()[0]?.model.trim(),
        cpu_threads: os.cpus().length,
        gpu: await gpuInfo(sys.run),
        uptime_hours: +(os.uptime() / 3600).toFixed(1),
        disks,
      };
    },
  },
  {
    name: 'change_volume',
    confirm: 'never',
    schema: () => ({
      description: 'Змінює гучність звуку системи: гучніше, тихіше або вимкнути/увімкнути звук',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: Object.keys(VOLUME_KEYS), description: 'up — гучніше, down — тихіше, mute — вимкнути або знову увімкнути звук' },
          amount: { type: 'string', enum: Object.keys(VOLUME_STEPS), description: 'Наскільки змінити: small ≈ 10%, medium ≈ 20% (за замовчуванням), large ≈ 40%' },
        },
        required: ['action'],
      },
    }),
    describe: ({ action }) => `Змінити гучність (${action})`,
    async run({ action, amount = 'medium' }, { os: sys }) {
      if (!Object.hasOwn(VOLUME_KEYS, action)) return { ok: false, error: `Невідома дія «${action}»` };
      // у скрипт потрапляють лише числа з таблиць вище, не текст від моделі
      const presses = action === 'mute' ? 1 : (Object.hasOwn(VOLUME_STEPS, amount) ? VOLUME_STEPS[amount] : VOLUME_STEPS.medium);
      const script = `$w = New-Object -ComObject WScript.Shell; 1..${presses} | ForEach-Object { $w.SendKeys([char]${VOLUME_KEYS[action]}) }`;
      const r = await sys.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script]);
      if (!r.ok) return { ok: false, error: 'Не вдалося змінити гучність' };
      return {
        ok: true,
        message: action === 'mute'
          ? 'Звук вимкнено або знову увімкнено'
          : `Гучність ${action === 'up' ? 'збільшено' : 'зменшено'} приблизно на ${presses * 2}%`,
      };
    },
  },
];
