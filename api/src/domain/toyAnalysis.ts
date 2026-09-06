import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { machineScopePredicate } from '../lib/scope.js';
import { queryMachineRows } from './reports.js';

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface ToyMonthlyPoint {
  monthStart: string;
  quantity: number;
  cost: string;
}

export interface ToyForecastRow {
  toyId: number;
  name: string;
  /** Текущая (актуальная) цена игрушки — по ней же считается стоимость прогноза: цена может
   * измениться, а планировать закупку нужно по тому, сколько это будет стоить сейчас, а не по
   * тому, сколько стоило в прошлом. */
  unitCost: string;
  /** Исторический расход по месяцам — количество и стоимость по цене, действовавшей в момент
   * каждой конкретной выдачи (unit_cost_snapshot). Смена текущей цены игрушки задним числом эти
   * цифры не меняет — это факт, а не прогноз. */
  monthly: ToyMonthlyPoint[];
  /** Простая скользящая средняя по последним (до 3) месяцам с данными — не выдумываем тренд там,
   * где для него нет оснований; это ориентир для закупки, а не точный прогноз спроса. Стоимость —
   * по ТЕКУЩЕЙ цене (unitCost), не по исторической. */
  forecastNextMonth: { quantity: number; cost: string };
}

/**
 * Помесячный расход каждой игрушки за последние `months` месяцев (включая текущий) — основа для
 * планирования закупки.
 */
export async function toyMonthlyTrend(client: Client, actor: Actor, months = 6): Promise<ToyForecastRow[]> {
  const scope = machineScopePredicate(actor, 's.machine_number', 2);
  const result = await client.query(
    `SELECT t.id AS toy_id, t.name, t.unit_cost,
            date_trunc('month', s.service_date)::date AS month_start,
            SUM(td.quantity)::int AS quantity,
            SUM(td.quantity * td.unit_cost_snapshot) AS cost
     FROM toy_distributions td
     JOIN services s ON s.id = td.service_id
     JOIN toys t ON t.id = td.toy_id
     WHERE s.service_date >= (date_trunc('month', now()) - ($1::int - 1) * interval '1 month')::date
       AND ${scope.sql}
     GROUP BY t.id, t.name, t.unit_cost, month_start
     ORDER BY t.id, month_start`,
    [months, ...scope.params],
  );

  const byToy = new Map<number, ToyForecastRow>();
  for (const row of result.rows) {
    const toyId = Number(row.toy_id);
    if (!byToy.has(toyId)) {
      byToy.set(toyId, { toyId, name: row.name, unitCost: String(row.unit_cost), monthly: [], forecastNextMonth: { quantity: 0, cost: '0.00' } });
    }
    byToy.get(toyId)!.monthly.push({
      monthStart: row.month_start,
      quantity: row.quantity,
      cost: String(row.cost),
    });
  }

  for (const toy of byToy.values()) {
    const recent = toy.monthly.slice(-3);
    const avgQuantity = recent.length > 0
      ? Math.round(recent.reduce((sum, m) => sum + m.quantity, 0) / recent.length)
      : 0;
    toy.forecastNextMonth = {
      quantity: avgQuantity,
      cost: (avgQuantity * Number(toy.unitCost)).toFixed(2),
    };
  }

  return [...byToy.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface MachineConsumptionRow {
  machineNumber: string;
  locationName: string;
  services: number;
  /** Число новых игр за период — прокси клиентского трафика: низкий ROI при высоком трафике и
   * низкий ROI при низком трафике требуют разных решений по настройке аппарата. */
  newGames: string;
  revenue: string;
  toyCost: string;
  /** Σвыручка / Σсебестоимость за период — тот же агрегатный принцип, что в помесячном отчёте
   * (DECISION-020), а не среднее по обслуживаниям. null — нет базы (себестоимость за период = 0). */
  ratio: number | null;
  quantities: Record<string, number>;
  /** «Модифицированный z-score» (Iglewicz & Hoaglin) относительно МЕДИАНЫ и MAD по флоту, не
   * относительно среднего и стандартного отклонения — см. комментарий у machineToyConsumption. */
  modifiedZScore: number | null;
  anomaly: 'HIGH_CONSUMPTION' | 'LOW_CONSUMPTION' | null;
}

export interface ToyTypeTotal {
  toyId: number;
  name: string;
  quantity: number;
  /** Сумма по цене, действовавшей в момент каждой выдачи (факт периода), не по текущей цене. */
  cost: string;
}

/** Порог для модифицированного z-score — принятое в статистике значение для этого метода
 * (не совпадает с порогом ~1.5–2, который использовался бы для обычного z-score). */
const ANOMALY_THRESHOLD = 3.5;
/** Меньше этого числа обслуживаний за период — выборка слишком мала для статистического вывода,
 * аппарат показывается, но не участвует в определении «нормы» и не помечается аномалией. */
const MIN_SERVICES_FOR_ANOMALY = 3;

/**
 * Расход игрушек по аппаратам за период с учётом зависимости от выручки (владелец: планирование
 * закупки и решения о настройке выигрышей — давать больше или меньше выигрышей). Аномалия — не
 * фиксированный порог (как у RoiBadge), а статистическое отклонение от ТИПИЧНОГО по флоту за тот
 * же период в ОБЕ стороны: «слишком щедрый» аппарат (мало выручки на единицу себестоимости
 * игрушек) и «слишком жёсткий» (наоборот — риск того, что аппарат почти не платит и отпугивает
 * игроков, тоже стоит проверить).
 *
 * Медиана + MAD (median absolute deviation), а не среднее + стандартное отклонение: именно
 * выбросы, которые мы ищем, сильнее всего искажают среднее и стандартное отклонение, поэтому
 * классический z-score занижает их собственную аномальность. Медиана и MAD устойчивы к выбросам
 * по построению — это стандартная рекомендация для такой задачи (Iglewicz & Hoaglin).
 */
export async function machineToyConsumption(
  client: Client,
  actor: Actor,
  filters: { from?: string; to?: string; locationId?: number },
): Promise<{
  machines: MachineConsumptionRow[];
  toyTotals: ToyTypeTotal[];
  fleetStats: { meanRatio: number | null; medianRatio: number | null; mad: number | null; sampleSize: number };
}> {
  const rows = await queryMachineRows(client, actor, filters);

  const scope = machineScopePredicate(actor, 's.machine_number', 3);
  const quantitiesResult = await client.query(
    `SELECT s.machine_number, td.toy_id, t.name,
            SUM(td.quantity)::int AS quantity,
            SUM(td.quantity * td.unit_cost_snapshot) AS cost
     FROM toy_distributions td
     JOIN services s ON s.id = td.service_id
     JOIN toys t ON t.id = td.toy_id
     WHERE ($1::date IS NULL OR s.service_date >= $1::date)
       AND ($2::date IS NULL OR s.service_date <= $2::date)
       AND ${scope.sql}
     GROUP BY s.machine_number, td.toy_id, t.name`,
    [filters.from ?? null, filters.to ?? null, ...scope.params],
  );
  const quantitiesByMachine = new Map<string, Record<string, number>>();
  const totalsByToy = new Map<number, ToyTypeTotal>();
  for (const row of quantitiesResult.rows) {
    const bucket = quantitiesByMachine.get(row.machine_number) ?? {};
    bucket[String(row.toy_id)] = row.quantity;
    quantitiesByMachine.set(row.machine_number, bucket);

    const toyId = Number(row.toy_id);
    const existing = totalsByToy.get(toyId) ?? { toyId, name: row.name, quantity: 0, cost: '0' };
    existing.quantity += row.quantity;
    existing.cost = (Number(existing.cost) + Number(row.cost)).toFixed(2);
    totalsByToy.set(toyId, existing);
  }

  const machines: MachineConsumptionRow[] = rows.map((row) => {
    const toyCostNumber = Number(row.toyCost);
    const ratio = toyCostNumber > 0 ? Number(row.revenue) / toyCostNumber : null;
    return {
      machineNumber: row.machineNumber,
      locationName: row.locationName,
      services: row.services,
      newGames: row.newGames,
      revenue: row.revenue,
      toyCost: row.toyCost,
      ratio,
      quantities: quantitiesByMachine.get(row.machineNumber) ?? {},
      modifiedZScore: null,
      anomaly: null,
    };
  });

  // The "typical" range is defined by machines with enough activity to be statistically
  // meaningful; a machine with one visit and a wild ratio should not skew the fleet baseline.
  const sample = machines.filter((m) => m.ratio !== null && m.services >= MIN_SERVICES_FOR_ANOMALY);
  const ratios = sample.map((m) => m.ratio!);
  const meanRatio = ratios.length > 0 ? ratios.reduce((sum, r) => sum + r, 0) / ratios.length : null;
  const medianRatio = median(ratios);
  const mad = medianRatio !== null ? median(ratios.map((r) => Math.abs(r - medianRatio))) : null;

  // MAD is frequently exactly 0 in a small/uniform fleet (e.g. several machines sharing the same
  // ratio) — a raw division would then call every tiny deviation infinitely anomalous. Iglewicz &
  // Hoaglin's own recommendation for this case is to fall back to the mean absolute deviation
  // (with its matching constant 1.2533) instead of MAD, rather than silently disabling detection.
  let scale = mad;
  let constant = 0.6745;
  if (medianRatio !== null && mad === 0) {
    const meanAbsoluteDeviation = ratios.reduce((sum, r) => sum + Math.abs(r - medianRatio), 0) / ratios.length;
    scale = meanAbsoluteDeviation;
    constant = 1.2533;
  }

  if (medianRatio !== null && scale !== null && scale > 0) {
    for (const machine of machines) {
      if (machine.ratio === null || machine.services < MIN_SERVICES_FOR_ANOMALY) continue;
      const modifiedZ = (constant * (machine.ratio - medianRatio)) / scale;
      machine.modifiedZScore = Number(modifiedZ.toFixed(2));
      if (modifiedZ <= -ANOMALY_THRESHOLD) machine.anomaly = 'HIGH_CONSUMPTION';
      else if (modifiedZ >= ANOMALY_THRESHOLD) machine.anomaly = 'LOW_CONSUMPTION';
    }
  }

  return {
    machines,
    toyTotals: [...totalsByToy.values()].sort((a, b) => a.name.localeCompare(b.name)),
    fleetStats: { meanRatio, medianRatio, mad, sampleSize: sample.length },
  };
}
