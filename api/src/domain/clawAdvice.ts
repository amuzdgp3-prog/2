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

/** Округление до сотых — шаги платы вроде 0,2 В копятся в двоичной дроби (12,4 + 0,2 = 12,600…01). */
export const roundClaw = (value: number): number => Math.round(value * 100) / 100;

/** Коридор нормы: цель ±10 % от самой цели; без цели — прежняя общая вилка 25–40 %. */
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

/** Доля затрат на игрушки в выручке, %; null — выручки не было. */
export function payoutPercent(totals: PeriodTotals): number | null {
  return totals.revenue > 0 ? (100 * totals.toyCost) / totals.revenue : null;
}

export type PayoutLevel = 'low' | 'ok' | 'high';

/** Где отдача относительно коридора: мало, норма или много. */
export function payoutLevel(percent: number, band: PayoutBand): PayoutLevel {
  if (percent < band.low) return 'low';
  if (percent > band.high) return 'high';
  return 'ok';
}

const within = (value: number, min: number | null, max: number | null) =>
  (min === null || value >= min - 1e-9) && (max === null || value <= max + 1e-9);

/**
 * Совет по настройкам клешни.
 *
 * Отдача ниже коридора — клешню надо держать крепче (прибавить), выше — слабее (убавить). Двигается
 * один параметр на один шаг платы: Weak, а если он уже у границы — Medium. Совет даётся только
 * после CLAW_MIN_GAMES игр с последнего изменения: раньше отдача ещё случайна.
 */
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

const perDay = (value: number, days: number) => (days > 0 ? value / days : null);
const changePercent = (before: number | null, after: number | null) =>
  before !== null && after !== null && before > 0 ? ((after - before) / before) * 100 : null;

/**
 * Итог изменения настроек: окно до против окна после. Поправка на фон — рост игр у остальных
 * аппаратов того же типа за те же окна вычитается из роста аппарата, чтобы сезон, праздники и
 * погода не выдавались за эффект настройки.
 */
export function clawChangeEffect(input: {
  before: WindowTotals;
  after: WindowTotals;
  typeBefore: WindowTotals | null;
  typeAfter: WindowTotals | null;
  complete: boolean;
}): ClawChangeEffect {
  const { before, after, typeBefore, typeAfter, complete } = input;
  const gamesPerDayBefore = perDay(before.games, before.days);
  const gamesPerDayAfter = perDay(after.games, after.days);
  const netPerDayBefore = perDay(before.revenue - before.toyCost, before.days);
  const netPerDayAfter = perDay(after.revenue - after.toyCost, after.days);
  const paceChangePercent = changePercent(gamesPerDayBefore, gamesPerDayAfter);
  const typePaceChangePercent = typeBefore && typeAfter
    ? changePercent(perDay(typeBefore.games, typeBefore.days), perDay(typeAfter.games, typeAfter.days))
    : null;
  return {
    complete,
    payoutBefore: payoutPercent(before),
    payoutAfter: payoutPercent(after),
    gamesPerDayBefore,
    gamesPerDayAfter,
    paceChangePercent,
    typePaceChangePercent,
    paceAdjustedPercent:
      paceChangePercent !== null && typePaceChangePercent !== null
        ? paceChangePercent - typePaceChangePercent
        : null,
    netPerDayBefore,
    netPerDayAfter,
    netChangePercent: changePercent(netPerDayBefore, netPerDayAfter),
  };
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
