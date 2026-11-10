// Мінімальний клієнт Ollama через вбудований fetch. Адреса завжди локальна (перевіряється в налаштуваннях).
const REQUEST_TIMEOUT_MS = 180_000;
export const NUM_CTX = 4096;

// Відеопам'яті впритул, тож завантаження моделі зрідка падає всередині Ollama (помилка 500).
// Друга спроба зазвичай проходить, тому один раз повторюємо самі.
export async function chat(config, messages, tools, signal) {
  try {
    return await chatOnce(config, messages, tools, signal);
  } catch (e) {
    if (!e.retryable || signal?.aborted) throw e;
    await new Promise((r) => setTimeout(r, 2000));
    if (signal?.aborted) throw new Error('Скасовано');
    return chatOnce(config, messages, tools, signal);
  }
}

async function chatOnce(config, messages, tools, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
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
        stream: false,
        think: false,
        keep_alive: '30m',
        // рекомендовані розробниками моделі параметри для режиму без роздумів
        // num_ctx задаємо явно: більше вікно не вміщається у 8 ГБ відеопам'яті поруч із самою моделлю
        options: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, num_ctx: NUM_CTX },
      }),
    });
  } catch (e) {
    if (signal?.aborted) throw new Error('Скасовано');
    if (e.name === 'TimeoutError') throw new Error('Модель не відповіла вчасно');
    throw new Error('Ollama не відповідає. Перевір, що вона запущена');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error ?? ''; } catch { /* тіло не JSON */ }
    if (res.status === 404) throw new Error(`Модель ${config.model} не знайдено в Ollama`);
    if (res.status >= 500) {
      const crashed = /terminated|exit status|out of memory|cuda/i.test(String(detail));
      const err = new Error(crashed
        ? 'Ollama не змогла запустити модель — найімовірніше, забракло відеопам\'яті. Закрий програми, що навантажують відеокарту, і спробуй ще раз'
        : `Ollama повернула помилку ${res.status}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`);
      err.retryable = true;
      throw err;
    }
    throw new Error(`Ollama повернула помилку ${res.status}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`);
  }
  const data = await res.json();
  if (!data?.message) throw new Error('Ollama повернула порожню відповідь');
  return data.message;
}

export async function ping(config) {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}
