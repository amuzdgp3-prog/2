import { toyCostStatus } from '../../toyCostStatus';

/**
 * Значок «Отношение выручка/себестоимость» — единственный, наравне со
 * статусом «работает/не работает», носитель цвета good/warn/bad/neutral
 * в дизайн-системе (docs/design/mockups/00_design_system.html, §«Цвет —
 * только сигнал»). Пороги и подпись «нет данных» — по README макетов:
 * Теперь значок показывает долю затрат на игрушки и статус из toyCostStatus.ts
 * (норма good, «отдаёт мало» warn, «отдаёт много» bad, отсутствие значения — neutral).
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

  const status = toyCostStatus(numeric);
  if (!status) {
    return (
      <span className="badge badge-neutral">
        <span className="badge-dot" />
        нет данных
      </span>
    );
  }

  // Норма — good; отклонение в любую сторону — сигнал технику: «много» (теряем деньги) — bad,
  // «мало» (люди перестанут играть) — warn.
  const variant = status.level === 'ok' ? 'good' : status.level === 'high' ? 'bad' : 'warn';

  return (
    <span className={`badge badge-${variant}`} title={`Затраты на игрушки ${status.percent} % выручки. ${status.hint}`}>
      <span className="badge-dot" />
      {status.percent}% · {status.label}
    </span>
  );
}
