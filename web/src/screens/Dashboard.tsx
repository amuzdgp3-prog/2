import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatMoney } from '../calc';
import { MachineTag } from '../components/ui/MachineTag';
import { RoiBadge } from '../components/ui/RoiBadge';

interface RevenueRow {
  machineNumber: string;
  locationName: string;
  revenue: string;
}

interface RoiRow {
  machineNumber: string;
  locationName: string;
  roi: string;
}

interface DashboardData {
  counts: { activeMachines: number; totalMachines: number; activeTerminals: number; totalTerminals: number };
  revenue: { monthToDate: string; weekToDate: string; lastMonth: string; yearToDate: string };
  topRevenue: RevenueRow[];
  worstRevenue: RevenueRow[];
  topRoi: RoiRow[];
  worstRoi: RoiRow[];
  anomalies: Array<{ id: number; machine_number: string; service_date: string; revenue: string; cashless_amount: string }>;
}

function RankedTable({ title, rows, metric }: { title: string; rows: RevenueRow[] | RoiRow[]; metric: 'revenue' | 'roi' }) {
  return (
    <div className="card card-pad" style={{ marginBottom: 14 }}>
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
                    {metric === 'revenue' ? `${formatMoney((row as RevenueRow).revenue)} ₽` : <RoiBadge value={(row as RoiRow).roi} />}
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
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<DashboardData>('/api/dashboard').then(setData).catch((caught) => setError((caught as Error).message));
  }, []);

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <p className="muted">Загрузка…</p>;

  return (
    <>
      <div className="kpi-row">
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
        <div className="kpi">
          <div className="lbl">С начала месяца</div>
          <div className="val mono">{formatMoney(data.revenue.monthToDate)} ₽</div>
        </div>
        <div className="kpi">
          <div className="lbl">За текущую неделю</div>
          <div className="val mono">{formatMoney(data.revenue.weekToDate)} ₽</div>
        </div>
        <div className="kpi">
          <div className="lbl">За прошлый месяц</div>
          <div className="val mono">{formatMoney(data.revenue.lastMonth)} ₽</div>
        </div>
        <div className="kpi">
          <div className="lbl">За текущий год</div>
          <div className="val mono">{formatMoney(data.revenue.yearToDate)} ₽</div>
        </div>
      </div>

      {data.anomalies.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div className="alert warn" style={{ marginBottom: 10 }}>
            Финансовые расхождения: безнал больше выручки. Данные не подгоняются автоматически.
          </div>
          <div className="table-wrap scroll-x">
            <table>
              <thead>
                <tr><th>Аппарат</th><th>Дата</th><th className="right">Выручка</th><th className="right">Безнал</th></tr>
              </thead>
              <tbody>
                {data.anomalies.map((row) => (
                  <tr key={row.id}>
                    <td>{row.machine_number}</td>
                    <td>{row.service_date}</td>
                    <td className="right mono">{formatMoney(row.revenue)}</td>
                    <td className="right mono">{formatMoney(row.cashless_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="muted" style={{ margin: '4px 0 10px', fontSize: 12 }}>
        Рейтинги — за текущий месяц (с 1 числа по сегодня)
      </div>
      <div className="row2" style={{ alignItems: 'flex-start' }}>
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
