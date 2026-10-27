import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { assertAdmin } from '../lib/scope.js';
import { formatDailySummary, loadDailySummary } from '../domain/dailySummary.js';
import { enqueueTelegramMessage } from './telegramOutbox.js';

/**
 * Постановка ежедневной сводки в очередь Telegram (DECISION-093).
 *
 * Два пути с разными правилами:
 * - плановый (планировщик, 21:30) — строго один раз за дату. Отметка — поле dailySummary в
 *   payload строки очереди: отдельная таблица под один флаг не нужна, а перезапуск API в любой
 *   момент после 21:30 не даёт ни потери, ни дубля;
 * - ручной (администратор, кнопка/запрос) — когда угодно и сколько угодно раз, без отметки,
 *   поэтому ручная отправка до 21:30 плановую не отменяет.
 */
export const DAILY_SUMMARY_TIME = '21:30';

// Произвольная, но постоянная константа: сериализует два параллельных плановых запуска (например,
// старый и новый контейнер при выкатке), чтобы проверка «уже ставили?» и вставка шли без гонки.
const DAILY_SUMMARY_LOCK = 920_093;

export async function enqueueScheduledDailySummary(client: Client, date: string): Promise<boolean> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [DAILY_SUMMARY_LOCK]);
  const done = await client.query(
    `SELECT 1 FROM telegram_outbox WHERE payload->>'dailySummary' = $1 LIMIT 1`,
    [date],
  );
  if (done.rowCount) return false;
  const text = formatDailySummary(await loadDailySummary(client, date));
  await enqueueTelegramMessage(client, 'text', { text, dailySummary: date });
  return true;
}

export async function enqueueDailySummaryNow(client: Client, actor: Actor, date: string): Promise<void> {
  assertAdmin(actor);
  const text = formatDailySummary(await loadDailySummary(client, date));
  await enqueueTelegramMessage(client, 'text', { text });
}
