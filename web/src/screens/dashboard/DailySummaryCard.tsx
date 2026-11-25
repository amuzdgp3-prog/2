import { formatMoney } from '../../calc';
import type { DailySummary } from './types';

function duration(start: string, finish: string): string {
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const elapsed = Math.max(0, minutes(finish) - minutes(start));
  return `${Math.floor(elapsed / 60)} ч ${String(elapsed % 60).padStart(2, '0')} мин`;
}

export function DailySummaryCard({ data, error }: { data: DailySummary | null; error: string | null }) {
  const rows = [...(data?.technicians ?? [])].sort((a, b) => b.machines - a.machines || a.start.localeCompare(b.start));
  const cashCents = rows.reduce((sum, row) => sum + Math.round(row.cash * 100), 0);
  const cashlessCents = rows.reduce((sum, row) => sum + Math.round(row.cashless * 100), 0);
  return (
    <section className="card dashboard-day" aria-label="Итоги дня по техникам">
      <div className="dashboard-day-header">
        <div><h2>Итоги дня</h2>{data && <div className="muted">{new Date(`${data.date}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })} · МСК</div>}</div>
        {data && <span className="muted">Техников: {rows.length} · Аппаратов: {rows.reduce((sum, row) => sum + row.machines, 0)}</span>}
      </div>
      {error && <p role="status" className="alert error">{error}{data && ' Показаны последние полученные данные.'}</p>}
      {!data ? <p className="muted">{error ? 'Ожидаем данные.' : 'Загрузка…'}</p> : <>
        <div className="dashboard-day-totals">
          <div><span className="muted">Выручка за день</span><strong className="mono">{formatMoney((cashCents + cashlessCents) / 100)} ₽</strong></div>
          <div><span className="muted">Нал</span><strong className="mono">{formatMoney(cashCents / 100)} ₽</strong></div>
          <div><span className="muted">Безнал</span><strong className="mono">{formatMoney(cashlessCents / 100)} ₽</strong></div>
        </div>
        {rows.length === 0 ? <p className="muted">Обслуживаний за день не было.</p> : <table className="dashboard-day-table">
          <thead><tr><th>Техник</th><th className="right">Аппаратов</th><th>Время работы</th><th className="right">Выручка, ₽</th><th className="right">Нал, ₽</th><th className="right">Безнал, ₽</th></tr></thead>
          <tbody>{rows.map((row, index) => <tr key={`${row.name}-${index}`}>
            <td><strong>{row.name}</strong></td>
            <td className="right"><span className="dashboard-mobile-label">Аппаратов</span>{row.machines}</td>
            <td><span className="dashboard-mobile-label">Время работы</span><span className="dashboard-hours">{duration(row.start, row.finish)}</span><small className="muted dashboard-range">{row.start} → {row.finish}</small></td>
            <td className="right mono"><span className="dashboard-mobile-label">Выручка, ₽</span>{formatMoney((Math.round(row.cash * 100) + Math.round(row.cashless * 100)) / 100)}</td>
            <td className="right mono"><span className="dashboard-mobile-label">Нал, ₽</span>{formatMoney(row.cash)}</td>
            <td className="right mono"><span className="dashboard-mobile-label">Безнал, ₽</span>{formatMoney(row.cashless)}</td>
          </tr>)}</tbody>
        </table>}
        <p className="muted dashboard-day-note">По обслуживаниям за день. Время — от первого до последнего обслуживания.</p>
      </>}
    </section>
  );
}
