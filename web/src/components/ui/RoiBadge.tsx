/**
 * Значок «Отношение выручка/себестоимость» — единственный, наравне со
 * статусом «работает/не работает», носитель цвета good/warn/bad/neutral
 * в дизайн-системе (docs/design/mockups/00_design_system.html, §«Цвет —
 * только сигнал»). Пороги и подпись «нет данных» — по README макетов:
 * ≥3.0 good, 2.0–2.9 warn, <2.0 bad, отсутствие значения — neutral.
 *
 * Соответствует серверной метрике revenue_to_cost_ratio (см. DECISION-012
 * в DECISIONS.md): сервер уже возвращает null, когда базы для расчёта нет
 * или она равна нулю, — компонент не пересчитывает ROI сам, только красит.
 */
export function RoiBadge({ value }: { value: number | string | null | undefined }) {
  const numeric = value === null || value === undefined || value === '' ? null : Number(value);

  if (numeric === null || !Number.isFinite(numeric)) {
    return (
      <span className="badge badge-neutral">
        <span className="badge-dot" />
        нет данных
      </span>
    );
  }

  const variant = numeric >= 3.0 ? 'good' : numeric >= 2.0 ? 'warn' : 'bad';

  return (
    <span className={`badge badge-${variant}`}>
      <span className="badge-dot" />
      ROI {numeric.toFixed(1)}
    </span>
  );
}
