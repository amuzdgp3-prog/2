import { useEffect, useState } from 'react';
import { api } from '../api';
import { daysSince, formatGames, formatMoney } from '../calc';
import { adviceText, adviseClaw, formatVolts, type ClawState } from '../clawAdvice';
import { formatDate, formatDateTime } from '../dateFormat';
import type { CachedMachine } from '../db';
import { toyCostStatus } from '../toyCostStatus';
import './PreviousService.css';

type RoiPoint = { service_date: string; revenue_to_cost_ratio: string | null };

const formatPercent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format;

function savedAdvice(state: ClawState | null | undefined) {
  if (!state) return { title: 'Совет недоступен', detail: 'Для аппарата нет данных о настройке клешни.' };

  const { advice } = adviseClaw({ ...state, totals: state.since });
  switch (advice.kind) {
    case 'no-settings':
      return { title: 'Указать настройку Weak', detail: 'Проверьте Weak Catch на аппарате и укажите его в разделе «Клешня».' };
    case 'no-data':
      return { title: 'Мало данных', detail: 'Для расчёта отдачи нужна выручка после последней настройки.' };
    case 'early':
      return {
        title: 'Пока не менять',
        detail: `С последней настройки сыграно ${formatGames(advice.games)} из ${advice.minGames} игр, необходимых для оценки.`,
      };
    case 'ok':
    case 'change':
    case 'limit': {
      const title = advice.kind === 'ok' ? 'Оставить настройки' : advice.kind === 'limit'
        ? 'Проверить клешню'
        : `${advice.direction === 'lower' ? 'Снизить' : 'Повысить'} ${advice.param === 'weak' ? 'Weak' : 'Medium'} до ${formatVolts(advice.to)} В`;
      const payout = `Отдача ${formatPercent(advice.payoutPercent)}% за ${formatGames(advice.games)} игр с последней настройки. Норма ${formatPercent(state.band.low)}–${formatPercent(state.band.high)}%.`;
      const correction = advice.kind === 'change'
        ? `${advice.param === 'weak' ? 'Weak Catch' : 'Medium'} ${formatVolts(advice.from)} → ${formatVolts(advice.to)} В. `
        : advice.kind === 'limit' ? `${adviceText(advice)}. ` : '';
      return { title, detail: correction + payout, attention: advice.kind !== 'ok' };
    }
  }
}

function metric(value: string | number, label: string) {
  return <div className="previous-service-metric"><span>{label}</span><b className="mono">{value}</b></div>;
}

export function PreviousService({ machine, toys }: {
  machine: CachedMachine;
  toys: Array<{ id: number; name: string }>;
}) {
  const [trend, setTrend] = useState<RoiPoint[]>([]);
  const { machine_number: machineNumber, last_service_at: lastServiceAt, claw_state: clawState } = machine;

  useEffect(() => {
    if (!lastServiceAt || !navigator.onLine) return;
    let active = true;
    void api.get<RoiPoint[]>(`/api/machines/${encodeURIComponent(machineNumber)}/roi-trend?limit=2`)
      .then((points) => { if (active) setTrend(points); })
      .catch(() => { if (active) setTrend([]); });
    return () => { active = false; };
  }, [machineNumber, lastServiceAt]);

  if (!lastServiceAt) return null;

  const latest = trend.at(-1);
  const previous = trend.at(-2);
  const latestPercent = toyCostStatus(latest ? latest.revenue_to_cost_ratio : machine.last_revenue_to_cost_ratio)?.percent;
  const previousPercent = toyCostStatus(previous?.revenue_to_cost_ratio)?.percent;
  const trendLabel = latestPercent === undefined ? 'ROI —' : previousPercent === undefined
    ? `ROI ${latestPercent}%` : `ROI ${previousPercent}% → ${latestPercent}%`;
  const journalDetail = latestPercent === undefined ? 'Нет данных о доле затрат в последней записи.'
    : previous && previousPercent !== undefined && latest
      ? `${formatDate(previous.service_date)} · ${previousPercent}% → ${formatDate(latest.service_date)} · ${latestPercent}%`
      : `${formatDate(latest?.service_date ?? lastServiceAt)} · ${latestPercent}%`;
  const advice = savedAdvice(clawState);
  const age = daysSince(lastServiceAt);
  const ageLabel = age === null || age < 0 ? '' : age === 0 ? '< 1 дн.' : `${age} дн.`;
  const toyList = Object.entries(machine.last_toy_quantities ?? {}).flatMap(([id, quantity]) => {
    const toy = toys.find((item) => item.id === Number(id));
    return toy ? [`${toy.name} ×${quantity}`] : [];
  }).join(', ');

  return (
    <section className="readonly-prev previous-service" aria-labelledby="previous-service-title">
      <header className="previous-service-header">
        <h2 id="previous-service-title">Прошлое обслуживание</h2>
        <span><time dateTime={lastServiceAt}>{formatDateTime(lastServiceAt)}</time>{ageLabel && ` · ${ageLabel}`}</span>
      </header>
      <details className={`previous-service-advice${advice.attention ? ' needs-attention' : ''}`}>
        <summary>
          <strong>{advice.title}</strong>
          <span className="previous-service-trend">{trendLabel}</span>
        </summary>
        <div className="previous-service-detail">
          <strong>Совет по сохранённым данным</strong>
          <p>{advice.detail}</p>
          <strong>Доля выручки на игрушки по журналу</strong>
          <p>{journalDetail}</p>
        </div>
      </details>
      <div className="previous-service-groups">
        <div className="previous-service-group">
          <h3>Игры</h3>
          {metric(machine.previous_game_counter, 'Счётчик')}
          {metric(machine.last_new_games == null ? '—' : `+${formatGames(machine.last_new_games)}`, 'Новых игр')}
        </div>
        <div className="previous-service-group">
          <h3>Деньги</h3>
          {metric(machine.last_revenue == null ? '—' : `${formatMoney(machine.last_revenue)} ₽`, 'Выручка')}
          {metric(machine.last_toy_cost == null ? '—' : `${formatMoney(machine.last_toy_cost)} ₽`, 'Игрушки')}
        </div>
      </div>
      {toyList && <p className="previous-service-toys">{toyList}</p>}
    </section>
  );
}
