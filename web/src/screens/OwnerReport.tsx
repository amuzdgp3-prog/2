import { useEffect, useState } from 'react';
import { api, getToken } from '../api';
import { formatGames, formatMoney } from '../calc';

interface MonthlyRow {
  monthStart: string;
  services: number;
  newGames: string;
  revenue: string;
  toyCost: string;
  profit: string;
  roi: string | null;
  expensesTotal: string;
  netProfit: string;
  cashless: string;
  paidToOwner: string;
  reachedOwner: string;
}

const MONTH_NAMES_FULL = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

function monthLabel(monthStart: string): string {
  const date = new Date(monthStart);
  return `${MONTH_NAMES_FULL[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthKey(monthStart: string): string {
  const date = new Date(monthStart);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function Delta({ current, previous }: { current: string; previous?: string }) {
  if (previous === undefined) return null;
  const currentValue = Number(current);
  const previousValue = Number(previous);
  if (previousValue === 0) return null;
  const pct = ((currentValue - previousValue) / Math.abs(previousValue)) * 100;
  const color = pct >= 0 ? 'var(--good)' : 'var(--bad)';
  return (
    <span style={{ color, fontSize: 12, marginLeft: 6 }}>
      {pct >= 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/**
 * Страница владельца — сразу после дашборда: отчёт за прошлый месяц по умолчанию, с возможностью
 * листать по месяцам и таблицей сравнения (только таблица, без графиков — по явному запросу
 * владельца). Данные — тот же единый расчётный слой (`domain/reports.ts` monthlyReport), что и
 * вкладка «Отчёты», просто другое представление.
 */
export default function OwnerReportScreen() {
  const [rows, setRows] = useState<MonthlyRow[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    api.get<MonthlyRow[]>('/api/reports/monthly?months=12')
      .then((data) => {
        setRows(data);
        if (data.length === 0) return;
        const lastIsCurrentMonth = monthKey(data[data.length - 1].monthStart) === currentMonthKey();
        const defaultIndex = lastIsCurrentMonth ? data.length - 2 : data.length - 1;
        setSelectedIndex(Math.max(defaultIndex, 0));
      })
      .catch((caught) => setError((caught as Error).message));
  }, []);

  const selected = selectedIndex !== null ? rows[selectedIndex] : null;
  const previous = selectedIndex !== null && selectedIndex > 0 ? rows[selectedIndex - 1] : undefined;

  const downloadExcel = async () => {
    if (!selected) return;
    const date = new Date(selected.monthStart);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    setDownloading(true);
    try {
      const response = await fetch(`/api/reports/monthly-excel?year=${year}&month=${month}`, {
        headers: { authorization: `Bearer ${getToken()}` },
      });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Отчет ${year}-${String(month).padStart(2, '0')}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  if (error) return <div className="alert error">{error}</div>;
  if (selectedIndex === null) return <p className="muted">Загрузка…</p>;
  if (!selected) return <p className="muted">Пока нет данных ни за один месяц</p>;

  return (
    <>
      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <button
            onClick={() => setSelectedIndex((i) => Math.max((i ?? 0) - 1, 0))}
            disabled={selectedIndex === 0}
          >
            ← Раньше
          </button>
          <strong style={{ flex: 1, textAlign: 'center' }}>{monthLabel(selected.monthStart)}</strong>
          <button
            onClick={() => setSelectedIndex((i) => Math.min((i ?? 0) + 1, rows.length - 1))}
            disabled={selectedIndex === rows.length - 1}
          >
            Позже →
          </button>
        </div>
      </div>

      <div className="card">
        <div className="muted">Выручка</div>
        <div className="big mono">
          {formatMoney(selected.revenue)} ₽
          <Delta current={selected.revenue} previous={previous?.revenue} />
        </div>
        <div className="muted mono" style={{ marginTop: 10 }}>
          Себестоимость игрушек: {formatMoney(selected.toyCost)} ₽ · Расходы бизнеса: {formatMoney(selected.expensesTotal)} ₽
        </div>
        <div className="mono" style={{ marginTop: 6 }}>
          Чистая прибыль: <strong>{formatMoney(selected.netProfit)} ₽</strong>
          <Delta current={selected.netProfit} previous={previous?.netProfit} />
        </div>
        <div className="mono" style={{ marginTop: 6 }}>
          Дошло до владельца: <strong>{formatMoney(selected.reachedOwner)} ₽</strong>
          <Delta current={selected.reachedOwner} previous={previous?.reachedOwner} />
        </div>
        <div className="muted mono" style={{ marginTop: 2, fontSize: 12.5 }}>
          Безнал напрямую: {formatMoney(selected.cashless)} ₽ · На карту переводом: {formatMoney(selected.paidToOwner)} ₽
        </div>
        <div className="muted mono" style={{ marginTop: 6 }}>
          Новых игр: {formatGames(selected.newGames)} · Обслуживаний: {selected.services} ·
          {' '}ROI: {selected.roi ?? '—'}
        </div>
        <button className="primary" style={{ marginTop: 12 }} onClick={downloadExcel} disabled={downloading}>
          {downloading ? 'Формирую…' : 'Скачать отчёт (xlsx)'}
        </button>
      </div>

      <div className="card">
        <div className="muted" style={{ marginBottom: 10 }}>Сравнение по месяцам</div>
        <div className="table-wrap scroll-x">
          <table>
            <thead>
              <tr>
                <th>Месяц</th>
                <th className="num">Выручка</th>
                <th className="num">Игрушки</th>
                <th className="num">Расходы</th>
                <th className="num">Чистая прибыль</th>
                <th className="num">ROI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={row.monthStart}
                  className="tappable"
                  style={i === selectedIndex ? { fontWeight: 700, background: 'var(--row-highlight, rgba(91,141,239,0.08))' } : undefined}
                  onClick={() => setSelectedIndex(i)}
                >
                  <td>{monthLabel(row.monthStart)}</td>
                  <td className="num">{formatMoney(row.revenue)} ₽</td>
                  <td className="num">{formatMoney(row.toyCost)} ₽</td>
                  <td className="num">{formatMoney(row.expensesTotal)} ₽</td>
                  <td className="num">{formatMoney(row.netProfit)} ₽</td>
                  <td className="num">{row.roi ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
