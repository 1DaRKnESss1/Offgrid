// Створює ярлик «Offgrid» на робочому столі: запуск без вікна терміналу (scripts/start-hidden.ps1).
//   node scripts/make-shortcut.js
// Іконка — та сама, що в треї (src/app/icon.js), зберігається як shell/offgrid.ico.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { iconPng } from '../src/app/icon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICO = path.join(ROOT, 'shell', 'offgrid.ico');
const LAUNCHER = path.join(ROOT, 'scripts', 'start-hidden.ps1');
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// ICO з вкладеними PNG (Windows Vista і новіші розуміють такий формат)
const sizes = [16, 32, 48, 256];
const images = sizes.map((s) => iconPng('idle', s));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((png, i) => {
  const e = 6 + 16 * i, s = sizes[i];
  header.writeUInt8(s >= 256 ? 0 : s, e); header.writeUInt8(s >= 256 ? 0 : s, e + 1);
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(png.length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
fs.writeFileSync(ICO, Buffer.concat([header, ...images]));

// сам ярлик робить Windows (WScript.Shell): шляхи передаються через змінні середовища, а не в тексті скрипта
const script = `$d = [Environment]::GetFolderPath('Desktop'); $l = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Offgrid.lnk'));
$l.TargetPath = $env:OG_PS; $l.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $env:OG_LAUNCH + '"';
$l.WorkingDirectory = $env:OG_ROOT; $l.IconLocation = $env:OG_ICO + ',0'; $l.WindowStyle = 7; $l.Description = 'Offgrid — локальний голосовий асистент'; $l.Save(); Join-Path $d 'Offgrid.lnk'`;
const out = execFileSync(POWERSHELL, ['-NoProfile', '-Command', script], { env: { ...process.env, OG_PS: POWERSHELL, OG_LAUNCH: LAUNCHER, OG_ROOT: ROOT, OG_ICO: ICO }, encoding: 'utf8' });
console.log(`Ярлик створено: ${out.trim()}`);
