import { useEffect, useState } from 'react';
import { api } from '../../api';
import { formatMoney } from '../../calc';
import { formatDate } from '../../dateFormat';
import { MachineTag } from '../../components/ui/MachineTag';

interface AnomalyRow {
  id: number;
  machine_number: string;
  service_date: string;
  revenue: string;
  cashless_amount: string;
  cash_amount: string;
}

const now = new Date();
const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

export function FinancialAnomaliesTab() {
  const [month, setMonth] = useState(currentMonth);
  const [rows, setRows] = useState<AnomalyRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ rows: AnomalyRow[] }>('/api/admin/financial-anomalies')
      .then((result) => setRows(result.rows))
      .catch((caught) => setError((caught as Error).message));
  }, []);

  if (error) return <div className="alert error">{error}</div>;

  const visible = rows.filter((row) => row.service_date.startsWith(month));
  const differenceKopecks = visible.reduce((total, row) => total + Math.round(Number(row.cash_amount) * 100), 0);

  return (
    <div className="card card-pad">
      <div className="form-row" style={{ alignItems: 'end', marginBottom: 14 }}>
        <label>Месяц <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
        <strong>Разница по отмеченным обслуживаниям: {formatMoney(differenceKopecks / 100)} ₽</strong>
      </div>
      {visible.length === 0 ? <p className="muted">За выбранный месяц записей нет.</p> : (
        <div className="table-wrap scroll-x">
          <table>
            <thead>
              <tr>
                <th>Аппарат</th><th>Дата</th><th className="right">Выручка, ₽</th>
                <th className="right">Безнал, ₽</th><th className="right">Разница, ₽</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id}>
                  <td><MachineTag number={row.machine_number} /></td>
                  <td>{formatDate(row.service_date)}</td>
                  <td className="right mono">{formatMoney(row.revenue)}</td>
                  <td className="right mono">{formatMoney(row.cashless_amount)}</td>
                  <td className="right mono">{formatMoney(row.cash_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
