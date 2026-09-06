import type { Client } from '../db/pool.js';
import type { Actor } from './audit.js';
import { forbidden } from './errors.js';

/**
 * Technician scope is resolved server-side on every protected endpoint (10_ТЗ §16).
 * It is the union of: the Location subtrees assigned to the technician, every Location tagged
 * with a classifier assigned to the technician, and point machine assignments. UI is never a
 * security mechanism, and no endpoint — services, search, reports, export, cashless, sync — may
 * bypass this filter.
 *
 * Classifiers are a second, independent way in: a Location's parent_id gives it one place in one
 * tree (right for the address itself — it only stands in one physical spot), but the owner also
 * groups addresses by cross-cutting labels that don't fit any single tree (e.g. a venue-type tag
 * that spans both "Юг" and "Север"). Granting by classifier means "every address carrying this
 * tag," independent of where that address sits in the location tree.
 */
const TECHNICIAN_MACHINES_SQL = `
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
  classifier_locations AS (
    SELECT lc.location_id AS id
    FROM staff_classifier_scope scs
    JOIN location_classifiers lc ON lc.classifier_id = scs.classifier_id
    WHERE scs.staff_id = $STAFF
  )
  SELECT p.machine_number FROM machine_placements p
  WHERE p.location_id IN (SELECT id FROM scope_tree)
     OR p.location_id IN (SELECT id FROM classifier_locations)
  UNION
  SELECT mt.machine_number FROM machine_technicians mt WHERE mt.staff_id = $STAFF
`;

/**
 * Builds a SQL predicate restricting a query to the machines the actor may see.
 * Admins and read-only bosses see everything; technicians see their scope only.
 */
export function machineScopePredicate(
  actor: Actor,
  machineColumn: string,
  nextParamIndex: number,
): { sql: string; params: unknown[] } {
  if (actor.role !== 'TECHNICIAN' || actor.id === null) {
    return { sql: 'TRUE', params: [] };
  }
  const sql = `${machineColumn} IN (${TECHNICIAN_MACHINES_SQL.replaceAll(
    '$STAFF',
    `$${nextParamIndex}`,
  )})`;
  return { sql, params: [actor.id] };
}

export async function listScopedMachineNumbers(client: Client, actor: Actor): Promise<string[]> {
  if (actor.role !== 'TECHNICIAN' || actor.id === null) {
    const all = await client.query('SELECT machine_number FROM machines ORDER BY machine_number');
    return all.rows.map((row) => row.machine_number);
  }
  const scoped = await client.query(TECHNICIAN_MACHINES_SQL.replaceAll('$STAFF', '$1'), [actor.id]);
  return scoped.rows.map((row) => row.machine_number);
}

export async function assertMachineInScope(
  client: Client,
  actor: Actor,
  machineNumber: string,
): Promise<void> {
  if (actor.role !== 'TECHNICIAN' || actor.id === null) return;
  const predicate = machineScopePredicate(actor, '$2', 1);
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
