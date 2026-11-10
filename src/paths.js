// Усі шляхи проєкту в одному місці. Нічого не пишемо поза папкою проєкту.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// OFFGRID_DATA — лише для тестів, щоб не чіпати справжні дані
export const DATA_DIR = process.env.OFFGRID_DATA ? path.resolve(process.env.OFFGRID_DATA) : path.join(ROOT, 'data');

export const DEFAULT_CONFIG = path.join(ROOT, 'config', 'default.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const LOG_FILE = path.join(DATA_DIR, 'actions.log');
export const NOTES_DIR = path.join(DATA_DIR, 'notes');
export const NOTES_TRASH = path.join(NOTES_DIR, '_кошик');
export const ELECTRON_DATA = path.join(DATA_DIR, 'electron');
