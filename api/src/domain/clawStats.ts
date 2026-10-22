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
