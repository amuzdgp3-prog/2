import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { machineScopePredicate } from '../lib/scope.js';

export interface ReportFilters {
  from?: string;
  to?: string;
  locationId?: number;
  machineNumber?: string;
  machineType?: string;
  technicianId?: number;
  routeId?: number;
  limit?: number;
  offset?: number;
}

export interface MachineRow {
  locationId: number;
  locationName: string;
  machineNumber: string;
  machineType: string;
  placementId: number;
  counterDivisor: string;
  services: number;
  newGames: string;
  newPrizes: number;
  revenue: string;
  cashless: string;
  cash: string;
  toyCost: string;
  anomalies: number;
  /**
   * «Отношение выручка / себестоимость» последнего обслуживания в выборке. Нормативно метрика
   * определена для одного обслуживания (10_ТЗ §10), а способ её агрегации за период документами
   * не задан, поэтому в строке аппарата показывается последнее значение, а не выдуманная сумма
   * отношений. `null` означает «нет данных».
   */
  lastRevenueToCostRatio: string | null;
}

export interface LocationTotal {
  locationId: number;
  locationName: string;
  services: number;
  newGames: string;
  revenue: string;
  cashless: string;
  cash: string;
  toyCost: string;
  machines: MachineRow[];
}

/** Exact decimal addition over NUMERIC strings, without touching floats. */
export function sumDecimal(values: Array<string | number>, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  let total = 0n;
  for (const value of values) {
    const text = String(value ?? '0');
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
    const scaled =
      BigInt(whole || '0') * scale +
      BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
    total += negative ? -scaled : scaled;
  }
  const negative = total < 0n;
  const absolute = negative ? -total : total;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * The single calculation/query layer behind reports, dashboard and export
 * (10_ТЗ §25, 12_CONTRACT F1). No caller implements its own financial formula, so all three
 * surfaces necessarily return the same numbers for the same filters.
 *
 * Business dates come from services.service_date, which is already resolved in the
 * Location timezone at write time, so period filters are business-time filters.
 */
export async function queryMachineRows(
  client: Client,
  actor: Actor,
  filters: ReportFilters,
): Promise<MachineRow[]> {
  const params: unknown[] = [];
  const conditions: string[] = [];

  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.from) conditions.push(`s.service_date >= ${push(filters.from)}::date`);
  if (filters.to) conditions.push(`s.service_date <= ${push(filters.to)}::date`);
  if (filters.machineNumber) conditions.push(`s.machine_number = ${push(filters.machineNumber)}`);
  if (filters.machineType) conditions.push(`m.machine_type = ${push(filters.machineType)}`);
  if (filters.technicianId) conditions.push(`s.technician_id = ${push(filters.technicianId)}`);
  if (filters.routeId) {
    conditions.push(
      `EXISTS (SELECT 1 FROM machine_routes mr
               WHERE mr.machine_number = s.machine_number AND mr.route_id = ${push(filters.routeId)})`,
    );
  }
  if (filters.locationId) {
    // Location filter includes the whole subtree (city/region rollup).
    conditions.push(`p.location_id IN (
      WITH RECURSIVE subtree AS (
        SELECT id FROM locations WHERE id = ${push(filters.locationId)}
        UNION
        SELECT child.id FROM locations child JOIN subtree ON child.parent_id = subtree.id
      ) SELECT id FROM subtree)`);
  }

  const scope = machineScopePredicate(actor, 's.machine_number', params.length + 1);
  params.push(...scope.params);
  conditions.push(scope.sql);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filters.limit ?? 500, 1), 2000);
  const offset = Math.max(filters.offset ?? 0, 0);

  const result = await client.query(
    `SELECT l.id                                    AS location_id,
            l.name                                  AS location_name,
            s.machine_number,
            m.machine_type,
            m.counter_divisor,
            p.id                                    AS placement_id,
            COUNT(*)::int                           AS services,
            SUM(s.new_games)                        AS new_games,
            SUM(s.new_prizes)::bigint               AS new_prizes,
            SUM(s.revenue)                          AS revenue,
            SUM(s.cashless_amount)                  AS cashless,
            SUM(s.cash_amount)                      AS cash,
            SUM(s.toy_cost)                         AS toy_cost,
            COUNT(*) FILTER (WHERE s.is_financial_anomaly)::int AS anomalies,
            (array_agg(s.revenue_to_cost_ratio ORDER BY s.occurred_at DESC, s.id DESC))[1]
                                                    AS last_revenue_to_cost_ratio
     FROM services s
     JOIN machine_placements p ON p.id = s.placement_id
     JOIN machines m ON m.machine_number = s.machine_number
     JOIN locations l ON l.id = p.location_id
     ${where}
     GROUP BY l.id, l.name, s.machine_number, m.machine_type, m.counter_divisor, p.id
     ORDER BY l.name, s.machine_number, p.id
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  return result.rows.map((row) => ({
    locationId: Number(row.location_id),
    locationName: row.location_name,
    machineNumber: row.machine_number,
    machineType: row.machine_type,
    placementId: Number(row.placement_id),
    counterDivisor: String(row.counter_divisor),
    services: row.services,
    newGames: String(row.new_games ?? '0'),
    newPrizes: Number(row.new_prizes ?? 0),
    revenue: String(row.revenue ?? '0'),
    cashless: String(row.cashless ?? '0'),
    cash: String(row.cash ?? '0'),
    toyCost: String(row.toy_cost ?? '0'),
    anomalies: row.anomalies,
    lastRevenueToCostRatio:
      row.last_revenue_to_cost_ratio === null || row.last_revenue_to_cost_ratio === undefined
        ? null
        : String(row.last_revenue_to_cost_ratio),
  }));
}

/** Location is the primary financial row; its total is by construction the sum of machine rows. */
export function aggregateByLocation(rows: MachineRow[]): LocationTotal[] {
  const byLocation = new Map<number, MachineRow[]>();
  for (const row of rows) {
    const bucket = byLocation.get(row.locationId) ?? [];
    bucket.push(row);
    byLocation.set(row.locationId, bucket);
  }

  return [...byLocation.entries()]
    .map(([locationId, machines]) => ({
      locationId,
      locationName: machines[0].locationName,
      services: machines.reduce((total, row) => total + row.services, 0),
      newGames: sumDecimal(machines.map((row) => row.newGames), 4),
      revenue: sumDecimal(machines.map((row) => row.revenue), 2),
      cashless: sumDecimal(machines.map((row) => row.cashless), 2),
      cash: sumDecimal(machines.map((row) => row.cash), 2),
      toyCost: sumDecimal(machines.map((row) => row.toyCost), 2),
      machines,
    }))
    .sort((left, right) => left.locationName.localeCompare(right.locationName));
}

export interface MonthlyRow {
  monthStart: string;
  services: number;
  newGames: string;
  revenue: string;
  toyCost: string;
  profit: string;
  /** Агрегированный ROI месяца = выручка/себестоимость ЗА МЕСЯЦ, а не среднее по обслуживаниям
   * (см. DECISION-020) — иначе несколько обслуживаний с нулевой себестоимостью исказили бы среднее. */
  roi: string | null;
}

/**
 * Финансовый отчёт по месяцам (docs/design/mockups/08_admin_financial_report.html) — тот же
 * единый расчётный слой: те же строки services, тот же scope, только другая группировка.
 */
export async function monthlyReport(
  client: Client,
  actor: Actor,
  filters: Pick<ReportFilters, 'locationId'> & { months?: number },
): Promise<MonthlyRow[]> {
  const params: unknown[] = [];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const conditions: string[] = [
    `s.service_date >= date_trunc('month', now()) - (${push(filters.months ?? 6)}::int - 1) * interval '1 month'`,
  ];
  if (filters.locationId) {
    conditions.push(`p.location_id IN (
      WITH RECURSIVE subtree AS (
        SELECT id FROM locations WHERE id = ${push(filters.locationId)}
        UNION
        SELECT child.id FROM locations child JOIN subtree ON child.parent_id = subtree.id
      ) SELECT id FROM subtree)`);
  }
  const scope = machineScopePredicate(actor, 's.machine_number', params.length + 1);
  params.push(...scope.params);
  conditions.push(scope.sql);

  const result = await client.query(
    `SELECT date_trunc('month', s.service_date)::date AS month_start,
            COUNT(*)::int AS services,
            SUM(s.new_games)  AS new_games,
            SUM(s.revenue)    AS revenue,
            SUM(s.toy_cost)   AS toy_cost
     FROM services s
     JOIN machine_placements p ON p.id = s.placement_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY 1
     ORDER BY 1`,
    params,
  );

  return result.rows.map((row) => {
    const revenue = String(row.revenue ?? '0');
    const toyCost = String(row.toy_cost ?? '0');
    const toyCostNumber = Number(toyCost);
    return {
      monthStart: row.month_start,
      services: row.services,
      newGames: String(row.new_games ?? '0'),
      revenue,
      toyCost,
      profit: sumDecimal([revenue, `-${toyCost}`], 2),
      roi: toyCostNumber > 0 ? (Number(revenue) / toyCostNumber).toFixed(2) : null,
    };
  });
}

export async function technicianReport(
  client: Client,
  actor: Actor,
  filters: ReportFilters,
): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = [];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const conditions: string[] = ['s.technician_id IS NOT NULL'];
  if (filters.from) conditions.push(`s.service_date >= ${push(filters.from)}::date`);
  if (filters.to) conditions.push(`s.service_date <= ${push(filters.to)}::date`);
  const scope = machineScopePredicate(actor, 's.machine_number', params.length + 1);
  params.push(...scope.params);
  conditions.push(scope.sql);

  const result = await client.query(
    `SELECT st.id, st.full_name, COUNT(*)::int AS services,
            SUM(s.new_games) AS new_games, SUM(s.revenue) AS revenue,
            SUM(s.cash_amount) AS cash, SUM(s.cashless_amount) AS cashless,
            SUM(s.toy_cost) AS toy_cost
     FROM services s
     JOIN staff st ON st.id = s.technician_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY st.id, st.full_name
     ORDER BY st.full_name`,
    params,
  );
  return result.rows;
}

export function toCsv(rows: MachineRow[]): string {
  const header = [
    'location_id',
    'location',
    'machine_number',
    'machine_type',
    'counter_divisor',
    'services',
    'new_games',
    'new_prizes',
    'revenue',
    'cashless',
    'cash',
    'toy_cost',
    'anomalies',
    'revenue_to_cost_ratio',
  ];
  const lines = rows.map((row) =>
    [
      row.locationId,
      `"${row.locationName.replaceAll('"', '""')}"`,
      row.machineNumber,
      row.machineType,
      row.counterDivisor,
      row.services,
      row.newGames,
      row.newPrizes,
      row.revenue,
      row.cashless,
      row.cash,
      row.toyCost,
      row.anomalies,
      // «нет данных» is exported literally, never as a misleading zero.
      row.lastRevenueToCostRatio ?? 'нет данных',
    ].join(','),
  );
  return [header.join(','), ...lines].join('\n');
}
