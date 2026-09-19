/**
 * Отображение ROI в привычном владельцу виде «прибыль/затраты на игрушки» в процентах,
 * например 70/30. Серверная метрика остаётся отношением выручка/себестоимость (DECISION-012);
 * здесь только перевод для показа: затраты = 100 / ratio, прибыль = 100 - затраты.
 * Ratio 3.33 → «70/30», 2.5 → «60/40», 2 → «50/50». Если ratio < 1 (игрушки дороже выручки),
 * прибыль получается отрицательной, например «-25/125» — это честный результат, не ошибка.
 */
export function formatRoiSplit(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const cost = Math.round(100 / ratio);
  return `${100 - cost}/${cost}`;
}
