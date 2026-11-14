// Розподіл відеопам'яті для моделі асистента.
//
// Навіщо: якщо модель не вміщається у відеопам'ять цілком, Windows тихо переносить надлишок у звичайну пам'ять,
// і швидкість падає в кілька разів. Автоматичний розподіл Ollama цього не враховує, тому рахуємо самі:
// скільки відеопам'яті зайнято іншими програмами і розпізнаванням мови — і скільки шарів моделі вміститься в решту.
// Виміряно на RTX 5060 Ti 8 ГБ з qwen3.5:9b: уся модель на відеокарті — 59 токенів/с, з переповненням — 10–15.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const NVIDIA_SMI = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe');
const MARGIN_MB = 400;        // запас: інші програми теж ворушаться
const BASE_MB = 1050;         // контекст і службові буфери моделі — займають відеопам'ять незалежно від числа шарів
const FILE_TO_VRAM = 0.87;    // файл моделі 6,55 ГБ займає у відеопам'яті близько 5,6 ГБ (заміряно 0,857, беремо із запасом)
const MB_PER_GB = 1e9 / (1024 * 1024); // Ollama рахує в десяткових гігабайтах, драйвер — у мебібайтах
const ALL_LAYERS = 99;        // «усі шари» мовою Ollama

/**
 * Скільки шарів моделі класти на відеокарту.
 *   totalMb    — уся відеопам'ять;
 *   othersMb   — зайнято всім, крім моделі асистента (інші програми, розпізнавання мови);
 *   reserveMb  — скільки ще залишити (наприклад, для розпізнавання, яке ще не завантажилось);
 *   fileGb     — розмір файлу моделі; blockCount — кількість її шарів (з Ollama).
 * Повертає число для параметра num_gpu.
 */
export function planGpuLayers({ totalMb, othersMb, reserveMb = 0, fileGb, blockCount }) {
  if (![totalMb, othersMb, fileGb, blockCount].every((v) => Number.isFinite(v) && v >= 0) || !(blockCount > 0)) return null;
  const fullMb = fileGb * MB_PER_GB * FILE_TO_VRAM;
  const budget = totalMb - othersMb - reserveMb - MARGIN_MB;
  if (budget >= fullMb) return ALL_LAYERS;
  const perLayer = Math.max(1, (fullMb - BASE_MB) / (blockCount + 2));
  return Math.max(0, Math.min(blockCount + 2, Math.floor((budget - BASE_MB) / perLayer)));
}

/** Відеопам'ять за даними драйвера NVIDIA: { totalMb, usedMb } або null, якщо nvidia-smi немає. */
export function readVram() {
  return new Promise((resolve) => {
    if (!existsSync(NVIDIA_SMI)) return resolve(null);
    execFile(NVIDIA_SMI, ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true }, (err, stdout) => {
        const [total, used] = String(stdout ?? '').trim().split('\n')[0]?.split(',').map((s) => Number(s.trim())) ?? [];
        resolve(!err && Number.isFinite(total) && Number.isFinite(used) ? { totalMb: total, usedMb: used } : null);
      });
  });
}

async function ollama(config, route, body) {
  const res = await fetch(`${config.ollamaUrl}${route}`, {
    method: body ? 'POST' : 'GET',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Ollama ${route}: ${res.status}`);
  return res.json();
}

/**
 * Вирішує, скільки шарів моделі класти на відеокарту просто зараз.
 * Щоб чесно побачити, скільки відеопам'яті зайнято всім іншим, модель спершу вивантажується
 * (наступний запит завантажить її знову, вже з правильним розподілом — це кілька секунд).
 * Повертає { layers, note } або { layers: null, note } — тоді розподіл лишається за Ollama.
 */
export async function decideGpuLayers(config, { reserveMb = 0 } = {}) {
  if (Number.isInteger(config.gpuLayers)) return { layers: config.gpuLayers, note: `задано в налаштуваннях: ${config.gpuLayers}` };
  try {
    if (!(await readVram())) return { layers: null, note: 'nvidia-smi недоступний — розподіл лишається за Ollama' };
    const [show, tags, ps] = await Promise.all([
      ollama(config, '/api/show', { model: config.model }),
      ollama(config, '/api/tags'),
      ollama(config, '/api/ps'),
    ]);
    const blockKey = Object.keys(show.model_info ?? {}).find((k) => k.endsWith('.block_count'));
    const blockCount = Number(show.model_info?.[blockKey]);
    const fileGb = (tags.models ?? []).find((m) => m.name === config.model || m.model === config.model)?.size / 1e9;
    if (!(blockCount > 0) || !(fileGb > 0)) return { layers: null, note: 'Ollama не повідомила розмір моделі — розподіл лишається за нею' };

    const loaded = (ps.models ?? []).some((m) => m.name === config.model || m.model === config.model);
    if (loaded) {
      await ollama(config, '/api/generate', { model: config.model, keep_alive: 0 });
      await new Promise((r) => setTimeout(r, 1500)); // даємо драйверу звільнити пам'ять
    }
    const vram = await readVram();
    if (!vram) return { layers: null, note: 'nvidia-smi недоступний — розподіл лишається за Ollama' };
    const layers = planGpuLayers({ totalMb: vram.totalMb, othersMb: vram.usedMb, reserveMb, fileGb, blockCount });
    if (layers === null) return { layers: null, note: 'не вдалося порахувати розподіл' };
    const freeGb = ((vram.totalMb - vram.usedMb) / 1024).toFixed(1);
    return { layers, note: layers === ALL_LAYERS ? `вільно ${freeGb} ГБ відеопам'яті — модель цілком на відеокарті`
      : `вільно лише ${freeGb} ГБ відеопам'яті — на відеокарті ${layers} шарів із ${blockCount + 1}, решта на процесорі (повільніше)` };
  } catch (e) {
    return { layers: null, note: `розподіл лишається за Ollama (${e.message})` };
  }
}
