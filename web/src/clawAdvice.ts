/**
 * Зеркало api/src/domain/clawAdvice.ts (DECISION-090): настройки клешни и совет технику. Телефон
 * досчитывает совет у аппарата без сети — к итогам с сервера добавляет текущее обслуживание,
 * поэтому правила здесь и на сервере должны совпадать.
 */

export const CLAW_NORM_SHARE = 0.1;
export const CLAW_MIN_GAMES = 300;
export const DEFAULT_PAYOUT_LOW = 25;
export const DEFAULT_PAYOUT_HIGH = 40;
export const CLAW_EFFECT_WINDOW_DAYS = 14;

export interface ClawValues {
  strong: number | null;
  medium: number | null;
  weak: number | null;
  prizeSet: number | null;
}

export interface ClawLimits {
  weakStep: number;
  strongStep: number;
  mediumStep: number;
  weakMin: number | null;
  weakMax: number | null;
  strongMin: number;
  strongMax: number;
  mediumMin: number;
  mediumMax: number;
}

export interface PayoutBand {
  target: number | null;
  low: number;
  high: number;
}

export interface PeriodTotals {
  games: number;
  revenue: number;
  toyCost: number;
}

export type ClawDirection = 'raise' | 'lower';

export type ClawAdvice =
  | { kind: 'no-settings' }
  | { kind: 'no-data'; games: number }
  | { kind: 'early'; games: number; minGames: number; payoutPercent: number | null }
  | { kind: 'ok'; games: number; payoutPercent: number }
  | {
      kind: 'change';
      param: 'weak' | 'medium';
      direction: ClawDirection;
      from: number;
      to: number;
      games: number;
      payoutPercent: number;
    }
  | { kind: 'limit'; direction: ClawDirection; games: number; payoutPercent: number };

export type ClawWarning = 'order';

export interface ClawAdviceResult {
  advice: ClawAdvice;
  warnings: ClawWarning[];
}

export interface ClawState {
  current: ClawValues;
  changedAt: string | null;
  limits: ClawLimits;
  band: PayoutBand;
  since: PeriodTotals;
}

export interface WindowTotals extends PeriodTotals {
  days: number;
}

export interface ClawChangeEffect {
  complete: boolean;
  payoutBefore: number | null;
  payoutAfter: number | null;
  gamesPerDayBefore: number | null;
  gamesPerDayAfter: number | null;
  paceChangePercent: number | null;
  typePaceChangePercent: number | null;
  paceAdjustedPercent: number | null;
  netPerDayBefore: number | null;
  netPerDayAfter: number | null;
  netChangePercent: number | null;
}

/** Значения, которые техник поменял на аппарате и отправляет вместе с обслуживанием. */
export interface ClawInput {
  strong?: number | null;
  medium?: number | null;
  weak?: number | null;
  prizeSet?: number | null;
}

export const roundClaw = (value: number): number => Math.round(value * 100) / 100;

export function payoutBand(target: number | null): PayoutBand {
  if (target === null || !Number.isFinite(target) || target <= 0) {
    return { target: null, low: DEFAULT_PAYOUT_LOW, high: DEFAULT_PAYOUT_HIGH };
  }
  return {
    target,
    low: roundClaw(target * (1 - CLAW_NORM_SHARE)),
    high: roundClaw(target * (1 + CLAW_NORM_SHARE)),
  };
}

export function payoutPercent(totals: PeriodTotals): number | null {
  return totals.revenue > 0 ? (100 * totals.toyCost) / totals.revenue : null;
}

export type PayoutLevel = 'low' | 'ok' | 'high';

export function payoutLevel(percent: number, band: PayoutBand): PayoutLevel {
  if (percent < band.low) return 'low';
  if (percent > band.high) return 'high';
  return 'ok';
}

const within = (value: number, min: number | null, max: number | null) =>
  (min === null || value >= min - 1e-9) && (max === null || value <= max + 1e-9);

/** Тот же совет, что на сервере (api/src/domain/clawAdvice.ts): правила должны совпадать. */
export function adviseClaw(input: {
  current: ClawValues;
  limits: ClawLimits;
  band: PayoutBand;
  totals: PeriodTotals;
}): ClawAdviceResult {
  const { current, limits, band, totals } = input;
  const warnings: ClawWarning[] = [];
  const { strong, medium, weak } = current;
  if (
    (strong !== null && medium !== null && strong < medium)
    || (medium !== null && weak !== null && medium < weak)
    || (strong !== null && weak !== null && strong < weak)
  ) {
    warnings.push('order');
  }

  if (weak === null) return { advice: { kind: 'no-settings' }, warnings };
  const games = totals.games;
  const percent = payoutPercent(totals);
  if (percent === null) return { advice: { kind: 'no-data', games }, warnings };
  if (games < CLAW_MIN_GAMES) {
    return { advice: { kind: 'early', games, minGames: CLAW_MIN_GAMES, payoutPercent: percent }, warnings };
  }

  const level = payoutLevel(percent, band);
  if (level === 'ok') return { advice: { kind: 'ok', games, payoutPercent: percent }, warnings };

  const direction: ClawDirection = level === 'low' ? 'raise' : 'lower';
  const sign = direction === 'raise' ? 1 : -1;
  const nextWeak = roundClaw(weak + sign * limits.weakStep);
  if (within(nextWeak, limits.weakMin, limits.weakMax)) {
    return {
      advice: { kind: 'change', param: 'weak', direction, from: weak, to: nextWeak, games, payoutPercent: percent },
      warnings,
    };
  }
  if (medium !== null) {
    const nextMedium = roundClaw(medium + sign * limits.mediumStep);
    if (within(nextMedium, limits.mediumMin, limits.mediumMax)) {
      return {
        advice: { kind: 'change', param: 'medium', direction, from: medium, to: nextMedium, games, payoutPercent: percent },
        warnings,
      };
    }
  }
  return { advice: { kind: 'limit', direction, games, payoutPercent: percent }, warnings };
}

/** Вольты по-русски: 12,6. */
export const formatVolts = (value: number | null) => {
  if (value === null) return '—';
  const rounded = roundClaw(value);
  // Десятые всегда видны (12,0 рядом с 12,2), сотые — только если шаг платы их требует.
  return (Number.isInteger(rounded * 10) ? rounded.toFixed(1) : String(rounded)).replace('.', ',');
};

export function adviceText(advice: ClawAdvice): string {
  switch (advice.kind) {
    case 'no-settings':
      return 'значения ещё не вносились';
    case 'no-data':
      return 'нет выручки с изменения';
    case 'early':
      return `рано судить: ${Math.round(advice.games)} из ${advice.minGames} игр`;
    case 'ok':
      return 'норма, не менять';
    case 'change': {
      const verb = advice.direction === 'raise'
        ? advice.param === 'weak' ? 'прибавить' : 'поднять'
        : advice.param === 'weak' ? 'убавить' : 'опустить';
      return `${verb} ${advice.param === 'weak' ? 'Weak' : 'Medium'} до ${formatVolts(advice.to)} В`;
    }
    case 'limit':
      return 'Weak и Medium у границы — проверить клешню, игрушки и Prize Set';
  }
}

export type ClawVerdict = 'follow' | 'free' | 'against';

/** Зеркало clawVerdict сервера: «по совету», «без совета», «против совета». */
export function clawVerdict(
  previousWeak: number | null,
  newWeak: number | null,
  advice: ClawAdviceResult | null,
): ClawVerdict | null {
  if (previousWeak === null || newWeak === null || previousWeak === newWeak) return null;
  const moved: ClawDirection = newWeak > previousWeak ? 'raise' : 'lower';
  const shown = advice?.advice;
  if (!shown || shown.kind !== 'change' || shown.param !== 'weak') return 'free';
  return shown.direction === moved ? 'follow' : 'against';
}
