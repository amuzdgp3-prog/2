import type { Client } from '../db/pool.js';
import { auditDelete, auditInsert, type Actor } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { assertAdmin } from '../lib/scope.js';

/**
 * A classifier is a plain tag on Location, independent of the parent_id tree: the same address
 * can carry several at once (e.g. a geographic one like "СПб Юг" and an unrelated venue-type one
 * like "Торговые центры" that spans both Север and Юг). See lib/scope.ts's own comment on why
 * this exists alongside — not instead of — the location subtree grant.
 */
export async function createClassifier(
  client: Client,
  actor: Actor,
  name: string,
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  const existing = await client.query('SELECT 1 FROM classifiers WHERE name = $1', [name]);
  if ((existing.rowCount ?? 0) > 0) {
    throw conflict('CLASSIFIER_EXISTS', 'классификатор с таким названием уже есть');
  }
  const inserted = await client.query(
    'INSERT INTO classifiers (name) VALUES ($1) RETURNING *',
    [name],
  );
  await auditInsert(client, actor, 'classifier', inserted.rows[0].id, inserted.rows[0]);
  return inserted.rows[0];
}

export async function deleteClassifier(client: Client, actor: Actor, classifierId: number): Promise<void> {
  assertAdmin(actor);
  const before = await client.query('SELECT * FROM classifiers WHERE id = $1', [classifierId]);
  if (before.rowCount === 0) throw notFound('классификатор не существует');

  await client.query('DELETE FROM staff_classifier_scope WHERE classifier_id = $1', [classifierId]);
  await client.query('DELETE FROM location_classifiers WHERE classifier_id = $1', [classifierId]);
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
