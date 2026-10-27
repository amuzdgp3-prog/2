import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { assertAdmin } from '../lib/scope.js';

/**
 * Очередь исходящих сообщений в Telegram (024_telegram_outbox.sql).
 *
 * Прод не может достучаться до api.telegram.org напрямую (DECISION-074) — реальную отправку
 * делает внешний релей на машине, где Telegram работает через VPN. Он забирает отсюда
 * неотправленные строки обычным HTTPS к этому же API и сам отмечает результат.
 *
 * В аудит это не пишется намеренно, по той же причине, что и у technician_draft_issues
 * (commands/draftIssues.ts): список оперативный, а не бизнес-журнал — строки живут до отправки,
 * а не копятся как история решений.
 */
export type TelegramOutboxKind = 'monthly_report' | 'text';

export interface TelegramOutboxRow {
  id: number;
  kind: TelegramOutboxKind;
  payload: Record<string, unknown>;
  created_at: Date;
  sent_at: Date | null;
  attempts: number;
  last_error: string | null;
}

/** Ставит сообщение в очередь. Вызывается изнутри чужих транзакций (отчёт, backup.sh, разбор
 *  черновика) — поэтому принимает чужой client, а не открывает свой. */
export async function enqueueTelegramMessage(
  client: Client,
  kind: TelegramOutboxKind,
  payload: Record<string, unknown>,
): Promise<TelegramOutboxRow> {
  const result = await client.query<TelegramOutboxRow>(
    `INSERT INTO telegram_outbox (kind, payload) VALUES ($1, $2) RETURNING *`,
    [kind, JSON.stringify(payload)],
  );
  return result.rows[0];
}

/** Список неотправленного для релея — по порядку постановки в очередь. */
export async function listPendingTelegramMessages(
  client: Client,
  actor: Actor,
): Promise<TelegramOutboxRow[]> {
  assertAdmin(actor);
  const result = await client.query<TelegramOutboxRow>(
    `SELECT * FROM telegram_outbox WHERE sent_at IS NULL ORDER BY id`,
  );
  return result.rows;
}

export async function getTelegramMessage(
  client: Client,
  actor: Actor,
  id: number,
): Promise<TelegramOutboxRow> {
  assertAdmin(actor);
  const result = await client.query<TelegramOutboxRow>('SELECT * FROM telegram_outbox WHERE id = $1', [id]);
  if (result.rowCount === 0) throw notFound('сообщение не найдено в очереди');
  return result.rows[0];
}

export async function markTelegramMessageSent(client: Client, actor: Actor, id: number): Promise<void> {
  assertAdmin(actor);
  const result = await client.query('UPDATE telegram_outbox SET sent_at = now() WHERE id = $1', [id]);
  if (result.rowCount === 0) throw notFound('сообщение не найдено в очереди');
}

/** Отметка неудачной попытки — строка остаётся в очереди, релей повторит её на следующем опросе. */
export async function markTelegramMessageFailed(
  client: Client,
  actor: Actor,
  id: number,
  error: string,
): Promise<void> {
  assertAdmin(actor);
  const result = await client.query(
    `UPDATE telegram_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
    [id, error.slice(0, 1000)],
  );
  if (result.rowCount === 0) throw notFound('сообщение не найдено в очереди');
}
