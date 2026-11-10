// Журнал дій: один рядок JSON на дію (data/actions.log). Лише дописуємо.
import fs from 'node:fs';
import path from 'node:path';
import { LOG_FILE } from '../paths.js';

const MAX_VALUE = 300;

function shorten(value) {
  if (typeof value === 'string') return value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) + `… (+${value.length - MAX_VALUE})` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(shorten);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 20).map(([k, v]) => [k, shorten(v)]));
  return value;
}

export function logAction(entry) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...shorten(entry) });
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    console.error('Не вдалося записати журнал:', e.message);
  }
}

export function readLog(limit = 50) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-limit);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}
