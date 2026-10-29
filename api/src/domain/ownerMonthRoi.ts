import type { Client } from '../db/pool.js';

/**
 * ROI аппарата за последние три обслуживания на конец месяца — столбец детализации месячного
 * отчёта владельца. Формула та же, что у хранимого ROI (DECISION-012): выручка обслуживания к
 * игрушкам предыдущего обслуживания размещения, а для первого — к начальным игрушкам. Разница в
 * том, что числитель и знаменатель суммируются по трём обслуживаниям: мягкие игрушки докладывают на
 * глаз, и перебор одного раза гасится недобором следующего, поэтому сумма по трём обслуживаниям
 * намного ближе к настоящей доходности аппарата, чем одно обслуживание.
 *
 * Если в месяце обслуживаний меньше трёх, недостающие берутся из предыдущих месяцев. null — база
 * нулевая или её нет («нет данных», как у хранимого ROI).
 */
export const ROI_SERVICES = 3;

export async function lastServicesRoi(
  client: Client,
  machineNumbers: string[],
  monthLastDate: string,
): Promise<Map<string, string | null>> {
  if (machineNumbers.length === 0) return new Map();
  const result = await client.query(
    `WITH chain AS (
       SELECT s.machine_number, s.service_date, s.occurred_at, s.id, s.revenue,
              COALESCE(
                LAG(s.toy_cost) OVER (PARTITION BY s.placement_id ORDER BY s.occurred_at, s.id),
                (SELECT SUM(pit.quantity * pit.unit_cost_snapshot)
                 FROM placement_initial_toys pit WHERE pit.placement_id = s.placement_id)
              ) AS cost_basis
       FROM services s
       WHERE s.machine_number = ANY($1::text[])
     ),
     last AS (
       SELECT machine_number, revenue, cost_basis,
              row_number() OVER (PARTITION BY machine_number ORDER BY occurred_at DESC, id DESC) AS k
       FROM chain
       WHERE service_date <= $2::date
     )
     SELECT machine_number,
            -- Обслуживание без базы (первое в размещении, начальных игрушек не вносили) ничего не
            -- говорит об игрушках: его выручку не берём, иначе она легла бы в числитель без знаменателя.
            CASE WHEN COALESCE(SUM(cost_basis), 0) = 0 THEN NULL
                 ELSE ROUND(SUM(revenue) FILTER (WHERE cost_basis IS NOT NULL) / SUM(cost_basis), 2) END AS roi
     FROM last
     WHERE k <= $3
     GROUP BY machine_number`,
    [machineNumbers, monthLastDate, ROI_SERVICES],
  );
  return new Map(
    result.rows.map((row) => [String(row.machine_number), row.roi === null ? null : String(row.roi)]),
  );
}
