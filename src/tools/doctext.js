// Міст до py/doc_text.py — читання тексту з Word, PDF і текстових файлів та пошук за вмістом.
// Python запускається окремим процесом на одне завдання (JSON у stdin -> JSON зі stdout) і лише читає файли.
// Що саме можна читати, вирішується ТУТ, у застосунку: скрипт отримує готові списки папок і типів файлів.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../paths.js';
import { resolveExe } from '../security/config.js';
import { SYSTEM32 } from './util.js';

const SCRIPT = path.join(ROOT, 'py', 'doc_text.py');

/**
 * Повний шлях до Python або null. Голе ім'я «python.exe» шукаємо лише в системних папках і PATH (resolveExe),
 * а не в поточній папці: інакше замість нього міг би запуститися файл, підкладений у папку проєкту.
 */
export const pythonPath = (config) => resolveExe(config.speech?.python ?? 'python.exe');

/** Виконує одне завдання. Повертає розібрану відповідь або { ok: false, error }. */
export function runDocTool(python, job, timeoutMs = 45_000) {
  return new Promise((resolve) => {
    if (!python) return resolve({ ok: false, error: 'Python не знайдено' });
    let child;
    // -I: Python не підхоплює модулі з поточної папки й змінних середовища; -X utf8: шляхи й текст у UTF-8
    try { child = spawn(python, ['-I', '-X', 'utf8', SCRIPT], { windowsHide: true, shell: false, cwd: SYSTEM32, stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) {
      return resolve({ ok: false, error: `Не вдалося запустити Python: ${e.message}` });
    }
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* вже завершився */ } resolve({ ok: false, error: 'Читання документів тривало надто довго' }); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (out.length < 2_000_000) out += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: `Не вдалося запустити Python: ${e.message}` }); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); } catch { resolve({ ok: false, error: 'Не вдалося прочитати документ (потрібні Python-бібліотеки python-docx і PyMuPDF)' }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(job));
  });
}
