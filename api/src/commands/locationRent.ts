import type { Client } from '../db/pool.js';
import { auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertAdmin } from '../lib/scope.js';

export interface SetLocationRentInput {
  monthlyAmount: string;
  /** ISO timestamp — по умолчанию «сейчас». Прошлое не трогается: текущий открытый период
   * закрывается этой датой, новый открывается с неё же (см. terminal_bindings). */
  effectiveFrom?: string;
}

/** Аренда — ставка за точку (адрес), не за конкретный аппарат: замена аппарата на том же месте
 * наследует уже действующую ставку автоматически. Правка не переписывает историю — закрывает
 * текущий период и открывает новый, так же как rebind терминала в commands/terminals.ts. */
export async function setLocationRent(
  client: Client,
  actor: Actor,
  locationId: number,
  input: SetLocationRentInput,
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  if (!(Number(input.monthlyAmount) >= 0)) {
    throw badRequest('INVALID_AMOUNT', 'сумма аренды не может быть отрицательной');
  }
  const location = await client.query('SELECT 1 FROM locations WHERE id = $1', [locationId]);
  if (location.rowCount === 0) throw notFound('точка не найдена');

  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString();

  const previous = await client.query(
    `UPDATE location_rent_periods SET ended_at = $2
     WHERE location_id = $1 AND ended_at IS NULL RETURNING *`,
    [locationId, effectiveFrom],
  );
  for (const row of previous.rows) {
    await auditUpdate(client, actor, 'location_rent_period', row.id, { ...row, ended_at: null }, row, {
      reason: 'rate_changed',
    });
  }

  const inserted = await client.query(
    `INSERT INTO location_rent_periods (location_id, monthly_amount, started_at, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [locationId, input.monthlyAmount, effectiveFrom, actor.id],
  );
  await auditInsert(client, actor, 'location_rent_period', inserted.rows[0].id, inserted.rows[0]);
  return inserted.rows[0];
}

export async function getLocationRentHistory(
  client: Client,
  locationId: number,
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(
    `SELECT * FROM location_rent_periods WHERE location_id = $1 ORDER BY started_at DESC`,
    [locationId],
  );
  return result.rows;
}
