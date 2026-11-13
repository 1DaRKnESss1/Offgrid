// Усі шляхи проєкту в одному місці. Нічого не пишемо поза папкою проєкту.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// OFFGRID_DATA — лише для тестів, щоб не чіпати справжні дані. Приймається тільки шлях усередині проєкту:
// асистент не пише поза своєю папкою, навіть якщо змінну задано помилково.
function dataDir() {
  const fallback = path.join(ROOT, 'data');
  if (!process.env.OFFGRID_DATA) return fallback;
  const wanted = path.resolve(process.env.OFFGRID_DATA);
  return wanted.toLowerCase().startsWith(ROOT.toLowerCase() + path.sep) ? wanted : fallback;
}
export const DATA_DIR = dataDir();

export const DEFAULT_CONFIG = path.join(ROOT, 'config', 'default.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const LOG_FILE = path.join(DATA_DIR, 'actions.log');
export const NOTES_DIR = path.join(DATA_DIR, 'notes');
export const NOTES_TRASH = path.join(NOTES_DIR, '_кошик');
