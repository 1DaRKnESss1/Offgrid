// Перевірка шляхів: файл має РЕАЛЬНО лежати в дозволеній папці (після розкриття посилань)
// і мати дозволений тип.
// Порядок важливий: спершу суто текстова перевірка, і лише для шляхів усередині дозволених папок —
// звернення до диска. Так шлях на кшталт \\чужий-сервер\папка ніколи не доходить до файлової системи
// (а отже, не може відкрити мережеве з'єднання) і не дає з'ясувати, які файли є деінде на диску.
import fs from 'node:fs/promises';
import path from 'node:path';

const DRIVE_PATH = /^[a-zA-Z]:\\/;
const norm = (p) => path.resolve(p).toLowerCase();

export function isInside(child, parent) {
  const c = norm(child), p = norm(parent);
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

async function real(p) {
  try { return await fs.realpath(p); } catch { return null; }
}

const OUTSIDE = { ok: false, error: 'Цей файл поза дозволеними папками' };

/**
 * Повертає { ok: true, path, size } з реальним шляхом або { ok: false, error }.
 * allowedExts — множина розширень у нижньому регістрі.
 */
export async function checkFile(filePath, folders, allowedExts) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return { ok: false, error: 'Не вказано шлях до файлу' };
  }
  // лише звичайні шляхи з літерою диска: жодних \\сервер\..., //сервер/..., \\?\..., \\.\...
  if (!/^[a-zA-Z]:[\\/]/.test(filePath)) return { ok: false, error: 'Потрібен повний шлях до файлу з результатів пошуку' };
  if (filePath.slice(2).includes(':')) return OUTSIDE; // альтернативні потоки NTFS (file.txt:stream)
  const resolved = path.resolve(filePath);
  if (!DRIVE_PATH.test(resolved)) return OUTSIDE;

  // 1) текстова перевірка — без звернення до диска
  const candidates = Object.values(folders).filter((f) => DRIVE_PATH.test(f.path) && isInside(resolved, f.path));
  if (candidates.length === 0) return OUTSIDE;
  const typeError = (ext) => ({ ok: false, error: `Файли типу «${ext || 'без розширення'}» не дозволені` });
  const ext = path.extname(resolved).toLowerCase();
  if (!allowedExts.has(ext)) return typeError(ext);

  // 2) перевірка на диску: куди шлях веде насправді
  const realFile = await real(resolved);
  if (!realFile) return { ok: false, error: 'Такого файлу не існує' };
  let inside = false;
  for (const f of candidates) {
    const realFolder = await real(f.path);
    if (realFolder && isInside(realFile, realFolder)) { inside = true; break; }
  }
  if (!inside) return OUTSIDE;
  if (!allowedExts.has(path.extname(realFile).toLowerCase())) return typeError(ext);

  let st;
  try { st = await fs.stat(realFile); } catch { return { ok: false, error: 'Такого файлу не існує' }; }
  if (!st.isFile()) return { ok: false, error: 'Це не файл' };
  return { ok: true, path: realFile, size: st.size };
}
