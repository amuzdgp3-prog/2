import type { Client } from '../db/pool.js';
import {
  CLAW_EFFECT_WINDOW_DAYS,
  adviseClaw,
  clawChangeEffect,
  payoutBand,
  payoutPercent,
  type ClawAdviceResult,
  type ClawChangeEffect,
  type ClawLimits,
  type ClawState,
  type ClawValues,
  type PayoutBand,
  type PeriodTotals,
  type WindowTotals,
} from './clawAdvice.js';

/**
 * Чтения для настроек клешни (DECISION-090): действующие значения, итоги с последнего изменения,
 * окна «до/после» и данные карточки аппарата. Правила совета — в clawAdvice.ts, здесь только SQL.
 *
 * Затраты периода берутся так же, как в метрике ROI (DECISION-012): игрушки, доложенные на
 * предыдущем обслуживании. Их восстанавливаем из уже хранимого отношения выручка/себестоимость —
 * revenue / revenue_to_cost_ratio, — а не пересчитываем заново, чтобы совет, журнал и отчёты
 * опирались на одно и то же число. Пустое отношение (в прошлый раз не докладывали) — затраты 0.
 */
const TOY_COST_SQL = `CASE WHEN s.revenue_to_cost_ratio > 0 THEN s.revenue / s.revenue_to_cost_ratio ELSE 0 END`;

export interface MachineClawConfig {
  machineNumber: string;
  machineType: string;
  enabled: boolean;
  limits: ClawLimits;
  band: PayoutBand;
  machineTarget: number | null;
  typeTarget: number | null;
}

const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export async function loadMachineClawConfig(client: Client, machineNumber: string): Promise<MachineClawConfig | null> {
  const result = await client.query(
    `SELECT m.machine_number, m.machine_type, m.target_payout_percent AS machine_target,
            t.has_claw_settings, t.target_payout_percent AS type_target,
            t.claw_weak_step, t.claw_strong_step, t.claw_medium_step,
            t.claw_weak_min, t.claw_weak_max, t.claw_strong_min, t.claw_strong_max,
            t.claw_medium_min, t.claw_medium_max
     FROM machines m JOIN machine_types t ON t.name = m.machine_type
     WHERE m.machine_number = $1`,
    [machineNumber],
  );
  const row = result.rows[0];
  if (!row) return null;
  const machineTarget = num(row.machine_target);
  const typeTarget = num(row.type_target);
  return {
    machineNumber: row.machine_number,
    machineType: row.machine_type,
    enabled: Boolean(row.has_claw_settings),
    limits: {
      weakStep: Number(row.claw_weak_step),
      strongStep: Number(row.claw_strong_step),
      mediumStep: Number(row.claw_medium_step),
      weakMin: num(row.claw_weak_min),
      weakMax: num(row.claw_weak_max),
      strongMin: Number(row.claw_strong_min),
      strongMax: Number(row.claw_strong_max),
      mediumMin: Number(row.claw_medium_min),
      mediumMax: Number(row.claw_medium_max),
    },
    band: payoutBand(machineTarget ?? typeTarget),
    machineTarget,
    typeTarget,
  };
}

export interface ClawSettingRow extends ClawValues {
  id: number;
  effectiveAt: Date;
  source: 'SERVICE' | 'CARD' | 'TASK';
  serviceId: number | null;
  taskId: number | null;
  advice: ClawAdviceResult | null;
  enteredBy: number | null;
  enteredByName: string | null;
  note: string;
}

function toSettingRow(row: Record<string, unknown>): ClawSettingRow {
  return {
    id: Number(row.id),
    effectiveAt: row.effective_at as Date,
    strong: num(row.strong),
    medium: num(row.medium),
    weak: num(row.weak),
    prizeSet: num(row.prize_set),
    source: row.source as ClawSettingRow['source'],
    serviceId: num(row.service_id),
    taskId: num(row.task_id),
    advice: (row.advice as ClawAdviceResult | null) ?? null,
    enteredBy: num(row.entered_by),
    enteredByName: (row.entered_by_name as string | null) ?? null,
    note: (row.note as string) ?? '',
  };
}

const SELECT_SETTINGS = `
  SELECT c.*, st.full_name AS entered_by_name
  FROM claw_settings c LEFT JOIN staff st ON st.id = c.entered_by`;

/** Действующая настройка — последняя строка истории на момент `at` (по умолчанию — сейчас). */
export async function loadCurrentClaw(
  client: Client,
  machineNumber: string,
  at?: Date | string,
): Promise<ClawSettingRow | null> {
  const result = await client.query(
    `${SELECT_SETTINGS}
     WHERE c.machine_number = $1 AND ($2::timestamptz IS NULL OR c.effective_at <= $2::timestamptz)
     ORDER BY c.effective_at DESC, c.id DESC LIMIT 1`,
    [machineNumber, at ?? null],
  );
  return result.rows[0] ? toSettingRow(result.rows[0]) : null;
}

export async function loadClawHistory(client: Client, machineNumber: string): Promise<ClawSettingRow[]> {
  const result = await client.query(
    `${SELECT_SETTINGS} WHERE c.machine_number = $1 ORDER BY c.effective_at DESC, c.id DESC`,
    [machineNumber],
  );
  return result.rows.map(toSettingRow);
}

/**
 * Итоги обслуживаний аппарата в полуинтервале (from, to]. from = null — с начала истории.
 * Обслуживание относится к периоду по своему моменту: его выручка — это игры, накопленные к нему.
 */
export async function machinePeriodTotals(
  client: Client,
  machineNumber: string,
  from: Date | string | null,
  to: Date | string | null = null,
): Promise<PeriodTotals> {
  const result = await client.query(
    `SELECT COALESCE(sum(s.new_games), 0) AS games,
            COALESCE(sum(s.revenue), 0) AS revenue,
            COALESCE(sum(${TOY_COST_SQL}), 0) AS toy_cost
     FROM services s
     WHERE s.machine_number = $1
       AND ($2::timestamptz IS NULL OR s.occurred_at > $2::timestamptz)
       AND ($3::timestamptz IS NULL OR s.occurred_at <= $3::timestamptz)`,
    [machineNumber, from, to],
  );
  const row = result.rows[0];
  return { games: Number(row.games), revenue: Number(row.revenue), toyCost: Number(row.toy_cost) };
}

/**
 * Итоги за окно (from, to] по набору аппаратов: либо один аппарат, либо все аппараты типа кроме
 * одного (фон для поправки). days — сумма длин периодов обслуживаний, попавших в окно: длина
 * считается по всей цепочке размещения, до фильтра окна, иначе первый период окна был бы обрезан.
 */
export async function windowTotals(
  client: Client,
  filter: { machineNumber: string } | { machineType: string; exceptMachine: string },
  from: Date | string,
  to: Date | string,
): Promise<WindowTotals> {
  const byMachine = 'machineNumber' in filter;
  const result = await client.query(
    `WITH s AS (
       SELECT s.occurred_at, s.new_games, s.revenue, ${TOY_COST_SQL} AS toy_cost,
              EXTRACT(EPOCH FROM s.occurred_at - COALESCE(
                LAG(s.occurred_at) OVER (PARTITION BY s.placement_id ORDER BY s.occurred_at, s.id),
                p.started_at)) / 86400 AS days
       FROM services s
       JOIN machine_placements p ON p.id = s.placement_id
       JOIN machines m ON m.machine_number = s.machine_number
       WHERE ${byMachine ? 's.machine_number = $1' : 'm.machine_type = $1 AND s.machine_number <> $2'}
     )
     SELECT COALESCE(sum(days), 0) AS days, COALESCE(sum(new_games), 0) AS games,
            COALESCE(sum(revenue), 0) AS revenue, COALESCE(sum(toy_cost), 0) AS toy_cost
     FROM s
     WHERE occurred_at > $${byMachine ? 2 : 3}::timestamptz AND occurred_at <= $${byMachine ? 3 : 4}::timestamptz
       AND days > 0`,
    byMachine
      ? [filter.machineNumber, from, to]
      : [filter.machineType, filter.exceptMachine, from, to],
  );
  const row = result.rows[0];
  return {
    days: Number(row.days),
    games: Number(row.games),
    revenue: Number(row.revenue),
    toyCost: Number(row.toy_cost),
  };
}

const DAY_MS = 86_400_000;

/** Итог изменения настроек в момент `at`: 14 дней до против 14 дней после, с поправкой на тип. */
export async function changeEffect(
  client: Client,
  machineNumber: string,
  machineType: string,
  at: Date,
  now: Date = new Date(),
): Promise<ClawChangeEffect> {
  const start = new Date(at.getTime() - CLAW_EFFECT_WINDOW_DAYS * DAY_MS);
  const end = new Date(at.getTime() + CLAW_EFFECT_WINDOW_DAYS * DAY_MS);
  const [before, after, typeBefore, typeAfter] = await Promise.all([
    windowTotals(client, { machineNumber }, start, at),
    windowTotals(client, { machineNumber }, at, end),
    windowTotals(client, { machineType, exceptMachine: machineNumber }, start, at),
    windowTotals(client, { machineType, exceptMachine: machineNumber }, at, end),
  ]);
  return clawChangeEffect({
    before,
    after,
    typeBefore: typeBefore.days > 0 ? typeBefore : null,
    typeAfter: typeAfter.days > 0 ? typeAfter : null,
    complete: now.getTime() >= end.getTime(),
  });
}

/** Состояние для телефона: совет у аппарата без сети, итоги закрытых периодов с изменения. */
export async function machineClawState(client: Client, machineNumber: string): Promise<ClawState | null> {
  const config = await loadMachineClawConfig(client, machineNumber);
  if (!config || !config.enabled) return null;
  const current = await loadCurrentClaw(client, machineNumber);
  const since = await machinePeriodTotals(client, machineNumber, current?.effectiveAt ?? null);
  return {
    current: current
      ? { strong: current.strong, medium: current.medium, weak: current.weak, prizeSet: current.prizeSet }
      : { strong: null, medium: null, weak: null, prizeSet: null },
    changedAt: current ? current.effectiveAt.toISOString() : null,
    limits: config.limits,
    band: config.band,
    since,
  };
}

/**
 * Колонки для списка аппаратов телефона (`alias` — алиас таблицы machines): тип с настройками
 * клешни, действующая настройка и итоги с её момента. Одним запросом на весь список, а не
 * machineClawState на каждый аппарат: список грузится при каждом обновлении каталога.
 */
export function clawStateColumnsSql(alias: string): { columns: string; joins: string } {
  return {
    columns: `claw_type.has_claw_settings AS claw_enabled,
              COALESCE(${alias}.target_payout_percent, claw_type.target_payout_percent) AS claw_target,
              claw_type.claw_weak_step, claw_type.claw_strong_step, claw_type.claw_medium_step,
              claw_type.claw_weak_min, claw_type.claw_weak_max, claw_type.claw_strong_min,
              claw_type.claw_strong_max, claw_type.claw_medium_min, claw_type.claw_medium_max,
              claw_now.strong AS claw_strong, claw_now.medium AS claw_medium, claw_now.weak AS claw_weak,
              claw_now.prize_set AS claw_prize_set, claw_now.effective_at AS claw_changed_at,
              claw_since.games AS claw_since_games, claw_since.revenue AS claw_since_revenue,
              claw_since.toy_cost AS claw_since_toy_cost`,
    joins: `JOIN machine_types claw_type ON claw_type.name = ${alias}.machine_type
       LEFT JOIN LATERAL (
         SELECT c.strong, c.medium, c.weak, c.prize_set, c.effective_at FROM claw_settings c
         WHERE c.machine_number = ${alias}.machine_number
         ORDER BY c.effective_at DESC, c.id DESC LIMIT 1
       ) claw_now ON claw_type.has_claw_settings
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(s.new_games), 0) AS games, COALESCE(sum(s.revenue), 0) AS revenue,
                COALESCE(sum(${TOY_COST_SQL}), 0) AS toy_cost
         FROM services s
         WHERE s.machine_number = ${alias}.machine_number
           AND (claw_now.effective_at IS NULL OR s.occurred_at > claw_now.effective_at)
       ) claw_since ON claw_type.has_claw_settings`,
  };
}

/** Собирает ClawState из колонок clawStateColumnsSql и убирает их из строки списка. */
export function takeClawState(row: Record<string, unknown>): ClawState | null {
  const state: ClawState | null = row.claw_enabled
    ? {
        current: {
          strong: num(row.claw_strong),
          medium: num(row.claw_medium),
          weak: num(row.claw_weak),
          prizeSet: num(row.claw_prize_set),
        },
        changedAt: row.claw_changed_at ? (row.claw_changed_at as Date).toISOString() : null,
        limits: {
          weakStep: Number(row.claw_weak_step),
          strongStep: Number(row.claw_strong_step),
          mediumStep: Number(row.claw_medium_step),
          weakMin: num(row.claw_weak_min),
          weakMax: num(row.claw_weak_max),
          strongMin: Number(row.claw_strong_min),
          strongMax: Number(row.claw_strong_max),
          mediumMin: Number(row.claw_medium_min),
          mediumMax: Number(row.claw_medium_max),
        },
        band: payoutBand(num(row.claw_target)),
        since: {
          games: Number(row.claw_since_games ?? 0),
          revenue: Number(row.claw_since_revenue ?? 0),
          toyCost: Number(row.claw_since_toy_cost ?? 0),
        },
      }
    : null;
  for (const key of Object.keys(row)) if (key.startsWith('claw_')) delete row[key];
  return state;
}

/**
 * Изменение настроек, пришедшее с обслуживанием, — для журнала (`alias` — строка services):
 * новые значения, прежние и совет в момент изменения. NULL — с этим обслуживанием не меняли.
 */
export function serviceClawChangeSql(alias: string): string {
  return `(SELECT json_build_object(
             'strong', c.strong, 'medium', c.medium, 'weak', c.weak, 'prizeSet', c.prize_set,
             'advice', c.advice,
             'previous', (SELECT json_build_object('strong', pr.strong, 'medium', pr.medium,
                                                   'weak', pr.weak, 'prizeSet', pr.prize_set)
                          FROM claw_settings pr
                          WHERE pr.machine_number = c.machine_number
                            AND (pr.effective_at, pr.id) < (c.effective_at, c.id)
                          ORDER BY pr.effective_at DESC, pr.id DESC LIMIT 1))
           FROM claw_settings c WHERE c.service_id = ${alias}.id)`;
}

/** Совет на момент `at` по итогам с последнего изменения до этого момента включительно. */
export async function adviceAt(
  client: Client,
  config: MachineClawConfig,
  current: ClawSettingRow | null,
  at: Date | string,
): Promise<ClawAdviceResult> {
  const totals = await machinePeriodTotals(client, config.machineNumber, current?.effectiveAt ?? null, at);
  return adviseClaw({
    current: current ?? { strong: null, medium: null, weak: null, prizeSet: null },
    limits: config.limits,
    band: config.band,
    totals,
  });
}

export interface ClawPeriodPoint {
  serviceDate: string;
  occurredAt: Date;
  days: number;
  games: number;
  gamesPerDay: number | null;
  payoutPercent: number | null;
  revenuePerDay: number | null;
  netPerDay: number | null;
  /** Weak, действовавший в этом периоде (настройка до момента обслуживания). */
  weak: number | null;
}

export interface MachineClawCard {
  machineNumber: string;
  machineType: string;
  enabled: boolean;
  limits: ClawLimits;
  band: PayoutBand;
  machineTarget: number | null;
  typeTarget: number | null;
  current: ClawSettingRow | null;
  since: PeriodTotals & { payoutPercent: number | null };
  advice: ClawAdviceResult;
  history: Array<
    ClawSettingRow & {
      /** Отдача и игры, пока стояла эта настройка. */
      tenure: PeriodTotals & { payoutPercent: number | null };
      /** Итог изменения «до/после»; у первых показаний — null, сравнивать не с чем. */
      effect: ClawChangeEffect | null;
    }
  >;
  periods: ClawPeriodPoint[];
}

/** Сколько последних периодов показывать на графике карточки. */
const CARD_PERIODS = 24;

export async function machineClawCard(client: Client, machineNumber: string): Promise<MachineClawCard | null> {
  const config = await loadMachineClawConfig(client, machineNumber);
  if (!config) return null;
  const historyRows = await loadClawHistory(client, machineNumber);
  const current = historyRows[0] ?? null;
  const sinceTotals = await machinePeriodTotals(client, machineNumber, current?.effectiveAt ?? null);
  const advice = adviseClaw({
    current: current ?? { strong: null, medium: null, weak: null, prizeSet: null },
    limits: config.limits,
    band: config.band,
    totals: sinceTotals,
  });

  const history = [];
  for (let index = 0; index < historyRows.length; index += 1) {
    const row = historyRows[index];
    const next = historyRows[index - 1] ?? null;
    const tenure = await machinePeriodTotals(client, machineNumber, row.effectiveAt, next?.effectiveAt ?? null);
    const isFirst = index === historyRows.length - 1;
    history.push({
      ...row,
      tenure: { ...tenure, payoutPercent: payoutPercent(tenure) },
      effect: isFirst ? null : await changeEffect(client, machineNumber, config.machineType, row.effectiveAt),
    });
  }

  const points = await client.query(
    `SELECT * FROM (
       SELECT s.service_date::text AS service_date, s.occurred_at, s.new_games, s.revenue,
              ${TOY_COST_SQL} AS toy_cost,
              EXTRACT(EPOCH FROM s.occurred_at - COALESCE(
                LAG(s.occurred_at) OVER (PARTITION BY s.placement_id ORDER BY s.occurred_at, s.id),
                p.started_at)) / 86400 AS days,
              (SELECT c.weak FROM claw_settings c
               WHERE c.machine_number = s.machine_number AND c.effective_at < s.occurred_at
               ORDER BY c.effective_at DESC, c.id DESC LIMIT 1) AS weak
       FROM services s JOIN machine_placements p ON p.id = s.placement_id
       WHERE s.machine_number = $1
       ORDER BY s.occurred_at DESC, s.id DESC
       LIMIT $2
     ) last ORDER BY occurred_at`,
    [machineNumber, CARD_PERIODS],
  );
  const periods: ClawPeriodPoint[] = points.rows.map((row) => {
    const days = Number(row.days);
    const games = Number(row.new_games);
    const revenue = Number(row.revenue);
    const toyCost = Number(row.toy_cost);
    return {
      serviceDate: row.service_date,
      occurredAt: row.occurred_at,
      days,
      games,
      gamesPerDay: days > 0 ? games / days : null,
      payoutPercent: revenue > 0 ? (100 * toyCost) / revenue : null,
      revenuePerDay: days > 0 ? revenue / days : null,
      netPerDay: days > 0 ? (revenue - toyCost) / days : null,
      weak: num(row.weak),
    };
  });

  return {
    machineNumber,
    machineType: config.machineType,
    enabled: config.enabled,
    limits: config.limits,
    band: config.band,
    machineTarget: config.machineTarget,
    typeTarget: config.typeTarget,
    current,
    since: { ...sinceTotals, payoutPercent: payoutPercent(sinceTotals) },
    advice,
    history,
    periods,
  };
}

export interface PayoutPaceBin {
  label: string;
  from: number;
  to: number | null;
  periods: number;
  /** Темп игр в следующем периоде, % от обычного темпа этого же аппарата. */
  nextPacePercent: number | null;
  /** Стандартная ошибка среднего, процентные пункты. */
  standardError: number | null;
}

export interface TypeClawAnalytics {
  machineType: string;
  periods: number;
  firstServiceAt: Date | null;
  bins: PayoutPaceBin[];
  effects: Array<{
    direction: 'raise' | 'lower';
    count: number;
    complete: number;
    paceAdjustedPercent: number | null;
    netChangePercent: number | null;
  }>;
}

const PACE_BINS: Array<[number, number | null]> = [[0, 10], [10, 20], [20, 30], [30, 40], [40, 50], [50, null]];

/**
 * «Больше выигрывают — больше играют?» по типу аппарата. Отдачу периода сравниваем с темпом игр в
 * СЛЕДУЮЩЕМ периоде: в одном и том же периоде слабая неделя сама поднимает процент отдачи (выручка
 * в знаменателе), и связь получилась бы ложной. Темп — относительно обычного темпа того же аппарата
 * (медиана), чтобы не сравнивать бойкие точки с тихими.
 */
export async function typeClawAnalytics(client: Client, machineType: string): Promise<TypeClawAnalytics> {
  const result = await client.query(
    `WITH s AS (
       SELECT s.placement_id, s.machine_number, s.occurred_at, s.new_games, s.revenue,
              ${TOY_COST_SQL} AS toy_cost,
              EXTRACT(EPOCH FROM s.occurred_at - LAG(s.occurred_at) OVER w) / 86400 AS days
       FROM services s JOIN machines m ON m.machine_number = s.machine_number
       WHERE m.machine_type = $1
       WINDOW w AS (PARTITION BY s.placement_id ORDER BY s.occurred_at, s.id)
     ),
     p AS (SELECT *, new_games / days AS pace FROM s WHERE days >= 1 AND days <= 21 AND revenue > 0),
     med AS (SELECT machine_number, percentile_cont(0.5) WITHIN GROUP (ORDER BY pace) AS mp
             FROM p GROUP BY 1 HAVING count(*) >= 6),
     q AS (SELECT 100 * toy_cost / revenue AS payout,
                  100 * LEAD(pace) OVER (PARTITION BY placement_id ORDER BY occurred_at) / mp AS next_pace
           FROM p JOIN med USING (machine_number) WHERE mp > 0)
     SELECT width_bucket(LEAST(payout, 999), ARRAY[10, 20, 30, 40, 50]::numeric[]) AS bin,
            count(next_pace)::int AS periods, avg(next_pace) AS next_pace,
            stddev(next_pace) / sqrt(NULLIF(count(next_pace), 0)) AS se
     FROM q WHERE next_pace IS NOT NULL
     GROUP BY 1 ORDER BY 1`,
    [machineType],
  );
  const byBin = new Map(result.rows.map((row) => [Number(row.bin), row]));
  const bins: PayoutPaceBin[] = PACE_BINS.map(([from, to], index) => {
    const row = byBin.get(index);
    return {
      label: to === null ? `${from}+` : `${from}–${to}`,
      from,
      to,
      periods: row ? Number(row.periods) : 0,
      nextPacePercent: row ? Number(row.next_pace) : null,
      standardError: row && row.se !== null ? Number(row.se) : null,
    };
  });

  const first = await client.query(
    `SELECT min(s.occurred_at) AS first FROM services s JOIN machines m ON m.machine_number = s.machine_number
     WHERE m.machine_type = $1`,
    [machineType],
  );

  const changes = await client.query(
    `SELECT c.machine_number, c.effective_at, c.weak,
            (SELECT pr.weak FROM claw_settings pr
             WHERE pr.machine_number = c.machine_number AND (pr.effective_at, pr.id) < (c.effective_at, c.id)
             ORDER BY pr.effective_at DESC, pr.id DESC LIMIT 1) AS previous_weak
     FROM claw_settings c JOIN machines m ON m.machine_number = c.machine_number
     WHERE m.machine_type = $1
     ORDER BY c.effective_at`,
    [machineType],
  );
  const sums = {
    raise: { count: 0, complete: 0, pace: [] as number[], net: [] as number[] },
    lower: { count: 0, complete: 0, pace: [] as number[], net: [] as number[] },
  };
  for (const row of changes.rows) {
    if (row.previous_weak === null || row.weak === null || Number(row.previous_weak) === Number(row.weak)) continue;
    const bucket = sums[Number(row.weak) > Number(row.previous_weak) ? 'raise' : 'lower'];
    bucket.count += 1;
    const effect = await changeEffect(client, row.machine_number, machineType, row.effective_at);
    if (!effect.complete) continue;
    bucket.complete += 1;
    if (effect.paceAdjustedPercent !== null) bucket.pace.push(effect.paceAdjustedPercent);
    if (effect.netChangePercent !== null) bucket.net.push(effect.netChangePercent);
  }
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

  return {
    machineType,
    periods: bins.reduce((total, bin) => total + bin.periods, 0),
    firstServiceAt: first.rows[0]?.first ?? null,
    bins,
    effects: (['raise', 'lower'] as const).map((direction) => ({
      direction,
      count: sums[direction].count,
      complete: sums[direction].complete,
      paceAdjustedPercent: mean(sums[direction].pace),
      netChangePercent: mean(sums[direction].net),
    })),
  };
}
