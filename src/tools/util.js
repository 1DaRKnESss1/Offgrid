// Спільні дрібниці для інструментів. Жодного shell: лише spawn/execFile з масивом аргументів.
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';

const WINDIR = process.env.SystemRoot ?? 'C:\\Windows';
export const SYSTEM32 = path.join(WINDIR, 'System32');
export const EXPLORER = path.join(WINDIR, 'explorer.exe');
export const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const TASKLIST = path.join(SYSTEM32, 'tasklist.exe');
export const TASKKILL = path.join(SYSTEM32, 'taskkill.exe');

/** Запускає програму окремо від асистента. true, якщо процес стартував. */
export function launch(exe, args = []) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { detached: true, stdio: 'ignore', shell: false });
    } catch { return resolve(false); }
    child.on('error', () => resolve(false));
    child.on('spawn', () => { child.unref(); resolve(true); });
  });
}

export function run(exe, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, windowsHide: true, shell: false }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout ?? '') });
    });
  });
}

/**
 * Шар доступу до системи, який отримують інструменти (ctx.os).
 * Electron підміняє openPath/openUrl на власні (ShellExecute), тести — на заглушки.
 */
export const nodeOs = {
  launch: (exe) => launch(exe),
  run,
  openPath: (p) => launch(EXPLORER, [p]),
  openUrl: (url) => launch(EXPLORER, [url]),
  openShellFolder: (target) => launch(EXPLORER, [target]),
};

export const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
