import type { Client } from '../db/pool.js';

export type Role = 'ADMIN' | 'TECHNICIAN' | 'BOSS';

export interface Actor {
  id: number | null;
  login: string;
  role: Role;
}

export const SYSTEM_ACTOR: Actor = { id: null, login: 'system', role: 'ADMIN' };

type Row = Record<string, unknown>;

/**
 * Audit runs inside the same transaction as the mutation and the recalculation
 * (10_ТЗ §17, 11_АРХИТЕКТУРА §16). Callers must pass rows produced by RETURNING,
 * not the request payload, so the log records what the database actually stored.
 */
async function writeAudit(
  client: Client,
  actor: Actor,
  action: 'INSERT' | 'UPDATE' | 'DELETE',
  entity: string,
  entityId: string | number,
  oldData: Row | null,
  newData: Row | null,
  context?: Row,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_id, actor_login, entity, entity_id, action, old_data, new_data, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      actor.id,
      actor.login,
      entity,
      String(entityId),
      action,
      oldData ? JSON.stringify(oldData) : null,
      newData ? JSON.stringify(newData) : null,
      context ? JSON.stringify(context) : null,
    ],
  );
}

export const auditInsert = (
  client: Client,
  actor: Actor,
  entity: string,
  entityId: string | number,
  newRow: Row,
  context?: Row,
) => writeAudit(client, actor, 'INSERT', entity, entityId, null, newRow, context);

export const auditUpdate = (
  client: Client,
  actor: Actor,
  entity: string,
  entityId: string | number,
  oldRow: Row,
  newRow: Row,
  context?: Row,
) => writeAudit(client, actor, 'UPDATE', entity, entityId, oldRow, newRow, context);

export const auditDelete = (
  client: Client,
  actor: Actor,
  entity: string,
  entityId: string | number,
  oldRow: Row,
  context?: Row,
) => writeAudit(client, actor, 'DELETE', entity, entityId, oldRow, null, context);
