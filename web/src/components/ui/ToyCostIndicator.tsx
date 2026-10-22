import type { ToyCostView } from '../../serviceToyCost';

const ICON: Record<ToyCostView['level'], string> = {
  low: 'M12 19V5M5 12l7-7 7 7',
  high: 'M12 5v14M5 12l7 7 7-7',
  ok: 'M5 12.5l4.5 4.5L19 7.5',
  idle: 'M9 7v10M15 7v10',
  none: 'M6 12h12',
};

/**
 * Доля затрат на игрушки в выручке: стрелка направления, число и слово. Стрелка вверх — отдачу
 * надо увеличить, вниз — уменьшить. Расчёт статуса — в toyCostStatus.ts; компонент только рисует.
 * «Мало игр» (idle) и «нет данных» (none, или null) — серые, без процента.
 */
export function ToyCostIndicator({ status }: { status: ToyCostView | null }) {
  const level = status ? status.level : 'none';
  const word = status ? status.label : 'нет данных';
  const title = !status
    ? 'Нет данных о затратах на игрушки'
    : status.percent === null
      ? status.hint
      : `Затраты на игрушки ${status.percent} % выручки. ${status.hint}`;
  return (
    <span className={`tci tci-${level}`} title={title}>
      <span className="tci-ico">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICON[level]} /></svg>
      </span>
      <span className="tci-txt">
        <b>{status && status.percent !== null ? `${status.percent}%` : '—'}</b>
        <small>{word}</small>
      </span>
    </span>
  );
}
