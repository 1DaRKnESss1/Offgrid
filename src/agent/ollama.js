// Мінімальний клієнт Ollama через вбудований fetch. Адреса завжди локальна (перевіряється в налаштуваннях).
// Відповідь читаємо потоком: текст з'являється (і озвучується) з першого речення, а не після всієї відповіді.
const REQUEST_TIMEOUT_MS = 180_000;
// 8192: підказка й опис 20 інструментів займають ~3500 токенів, тож у вікні 4096 на розмову й відповідь не
// лишалося місця (відповіді обривалися, а Ollama мовчки відрізала початок — правила). Подвоєння коштує ~130 МБ
// відеопам'яті (виміряно: 6900 -> 7032 МіБ з усіма шарами на відеокарті).
export const NUM_CTX = 8192;
const CANCELLED = 'Скасовано';

// Скільки шарів моделі класти на відеокарту (див. gpu.js). null — вирішує сама Ollama.
let gpuLayers = null;
export function setGpuLayers(layers) {
  gpuLayers = Number.isInteger(layers) && layers >= 0 ? layers : null;
}

/**
 * Один запит до моделі. onDelta(шматок тексту) викликається в міру надходження відповіді.
 * Повертає { content, tool_calls }.
 * Відеопам'яті впритул, тож завантаження моделі зрідка падає всередині Ollama (помилка 500).
 * Друга спроба зазвичай проходить, тому один раз повторюємо самі — але лише якщо ще нічого не показали.
 */
export async function chat(config, messages, tools, signal, onDelta = () => {}) {
  try {
    return await chatOnce(config, messages, tools, signal, onDelta);
  } catch (e) {
    if (!e.retryable || signal?.aborted) throw e;
    // пауза перед повтором не має затримувати скасування
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (signal?.aborted) throw new Error(CANCELLED);
    return chatOnce(config, messages, tools, signal, onDelta);
  }
}

function serverError(status, detail) {
  const text = String(detail ?? '');
  const crashed = /terminated|exit status|out of memory|cuda/i.test(text);
  return new Error(crashed
    ? 'Ollama не змогла запустити модель — найімовірніше, забракло відеопам\'яті. Закрий програми, що навантажують відеокарту, і спробуй ще раз'
    : `Ollama повернула помилку${status ? ` ${status}` : ''}${text ? `: ${text.slice(0, 160)}` : ''}`);
}

async function chatOnce(config, messages, tools, signal, onDelta) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let emitted = false;
  const fail = (e) => {
    if (signal?.aborted) return new Error(CANCELLED);
    if (e?.name === 'TimeoutError') return new Error('Модель не відповіла вчасно');
    return e;
  };

  let res;
  try {
    res = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({
        model: config.model,
        messages,
        tools,
        stream: true,
        think: false,
        keep_alive: '30m',
        // рекомендовані розробниками моделі параметри для режиму без роздумів
        // num_ctx задаємо явно: типове вікно Ollama інше, а зміна розміру перезавантажує модель
        options: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, num_ctx: NUM_CTX,
          ...(gpuLayers !== null ? { num_gpu: gpuLayers } : {}) },
      }),
    });
  } catch (e) {
    const err = fail(e);
    throw err === e ? new Error('Ollama не відповідає. Перевір, що вона запущена') : err;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error ?? ''; } catch { /* тіло не JSON */ }
    if (res.status === 404) throw new Error(`Модель ${config.model} не знайдено в Ollama`);
    const err = serverError(res.status, detail);
    if (res.status >= 500) err.retryable = true;
    throw err;
  }

  let content = '';
  const toolCalls = [];
  let done = false;
  const handle = (line) => {
    let data;
    try { data = JSON.parse(line); } catch { return; }
    if (data.error) {
      const err = serverError(0, data.error);
      err.retryable = !emitted;
      throw err;
    }
    const piece = data.message?.content;
    if (typeof piece === 'string' && piece) {
      content += piece;
      emitted = true;
      onDelta(piece);
    }
    if (Array.isArray(data.message?.tool_calls)) toolCalls.push(...data.message.tool_calls);
    if (data.done) done = true;
  };

  try {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handle(line);
      }
    }
    if (buffer.trim()) handle(buffer.trim());
  } catch (e) {
    throw fail(e);
  }
  if (!done) {
    const err = new Error('Ollama обірвала відповідь на півслові');
    err.retryable = !emitted;
    throw err;
  }
  return { content, tool_calls: toolCalls };
}

/** Вивантажує модель із пам'яті (звільняє відеопам'ять). */
export async function unloadModel(config) {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ model: config.model, keep_alive: 0 }),
    });
    return res.ok;
  } catch { return false; }
}

/**
 * Завантажує модель заздалегідь — з тими самими параметрами, що й справжні запити (інакше Ollama
 * перезавантажила б її ще раз). Так перша відповідь після «сну» не чекає на завантаження.
 */
export async function preloadModel(config) {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model: config.model, keep_alive: '30m',
        options: { num_ctx: NUM_CTX, ...(gpuLayers !== null ? { num_gpu: gpuLayers } : {}) } }),
    });
    return res.ok;
  } catch { return false; }
}

export async function ping(config) {
  try {
    // запас у 4 с: під час запуску застосунку процесор зайнятий завантаженням моделей мовлення
    const res = await fetch(`${config.ollamaUrl}/api/version`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch { return false; }
}
