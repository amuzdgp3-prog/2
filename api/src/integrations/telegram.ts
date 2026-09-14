import { badRequest } from '../lib/errors.js';

/**
 * Отправка сгенерированного отчёта владельцу в Telegram. Никаких новых зависимостей — глобальные
 * fetch/FormData/Blob уже есть в рантайме Node, используемом этим проектом (см. integrations/ivend.ts
 * для того же паттерна вызова внешнего HTTP API через fetch).
 */

// Node's global fetch has no default timeout — обнаружено на реальном проде: сеть сервера не
// пропускает TCP до api.telegram.org (заблокировано на уровне провайдера/файрвола — ping проходит,
// TCP:443 зависает), и без таймаута запрос из commands/reports.ts висел бы вечно, держа открытым
// соединение к БД из пула под тем же `finally { client.release() }` (тот же класс бага, что
// DECISION-041 уже чинил для кабинета iVend). 30с — щедро для одного маленького xlsx-файла.
// Переопределяемо по той же причине, что и у iVend: тесту на таймаут нужен короткий срок, а не
// реальные 30 секунд ожидания.
const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_SEND_TIMEOUT_MS ?? 30_000);

// Overridable so a timeout test can point this at a local hanging server instead of the real
// Bot API — same reasoning as IVEND_GRAPHQL_URL in integrations/ivend.ts.
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';

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

  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
  } catch (error) {
    // Таймаут (AbortError) или сетевой сбой — деловая ошибка для того, кто нажал кнопку, а не
    // повод падать 500-й: та же обёртка badRequest, что и у ответа не-2xx ниже.
    const reason = error instanceof Error ? error.message : String(error);
    throw badRequest('TELEGRAM_SEND_FAILED', `не удалось отправить отчёт в Telegram: нет соединения (${reason})`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw badRequest('TELEGRAM_SEND_FAILED', `не удалось отправить отчёт в Telegram: ${response.status} ${body}`);
  }
}
