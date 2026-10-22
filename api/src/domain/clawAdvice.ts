/**
 * Настройки клешни (меню платы Crane Setting → Claw Set) и совет технику, как их подвинуть, чтобы
 * отдача игрушек пришла к цели (DECISION-090).
 *
 * Отдача здесь — та же метрика, что в журнале и отчётах: доля затрат на игрушки в выручке, где
 * затраты периода — игрушки, доложенные в прошлый раз (revenue_to_cost_ratio, DECISION-012). Её
 * считают не по одному обслуживанию, а по сумме всех обслуживаний с последнего изменения настроек:
 * на коротком отрезке отдача «гуляет» сама, и совет по одному периоду прыгал бы туда-обратно.
 *
 * Зеркало этого модуля — web/src/clawAdvice.ts: телефон досчитывает совет у аппарата без сети,
 * добавляя к итогам с сервера текущее обслуживание. Правила в двух местах должны совпадать.
 */

/** Норма — цель ± эта доля самой цели: при цели 35 % это 31,5–38,5 %. */
export const CLAW_NORM_SHARE = 0.1;
/** Сколько игр должно пройти с последнего изменения, прежде чем давать совет. */
export const CLAW_MIN_GAMES = 300;
/** Вилка для аппаратов без цели — прежняя общая норма индикатора затрат (toyCostStatus.ts). */
export const DEFAULT_PAYOUT_LOW = 25;
export const DEFAULT_PAYOUT_HIGH = 40;
/** Окно сравнения «до и после» изменения настроек, дней. */
export const CLAW_EFFECT_WINDOW_DAYS = 14;

/** Значения меню Claw Set. null — значение ни разу не вносилось. */
export interface ClawValues {
  /** п.1 Strong Catch, вольты. */
  strong: number | null;
  /** п.2 Medium Catch, вольты. */
  medium: number | null;
  /** п.3 Weak Catch, вольты — его меняют чаще всего. */
  weak: number | null;
  /** Prize Set — игр на приз. Для справки, совета по нему нет. */
  prizeSet: number | null;
}

/** Шаги и границы, заданные на карточке типа аппарата. */
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

/** Коридор нормы отдачи в процентах выручки. target = null — у аппарата и типа цели нет. */
export interface PayoutBand {
  target: number | null;
  low: number;
  high: number;
}

/** Суммы по обслуживаниям за период: игры, выручка и затраты на игрушки этого периода. */
export interface PeriodTotals {
  games: number;
  revenue: number;
  toyCost: number;
}

export type ClawDirection = 'raise' | 'lower';

export type ClawAdvice =
  /** Weak ни разу не вносился — совет не из чего строить. */
  | { kind: 'no-settings' }
  /** С изменения не было выручки — отдачу не посчитать. */
  | { kind: 'no-data'; games: number }
  /** Игр с изменения меньше порога — судить рано. */
  | { kind: 'early'; games: number; minGames: number; payoutPercent: number | null }
  | { kind: 'ok'; games: number; payoutPercent: number }
  /** Подвинуть один параметр на шаг: обычно Weak, у границы Weak — Medium. */
  | {
      kind: 'change';
      param: 'weak' | 'medium';
      direction: ClawDirection;
      from: number;
      to: number;
      games: number;
      payoutPercent: number;
    }
  /** Нужно двигать, но и Weak, и Medium уже у границы: дело не в настройках. */
  | { kind: 'limit'; direction: ClawDirection; games: number; payoutPercent: number };

/** Strong ≥ Medium ≥ Weak нарушено — значения противоречат друг другу. */
export type ClawWarning = 'order';

export interface ClawAdviceResult {
  advice: ClawAdvice;
  warnings: ClawWarning[];
}

/**
 * Что телефон получает в списке аппаратов, чтобы показать совет у аппарата без сети: действующие
 * значения, шаги и границы типа, коридор и итоги закрытых периодов с последнего изменения.
 */
export interface ClawState {
  current: ClawValues;
  /** Момент последнего изменения; null — значения ещё не вносились. */
  changedAt: string | null;
  limits: ClawLimits;
  band: PayoutBand;
  since: PeriodTotals;
}

/** Суммы за окно «до» или «после» изменения; days — сумма длин периодов обслуживаний в окне. */
export interface WindowTotals extends PeriodTotals {
  days: number;
}

/** Итог изменения настроек: 14 дней до против 14 дней после, с поправкой на общий фон типа. */
export interface ClawChangeEffect {
  /** Окно «после» уже прошло целиком. */
  complete: boolean;
  payoutBefore: number | null;
  payoutAfter: number | null;
  gamesPerDayBefore: number | null;
  gamesPerDayAfter: number | null;
  /** Рост игр в сутки, %. */
  paceChangePercent: number | null;
  /** Рост игр у остальных аппаратов того же типа за те же окна, %. */
  typePaceChangePercent: number | null;
  /** Собственный эффект: рост аппарата минус рост типа, процентные пункты. */
  paceAdjustedPercent: number | null;
  /** Выручка минус игрушки, ₽ в сутки. */
  netPerDayBefore: number | null;
  netPerDayAfter: number | null;
  netChangePercent: number | null;
}
