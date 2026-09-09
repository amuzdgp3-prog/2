import { badRequest } from '../lib/errors.js';

/**
 * Отправка сгенерированного отчёта владельцу в Telegram. Никаких новых зависимостей — глобальные
 * fetch/FormData/Blob уже есть в рантайме Node, используемом этим проектом (см. integrations/ivend.ts
 * для того же паттерна вызова внешнего HTTP API через fetch).
 */
export async function sendTelegramDocument(
  botToken: string,
  chatId: string,
  buffer: Buffer,
  filename: string,
  caption?: string,
): Promise<void> {
  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) form.append('caption', caption);
  form.append(
    'document',
    new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    filename,
  );

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: 'POST',
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw badRequest('TELEGRAM_SEND_FAILED', `не удалось отправить отчёт в Telegram: ${response.status} ${body}`);
  }
}
