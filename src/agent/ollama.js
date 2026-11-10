// Мінімальний клієнт Ollama через вбудований fetch. Адреса завжди локальна (перевіряється в налаштуваннях).
const REQUEST_TIMEOUT_MS = 180_000;

export async function chat(config, messages, tools, signal) {
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
        options: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 },
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
    throw new Error(`Ollama повернула помилку ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
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
