import type { Client } from '../db/pool.js';
import { auditDelete, auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { assertAdmin } from '../lib/scope.js';

/**
 * Каталог: a classifier is a node in a self-referencing tree (parent_id, multiple independent
 * roots), and a tag on either a Location or a Machine, independent of the Location's own
 * parent_id tree. The same address or machine can carry several classifier tags at once (e.g. a
 * geographic one like "СПб Юг" and an unrelated venue-type one like "Торговые центры" that spans
 * both Север and Юг), and granting a staff member an ancestor node reaches every tag anywhere in
 * its subtree — see lib/scope.ts's own comment for why this exists alongside, and now instead of,
 * the Location parent_id tree as the organising mechanism.
 */
export async function createClassifier(
  client: Client,
  actor: Actor,
  name: string,
  parentId?: number | null,
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  const existing = await client.query('SELECT 1 FROM classifiers WHERE name = $1', [name]);
  if ((existing.rowCount ?? 0) > 0) {
    throw conflict('CLASSIFIER_EXISTS', 'классификатор с таким названием уже есть');
  }
  const inserted = await client.query(
    'INSERT INTO classifiers (name, parent_id) VALUES ($1, $2) RETURNING *',
    [name, parentId ?? null],
  );
  await auditInsert(client, actor, 'classifier', inserted.rows[0].id, inserted.rows[0]);
  return inserted.rows[0];
}

/**
 * Renames and/or moves a node within the Каталог tree. Mirrors locations.ts's updateLocation
 * cycle guard exactly: a node can't become its own parent, and can't be moved into one of its own
 * descendants — either would turn classifier_tree in lib/scope.ts into an infinite recursion the
 * next time any grant walks through here.
 */
export async function updateClassifier(
  client: Client,
  actor: Actor,
  classifierId: number,
  patch: { name?: string; parentId?: number | null },
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  const before = await client.query('SELECT * FROM classifiers WHERE id = $1', [classifierId]);
  if (before.rowCount === 0) throw notFound('классификатор не существует');

  if (patch.parentId !== undefined && patch.parentId !== null) {
    if (patch.parentId === classifierId) {
      throw badRequest('CLASSIFIER_CYCLE', 'узел каталога не может быть собственным родителем');
    }
    const cycle = await client.query(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM classifiers WHERE id = $1
         UNION ALL
         SELECT c.id FROM classifiers c JOIN descendants d ON c.parent_id = d.id
       )
       SELECT 1 FROM descendants WHERE id = $2`,
      [classifierId, patch.parentId],
    );
    if (cycle.rowCount) {
      throw badRequest(
        'CLASSIFIER_CYCLE',
        'нельзя переместить узел каталога в один из его собственных вложенных узлов',
      );
    }
  }

  const after = await client.query(
    `UPDATE classifiers SET
       name      = COALESCE($2, name),
       parent_id = CASE WHEN $3::boolean THEN $4::bigint ELSE parent_id END
     WHERE id = $1 RETURNING *`,
    [classifierId, patch.name ?? null, patch.parentId !== undefined, patch.parentId ?? null],
  );
  await auditUpdate(client, actor, 'classifier', classifierId, before.rows[0], after.rows[0]);
  return after.rows[0];
}

export async function deleteClassifier(client: Client, actor: Actor, classifierId: number): Promise<void> {
  assertAdmin(actor);
  const before = await client.query('SELECT * FROM classifiers WHERE id = $1', [classifierId]);
  if (before.rowCount === 0) throw notFound('классификатор не существует');

  const children = await client.query('SELECT 1 FROM classifiers WHERE parent_id = $1', [classifierId]);
  if ((children.rowCount ?? 0) > 0) {
    throw conflict('CLASSIFIER_HAS_CHILDREN', 'нельзя удалить узел каталога, у которого есть дочерние узлы');
  }

  await client.query('DELETE FROM staff_classifier_scope WHERE classifier_id = $1', [classifierId]);
  await client.query('DELETE FROM location_classifiers WHERE classifier_id = $1', [classifierId]);
  await client.query('DELETE FROM machine_classifiers WHERE classifier_id = $1', [classifierId]);
  await client.query('DELETE FROM classifiers WHERE id = $1', [classifierId]);
  await auditDelete(client, actor, 'classifier', classifierId, before.rows[0]);
}

export async function addLocationToClassifier(
  client: Client,
  actor: Actor,
  classifierId: number,
  locationId: number,
): Promise<void> {
  assertAdmin(actor);
  const inserted = await client.query(
    `INSERT INTO location_classifiers (location_id, classifier_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING *`,
    [locationId, classifierId],
  );
  if (inserted.rowCount) {
    await auditInsert(client, actor, 'location_classifier', `${locationId}:${classifierId}`, inserted.rows[0]);
  }
}

export async function removeLocationFromClassifier(
  client: Client,
  actor: Actor,
  classifierId: number,
  locationId: number,
): Promise<void> {
  assertAdmin(actor);
  const removed = await client.query(
    'DELETE FROM location_classifiers WHERE location_id = $1 AND classifier_id = $2 RETURNING *',
    [locationId, classifierId],
  );
  if (removed.rowCount) {
    await auditDelete(client, actor, 'location_classifier', `${locationId}:${classifierId}`, removed.rows[0]);
  }
}

export async function addMachineToClassifier(
  client: Client,
  actor: Actor,
  classifierId: number,
  machineNumber: string,
): Promise<void> {
  assertAdmin(actor);
  const inserted = await client.query(
    `INSERT INTO machine_classifiers (machine_number, classifier_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING *`,
    [machineNumber, classifierId],
  );
  if (inserted.rowCount) {
    await auditInsert(client, actor, 'machine_classifier', `${machineNumber}:${classifierId}`, inserted.rows[0]);
  }
}

export async function removeMachineFromClassifier(
  client: Client,
  actor: Actor,
  classifierId: number,
  machineNumber: string,
): Promise<void> {
  assertAdmin(actor);
  const removed = await client.query(
    'DELETE FROM machine_classifiers WHERE machine_number = $1 AND classifier_id = $2 RETURNING *',
    [machineNumber, classifierId],
  );
  if (removed.rowCount) {
    await auditDelete(client, actor, 'machine_classifier', `${machineNumber}:${classifierId}`, removed.rows[0]);
  }
}

export async function grantClassifierScope(
  client: Client,
  actor: Actor,
  staffId: number,
  classifierId: number,
): Promise<void> {
  assertAdmin(actor);
  const inserted = await client.query(
    `INSERT INTO staff_classifier_scope (staff_id, classifier_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING *`,
    [staffId, classifierId],
  );
  if (inserted.rowCount) {
    await auditInsert(client, actor, 'staff_classifier_scope', `${staffId}:${classifierId}`, inserted.rows[0]);
  }
}

export async function revokeClassifierScope(
  client: Client,
  actor: Actor,
  staffId: number,
  classifierId: number,
): Promise<void> {
  assertAdmin(actor);
  const removed = await client.query(
    'DELETE FROM staff_classifier_scope WHERE staff_id = $1 AND classifier_id = $2 RETURNING *',
    [staffId, classifierId],
  );
  if (removed.rowCount) {
    await auditDelete(client, actor, 'staff_classifier_scope', `${staffId}:${classifierId}`, removed.rows[0]);
  }
}
