import { useAuth } from '../auth';
import { useDashboard } from './dashboard/useDashboard';
import { DailySummaryCard } from './dashboard/DailySummaryCard';
import type { RevenueRow, RoiRow, RevenueParts, RevenuePeriod } from './dashboard/types';
import './dashboard/Dashboard.css';
import { formatMoney } from '../calc';
import { MachineTag } from '../components/ui/MachineTag';
import { RoiBadge } from '../components/ui/RoiBadge';

function RevenueBreakdown({ parts }: { parts: RevenueParts | undefined }) {
  if (!parts) return null;
  return <div className="dashboard-breakdown">
    <div><span className="muted">Нал</span><span>{formatMoney(parts.cash)} ₽</span></div>
    <div><span className="muted">Безнал</span><span>{formatMoney(parts.cashless)} ₽</span></div>
  </div>;
}

function RankedTable({ title, rows, metric }: { title: string; rows: RevenueRow[] | RoiRow[]; metric: 'revenue' | 'roi' }) {
  return (
    <div className={`card card-pad dashboard-ranked-table ${metric === 'revenue' ? 'dashboard-revenue-ranked' : ''}`} style={{ marginBottom: 14 }}>
      <div className="muted" style={{ marginBottom: 8 }}>{title}</div>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>Нет данных за месяц</p>
      ) : (
        <div className="table-wrap scroll-x">
          <table>
            <tbody>
              {rows.map((row) => (
                <tr key={row.machineNumber}>
                  <td><MachineTag number={row.machineNumber} /></td>
                  <td className="wrap">{row.locationName}</td>
                  <td className="right mono">
                    {metric === 'revenue' ? <>
                      {formatMoney((row as RevenueRow).revenue)} ₽
                      <div className="muted dashboard-rank-breakdown">Нал {formatMoney((row as RevenueRow).cash)} ₽ · Безнал {formatMoney((row as RevenueRow).cashless)} ₽</div>
                    </> : <RoiBadge value={(row as RoiRow).roi} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Сводка (docs/design/mockups/05_admin_dashboard.html): фиксированные KPI-периоды и топ/худшие-10. */
export default function DashboardScreen() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const { data, daily, error, dailyError } = useDashboard(user?.id, isAdmin);
  if (!data) return error ? <div className="alert error" role="status">{error}</div> : <p className="muted">Загрузка…</p>;
  const periods: Array<[RevenuePeriod, string]> = [
    ['monthToDate', 'С начала месяца'], ['weekToDate', 'За текущую неделю'],
    ['lastMonth', 'За прошлый месяц'], ['yearToDate', 'За текущий год'],
  ];

  return (
    <>
      {error && <div className="alert error" role="status">{error} Показаны последние полученные данные.</div>}
      <div className="kpi-row dashboard-kpis">
        <div className="kpi">
          <div className="lbl">Активных аппаратов</div>
          <div className="val">{data.counts.activeMachines}</div>
          <div className="sub">из {data.counts.totalMachines} всего</div>
        </div>
        <div className="kpi">
          <div className="lbl">Активных терминалов</div>
          <div className="val">{data.counts.activeTerminals}</div>
          <div className="sub">из {data.counts.totalTerminals} всего</div>
        </div>
        {periods.map(([period, label]) => <div className="kpi" key={period}>
          <div className="lbl">{label}</div>
          <div className="val mono">{formatMoney(data.revenue[period])} ₽</div>
          <RevenueBreakdown parts={data.revenueBreakdown?.[period]} />
        </div>)}
      </div>

      {isAdmin && <DailySummaryCard data={daily} error={dailyError} />}

      <div className="muted" style={{ margin: '4px 0 10px', fontSize: 12 }}>
        Рейтинги — за текущий месяц (с 1 числа по сегодня)
      </div>
      <div className="row2 dashboard-rankings" style={{ alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Лучшие</div>
          <RankedTable title="Топ 10 по выручке" rows={data.topRevenue} metric="revenue" />
          <RankedTable title="Топ 10 по ROI" rows={data.topRoi} metric="roi" />
        </div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Худшие</div>
          <RankedTable title="Худшие 10 по выручке" rows={data.worstRevenue} metric="revenue" />
          <RankedTable title="Худшие 10 по ROI" rows={data.worstRoi} metric="roi" />
        </div>
      </div>
    </>
  );
}
