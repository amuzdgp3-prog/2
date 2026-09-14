import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { machineScopePredicate } from '../lib/scope.js';
import type { ReportFilters } from './reports.js';

/**
 * Эффективность техника (DECISION-046 закрыт владельцем 14.09.2026).
 *
 * Единица измерения — ПАРА соседних визитов на одной установке: визит N подготовил аппарат
 * (разложил игрушки, протёр стекло), визит N+1 закрыл период и забрал деньги. Выручка периода
 * засчитывается технику визита N, а не тому, кто её физически собрал: оценивается именно
 * подготовка аппарата, от неё зависит его привлекательность и, значит, выручка до следующего
 * приезда. Это прямое решение владельца.
 *
 * Чего здесь сознательно НЕТ:
 * — поправки на сложность маршрута: владелец подтвердил, что работа везде одинаковая, поэтому
 *   уровни B и C исходного документа (и двойное начисление сложности между ними) не строятся;
 * — коэффициента λ: вместо подгоночного веса стоит честная отсечка в MIN_PAIRS пар, ниже которой
 *   техник вообще не получает оценку, а помечается «мало данных».
 *
 * Что исправлено против исходной методики владельца (восемь пунктов разбора):
 * 1. Деление на ноль при нулевом вложении игрушек — пара без игрушек не участвует в метрике
 *    «отдача на игрушки», но остаётся в метрике «выручка в сутки»; знаменатель нулём не бывает.
 * 2. Смешение взвешенного среднего с невзвешенной дисперсией — и среднее, и дисперсия считаются
 *    по одним и тем же весам (длительность периода в днях).
 * 3. Нормальное приближение при малых N — доверительный интервал строится бутстрэпом, при N=3
 *    он честно получается широким, а не притворяется узким.
 * 4. Безразмерность «стабильности» — это коэффициент вариации (разброс, делённый на среднее),
 *    безразмерный по построению.
 * 5. Нормировка по максимуму — заменена на 90-й перцентиль по парам, один удачный визит больше
 *    не задирает шкалу всему парку.
 * 6. Неопределённый λ — снят вместе с самим коэффициентом, см. выше.
 * 7. Двойная поправка на сложность — снята вместе со сложностью, см. выше.
 * 8. Неоднозначность отчётной даты s1/s2 — зафиксирована: пара принадлежит дате визита N,
 *    фильтр периода отбирает пары по дате подготовки, а не по дате сбора денег.
 *
 * Отдельно: «выручка в сутки» сама по себе НЕ сравнивает техников между собой — она сравнивает
 * их маршруты, потому что проходимость точек разная, даже если работа на них одинаковая. Поэтому
 * главная сравнительная величина здесь — индекс к собственной норме аппарата (см. pairIndex).
 */

/** Меньше трёх пар — техник не оценивается (решение владельца от 14.09.2026). */
export const MIN_PAIRS = 3;

/** Одна пара «подготовил → закрыли период». */
export interface VisitPair {
  technicianId: number;
  technicianName: string;
  machineNumber: string;
  /** Визит N: тот, чью работу оцениваем. */
  setupServiceId: number;
  setupDate: string;
  /** Визит N+1: тот, на котором деньги были сняты. */
  closingServiceId: number;
  periodDays: number;
  /** Выручка, собранная на закрывающем визите, то есть заработанная за период после подготовки. */
  revenue: number;
  /** Себестоимость игрушек, вложенных на подготовке. Ноль — если игрушек не докладывали. */
  toyCostAtSetup: number;
  revenuePerDay: number;
  /** Выручка на рубль вложенных игрушек; null, если не вкладывали (пункт 1 разбора). */
  returnOnToys: number | null;
  /**
   * Отношение выручки в сутки к собственной норме этого аппарата, посчитанной по ОСТАЛЬНЫМ его
   * парам (leave-one-out — иначе пара сравнивалась бы с нормой, в которую сама и входит).
   * null, если у аппарата нет других пар: по одному наблюдению норму не построить.
   * 1.0 — «аппарат заработал ровно столько, сколько зарабатывает обычно», 1.2 — на 20 % больше.
   */
  index: number | null;
}

export interface TechnicianEffectivenessRow {
  technicianId: number;
  technicianName: string;
  pairs: number;
  pairsWithToys: number;
  pairsWithIndex: number;
  totalDays: number;
  totalRevenue: number;
  /** Взвешенное по дням среднее = вся выручка / все дни. Сравнивать техников по нему нельзя. */
  revenuePerDay: number;
  /** Коэффициент вариации выручки в сутки: 0.2 — ровно, 0.8 — разброс от визита к визиту. */
  stability: number | null;
  returnOnToys: number | null;
  /** Главная сравнительная величина: взвешенное среднее индексов к норме аппарата. */
  index: number | null;
  /** Бутстрэп-интервал для index, 95 %. null при недостатке пар. */
  indexCi: [number, number] | null;
  /** Место на шкале парка: index, делённый на 90-й перцентиль индексов всех пар. */
  scaled: number | null;
  enoughData: boolean;
}

export interface TechnicianEffectivenessReport {
  rows: TechnicianEffectivenessRow[];
  /** Сколько пар отброшено и почему — чтобы в интерфейсе не гадать, куда делись визиты. */
  meta: {
    totalPairs: number;
    minPairs: number;
    fleetIndexP90: number | null;
  };
}

/** Детерминированный генератор: отчёт не должен менять цифры при каждом обновлении страницы. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function weightedMean(values: number[], weights: number[]): number | null {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) return null;
  const weighted = values.reduce((sum, value, i) => sum + value * weights[i], 0);
  return weighted / totalWeight;
}

/**
 * Несмещённая дисперсия для весов надёжности: делитель Σw − Σw²/Σw, а не (n−1).
 * Пункт 2 разбора: среднее и дисперсия должны считаться по одним и тем же весам.
 */
export function weightedVariance(values: number[], weights: number[]): number | null {
  if (values.length < 2) return null;
  const mean = weightedMean(values, weights);
  if (mean === null) return null;
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const sumSquaredWeights = weights.reduce((sum, weight) => sum + weight * weight, 0);
  const denominator = totalWeight - sumSquaredWeights / totalWeight;
  if (denominator <= 0) return null;
  const numerator = values.reduce(
    (sum, value, i) => sum + weights[i] * (value - mean) * (value - mean),
    0,
  );
  return numerator / denominator;
}

/** Коэффициент вариации — безразмерная «стабильность» (пункт 4 разбора). */
export function coefficientOfVariation(values: number[], weights: number[]): number | null {
  const mean = weightedMean(values, weights);
  const variance = weightedVariance(values, weights);
  if (mean === null || variance === null || mean <= 0) return null;
  return Math.sqrt(variance) / mean;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Бутстрэп-интервал для взвешенного среднего (пункт 3 разбора). При N около трёх нормальное
 * приближение даёт заведомо слишком узкий интервал, поэтому пересэмплируем сами пары.
 */
export function bootstrapCi(
  values: number[],
  weights: number[],
  options: { iterations?: number; seed?: number; level?: number } = {},
): [number, number] | null {
  const { iterations = 2000, seed = 20260914, level = 0.95 } = options;
  if (values.length < 2) return null;
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampleValues: number[] = [];
    const sampleWeights: number[] = [];
    for (let draw = 0; draw < values.length; draw += 1) {
      const pick = Math.floor(random() * values.length);
      sampleValues.push(values[pick]);
      sampleWeights.push(weights[pick]);
    }
    const mean = weightedMean(sampleValues, sampleWeights);
    if (mean !== null) means.push(mean);
  }
  if (means.length === 0) return null;
  const tail = (1 - level) / 2;
  const low = percentile(means, tail);
  const high = percentile(means, 1 - tail);
  return low === null || high === null ? null : [low, high];
}

/**
 * Индекс пары к собственной норме аппарата, leave-one-out. Пары одного аппарата сравниваются с
 * медианой ОСТАЛЬНЫХ его пар: аппарат служит контролем сам себе, поэтому разная проходимость
 * точек перестаёт влиять на сравнение техников, и никакой поправки на «сложность» для этого не
 * нужно — что и требовалось после решения владельца.
 */
export function withMachineIndex(pairs: Omit<VisitPair, 'index'>[]): VisitPair[] {
  const byMachine = new Map<string, number[]>();
  for (const pair of pairs) {
    const list = byMachine.get(pair.machineNumber) ?? [];
    list.push(pair.revenuePerDay);
    byMachine.set(pair.machineNumber, list);
  }

  return pairs.map((pair) => {
    const all = byMachine.get(pair.machineNumber) ?? [];
    if (all.length < 2) return { ...pair, index: null };
    // Медиана без текущего наблюдения: одно вхождение значения убираем, дубликаты сохраняем.
    const others = [...all];
    others.splice(others.indexOf(pair.revenuePerDay), 1);
    const norm = percentile(others, 0.5);
    if (norm === null || norm <= 0) return { ...pair, index: null };
    return { ...pair, index: pair.revenuePerDay / norm };
  });
}

/** Сводит пары по технику: веса — дни периода, метрики — по правилам разбора. */
export function aggregatePairs(pairs: VisitPair[]): TechnicianEffectivenessReport {
  const indexed = pairs.filter((pair) => pair.index !== null);
  const fleetIndexP90 = percentile(indexed.map((pair) => pair.index as number), 0.9);

  const byTechnician = new Map<number, VisitPair[]>();
  for (const pair of pairs) {
    const list = byTechnician.get(pair.technicianId) ?? [];
    list.push(pair);
    byTechnician.set(pair.technicianId, list);
  }

  const rows: TechnicianEffectivenessRow[] = [];
  for (const [technicianId, list] of byTechnician) {
    const days = list.map((pair) => pair.periodDays);
    const perDay = list.map((pair) => pair.revenuePerDay);
    const totalDays = days.reduce((sum, value) => sum + value, 0);
    const totalRevenue = list.reduce((sum, pair) => sum + pair.revenue, 0);

    const withToys = list.filter((pair) => pair.returnOnToys !== null);
    const withIndex = list.filter((pair) => pair.index !== null);

    const index = withIndex.length > 0
      ? weightedMean(
        withIndex.map((pair) => pair.index as number),
        withIndex.map((pair) => pair.periodDays),
      )
      : null;

    const enoughData = list.length >= MIN_PAIRS;

    rows.push({
      technicianId,
      technicianName: list[0].technicianName,
      pairs: list.length,
      pairsWithToys: withToys.length,
      pairsWithIndex: withIndex.length,
      totalDays,
      totalRevenue,
      revenuePerDay: weightedMean(perDay, days) ?? 0,
      stability: enoughData ? coefficientOfVariation(perDay, days) : null,
      returnOnToys: withToys.length > 0
        ? weightedMean(
          withToys.map((pair) => pair.returnOnToys as number),
          withToys.map((pair) => pair.toyCostAtSetup),
        )
        : null,
      index: enoughData ? index : null,
      indexCi: enoughData && withIndex.length >= 2
        ? bootstrapCi(
          withIndex.map((pair) => pair.index as number),
          withIndex.map((pair) => pair.periodDays),
        )
        : null,
      scaled: enoughData && index !== null && fleetIndexP90 !== null && fleetIndexP90 > 0
        ? index / fleetIndexP90
        : null,
      enoughData,
    });
  }

  rows.sort((left, right) => {
    if (left.enoughData !== right.enoughData) return left.enoughData ? -1 : 1;
    return (right.index ?? -Infinity) - (left.index ?? -Infinity);
  });

  return { rows, meta: { totalPairs: pairs.length, minPairs: MIN_PAIRS, fleetIndexP90 } };
}

/**
 * Достаёт пары из базы. Цепочка строится окном по (placement_id, occurred_at, id) — той же
 * связкой, что и счётчик в CHAIN_CTES, поэтому переезд аппарата на другую точку пару не склеивает.
 * Фильтр периода применяется к дате ПОДГОТОВКИ (пункт 8 разбора).
 */
export async function loadVisitPairs(
  client: Client,
  actor: Actor,
  filters: ReportFilters,
): Promise<Omit<VisitPair, 'index'>[]> {
  const params: unknown[] = [];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  // Цепочка строится по ВСЕМ выездам на установке, без фильтров: закрывающий выезд может
  // оказаться и за границей отчётного периода, и под служебной учётной записью, но период он всё
  // равно закрывает. Если фильтровать до окна, последняя пара периода молча пропадает — на этом
  // тест и поймал первую версию запроса. Фильтры применяются ниже, к выезду ПОДГОТОВКИ.
  const scope = machineScopePredicate(actor, 's.machine_number', params.length + 1);
  params.push(...scope.params);

  // Служебные учётные записи исключаются тем же признаком, что и в факт-отчёте (DECISION-049),
  // но только как исполнители подготовки — закрывать период они могут.
  const setupConditions: string[] = ['c.technician_id IS NOT NULL', 'st.is_field_technician'];
  if (filters.from) setupConditions.push(`c.service_date >= ${push(filters.from)}::date`);
  if (filters.to) setupConditions.push(`c.service_date <= ${push(filters.to)}::date`);
  if (filters.technicianId) setupConditions.push(`c.technician_id = ${push(filters.technicianId)}`);

  const result = await client.query(
    `WITH chain AS (
       SELECT s.id, s.placement_id, s.machine_number, s.occurred_at, s.service_date,
              s.technician_id, s.toy_cost,
              LEAD(s.id)          OVER w AS closing_id,
              LEAD(s.revenue)     OVER w AS closing_revenue,
              LEAD(s.occurred_at) OVER w AS closing_at
       FROM services s
       WHERE ${scope.sql}
       WINDOW w AS (PARTITION BY s.placement_id ORDER BY s.occurred_at, s.id)
     )
     SELECT c.technician_id, st.full_name, c.machine_number,
            c.id AS setup_id, c.service_date AS setup_date,
            c.closing_id, c.closing_revenue, c.toy_cost,
            EXTRACT(EPOCH FROM (c.closing_at - c.occurred_at)) / 86400 AS period_days
     FROM chain c
     JOIN staff st ON st.id = c.technician_id
     WHERE c.closing_id IS NOT NULL
       AND c.closing_at > c.occurred_at
       AND ${setupConditions.join(' AND ')}
     ORDER BY c.technician_id, c.occurred_at`,
    params,
  );

  return result.rows.map((row) => {
    const periodDays = Number(row.period_days);
    const revenue = Number(row.closing_revenue);
    const toyCostAtSetup = Number(row.toy_cost);
    return {
      technicianId: Number(row.technician_id),
      technicianName: row.full_name as string,
      machineNumber: row.machine_number as string,
      setupServiceId: Number(row.setup_id),
      setupDate: String(row.setup_date),
      closingServiceId: Number(row.closing_id),
      periodDays,
      revenue,
      toyCostAtSetup,
      revenuePerDay: revenue / periodDays,
      returnOnToys: toyCostAtSetup > 0 ? revenue / toyCostAtSetup : null,
    };
  });
}

export async function technicianEffectiveness(
  client: Client,
  actor: Actor,
  filters: ReportFilters,
): Promise<TechnicianEffectivenessReport> {
  const raw = await loadVisitPairs(client, actor, filters);
  return aggregatePairs(withMachineIndex(raw));
}
