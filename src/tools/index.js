// Реєстр інструментів. Кожен інструмент:
//   name, confirm ('never' | 'tainted' | 'always'), untrusted (результат — сторонній текст),
//   schema(config), describe(args, ctx) — текст для вікна підтвердження (складає код, не модель),
//   precheck(args, ctx) — рання відмова до підтвердження, run(args, ctx).
import apps from './apps.js';
import system from './system.js';
import files from './files.js';
import notes from './notes.js';
import web from './web.js';
import allow from './allow.js';

// Підписи для панелі, коли інструмент нічого не «зробив», а лише щось дізнався
export const TOOL_LABELS = {
  get_time: 'Перевірив час',
  get_system_info: 'Перевірив стан системи',
  find_files: 'Пошукав файли',
  list_folder: 'Переглянув папку',
  read_text_file: 'Прочитав файл',
  list_notes: 'Переглянув нотатки',
  read_note: 'Прочитав нотатку',
};

export const ALL_TOOLS = [...system, ...apps, ...files, ...notes, ...web, ...allow];

export function activeTools(config) {
  return ALL_TOOLS.filter((t) => !t.available || t.available(config));
}

/** Опис інструментів у форматі Ollama. */
export function toolSchemas(config) {
  return activeTools(config).map((t) => ({ type: 'function', function: { name: t.name, ...t.schema(config) } }));
}

export function findTool(config, name) {
  return activeTools(config).find((t) => t.name === name) ?? null;
}
