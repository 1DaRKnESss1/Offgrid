// Перевірка шляхів: файл має РЕАЛЬНО лежати в дозволеній папці (після розкриття посилань)
// і мати дозволений тип.
import fs from 'node:fs/promises';
import path from 'node:path';

const norm = (p) => path.resolve(p).toLowerCase();

export function isInside(child, parent) {
  const c = norm(child), p = norm(parent);
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

async function real(p) {
  try { return await fs.realpath(p); } catch { return null; }
}

/**
 * Повертає { ok: true, path } з реальним шляхом або { ok: false, error }.
 * allowedExts — множина розширень у нижньому регістрі.
 */
export async function checkFile(filePath, folders, allowedExts) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return { ok: false, error: 'Не вказано шлях до файлу' };
  }
  if (!path.isAbsolute(filePath)) return { ok: false, error: 'Потрібен повний шлях до файлу з результатів пошуку' };
  // альтернативні потоки NTFS (file.txt:stream) і спецпристрої
  if (/:/.test(filePath.slice(2)) || /^\\\\[.?]\\/.test(filePath)) return { ok: false, error: 'Такий шлях не дозволено' };

  const realFile = await real(filePath);
  if (!realFile) return { ok: false, error: 'Такого файлу не існує' };

  let inside = false;
  for (const f of Object.values(folders)) {
    const realFolder = await real(f.path);
    if (realFolder && isInside(realFile, realFolder)) { inside = true; break; }
  }
  if (!inside) return { ok: false, error: 'Цей файл поза дозволеними папками' };

  const ext = path.extname(realFile).toLowerCase();
  if (!allowedExts.has(ext)) return { ok: false, error: `Файли типу «${ext || 'без розширення'}» не дозволені` };

  const st = await fs.stat(realFile);
  if (!st.isFile()) return { ok: false, error: 'Це не файл' };
  return { ok: true, path: realFile, size: st.size };
}
