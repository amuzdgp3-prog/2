import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { machineScopePredicate } from '../lib/scope.js';

export interface ReportFilters {
  from?: string;
  to?: string;
  locationId?: number;
  classifierId?: number;
  machineNumber?: string;
  machineType?: string;
  technicianId?: number;
  routeId?: number;
  limit?: number;
  offset?: number;
}

/**
 * A machine-set filter by Каталог node, mirroring lib/scope.ts's classifier resolution but
 * without any staff grant involved — every machine tagged anywhere in the node's subtree, either
 * directly or via the address it's currently placed at.
 */
function classifierMachineFilterSql(classifierId: number, push: (value: unknown) => string): string {
  return `s.machine_number IN (
    WITH RECURSIVE classifier_tree AS (
      SELECT id FROM classifiers WHERE id = ${push(classifierId)}
      UNION
      SELECT child.id FROM classifiers child JOIN classifier_tree parent ON child.parent_id = parent.id
    )
    SELECT p2.machine_number FROM machine_placements p2
    WHERE p2.ended_at IS NULL AND p2.location_id IN (
      SELECT lc.location_id FROM location_classifiers lc WHERE lc.classifier_id IN (SELECT id FROM classifier_tree)
    )
    UNION
    SELECT mc.machine_number FROM machine_classifiers mc WHERE mc.classifier_id IN (SELECT id FROM classifier_tree)
  )`;
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
 * Exact decimal division over 2-decimal money strings (revenue / toyCost), rounded half away
 * from zero — DECISION-004 requires all financial arithmetic to stay in exact decimal, never a
 * JS float, and `Number(a) / Number(b)` breaks that for aggregated totals large enough to strain
 * a double's mantissa. The operands' own 2-decimal scale cancels out of the ratio, so only the
 * requested output `decimals` need rounding.
 */
export function divideDecimal(
  numerator: string | number,
  denominator: string | number,
  decimals: number,
): string {
  const parseMoney = (value: string | number): bigint => {
    const text = String(value ?? '0');
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
    const scaled = BigInt(whole || '0') * 100n + BigInt((fraction + '00').slice(0, 2) || '0');
    return negative ? -scaled : scaled;
  };
  const num = parseMoney(numerator);
  const den = parseMoney(denominator);
  const outScale = 10n ** BigInt(decimals);
  const product = num * outScale;
  let quotient = product / den;
  const remainder = product % den;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  const absDen = den < 0n ? -den : den;
  if (2n * absRemainder >= absDen) quotient += (product < 0n) !== (den < 0n) ? -1n : 1n;
  const negative = quotient < 0n;
  const absolute = negative ? -quotient : quotient;
  const whole = absolute / outScale;
  const fraction = (absolute % outScale).toString().padStart(decimals, '0');
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
  if (filters.classifierId) {
    conditions.push(classifierMachineFilterSql(filters.classifierId, push));
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
  /** Расходы на содержание бизнеса за тот же календарный месяц (business_expenses), не связаны
   * со scope по аппаратам — админ у бизнеса один, поэтому здесь нет построчного machineScopePredicate. */
  expensesTotal: string;
  /** Выручка минус себестоимость игрушек минус расходы на бизнес — то, что реально видит владелец. */
  netProfit: string;
}

/**
 * Финансовый отчёт по месяцам (docs/design/mockups/08_admin_financial_report.html) — тот же
 * единый расчётный слой: те же строки services, тот же scope, только другая группировка.
 */
export async function monthlyReport(
  client: Client,
  actor: Actor,
  filters: Pick<ReportFilters, 'locationId' | 'classifierId'> & { months?: number },
): Promise<MonthlyRow[]> {
  const params: unknown[] = [];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const conditions: string[] = [
    `s.service_date >= date_trunc('month', now()) - (${push(filters.months ?? 6)}::int - 1) * interval '1 month'`,
    // Same "tomorrow UTC" upper bound as the dashboard's periods (see routes/reports.ts
    // dashboardPeriods): without it, any future-dated row (a regression, or leftover load-test
    // data) creates a phantom future-month bucket instead of being excluded.
    `s.service_date <= (now() + interval '1 day')::date`,
  ];
  if (filters.locationId) {
    conditions.push(`p.location_id IN (
      WITH RECURSIVE subtree AS (
        SELECT id FROM locations WHERE id = ${push(filters.locationId)}
        UNION
        SELECT child.id FROM locations child JOIN subtree ON child.parent_id = subtree.id
      ) SELECT id FROM subtree)`);
  }
  if (filters.classifierId) {
    conditions.push(classifierMachineFilterSql(filters.classifierId, push));
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

  // Расходы на бизнес — не привязаны к конкретным аппаратам/адресам, поэтому не участвуют ни в
  // фильтре по location/classifier, ни в scope: это единый гроссбух на весь бизнес, а не по флоту.
  const expensesByMonth = await client.query(
    `SELECT date_trunc('month', expense_date)::date AS month_start, SUM(amount) AS total
     FROM business_expenses
     WHERE expense_date >= date_trunc('month', now()) - ($1::int - 1) * interval '1 month'
       AND expense_date <= (now() + interval '1 day')::date
     GROUP BY 1`,
    [filters.months ?? 6],
  );
  const expensesMap = new Map<string, string>(
    expensesByMonth.rows.map((row) => [String(row.month_start), String(row.total ?? '0')]),
  );

  // Аренда — та же логика, что и business_expenses выше (не фильтруется по location/classifier/
  // scope, единый итог на весь бизнес), но сумма за месяц не берётся напрямую из строк, а считается
  // пропорционально пересечению каждого периода аренды с этим календарным месяцем — иначе смена
  // ставки в середине месяца исказила бы и старые, и новые месяцы, а не только период после правки.
  const rentByMonth = await client.query(
    `WITH months AS (
       SELECT generate_series(
         date_trunc('month', now()) - ($1::int - 1) * interval '1 month',
         date_trunc('month', now()), interval '1 month'
       ) AS month_start
     )
     SELECT m.month_start::date AS month_start,
            SUM(
              r.monthly_amount * GREATEST(0, EXTRACT(EPOCH FROM (
                LEAST(COALESCE(r.ended_at, 'infinity'::timestamptz), m.month_start + interval '1 month')
                - GREATEST(r.started_at, m.month_start)
              )))
              -- Нормировка на РЕАЛЬНУЮ длительность конкретного месяца (28-31 день), не на
              -- условные "30 дней", которыми Postgres трактует interval '1 month' в EPOCH —
              -- иначе полный месяц по неизменной ставке считался бы дороже в 31-дневных месяцах
              -- и дешевле в феврале, вместо ровно monthly_amount.
              / EXTRACT(EPOCH FROM ((m.month_start + interval '1 month') - m.month_start))
            ) AS total
     FROM months m
     JOIN location_rent_periods r
       ON tstzrange(r.started_at, r.ended_at) && tstzrange(m.month_start, m.month_start + interval '1 month')
     GROUP BY 1`,
    [filters.months ?? 6],
  );
  const rentMap = new Map<string, string>(
    rentByMonth.rows.map((row) => [String(row.month_start), String(row.total ?? '0')]),
  );

  return result.rows.map((row) => {
    const revenue = String(row.revenue ?? '0');
    const toyCost = String(row.toy_cost ?? '0');
    const toyCostNumber = Number(toyCost);
    const monthKey = String(row.month_start);
    const expensesTotal = sumDecimal([expensesMap.get(monthKey) ?? '0', rentMap.get(monthKey) ?? '0'], 2);
    return {
      monthStart: row.month_start,
      services: row.services,
      newGames: String(row.new_games ?? '0'),
      revenue,
      toyCost,
      profit: sumDecimal([revenue, `-${toyCost}`], 2),
      roi: toyCostNumber > 0 ? divideDecimal(revenue, toyCost, 2) : null,
      expensesTotal,
      netProfit: sumDecimal([revenue, `-${toyCost}`, `-${expensesTotal}`], 2),
    };
  });
}

export interface ExpenseRow {
  id: number;
  category: string;
  expenseDate: string;
  amount: string;
  comment: string;
}

export interface ExpensesSummary {
  byCategory: Array<{ category: string; total: string; rows: ExpenseRow[] }>;
  total: string;
}

const EXPENSE_CATEGORY_ORDER = ['FUEL', 'SALARY', 'CARD', 'OTHER'];

/** Расходы на бизнес за период, сгруппированные по категории — основа раздела «РАСХОДЫ» в
 * ежемесячном xlsx-отчёте и вкладки «Затраты» в админке. assertAdmin внутри commands/expenses.ts
 * покрывает мутации; это чтение той же таблицы для отчёта, доступного и BOSS (см. routes). */
export async function expensesSummary(
  client: Client,
  filters: { from?: string; to?: string },
): Promise<ExpensesSummary> {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filters.from) { params.push(filters.from); conditions.push(`expense_date >= $${params.length}::date`); }
  if (filters.to) { params.push(filters.to); conditions.push(`expense_date <= $${params.length}::date`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await client.query(
    `SELECT id, category, expense_date, amount, comment
     FROM business_expenses ${where}
     ORDER BY category, expense_date, id`,
    params,
  );

  const rows: ExpenseRow[] = result.rows.map((row) => ({
    id: Number(row.id),
    category: row.category,
    expenseDate: row.expense_date,
    amount: String(row.amount),
    comment: row.comment,
  }));

  const byCategory = EXPENSE_CATEGORY_ORDER
    .map((category) => ({ category, rows: rows.filter((row) => row.category === category) }))
    .filter((bucket) => bucket.rows.length > 0)
    .map((bucket) => ({
      ...bucket,
      total: sumDecimal(bucket.rows.map((row) => row.amount), 2),
    }));

  return { byCategory, total: sumDecimal(rows.map((row) => row.amount), 2) };
}

export interface RentLocationRow {
  locationId: number;
  locationName: string;
  /** Ставка, действующая на конец периода (для отображения) — если ставка менялась внутри
   * периода, фактически начисленная сумма ниже считается по каждому отрезку отдельно, не по
   * этому единственному числу. */
  currentMonthlyAmount: string;
  proratedCost: string;
}

export interface RentSummary {
  locations: RentLocationRow[];
  total: string;
}

/** Аренда за период — по каждой точке, пропорционально пересечению её периодов аренды с [from,
 * to) (та же логика проекции, что в monthlyReport, но на произвольный период, а не на календарный
 * месяц). Используется ежемесячным xlsx-отчётом и карточкой аппарата. */
export async function rentSummary(
  client: Client,
  filters: { from: string; to: string },
): Promise<RentSummary> {
  const result = await client.query(
    `WITH overlapping AS (
       SELECT r.location_id, r.monthly_amount, r.started_at, r.ended_at
       FROM location_rent_periods r
       WHERE tstzrange(r.started_at, r.ended_at) && tstzrange($1::timestamptz, $2::timestamptz)
     )
     SELECT l.id AS location_id, l.name AS location_name,
            (SELECT o2.monthly_amount FROM overlapping o2 WHERE o2.location_id = l.id
             ORDER BY o2.started_at DESC LIMIT 1) AS current_monthly_amount,
            SUM(
              o.monthly_amount * GREATEST(0, EXTRACT(EPOCH FROM (
                LEAST(COALESCE(o.ended_at, 'infinity'::timestamptz), $2::timestamptz)
                - GREATEST(o.started_at, $1::timestamptz)
              )))
              -- Нормировка на реальную длину ЗАПРОШЕННОГО периода [from,to), не на условные
              -- "30 дней" — тогда полный период, целиком покрытый неизменной ставкой, всегда даёт
              -- ровно monthly_amount, каким бы ни было число дней в конкретном месяце.
              / EXTRACT(EPOCH FROM ($2::timestamptz - $1::timestamptz))
            ) AS prorated_cost
     FROM overlapping o JOIN locations l ON l.id = o.location_id
     GROUP BY l.id, l.name
     ORDER BY l.name`,
    [filters.from, filters.to],
  );

  const locations: RentLocationRow[] = result.rows.map((row) => ({
    locationId: Number(row.location_id),
    locationName: row.location_name,
    currentMonthlyAmount: String(row.current_monthly_amount),
    proratedCost: String(row.prorated_cost),
  }));

  return { locations, total: sumDecimal(locations.map((row) => row.proratedCost), 2) };
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
