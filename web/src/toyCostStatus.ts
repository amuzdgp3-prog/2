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

export interface ToyCostStatus {
  /** Доля затрат на игрушки в выручке, целые проценты. */
  percent: number;
  level: ToyCostLevel;
  label: string;
  /** Что делать технику. */
  hint: string;
}

export function toyCostStatus(ratio: number | string | null | undefined): ToyCostStatus | null {
  if (ratio === null || ratio === undefined || ratio === '') return null;
  const value = Number(ratio);
  if (!Number.isFinite(value) || value <= 0) return null;
  const percent = Math.round(100 / value);
  if (percent < TOY_COST_LOW_BELOW) {
    return { percent, level: 'low', label: 'отдаёт мало', hint: 'Настроить аппарат на большую отдачу' };
  }
  if (percent > TOY_COST_HIGH_ABOVE) {
    return { percent, level: 'high', label: 'отдаёт много', hint: 'Настроить аппарат на меньшую отдачу' };
  }
  return { percent, level: 'ok', label: 'норма', hint: 'В целевой вилке' };
}
