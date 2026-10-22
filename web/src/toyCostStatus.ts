/**
 * Доля затрат на игрушки в выручке и статус «отдаёт мало / норма / отдаёт много».
 * Серверная метрика остаётся отношением выручка/себестоимость (DECISION-012); здесь только
 * перевод для показа: доля затрат = 100 / ratio. Целевая вилка владельца — прибыль/затраты
 * 70/30 или 60/40, то есть затраты 30–40 %; нижняя граница нормы взята с запасом (25 %),
 * потому что большинство парка сейчас тратит на игрушки заметно меньше 30 %.
 */
export type ToyCostLevel = 'low' | 'ok' | 'high';

export const TOY_COST_LOW_BELOW = 25;
export const TOY_COST_HIGH_ABOVE = 40;

/**
 * Коридор нормы. По умолчанию — общая вилка выше; у аппарата с целью отдачи — цель ±10 % от цели
 * (DECISION-090, clawAdvice.ts payoutBand).
 */
export interface ToyCostBand {
  low: number;
  high: number;
}

const DEFAULT_BAND: ToyCostBand = { low: TOY_COST_LOW_BELOW, high: TOY_COST_HIGH_ABOVE };

export interface ToyCostStatus {
  /** Доля затрат на игрушки в выручке, целые проценты. */
  percent: number;
  level: ToyCostLevel;
  label: string;
  /** Что делать технику. */
  hint: string;
}

export function toyCostStatus(
  ratio: number | string | null | undefined,
  band: ToyCostBand = DEFAULT_BAND,
): ToyCostStatus | null {
  if (ratio === null || ratio === undefined || ratio === '') return null;
  const value = Number(ratio);
  if (!Number.isFinite(value) || value <= 0) return null;
  return statusFromPercent(Math.round(100 / value), band);
}

/**
 * Доля затрат за период по суммам (затраты ÷ выручка), для отчёта. Нулевые затраты при выручке —
 * «0 % · отдаёт мало»: игры шли, а докладывать было нечего. Нет выручки — «нет данных» (null).
 */
export function toyCostStatusFromAmounts(
  toyCost: number | string | null | undefined,
  revenue: number | string | null | undefined,
  band: ToyCostBand = DEFAULT_BAND,
): ToyCostStatus | null {
  if (toyCost === null || toyCost === undefined || revenue === null || revenue === undefined) return null;
  const cost = Number(toyCost);
  const income = Number(revenue);
  if (!Number.isFinite(cost) || !Number.isFinite(income) || cost < 0 || income <= 0) return null;
  if (cost === 0) {
    // Выручка есть, а игрушек за период не докладывали — призы почти не выпадали.
    return { percent: 0, level: 'low', label: 'отдаёт мало', hint: 'За период игрушки не докладывали. Настроить аппарат на большую отдачу' };
  }
  return statusFromPercent(Math.round((100 * cost) / income), band);
}

function statusFromPercent(percent: number, band: ToyCostBand): ToyCostStatus {
  if (percent < band.low) {
    return { percent, level: 'low', label: 'отдаёт мало', hint: 'Настроить аппарат на большую отдачу' };
  }
  if (percent > band.high) {
    return { percent, level: 'high', label: 'отдаёт много', hint: 'Настроить аппарат на меньшую отдачу' };
  }
  return { percent, level: 'ok', label: 'норма', hint: 'В целевой вилке' };
}
