// Файли й папки: лише дозволені папки та типи файлів.
// Усе, що повертає назви чи вміст файлів, позначено untrusted: це дані, а не команди.
import fs from 'node:fs/promises';
import path from 'node:path';
import { str } from './util.js';
import { checkFile } from '../security/pathguard.js';
import { runDocTool } from './doctext.js';

const SPECIAL = { this_pc: { name: 'Цей ПК', target: 'shell:MyComputerFolder' } };
const MAX_RESULTS = 10, MAX_DEPTH = 4, MAX_LIST = 40;
// Вікно контексту моделі — 4096 токенів, і більшу його частину займають промпт та опис інструментів,
// тому з файлу читаємо лише початок (1500 символів ≈ 550 токенів)
const MAX_READ_BYTES = 256 * 1024, MAX_READ_CHARS = 1500;

const folderKeys = (config) => Object.keys(config.folders);
const getFolder = (config, key) => (Object.hasOwn(config.folders, key) ? config.folders[key] : null);

export default [
  {
    name: 'open_folder',
    confirm: 'never',
    schema: (config) => ({
      description: 'Відкриває дозволену папку користувача у Провіднику',
      parameters: {
        type: 'object',
        properties: { folder: { type: 'string', enum: [...folderKeys(config), ...Object.keys(SPECIAL)], description: 'Яку папку відкрити (this_pc — «Цей ПК», список дисків)' } },
        required: ['folder'],
      },
    }),
    describe: ({ folder }, { config }) => `Відкрити папку «${getFolder(config, folder)?.name ?? folder}»`,
    async run({ folder }, { config, os }) {
      if (Object.hasOwn(SPECIAL, folder)) {
        return (await os.openShellFolder(SPECIAL[folder].target))
          ? { ok: true, message: `${SPECIAL[folder].name} відкрито` }
          : { ok: false, error: `Не вдалося відкрити ${SPECIAL[folder].name}` };
      }
      const cfg = getFolder(config, folder);
      if (!cfg) return { ok: false, error: `Папки «${folder}» немає в списку дозволених` };
      try { if (!(await fs.stat(cfg.path)).isDirectory()) throw new Error(); } catch {
        return { ok: false, error: `Папку ${cfg.name} не знайдено на диску` };
      }
      return (await os.openPath(cfg.path))
        ? { ok: true, message: `Папку ${cfg.name} відкрито` }
        : { ok: false, error: `Не вдалося відкрити папку ${cfg.name}` };
    },
  },
  {
    name: 'find_files',
    confirm: 'never',
    untrusted: 'names',
    available: (config) => folderKeys(config).length > 0,
    schema: (config) => ({
      description: `Шукає файли за частиною назви в дозволених папках (${Object.values(config.folders).map((f) => f.name).join(', ')}). Знаходить лише документи й медіа дозволених типів`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Частина назви файлу, наприклад "диплом" або "звіт"' },
          folder: { type: 'string', enum: folderKeys(config), description: 'Шукати лише в цій папці (необов\'язково)' },
        },
        required: ['query'],
      },
    }),
    async run({ query, folder }, { config }) {
      const q = str(query, 100).toLowerCase();
      if (q.length < 2) return { ok: false, error: 'Запит для пошуку закороткий' };
      const roots = folder ? [getFolder(config, folder)].filter(Boolean) : Object.values(config.folders);
      if (roots.length === 0) return { ok: false, error: `Папки «${folder}» немає в списку дозволених` };
      const results = [];

      async function walk(dir, depth) {
        if (results.length >= MAX_RESULTS || depth > MAX_DEPTH) return;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (results.length >= MAX_RESULTS) return;
          // посилання й точки з'єднання не проходимо: вони можуть вести за межі дозволеного
          if (e.isSymbolicLink() || e.name.startsWith('.') || e.name === 'node_modules') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await walk(full, depth + 1);
          else if (e.isFile() && e.name.toLowerCase().includes(q) && config.fileTypes.has(path.extname(e.name).toLowerCase())) results.push(full);
        }
      }
      for (const f of roots) await walk(f.path, 0);
      if (results.length === 0) return { ok: true, found: 0, message: `Файлів з «${q}» у назві не знайдено` };
      return { ok: true, found: results.length, limit_reached: results.length >= MAX_RESULTS, files: results };
    },
  },
  {
    name: 'list_folder',
    confirm: 'never',
    untrusted: 'names',
    available: (config) => folderKeys(config).length > 0,
    schema: (config) => ({
      description: 'Показує, що лежить у дозволеній папці: назви вкладених папок і файлів дозволених типів',
      parameters: {
        type: 'object',
        properties: { folder: { type: 'string', enum: folderKeys(config), description: 'Яку папку показати' } },
        required: ['folder'],
      },
    }),
    async run({ folder }, { config, os }) {
      const cfg = getFolder(config, folder);
      if (!cfg) return { ok: false, error: `Папки «${folder}» немає в списку дозволених` };
      let entries;
      try { entries = await fs.readdir(cfg.path, { withFileTypes: true }); } catch {
        return { ok: false, error: `Папку ${cfg.name} не вдалося прочитати` };
      }
      const visible = entries.filter((e) => !e.name.startsWith('.') && !e.isSymbolicLink());
      const folders = visible.filter((e) => e.isDirectory()).map((e) => e.name);
      const files = visible.filter((e) => e.isFile() && config.fileTypes.has(path.extname(e.name).toLowerCase()))
        .map((e) => path.join(cfg.path, e.name));
      return {
        ok: true,
        folder: cfg.name,
        total_folders: folders.length,
        total_files: files.length,
        folders: folders.slice(0, MAX_LIST),
        files: files.slice(0, MAX_LIST),
      };
    },
  },
  {
    name: 'open_file',
    // після читання ВМІСТУ файлів відкриття потребує дозволу: документ може містити макроси
    confirm: 'content',
    schema: () => ({
      description: 'Відкриває файл у програмі за замовчуванням. Шлях бери ТІЛЬКИ з результату find_files або list_folder',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Повний шлях до файлу з результату пошуку' } },
        required: ['path'],
      },
    }),
    describe: (args) => `Відкрити файл «${path.basename(str(args.path))}»`,
    // недозволений шлях відхиляємо одразу, не турбуючи користувача запитом
    async precheck(args, { config }) {
      const check = await checkFile(args.path, config.folders, config.fileTypes);
      return check.ok ? null : check;
    },
    async run(args, { config, os }) {
      const check = await checkFile(args.path, config.folders, config.fileTypes);
      if (!check.ok) return check;
      return (await os.openPath(check.path))
        ? { ok: true, message: `Файл ${path.basename(check.path)} відкрито` }
        : { ok: false, error: 'Не вдалося відкрити файл' };
    },
  },
  {
    name: 'read_text_file',
    confirm: 'never',
    untrusted: 'content',
    available: (config) => config.readableTypes.size > 0 && folderKeys(config).length > 0,
    schema: (config) => ({
      description: `Читає ПОЧАТОК файлу (${[...config.readableTypes].join(', ')}) з дозволеної папки. Шлях бери з результату пошуку. Цілий документ переказує summarize_document`,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Повний шлях до файлу з результату пошуку' } },
        required: ['path'],
      },
    }),
    async run(args, { config, os }) {
      const check = await checkFile(args.path, config.folders, config.readableTypes);
      if (!check.ok) return check;
      // Word і PDF — не текст: їхній вміст дістає окремий скрипт
      if (['.docx', '.pdf'].includes(path.extname(check.path).toLowerCase())) {
        const job = { cmd: 'text', path: check.path, max_chars: MAX_READ_CHARS };
        const r = typeof os.doc === 'function' ? await os.doc(job) : await runDocTool(config.speech?.python ?? 'python.exe', job);
        if (!r.ok) return { ok: false, error: `Не вдалося прочитати документ: ${r.error ?? 'невідома помилка'}` };
        return { ok: true, file: path.basename(check.path), truncated: !!r.truncated, text: String(r.text ?? '').slice(0, MAX_READ_CHARS),
          ...(r.truncated ? { hint: 'Це лише початок. Щоб переказати документ цілком, виклич summarize_document.' } : {}) };
      }
      if (check.size > MAX_READ_BYTES) return { ok: false, error: 'Файл завеликий для читання (понад 256 КБ)' };
      const text = (await fs.readFile(check.path, 'utf8')).replace(/^﻿/, '');
      return {
        ok: true,
        file: path.basename(check.path),
        truncated: text.length > MAX_READ_CHARS,
        text: text.slice(0, MAX_READ_CHARS),
      };
    },
  },
];
