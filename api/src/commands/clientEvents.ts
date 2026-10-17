import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';

/**
 * Журнал событий клиента (DECISION-087, 022_client_events.sql).
 *
 * Пишет любой вошедший пользователь, staff_id берётся из токена. Это служебная диагностика, а не
 * учёт: в audit_log не попадает, строки старше 30 дней удаляются тем же запросом, что и запись, —
 * отдельного планировщика на проде нет.
 */
export interface ClientEventInput {
  at: string;
  kind: string;
  screen?: string;
  detail?: Record<string, unknown>;
}

export interface ClientEventsBody {
  appVersion: string;
  events: ClientEventInput[];
}

export const MAX_DETAIL_BYTES = 2048;
const RETENTION = '30 days';

export async function recordClientEvents(
  client: Client,
  actor: Actor,
  body: ClientEventsBody,
  userAgent: string | undefined,
): Promise<void> {
  const agent = userAgent?.slice(0, 300) ?? null;
  for (const event of body.events) {
    await client.query(
      `INSERT INTO client_events (staff_id, occurred_at, app_version, kind, screen, detail, user_agent)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6::jsonb, $7)`,
      [actor.id, occurredAt(event.at), body.appVersion, event.kind, event.screen ?? null, detailJson(event.detail), agent],
    );
  }
  await client.query(`DELETE FROM client_events WHERE received_at < now() - $1::interval`, [RETENTION]);
}

/** Часы телефона бывают сбиты или строка битая — тогда берём время приёма, а не роняем запись. */
function occurredAt(raw: string): string {
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function detailJson(detail: Record<string, unknown> | undefined): string | null {
  if (!detail) return null;
  const json = JSON.stringify(detail);
  return Buffer.byteLength(json) <= MAX_DETAIL_BYTES ? json : JSON.stringify({ truncated: true, head: json.slice(0, 500) });
}
