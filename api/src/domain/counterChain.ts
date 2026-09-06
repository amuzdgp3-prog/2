import type { Client } from '../db/pool.js';
import { auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';

/**
 * Counter chain (10_ТЗ §7 §22.2, extended by DECISION-001 counter divisor):
 *
 *   growth             = current_game_counter - previous_game_counter
 *   games_from_counter = growth / counter_divisor
 *   new_games          = games_from_counter - test_games
 *   new_prizes         = current_prize_counter - previous_prize_counter
 *   revenue            = new_games * price_per_game_snapshot
 *
 * The previous counters come from the preceding Service of the same Placement, or from the
 * Placement initial counters for the first Service. Counters of different Placements are never
 * compared. All arithmetic is done by PostgreSQL in exact NUMERIC, never in JS floats.
 *
 * The whole chain of one machine is recomputed in a single statement using LAG(), so a Service
 * inserted, edited or deleted in the middle of the history repairs every dependent row.
 */
const CHAIN_CTES = `
  WITH chain AS (
    SELECT
      s.id,
      s.placement_id,
      s.occurred_at,
      s.game_counter,
      s.prize_counter,
      s.test_games,
      s.price_per_game_snapshot,
      -- The divisor is a snapshot taken when the service was recorded, exactly like the price.
      -- A later change of the machine setting must not rewrite past revenue.
      CASE WHEN s.counter_divisor_applied IS NULL OR s.counter_divisor_applied <= 0
           THEN 1.00::numeric ELSE s.counter_divisor_applied END AS counter_divisor,
      COALESCE(LAG(s.game_counter) OVER w, p.initial_game_counter)   AS prev_game_counter,
      COALESCE(LAG(s.prize_counter) OVER w, p.initial_prize_counter) AS prev_prize_counter,
      COALESCE(LAG(s.occurred_at) OVER w, p.started_at)              AS period_start
    FROM services s
    JOIN machine_placements p ON p.id = s.placement_id
    WHERE s.machine_number = $1
    WINDOW w AS (PARTITION BY s.placement_id ORDER BY s.occurred_at, s.id)
  ),
  raw AS (
    SELECT
      c.*,
      (c.game_counter - c.prev_game_counter)   AS growth,
      -- Rounded to the stored scale first, so revenue is always exactly
      -- ROUND(stored new_games * price, 2) and the saved numbers reconcile.
      ROUND(((c.game_counter - c.prev_game_counter)::numeric / c.counter_divisor) - c.test_games, 4)
                                               AS new_games
    FROM chain c
  ),
  priced AS (
    SELECT
      r.id,
      r.placement_id,
      r.occurred_at,
      r.period_start,
      r.growth,
      r.counter_divisor,
      r.new_games,
      (r.prize_counter - r.prev_prize_counter)                 AS new_prizes,
      ROUND(r.new_games * r.price_per_game_snapshot, 2)        AS revenue,
      COALESCE((
        SELECT SUM(td.quantity * td.unit_cost_snapshot)
        FROM toy_distributions td WHERE td.service_id = r.id
      ), 0)                                                    AS toy_cost,
      COALESCE((
        -- Half-open Service period: previous timestamp <= occurred_at < current (10_ТЗ §12).
        SELECT SUM(t.amount)
        FROM cashless_transactions t
        WHERE t.matched_machine_number = $1
          AND t.match_status = 'MATCHED'
          AND t.occurred_at >= r.period_start
          AND t.occurred_at <  r.occurred_at
      ), 0)                                                    AS cashless_amount
    FROM raw r
  ),
  computed AS (
    SELECT
      w.*,
      -- «Отношение выручка / себестоимость» (10_ТЗ §10): выручка текущего обслуживания к
      -- себестоимости игрушек предыдущего; для первого обслуживания Placement — к стоимости
      -- его начальных игрушек. Нет базы или ноль — NULL, то есть «нет данных».
      CASE
        WHEN w.cost_basis IS NULL OR w.cost_basis = 0 THEN NULL
        ELSE ROUND(w.revenue / w.cost_basis, 4)
      END AS revenue_to_cost_ratio
    FROM (
      SELECT
        p.*,
        COALESCE(
          LAG(p.toy_cost) OVER (PARTITION BY p.placement_id ORDER BY p.occurred_at, p.id),
          (SELECT SUM(pit.quantity * pit.unit_cost_snapshot)
           FROM placement_initial_toys pit
           WHERE pit.placement_id = p.placement_id)
        ) AS cost_basis
      FROM priced p
    ) w
  )
`;

export interface ChainRow {
  id: number;
  placement_id: number;
  occurred_at: Date;
  period_start: Date;
  growth: string;
  counter_divisor: string;
  new_games: string;
  new_prizes: string;
  revenue: string;
  toy_cost: string;
  cashless_amount: string;
  cost_basis: string | null;
  revenue_to_cost_ratio: string | null;
}

export async function previewMachineChain(
  client: Client,
  machineNumber: string,
): Promise<ChainRow[]> {
  const result = await client.query<ChainRow>(
    `${CHAIN_CTES} SELECT * FROM computed ORDER BY occurred_at, id`,
    [machineNumber],
  );
  return result.rows;
}

/**
 * Recalculates every Service of one machine and audits the rows whose values changed.
 * The caller must already hold the machine lock and be inside the business transaction.
 */
export async function recalcMachineChain(
  client: Client,
  machineNumber: string,
  actor: Actor,
  reason: string,
): Promise<{ recalculated: number; changed: number }> {
  const computed = await previewMachineChain(client, machineNumber);

  // Negative new_games means the reading, the test games or the divisor are inconsistent;
  // the whole business operation is rejected rather than silently clamped (12_CONTRACT F3).
  const negative = computed.filter((row) => Number(row.new_games) < 0);
  if (negative.length > 0) {
    throw badRequest(
      'NEGATIVE_NEW_GAMES',
      'расчёт даёт отрицательное количество новых игр: проверьте показания и тестовые игры',
      negative.map((row) => ({
        serviceId: row.id,
        growth: row.growth,
        counterDivisor: row.counter_divisor,
        newGames: row.new_games,
      })),
    );
  }

  const before = await client.query(
    `SELECT id, new_games, new_prizes, revenue, toy_cost, cashless_amount,
            cash_amount, is_financial_anomaly, counter_divisor_applied, revenue_to_cost_ratio
     FROM services WHERE machine_number = $1`,
    [machineNumber],
  );
  const beforeById = new Map<number, Record<string, unknown>>(
    before.rows.map((row) => [row.id as number, row]),
  );

  const updated = await client.query(
    `${CHAIN_CTES}
     UPDATE services s
     SET new_games               = computed.new_games,
         new_prizes              = computed.new_prizes,
         revenue                 = computed.revenue,
         toy_cost                = computed.toy_cost,
         cashless_amount         = computed.cashless_amount,
         counter_divisor_applied = computed.counter_divisor,
         revenue_to_cost_ratio   = computed.revenue_to_cost_ratio
     FROM computed
     WHERE s.id = computed.id
     RETURNING s.id, s.new_games, s.new_prizes, s.revenue, s.toy_cost, s.cashless_amount,
               s.cash_amount, s.is_financial_anomaly, s.counter_divisor_applied,
               s.revenue_to_cost_ratio`,
    [machineNumber],
  );

  let changed = 0;
  const trackedFields = [
    'new_games',
    'new_prizes',
    'revenue',
    'toy_cost',
    'cashless_amount',
    'counter_divisor_applied',
    'revenue_to_cost_ratio',
  ] as const;

  for (const row of updated.rows) {
    const old = beforeById.get(row.id as number);
    if (!old) continue;
    const differs = trackedFields.some((field) => String(old[field]) !== String(row[field]));
    if (!differs) continue;
    changed += 1;
    await auditUpdate(client, actor, 'service', row.id as number, old, row, { reason });
  }

  return { recalculated: updated.rowCount ?? 0, changed };
}
