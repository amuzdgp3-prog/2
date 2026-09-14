import { badRequest } from '../lib/errors.js';

/**
 * Отправка сгенерированного отчёта владельцу на почту через Resend (api.resend.com) — тот же
 * паттерн, что и integrations/telegram.ts: обычный fetch, без новых зависимостей, HTTP JSON API
 * вместо SMTP-библиотеки (MIME/вложения/TLS-рукопожатие SMTP пришлось бы иначе тащить отдельным
 * пакетом). Появилось как второй канал доставки того же отчёта после того, как выяснилось, что
 * сеть сервера не пропускает Telegram (DECISION-074) — Telegram-код при этом не удалён, электронная
 * почта — дополнительный способ, а не замена.
 */

// Тот же класс бага, что уже нашли и починили для Telegram (DECISION-074) и раньше для iVend
// (DECISION-041): у глобального fetch в Node нет таймаута по умолчанию. Переопределяемо для теста
// на зависшее соединение, как и у обоих соседей.
const EMAIL_TIMEOUT_MS = Number(process.env.EMAIL_SEND_TIMEOUT_MS ?? 30_000);

// Переопределяемо, чтобы тест на таймаут подставлял локальный зависающий сервер вместо реального
// api.resend.com — тот же приём, что TELEGRAM_API_BASE/IVEND_GRAPHQL_URL.
const RESEND_API_BASE = process.env.RESEND_API_BASE ?? 'https://api.resend.com';

export async function sendReportEmail(
  apiKey: string,
  from: string,
  to: string,
  buffer: Buffer,
  filename: string,
  subject: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${RESEND_API_BASE}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html: `<p>Ежемесячный отчёт Apixspb — во вложении.</p>`,
        attachments: [{ filename, content: buffer.toString('base64') }],
      }),
      signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw badRequest('EMAIL_SEND_FAILED', `не удалось отправить отчёт на почту: нет соединения (${reason})`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw badRequest('EMAIL_SEND_FAILED', `не удалось отправить отчёт на почту: ${response.status} ${body}`);
  }
}
