import { config } from '../config.js';
import { pool, type Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { assertAdmin } from '../lib/scope.js';

export async function queueCounterPhoto(
  client: Client,
  serviceId: number,
  games: number,
  prizes: number | null,
): Promise<void> {
  if (!config.counterPhotoToken) return;
  await client.query(
    `INSERT INTO counter_photo_checks (service_id, entered_games, entered_prizes)
     VALUES ($1, $2, $3) ON CONFLICT (service_id) DO NOTHING`,
    [serviceId, games, prizes],
  );
}

export async function pendingCounterPhotos() {
  const result = await pool.query(
    `SELECT c.service_id AS id, s.photo_object_key AS "photoObjectKey"
     FROM counter_photo_checks c JOIN services s ON s.id = c.service_id
     WHERE c.status = 'PENDING' ORDER BY c.service_id LIMIT 100`,
  );
  return result.rows;
}

export async function saveCounterPhotoResult(id: string, values: [number, number] | null) {
  const readings = values && values[0] !== values[1] ? values : null;
  const games = readings ? Math.max(...readings) : null;
  const prizes = readings ? Math.min(...readings) : null;
  const result = await pool.query<{ status: string }>(
    `UPDATE counter_photo_checks SET
       detected_games = $2::bigint, detected_prizes = $3::bigint, checked_at = now(),
       status = CASE WHEN $2::bigint IS NULL THEN 'UNREADABLE'
                     WHEN entered_games <> $2 OR (entered_prizes IS NOT NULL AND entered_prizes <> $3)
                       THEN 'MISMATCH'
                     ELSE 'MATCH' END
     WHERE service_id = $1 AND status = 'PENDING' RETURNING status`,
    [id, games, prizes],
  );
  if (result.rows[0]) return result.rows[0];

  const existing = await pool.query<{ status: string }>(
    'SELECT status FROM counter_photo_checks WHERE service_id = $1', [id],
  );
  if (!existing.rows[0]) throw notFound('задание сверки не найдено');
  return existing.rows[0];
}

export async function counterPhotoReviews(actor: Actor) {
  assertAdmin(actor);
  const result = await pool.query(
    `SELECT c.service_id AS id, c.status, c.entered_games AS "enteredGames",
            c.entered_prizes AS "enteredPrizes", c.detected_games AS "detectedGames",
            c.detected_prizes AS "detectedPrizes", s.machine_number AS "machineNumber",
            p.address AS "machineAddress", s.occurred_at AS "occurredAt",
            s.game_counter AS "currentGames", s.prize_counter AS "currentPrizes",
            s.photo_object_key AS "photoObjectKey", st.full_name AS "technicianName"
     FROM counter_photo_checks c
     JOIN services s ON s.id = c.service_id
     JOIN machine_placements p ON p.id = s.placement_id
     LEFT JOIN staff st ON st.id = s.technician_id
     WHERE c.status IN ('MISMATCH', 'UNREADABLE') ORDER BY c.service_id DESC`,
  );
  return result.rows;
}

export async function resolveCounterPhoto(actor: Actor, id: string) {
  assertAdmin(actor);
  const result = await pool.query(
    `UPDATE counter_photo_checks
     SET status = 'RESOLVED', resolved_at = now(), resolved_by = $2
     WHERE service_id = $1 AND status IN ('MISMATCH', 'UNREADABLE')
     RETURNING status`,
    [id, actor.id],
  );
  if (result.rowCount) return { status: 'RESOLVED' };
  const existing = await pool.query(
    `SELECT 1 FROM counter_photo_checks WHERE service_id = $1 AND status = 'RESOLVED'`, [id],
  );
  if (!existing.rowCount) throw notFound('расхождение не найдено');
  return { status: 'RESOLVED' };
}
