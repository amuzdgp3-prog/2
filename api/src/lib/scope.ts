import type { Client } from '../db/pool.js';
import type { Actor } from './audit.js';
import { forbidden } from './errors.js';

/**
 * Scope is resolved server-side on every protected endpoint (10_ТЗ §16). It is the union of:
 * the Location subtrees assigned directly (staff_location_scope), every Location or Machine
 * tagged anywhere in a granted Каталог subtree (staff_classifier_scope, walked recursively
 * through classifiers.parent_id), and point machine assignments (machine_technicians). UI is
 * never a security mechanism, and no endpoint — services, search, reports, export, cashless,
 * sync — may bypass this filter.
 *
 * Каталог (classifiers) is a second, independent way in, orthogonal to the Location parent_id
 * tree: a Location's parent_id gives it one place in one tree (right for the address itself — it
 * only stands in one physical spot), but the owner also groups addresses AND individual machines
 * by cross-cutting, possibly-nested labels that don't fit any single tree (e.g. a city root with
 * district/venue-type children, or a machine-type tag that spans multiple cities). Granting a
 * Каталог node means "every address or machine tagged anywhere in this node's subtree,"
 * independent of where those addresses sit in the Location tree.
 *
 * A tag on a Location only reaches the machine CURRENTLY placed there (ended_at IS NULL) — a
 * machine that moves away loses it, and a replacement machine placed there inherits it
 * automatically, matching how the owner actually swaps hardware at one contract address. A tag
 * placed directly on a Machine (machine_classifiers) is independent of placement entirely, for
 * the rare case where two different machine types share one physical address and need to be
 * told apart.
 */
const SCOPED_MACHINES_SQL = `
  WITH RECURSIVE scope_tree AS (
    SELECT l.id
    FROM staff_location_scope s
    JOIN locations l ON l.id = s.location_id
    WHERE s.staff_id = $STAFF
    UNION
    SELECT child.id
    FROM locations child
    JOIN scope_tree parent ON child.parent_id = parent.id
  ),
  classifier_tree AS (
    SELECT c.id
    FROM staff_classifier_scope scs
    JOIN classifiers c ON c.id = scs.classifier_id
    WHERE scs.staff_id = $STAFF
    UNION
    SELECT child.id
    FROM classifiers child
    JOIN classifier_tree parent ON child.parent_id = parent.id
  ),
  classifier_locations AS (
    SELECT lc.location_id AS id
    FROM location_classifiers lc
    WHERE lc.classifier_id IN (SELECT id FROM classifier_tree)
  ),
  classifier_machines AS (
    SELECT mc.machine_number
    FROM machine_classifiers mc
    WHERE mc.classifier_id IN (SELECT id FROM classifier_tree)
  )
  SELECT p.machine_number FROM machine_placements p
  WHERE p.location_id IN (SELECT id FROM scope_tree)
  UNION
  SELECT p.machine_number FROM machine_placements p
  WHERE p.ended_at IS NULL AND p.location_id IN (SELECT id FROM classifier_locations)
  UNION
  SELECT machine_number FROM classifier_machines
  UNION
  SELECT mt.machine_number FROM machine_technicians mt WHERE mt.staff_id = $STAFF
`;

/** True if a staff member has been granted anything at all, via any of the three grant tables. */
const GRANTS_EXIST_SQL = `
  EXISTS (
    SELECT 1 FROM staff_location_scope WHERE staff_id = $STAFF
    UNION ALL
    SELECT 1 FROM staff_classifier_scope WHERE staff_id = $STAFF
    UNION ALL
    SELECT 1 FROM machine_technicians WHERE staff_id = $STAFF
  )
`;

/**
 * Builds a SQL predicate restricting a query to the machines the actor may see.
 * ADMIN always sees everything. TECHNICIAN always sees exactly what's granted — an ungranted
 * technician sees nothing (unchanged, long-established behaviour). BOSS is the new scoped role:
 * an ungranted BOSS keeps seeing everything (backward compatible with every BOSS account that
 * existed before scoping applied to this role at all), and narrows to exactly what's granted the
 * moment any grant exists — so revoking a BOSS's last remaining grant silently restores full
 * visibility, which is intentional, not a bug.
 */
export function machineScopePredicate(
  actor: Actor,
  machineColumn: string,
  nextParamIndex: number,
): { sql: string; params: unknown[] } {
  if (actor.role === 'ADMIN' || actor.id === null) {
    return { sql: 'TRUE', params: [] };
  }
  const staffParam = `$${nextParamIndex}`;
  const scoped = `${machineColumn} IN (${SCOPED_MACHINES_SQL.replaceAll('$STAFF', staffParam)})`;
  const sql =
    actor.role === 'BOSS'
      ? `(NOT (${GRANTS_EXIST_SQL.replaceAll('$STAFF', staffParam)}) OR ${scoped})`
      : scoped;
  return { sql, params: [actor.id] };
}

export async function listScopedMachineNumbers(client: Client, actor: Actor): Promise<string[]> {
  const predicate = machineScopePredicate(actor, 'machine_number', 1);
  const rows = await client.query(
    `SELECT machine_number FROM machines WHERE ${predicate.sql} ORDER BY machine_number`,
    predicate.params,
  );
  return rows.rows.map((row) => row.machine_number);
}

export async function assertMachineInScope(
  client: Client,
  actor: Actor,
  machineNumber: string,
): Promise<void> {
  const predicate = machineScopePredicate(actor, '$2', 1);
  if (predicate.sql === 'TRUE') return;
  const allowed = await client.query(`SELECT ${predicate.sql} AS allowed`, [
    ...predicate.params,
    machineNumber,
  ]);
  if (!allowed.rows[0]?.allowed) {
    throw forbidden('аппарат вне зоны ответственности техника');
  }
}

export function assertCanMutate(actor: Actor): void {
  if (actor.role === 'BOSS') {
    throw forbidden('роль «руководитель» доступна только для просмотра');
  }
}

export function assertAdmin(actor: Actor): void {
  if (actor.role !== 'ADMIN') {
    throw forbidden('требуется роль администратора');
  }
}
