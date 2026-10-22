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
