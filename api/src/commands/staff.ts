import type { Client } from '../db/pool.js';
import { auditDelete, auditUpdate, type Actor, type Role } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { assertAdmin } from '../lib/scope.js';

const STAFF_COLUMNS = 'id, login, full_name, role, is_active, created_at, updated_at';

/**
 * Guards against locking everyone out: an operation that would leave zero active ADMIN accounts
 * is rejected. This is not in the normative document set — it is an operational safety decision,
 * not a business rule, so it applies only here and is not audited as a business mutation.
 */
async function assertAdminRemains(client: Client, excludingStaffId: number): Promise<void> {
  const remaining = await client.query(
    `SELECT COUNT(*)::int AS count FROM staff
     WHERE role = 'ADMIN' AND is_active AND id <> $1`,
    [excludingStaffId],
  );
  if (remaining.rows[0].count === 0) {
    throw badRequest(
      'LAST_ADMIN',
      'нельзя разжаловать или деактивировать последнего активного администратора',
    );
  }
}

export async function updateStaffProfile(
  client: Client,
  actor: Actor,
  staffId: number,
  patch: { fullName?: string; role?: Role; isActive?: boolean },
): Promise<Record<string, unknown>> {
  assertAdmin(actor);

  const before = await client.query(`SELECT ${STAFF_COLUMNS} FROM staff WHERE id = $1`, [staffId]);
  if (before.rowCount === 0) throw notFound('сотрудник не существует');

  const demotingOrDeactivating =
    before.rows[0].role === 'ADMIN' &&
    before.rows[0].is_active &&
    ((patch.role !== undefined && patch.role !== 'ADMIN') || patch.isActive === false);
  if (demotingOrDeactivating) {
    await assertAdminRemains(client, staffId);
  }

  const after = await client.query(
    `UPDATE staff SET
       full_name = COALESCE($2, full_name),
       role      = COALESCE($3::staff_role, role),
       is_active = COALESCE($4, is_active)
     WHERE id = $1
     RETURNING ${STAFF_COLUMNS}`,
    [staffId, patch.fullName ?? null, patch.role ?? null, patch.isActive ?? null],
  );

  await auditUpdate(client, actor, 'staff', staffId, before.rows[0], after.rows[0]);
  return after.rows[0];
}

/**
 * Resets a staff member's password. No complexity/length policy is enforced by design — this is
 * an internal operational tool, not a public-facing account system, and the added friction had no
 * matching benefit here. The audit record deliberately never contains the password or its hash,
 * only the fact that a reset happened.
 */
export async function setStaffPassword(
  client: Client,
  actor: Actor,
  staffId: number,
  newPassword: string,
): Promise<void> {
  assertAdmin(actor);
  if (!newPassword) throw badRequest('PASSWORD_REQUIRED', 'пароль не может быть пустым');

  const existing = await client.query(`SELECT ${STAFF_COLUMNS} FROM staff WHERE id = $1`, [staffId]);
  if (existing.rowCount === 0) throw notFound('сотрудник не существует');

  const passwordHash = await hashPassword(newPassword);
  await client.query('UPDATE staff SET password_hash = $2 WHERE id = $1', [staffId, passwordHash]);

  await auditUpdate(client, actor, 'staff', staffId, existing.rows[0], existing.rows[0], {
    reason: 'password_reset',
  });
}

/**
 * Deletes a staff account outright — deliberately narrower than deactivating (`isActive:
 * false`), which stays the right tool whenever the account has done real work: services,
 * placements, photos and terminal bindings all carry a `staff.id` foreign key with no cascade,
 * matching this project's general rule that nothing with financial/audit weight is ever truly
 * erased (see e.g. machine_placements' own no-delete trigger). Delete exists for the other,
 * equally real case — an account created by mistake, or for a technician who never actually
 * logged a single visit — where deactivating would just leave permanent clutter in the staff
 * list for no benefit. staff_location_scope and machine_technicians are plain assignment tables
 * with no historical meaning of their own, so those are cleared rather than treated as "history."
 */
export async function deleteStaff(client: Client, actor: Actor, staffId: number): Promise<void> {
  assertAdmin(actor);

  const existing = await client.query(`SELECT ${STAFF_COLUMNS} FROM staff WHERE id = $1`, [staffId]);
  if (existing.rowCount === 0) throw notFound('сотрудник не существует');

  if (existing.rows[0].role === 'ADMIN' && existing.rows[0].is_active) {
    await assertAdminRemains(client, staffId);
  }

  const usage = await client.query(
    `SELECT
       EXISTS(SELECT 1 FROM services WHERE created_by = $1 OR technician_id = $1)      AS in_services,
       EXISTS(SELECT 1 FROM audit_log WHERE actor_id = $1)                             AS in_audit,
       EXISTS(SELECT 1 FROM machine_placements WHERE installed_by = $1 OR closed_by = $1) AS in_placements,
       EXISTS(SELECT 1 FROM photo_objects WHERE uploaded_by = $1)                       AS in_photos,
       EXISTS(SELECT 1 FROM terminal_bindings WHERE created_by = $1)                    AS in_terminals`,
    [staffId],
  );
  const usageRow = usage.rows[0];
  if (usageRow.in_services || usageRow.in_audit || usageRow.in_placements || usageRow.in_photos || usageRow.in_terminals) {
    throw conflict(
      'STAFF_HAS_HISTORY',
      'нельзя удалить сотрудника — за ним есть история действий (обслуживания, аудит и т.п.); отключите учётную запись вместо удаления',
    );
  }

  await client.query('DELETE FROM staff_location_scope WHERE staff_id = $1', [staffId]);
  await client.query('DELETE FROM machine_technicians WHERE staff_id = $1', [staffId]);
  await client.query('DELETE FROM staff WHERE id = $1', [staffId]);

  await auditDelete(client, actor, 'staff', staffId, existing.rows[0]);
}
