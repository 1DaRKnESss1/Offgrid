// Нотатки: єдине місце, куди асистент ЗАПИСУЄ файли, — data/notes усередині проєкту.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { NOTES_DIR, NOTES_TRASH } from '../paths.js';
import { str } from './util.js';

const MAX_NOTE_CHARS = 20000, MAX_READ_CHARS = 4000;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function safeTitle(title) {
  let t = str(title, 80).replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 50);
  if (!t || RESERVED.test(t)) t = `Нотатка ${new Date().toLocaleString('uk-UA').replace(/[:/.,]/g, '-')}`;
  return t;
}

// Назва нотатки від моделі -> файл строго всередині папки нотаток
function resolveNote(name) {
  let n = str(name, 120);
  if (!n) return null;
  if (!/\.txt$/i.test(n)) n += '.txt';
  if (n !== path.basename(n) || n.includes('..') || /[\\/:*?"<>|]/.test(n)) return null;
  const full = path.join(NOTES_DIR, n);
  return existsSync(full) ? full : null;
}

async function listNotes() {
  try {
    const entries = await fs.readdir(NOTES_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && /\.txt$/i.test(e.name)).map((e) => e.name);
  } catch { return []; }
}

export default [
  {
    name: 'write_note',
    confirm: 'tainted',
    schema: () => ({
      description: 'Записує текст у нову нотатку (текстовий файл) і відкриває її. Використовуй, коли просять щось написати, записати, скласти список чи нотатку. Текст складай сам.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Коротка назва нотатки, 1-4 слова' },
          text: { type: 'string', description: 'Повний текст, який треба записати' },
        },
        required: ['text'],
      },
    }),
    describe: ({ title, text }) => `Створити нотатку «${safeTitle(title)}»: ${str(text, 160)}`,
    async run({ title, text }, { os }) {
      const body = typeof text === 'string' ? text.trim() : '';
      if (!body) return { ok: false, error: 'Немає тексту для запису' };
      if (body.length > MAX_NOTE_CHARS) return { ok: false, error: 'Текст нотатки задовгий' };
      const base = safeTitle(title);
      await fs.mkdir(NOTES_DIR, { recursive: true });
      // ніколи не перезаписуємо існуючий файл — додаємо номер; прапорець wx страхує від гонки
      for (let i = 1; i < 100; i++) {
        const file = path.join(NOTES_DIR, i === 1 ? `${base}.txt` : `${base} (${i}).txt`);
        try {
          await fs.writeFile(file, body.replace(/\r?\n/g, '\r\n'), { encoding: 'utf8', flag: 'wx' });
        } catch (e) {
          if (e.code === 'EEXIST') continue;
          throw e;
        }
        const opened = await os.openPath(file);
        return { ok: true, message: `Записано в нотатку «${path.basename(file, '.txt')}»${opened ? ' і відкрито' : ''}`, note: path.basename(file) };
      }
      return { ok: false, error: 'Забагато нотаток з такою назвою' };
    },
  },
  {
    name: 'list_notes',
    confirm: 'never',
    untrusted: true,
    schema: () => ({
      description: 'Повертає назви збережених нотаток асистента',
      parameters: { type: 'object', properties: {} },
    }),
    async run() {
      const notes = await listNotes();
      return { ok: true, count: notes.length, notes: notes.slice(0, 50) };
    },
  },
  {
    name: 'read_note',
    confirm: 'never',
    untrusted: true,
    schema: () => ({
      description: 'Читає текст збереженої нотатки. Назву бери з результату list_notes',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string', description: 'Назва нотатки з результату list_notes' } },
        required: ['note'],
      },
    }),
    async run({ note }) {
      const file = resolveNote(note);
      if (!file) return { ok: false, error: 'Такої нотатки немає' };
      const text = (await fs.readFile(file, 'utf8')).replace(/^﻿/, '');
      return { ok: true, note: path.basename(file), truncated: text.length > MAX_READ_CHARS, text: text.slice(0, MAX_READ_CHARS) };
    },
  },
  {
    name: 'delete_note',
    confirm: 'always',
    schema: () => ({
      description: 'Видаляє нотатку (переміщує в кошик нотаток). Користувач сам підтверджує це кнопкою. Назву бери з результату list_notes',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string', description: 'Назва нотатки з результату list_notes' } },
        required: ['note'],
      },
    }),
    describe: ({ note }) => `Перемістити нотатку «${str(note, 80)}» до кошика нотаток`,
    precheck: ({ note }) => (resolveNote(note) ? null : { ok: false, error: 'Такої нотатки немає' }),
    async run({ note }) {
      const file = resolveNote(note);
      if (!file) return { ok: false, error: 'Такої нотатки немає' };
      await fs.mkdir(NOTES_TRASH, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.rename(file, path.join(NOTES_TRASH, `${stamp} ${path.basename(file)}`));
      return { ok: true, message: `Нотатку «${path.basename(file, '.txt')}» переміщено до кошика нотаток` };
    },
  },
];
