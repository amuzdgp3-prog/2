import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { machineScopePredicate } from '../lib/scope.js';
import { clawVerdict, payoutBand, type ClawAdvice, type ClawAdviceResult } from './clawAdvice.js';
import { adviceAt, changeEffect, loadCurrentClaw, loadMachineClawConfig } from './clawStats.js';

/**
 * Раздел отчёта владельца «Отдача и настройки клешни» за месяц (DECISION-090). Считается одним
 * расчётом для страницы и xlsx, как и весь отчёт. Зеркало типов — web/src/ownerMonthReport.ts.
 */
export interface OwnerMonthPayoutType {
  machineTypeName: string;
  target: number | null;
  low: number;
  high: number;
  /** Отдача типа за месяц и за прошлый месяц, % выручки. */
  payoutPercent: number | null;
  payoutPercentPrev: number | null;
  machines: number;
  /** Аппараты относительно цели — по отдаче с последнего изменения настроек на конец месяца. */
  lowCount: number;
  okCount: number;
  highCount: number;
  earlyCount: number;
  /** Выручка минус игрушки в сутки на аппарат, ₽. */
  netPerDay: number | null;
  netPerDayPrev: number | null;
}

export interface OwnerMonthClawEffect {
  direction: 'raise' | 'lower';
  /** Изменений Weak за месяц в эту сторону. */
  count: number;
  /** Из них с прошедшим окном 14 дней — только они попадают в средние. */
  complete: number;
  paceAdjustedPercent: number | null;
  netChangePercent: number | null;
}

export interface OwnerMonthAttention {
  machineNumber: string;
  address: string;
  machineTypeName: string;
  payoutPercent: number;
  target: number | null;
  games: number;
  /** Момент последнего изменения настроек. */
  since: string | null;
  advice: ClawAdvice;
}

export interface OwnerMonthPayout {
  types: OwnerMonthPayoutType[];
  changes: {
    total: number;
    machines: number;
    follow: number;
    free: number;
    against: number;
    /** Аппаратов, где совет «подвинуть» висит на конец месяца, а настройку не трогали. */
    pendingAdvice: number;
    effects: OwnerMonthClawEffect[];
  };
  attention: OwnerMonthAttention[];
}

interface Range {
  start: string;
  end: string;
}

const TOY_COST_SQL = `CASE WHEN s.revenue_to_cost_ratio > 0 THEN s.revenue / s.revenue_to_cost_ratio ELSE 0 END`;

function previousMonth(range: Range): Range {
  const start = new Date(range.start);
  const prev = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
  return { start: prev.toISOString(), end: range.start };
}

async function typeMonthTotals(
  client: Client,
  actor: Actor,
  range: Range,
): Promise<Map<string, { revenue: number; toyCost: number; machines: number }>> {
  const scope = machineScopePredicate(actor, 's.machine_number', 3);
  const result = await client.query(
    `SELECT m.machine_type, sum(s.revenue) AS revenue, sum(${TOY_COST_SQL}) AS toy_cost,
            count(DISTINCT s.machine_number)::int AS machines
     FROM services s JOIN machines m ON m.machine_number = s.machine_number
     WHERE s.occurred_at >= $1::timestamptz AND s.occurred_at < $2::timestamptz AND ${scope.sql}
     GROUP BY m.machine_type`,
    [range.start, range.end, ...scope.params],
  );
  return new Map(result.rows.map((row) => [
    String(row.machine_type),
    { revenue: Number(row.revenue), toyCost: Number(row.toy_cost), machines: Number(row.machines) },
  ]));
}

/**
 * Дней в периоде для «в сутки». Текущий месяц ещё не кончился — делим на прошедшие дни, а не на
 * все дни месяца: иначе середина месяца выглядела бы заметно хуже прошлого целого месяца.
 */
const days = (range: Range, now: Date = new Date()) =>
  (Math.min(new Date(range.end).getTime(), now.getTime()) - new Date(range.start).getTime()) / 86_400_000;

export async function ownerMonthPayout(client: Client, actor: Actor, range: Range): Promise<OwnerMonthPayout> {
  const now = new Date();
  // Состояние «на конец месяца»; для текущего месяца — на сейчас.
  const asOf = new Date(Math.min(now.getTime(), new Date(range.end).getTime() - 1));
  const prevRange = previousMonth(range);
  const [month, prev] = await Promise.all([
    typeMonthTotals(client, actor, range),
    typeMonthTotals(client, actor, prevRange),
  ]);

  const types = await client.query(
    `SELECT name, target_payout_percent FROM machine_types WHERE has_claw_settings ORDER BY name`,
  );
  const scope = machineScopePredicate(actor, 'm.machine_number', 2);
  const machines = await client.query(
    `SELECT m.machine_number, m.machine_type, p.address, l.name AS location_name
     FROM machines m
     JOIN machine_types t ON t.name = m.machine_type AND t.has_claw_settings
     JOIN machine_placements p ON p.machine_number = m.machine_number
          AND p.started_at <= $1::timestamptz AND (p.ended_at IS NULL OR p.ended_at > $1::timestamptz)
     JOIN locations l ON l.id = p.location_id
     WHERE m.status = 'ACTIVE' AND ${scope.sql}
     ORDER BY m.machine_number`,
    [asOf, ...scope.params],
  );

  const counts = new Map<string, { low: number; ok: number; high: number; early: number; total: number }>();
  const attention: OwnerMonthAttention[] = [];
  for (const machine of machines.rows) {
    const config = await loadMachineClawConfig(client, machine.machine_number);
    if (!config) continue;
    const current = await loadCurrentClaw(client, machine.machine_number, asOf);
    const { advice } = await adviceAt(client, config, current, asOf);
    const bucket = counts.get(config.machineType) ?? { low: 0, ok: 0, high: 0, early: 0, total: 0 };
    bucket.total += 1;
    if (advice.kind === 'ok') bucket.ok += 1;
    else if (advice.kind === 'change' || advice.kind === 'limit') {
      if (advice.direction === 'raise') bucket.low += 1;
      else bucket.high += 1;
      attention.push({
        machineNumber: machine.machine_number,
        address: machine.address || machine.location_name,
        machineTypeName: config.machineType,
        payoutPercent: advice.payoutPercent,
        target: config.band.target,
        games: advice.games,
        since: current ? current.effectiveAt.toISOString() : null,
        advice,
      });
    } else bucket.early += 1;
    counts.set(config.machineType, bucket);
  }
  attention.sort((left, right) => right.games - left.games);

  const typeRows: OwnerMonthPayoutType[] = types.rows.map((row) => {
    const name = String(row.name);
    const target = row.target_payout_percent === null ? null : Number(row.target_payout_percent);
    const band = payoutBand(target);
    const cur = month.get(name);
    const before = prev.get(name);
    const bucket = counts.get(name) ?? { low: 0, ok: 0, high: 0, early: 0, total: 0 };
    return {
      machineTypeName: name,
      target,
      low: band.low,
      high: band.high,
      payoutPercent: cur && cur.revenue > 0 ? (100 * cur.toyCost) / cur.revenue : null,
      payoutPercentPrev: before && before.revenue > 0 ? (100 * before.toyCost) / before.revenue : null,
      machines: bucket.total,
      lowCount: bucket.low,
      okCount: bucket.ok,
      highCount: bucket.high,
      earlyCount: bucket.early,
      netPerDay: cur && cur.machines > 0 ? (cur.revenue - cur.toyCost) / cur.machines / days(range) : null,
      netPerDayPrev: before && before.machines > 0 ? (before.revenue - before.toyCost) / before.machines / days(prevRange) : null,
    };
  });

  // Изменения настроек за месяц (кроме первых показаний — сравнивать их не с чем).
  const changeScope = machineScopePredicate(actor, 'c.machine_number', 3);
  const changes = await client.query(
    `SELECT c.machine_number, c.effective_at, c.weak, c.advice, m.machine_type,
            (SELECT pr.weak FROM claw_settings pr
             WHERE pr.machine_number = c.machine_number AND (pr.effective_at, pr.id) < (c.effective_at, c.id)
             ORDER BY pr.effective_at DESC, pr.id DESC LIMIT 1) AS previous_weak,
            EXISTS (SELECT 1 FROM claw_settings pr
                    WHERE pr.machine_number = c.machine_number AND (pr.effective_at, pr.id) < (c.effective_at, c.id))
              AS has_previous
     FROM claw_settings c JOIN machines m ON m.machine_number = c.machine_number
     WHERE c.effective_at >= $1::timestamptz AND c.effective_at < $2::timestamptz AND ${changeScope.sql}
     ORDER BY c.effective_at`,
    [range.start, range.end, ...changeScope.params],
  );
  const verdicts = { follow: 0, free: 0, against: 0 };
  const effectSums = {
    raise: { count: 0, complete: 0, pace: [] as number[], net: [] as number[] },
    lower: { count: 0, complete: 0, pace: [] as number[], net: [] as number[] },
  };
  const changed = changes.rows.filter((row) => row.has_previous);
  for (const row of changed) {
    const previousWeak = row.previous_weak === null ? null : Number(row.previous_weak);
    const weak = row.weak === null ? null : Number(row.weak);
    const verdict = clawVerdict(previousWeak, weak, row.advice as ClawAdviceResult | null);
    if (verdict) verdicts[verdict] += 1;
    if (previousWeak === null || weak === null || previousWeak === weak) continue;
    const sums = effectSums[weak > previousWeak ? 'raise' : 'lower'];
    sums.count += 1;
    const effect = await changeEffect(client, row.machine_number, row.machine_type, row.effective_at, now);
    if (!effect.complete) continue;
    sums.complete += 1;
    if (effect.paceAdjustedPercent !== null) sums.pace.push(effect.paceAdjustedPercent);
    if (effect.netChangePercent !== null) sums.net.push(effect.netChangePercent);
  }
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

  return {
    types: typeRows,
    changes: {
      total: changed.length,
      machines: new Set(changed.map((row) => row.machine_number)).size,
      ...verdicts,
      pendingAdvice: attention.length,
      effects: (['raise', 'lower'] as const).map((direction) => ({
        direction,
        count: effectSums[direction].count,
        complete: effectSums[direction].complete,
        paceAdjustedPercent: mean(effectSums[direction].pace),
        netChangePercent: mean(effectSums[direction].net),
      })),
    },
    attention,
  };
}

