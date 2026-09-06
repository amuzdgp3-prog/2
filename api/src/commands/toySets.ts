import type { Client } from '../db/pool.js';
import { auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertAdmin } from '../lib/scope.js';

export interface ToySetItemInput {
  toyId: number;
  quantity: number;
}

async function replaceItems(
  client: Client,
  actor: Actor,
  setId: number,
  items: ToySetItemInput[],
): Promise<void> {
  await client.query('DELETE FROM toy_set_items WHERE set_id = $1', [setId]);
  for (const item of items) {
    if (item.quantity <= 0) continue;
    const inserted = await client.query(
      `INSERT INTO toy_set_items (set_id, toy_id, quantity)
       SELECT $1, t.id, $3 FROM toys t WHERE t.id = $2
       RETURNING *`,
      [setId, item.toyId, item.quantity],
    );
    if (inserted.rowCount === 0) throw notFound(`игрушка №${item.toyId} не существует`);
  }
  await auditInsert(client, actor, 'toy_set_items', setId, { items });
}

export async function createToySet(
  client: Client,
  actor: Actor,
  input: { name: string; items: ToySetItemInput[] },
): Promise<{ id: number; name: string }> {
  assertAdmin(actor);
  if (!input.name.trim()) throw badRequest('NAME_REQUIRED', 'название набора не может быть пустым');

  const inserted = await client.query(
    'INSERT INTO toy_sets (name) VALUES ($1) RETURNING *',
    [input.name],
  );
  await auditInsert(client, actor, 'toy_set', inserted.rows[0].id, inserted.rows[0]);
  await replaceItems(client, actor, inserted.rows[0].id, input.items);
  return inserted.rows[0];
}

export async function updateToySet(
  client: Client,
  actor: Actor,
  setId: number,
  input: { name?: string; items?: ToySetItemInput[] },
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  const before = await client.query('SELECT * FROM toy_sets WHERE id = $1', [setId]);
  if (before.rowCount === 0) throw notFound('набор игрушек не существует');

  const after = await client.query(
    'UPDATE toy_sets SET name = COALESCE($2, name) WHERE id = $1 RETURNING *',
    [setId, input.name ?? null],
  );
  await auditUpdate(client, actor, 'toy_set', setId, before.rows[0], after.rows[0]);

  if (input.items) await replaceItems(client, actor, setId, input.items);
  return after.rows[0];
}

/**
 * Назначает набор одному аппарату — это только подсказка для формы обслуживания
 * (что предложить технику по умолчанию), а не ограничение на реальный расход игрушек.
 */
export async function assignToySetToMachine(
  client: Client,
  actor: Actor,
  machineNumber: string,
  setId: number | null,
): Promise<void> {
  assertAdmin(actor);
  const before = await client.query('SELECT machine_number, default_toy_set_id FROM machines WHERE machine_number = $1', [
    machineNumber,
  ]);
  if (before.rowCount === 0) throw notFound('аппарат не существует');

  if (setId !== null) {
    const set = await client.query('SELECT 1 FROM toy_sets WHERE id = $1', [setId]);
    if (set.rowCount === 0) throw notFound('набор игрушек не существует');
  }

  const after = await client.query(
    'UPDATE machines SET default_toy_set_id = $2 WHERE machine_number = $1 RETURNING machine_number, default_toy_set_id',
    [machineNumber, setId],
  );
  await auditUpdate(client, actor, 'machine', machineNumber, before.rows[0], after.rows[0], {
    reason: 'default_toy_set_changed',
  });
}

export interface BulkApplyFilter {
  machineType?: string;
  routeId?: number;
  locationId?: number;
  machineNumbers?: string[];
}

/**
 * Массовое назначение набора: по типу аппарата, по маршруту, по точке (с поддеревом) или по
 * явному списку номеров — как минимум один признак обязателен, иначе это назначило бы набор
 * вообще всем аппаратам без разбора, что почти наверняка не то, что имел в виду администратор.
 */
export async function applyToySetInBulk(
  client: Client,
  actor: Actor,
  setId: number,
  filter: BulkApplyFilter,
): Promise<{ updated: number }> {
  assertAdmin(actor);

  const set = await client.query('SELECT 1 FROM toy_sets WHERE id = $1', [setId]);
  if (set.rowCount === 0) throw notFound('набор игрушек не существует');

  const hasFilter =
    filter.machineType || filter.routeId || filter.locationId || (filter.machineNumbers?.length ?? 0) > 0;
  if (!hasFilter) {
    throw badRequest(
      'FILTER_REQUIRED',
      'нужно указать тип, маршрут, точку или список аппаратов — массовое назначение без фильтра запрещено',
    );
  }

  // The filter params are numbered from their own array, separate from setId: a query that binds
  // a parameter it never references in its SQL text fails with "could not determine data type",
  // and the SELECT below never mentions setId at all.
  const params: unknown[] = [];
  const push = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions: string[] = [];

  if (filter.machineType) conditions.push(`m.machine_type = ${push(filter.machineType)}`);
  if (filter.machineNumbers?.length) {
    conditions.push(`m.machine_number = ANY(${push(filter.machineNumbers)}::text[])`);
  }
  if (filter.routeId) {
    conditions.push(
      `EXISTS (SELECT 1 FROM machine_routes mr WHERE mr.machine_number = m.machine_number AND mr.route_id = ${push(filter.routeId)})`,
    );
  }
  if (filter.locationId) {
    conditions.push(`EXISTS (
      SELECT 1 FROM machine_placements p
      WHERE p.machine_number = m.machine_number AND p.ended_at IS NULL AND p.location_id IN (
        WITH RECURSIVE subtree AS (
          SELECT id FROM locations WHERE id = ${push(filter.locationId)}
          UNION
          SELECT child.id FROM locations child JOIN subtree ON child.parent_id = subtree.id
        ) SELECT id FROM subtree
      ))`,
    );
  }

  const before = await client.query(
    `SELECT machine_number, default_toy_set_id FROM machines m WHERE ${conditions.join(' AND ')}`,
    params,
  );

  const after = await client.query(
    `UPDATE machines m SET default_toy_set_id = $${params.length + 1}
     WHERE ${conditions.join(' AND ')}
     RETURNING machine_number, default_toy_set_id`,
    [...params, setId],
  );

  const beforeByMachine = new Map(before.rows.map((row) => [row.machine_number, row]));
  for (const row of after.rows) {
    await auditUpdate(
      client,
      actor,
      'machine',
      row.machine_number,
      beforeByMachine.get(row.machine_number) ?? {},
      row,
      { reason: 'default_toy_set_bulk_applied', filter },
    );
  }

  return { updated: after.rowCount ?? 0 };
}
