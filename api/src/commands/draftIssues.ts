import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { assertAdmin } from '../lib/scope.js';

/**
 * Застрявшие черновики техников (DECISION-048, 016_draft_issues.sql).
 *
 * Докладывает сам техник — точнее, его клиент при отказе синхронизации, — поэтому здесь нет
 * assertAdmin: техник имеет право сообщить о своей же проблеме. Зато `technician_id` берётся из
 * токена, а не из тела запроса: приписать свой затык другому нельзя.
 *
 * В аудит это не пишется намеренно. Список оперативный, строки в нём живут до починки черновика и
 * удаляются, а не копятся; писать в неизменяемый журнал факт «у техника не отправилось» значило бы
 * засорять его тем же, чем раньше засоряли копии безнала (DECISION-044).
 */
export interface DraftIssueRow {
  local_id: string;
  technician_id: number | null;
  technician_name: string | null;
  machine_number: string;
  machine_address: string | null;
  occurred_at: Date;
  error_code: string;
  error_message: string;
  reported_at: Date;
  updated_at: Date;
}

export async function reportDraftIssue(
  client: Client,
  actor: Actor,
  input: {
    localId: string;
    machineNumber: string;
    occurredAt: string;
    errorCode: string;
    errorMessage: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO technician_draft_issues
       (local_id, technician_id, machine_number, occurred_at, error_code, error_message)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6)
     ON CONFLICT (local_id) DO UPDATE
       SET error_code = EXCLUDED.error_code,
           error_message = EXCLUDED.error_message,
           occurred_at = EXCLUDED.occurred_at,
           updated_at = now()`,
    [
      input.localId,
      actor.id,
      input.machineNumber,
      input.occurredAt,
      input.errorCode,
      input.errorMessage.slice(0, 1000),
    ],
  );
}

/** Черновик уехал или удалён — проблема закрыта, строка списку больше не нужна. */
export async function resolveDraftIssue(
  client: Client,
  _actor: Actor,
  localId: string,
): Promise<void> {
  await client.query('DELETE FROM technician_draft_issues WHERE local_id = $1', [localId]);
}

export async function listDraftIssues(client: Client, actor: Actor): Promise<DraftIssueRow[]> {
  assertAdmin(actor);
  const result = await client.query<DraftIssueRow>(
    `SELECT i.*, st.full_name AS technician_name, p.address AS machine_address
     FROM technician_draft_issues i
     LEFT JOIN staff st ON st.id = i.technician_id
     LEFT JOIN machine_placements p
       ON p.machine_number = i.machine_number AND p.ended_at IS NULL
     ORDER BY i.updated_at DESC`,
  );
  return result.rows;
}
