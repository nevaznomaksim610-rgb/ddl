export class TelegramError extends Error {
  constructor(code, description, retryAfter = 0) {
    super(description);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class Telegram {
  constructor(token) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token || '')) throw new Error('BOT_TOKEN не задан или имеет неверный формат');
    this.token = token;
  }

  async call(method, payload = {}) {
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(method === 'getUpdates' ? 45000 : 15000),
      });
    } catch {
      throw new TelegramError(0, 'Telegram недоступен: ошибка сети или тайм-аут');
    }
    let body;
    try { body = await response.json(); } catch { throw new TelegramError(response.status, 'Telegram вернул некорректный ответ'); }
    if (!body.ok) throw new TelegramError(body.error_code || response.status, String(body.description || 'Ошибка Telegram').replaceAll(this.token, '[TOKEN]'), body.parameters?.retry_after || 0);
    return body.result;
  }
}
