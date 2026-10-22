import type { ToyCostStatus } from '../../toyCostStatus';

const ICON: Record<ToyCostStatus['level'] | 'none', string> = {
  low: 'M12 19V5M5 12l7-7 7 7',
  high: 'M12 5v14M5 12l7 7 7-7',
  ok: 'M5 12.5l4.5 4.5L19 7.5',
  none: 'M6 12h12',
};

/**
 * Доля затрат на игрушки в выручке: стрелка направления, число и слово. Стрелка вверх — отдачу
 * надо увеличить, вниз — уменьшить. Расчёт статуса — в toyCostStatus.ts; компонент только рисует.
 * Нет данных (null) — серый прочерк.
 */
export function ToyCostIndicator({ status }: { status: ToyCostStatus | null }) {
  const level = status ? status.level : 'none';
  const word = status ? status.label : 'нет данных';
  const title = status ? `Затраты на игрушки ${status.percent} % выручки. ${status.hint}` : 'Нет данных о затратах на игрушки';
  return (
    <span className={`tci tci-${level}`} title={title}>
      <span className="tci-ico">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICON[level]} /></svg>
      </span>
      <span className="tci-txt">
        <b>{status ? `${status.percent}%` : '—'}</b>
        <small>{word}</small>
      </span>
    </span>
  );
}
