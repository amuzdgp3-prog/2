import { useEffect, useState } from 'react';
import { api, getToken } from '../api';
import { useAuth } from '../auth';
import { formatGames, formatMoney } from '../calc';

interface MachineRow {
  machineNumber: string;
  machineType: string;
  counterDivisor: string;
  services: number;
  newGames: string;
  revenue: string;
  cashless: string;
  cash: string;
  toyCost: string;
  lastRevenueToCostRatio: string | null;
}

interface LocationRow {
  locationId: number;
  locationName: string;
  services: number;
  newGames: string;
  revenue: string;
  cashless: string;
  cash: string;
  toyCost: string;
  machines: MachineRow[];
}

interface ReportResponse {
  locations: LocationRow[];
  totals: { services: number; newGames: string; revenue: string; cashless: string; cash: string; toyCost: string };
}

interface MonthlyRow {
  monthStart: string;
  services: number;
  newGames: string;
  revenue: string;
  toyCost: string;
  profit: string;
  roi: string | null;
}

const MONTH_NAMES = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const FULL_MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

function MonthlyChart({ rows }: { rows: MonthlyRow[] }) {
  if (rows.length === 0) return null;
  const maxTotal = Math.max(...rows.map((row) => Number(row.revenue) + Number(row.toyCost)), 1);
  const chartHeight = 180;

  return (
    <div className="chart-card">
      <div className="head">
        <h3>Выручка и себестоимость по месяцам</h3>
        <div className="chart-legend">
          <span><i style={{ background: 'var(--brass)' }} />Выручка</span>
          <span><i style={{ background: 'var(--ink-faint)', opacity: 0.55 }} />Себестоимость игрушек</span>
        </div>
      </div>
      <div className="bars">
        {rows.map((row) => {
          const revenue = Number(row.revenue);
          const cost = Number(row.toyCost);
          const total = revenue + cost;
          const stackHeight = Math.round((total / maxTotal) * chartHeight);
          const revenueHeight = total > 0 ? Math.round((revenue / total) * stackHeight) : 0;
          const costHeight = stackHeight - revenueHeight;
          const date = new Date(row.monthStart);
          return (
            <div className="bargroup" key={row.monthStart}>
              <div className="stack" style={{ height: stackHeight }}>
                <div className="rev" style={{ height: revenueHeight }} />
                <div className="cost" style={{ height: costHeight }} />
              </div>
              <div className="m">{MONTH_NAMES[date.getMonth()]}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ReportsScreen() {
  const { user } = useAuth();
  const [from, setFrom] = useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const now = new Date();
  const [excelYear, setExcelYear] = useState(now.getFullYear());
  const [excelMonth, setExcelMonth] = useState(now.getMonth() + 1);
  const [excelBusy, setExcelBusy] = useState(false);
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [telegramNotice, setTelegramNotice] = useState<string | null>(null);
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [locationId, setLocationId] = useState('');
  const [classifiers, setClassifiers] = useState<Array<{ id: number; name: string; parent_id: number | null }>>([]);
  const [classifierId, setClassifierId] = useState('');
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [technicians, setTechnicians] = useState<Array<Record<string, string | number>>>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const query = new URLSearchParams({
    from, to, ...(locationId ? { locationId } : {}), ...(classifierId ? { classifierId } : {}),
  }).toString();

  useEffect(() => {
    api.get<Array<{ id: number; name: string }>>('/api/locations').then(setLocations).catch(() => undefined);
    api.get<Array<{ id: number; name: string; parent_id: number | null }>>('/api/classifiers')
      .then(setClassifiers).catch(() => undefined);
  }, []);

  const loadReport = () => {
    setLoading(true);
    setError(null);
    const monthlyQuery = new URLSearchParams({
      months: '6', ...(locationId ? { locationId } : {}), ...(classifierId ? { classifierId } : {}),
    }).toString();
    Promise.all([
      api.get<ReportResponse>(`/api/reports/financial?${query}`).then(setReport),
      api.get<MonthlyRow[]>(`/api/reports/monthly?${monthlyQuery}`).then(setMonthly).catch(() => setMonthly([])),
      api
        .get<Array<Record<string, string | number>>>(`/api/reports/technicians?${query}`)
        .then(setTechnicians)
        .catch(() => setTechnicians([])),
    ])
      .catch((caught) => setError((caught as Error).message))
      .finally(() => setLoading(false));
  };

  // Меняя дату или точку, отчёт обновляется сам — кнопка «Показать» ниже делает то же самое по
  // явному запросу, для тех, кто ждёт видимого подтверждения, что фильтр применился.
  useEffect(loadReport, [query]);

  const downloadCsv = async () => {
    const response = await fetch(`/api/reports/export.csv?${query}`, {
      headers: { authorization: `Bearer ${getToken()}` },
    });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `apixspb-${from}-${to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadMonthlyExcel = async () => {
    setExcelBusy(true);
    try {
      const response = await fetch(`/api/reports/monthly-excel?year=${excelYear}&month=${excelMonth}`, {
        headers: { authorization: `Bearer ${getToken()}` },
      });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Отчет ${excelYear}-${String(excelMonth).padStart(2, '0')}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExcelBusy(false);
    }
  };

  const sendMonthlyExcelToTelegram = async () => {
    setTelegramBusy(true);
    setTelegramNotice(null);
    try {
      await api.post(`/api/reports/monthly-excel/send-telegram?year=${excelYear}&month=${excelMonth}`, {});
      setTelegramNotice('Отчёт отправлен в Telegram');
    } catch (caught) {
      setTelegramNotice(`Не удалось отправить: ${(caught as Error).message}`);
    } finally {
      setTelegramBusy(false);
    }
  };

  return (
    <>
      {error && <div className="alert error">{error}</div>}

      <div className="card stack">
        <div className="grid-2">
          <div>
            <label htmlFor="from">С</label>
            <input id="from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div>
            <label htmlFor="to">По</label>
            <input id="to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
        </div>
        <div>
          <label htmlFor="catalog">Узел каталога (включая вложенные)</label>
          <select id="catalog" value={classifierId} onChange={(event) => setClassifierId(event.target.value)}>
            <option value="">Весь каталог</option>
            {[...classifiers].sort((a, b) => a.name.localeCompare(b.name, 'ru')).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="location">Точка (включая вложенные, устаревающий способ)</label>
          <select id="location" value={locationId} onChange={(event) => setLocationId(event.target.value)}>
            <option value="">Все точки</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>{location.name}</option>
            ))}
          </select>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="primary" onClick={loadReport} disabled={loading} style={{ flex: 1 }}>
            {loading ? 'Загрузка…' : 'Показать'}
          </button>
          <button onClick={downloadCsv}>Выгрузить CSV</button>
        </div>
      </div>

      <div className="card stack">
        <div className="muted">Ежемесячный отчёт (та же форма, что для собственника)</div>
        <div className="grid-2">
          <div>
            <label htmlFor="excel-month">Месяц</label>
            <select id="excel-month" value={excelMonth} onChange={(event) => setExcelMonth(Number(event.target.value))}>
              {FULL_MONTH_NAMES.map((name, i) => (
                <option key={name} value={i + 1}>{name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="excel-year">Год</label>
            <input
              id="excel-year"
              type="number"
              value={excelYear}
              onChange={(event) => setExcelYear(Number(event.target.value))}
            />
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="primary" onClick={downloadMonthlyExcel} disabled={excelBusy} style={{ flex: 1 }}>
            {excelBusy ? 'Формирую…' : 'Сформировать отчёт (xlsx)'}
          </button>
          {user?.role === 'ADMIN' && (
            <button onClick={sendMonthlyExcelToTelegram} disabled={telegramBusy}>
              {telegramBusy ? 'Отправляю…' : 'Отправить в Telegram'}
            </button>
          )}
        </div>
        {telegramNotice && <div className="muted">{telegramNotice}</div>}
      </div>

      <MonthlyChart rows={monthly} />

      {monthly.length > 0 && (
        <div className="table-wrap scroll-x" style={{ marginBottom: 20 }}>
          <table>
            <thead>
              <tr>
                <th>Период</th>
                <th className="num">Обслуживаний</th>
                <th className="num">Новых игр</th>
                <th className="num">Выручка</th>
                <th className="num">Себестоимость</th>
                <th className="num">Прибыль</th>
                <th className="num">ROI</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((row) => (
                <tr key={row.monthStart}>
                  <td>{new Date(row.monthStart).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</td>
                  <td className="num">{row.services}</td>
                  <td className="num">{formatGames(row.newGames)}</td>
                  <td className="num">{formatMoney(row.revenue)} ₽</td>
                  <td className="num">{formatMoney(row.toyCost)} ₽</td>
                  <td className="num">{formatMoney(row.profit)} ₽</td>
                  <td className="num" style={{ color: row.roi === null ? undefined : Number(row.roi) >= 3 ? 'var(--good)' : Number(row.roi) >= 2 ? 'var(--warn)' : 'var(--bad)', fontWeight: 700 }}>
                    {row.roi ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {technicians.length > 0 && (
        <div className="table-wrap scroll-x" style={{ marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 8px' }}>По техникам за период</h3>
          <div className="muted" style={{ marginBottom: 8, fontSize: 12.5 }}>
            Факты за период, а не оценка эффективности: выручка здесь — та, что собрана в выезды
            этого техника, и зависит от маршрута не меньше, чем от работы. Служебные учётные записи
            в таблицу не входят.
          </div>
          <table>
            <thead>
              <tr>
                <th>Техник</th>
                <th className="num">Выездов</th>
                <th className="num">Аппаратов</th>
                <th className="num">Игрушек</th>
                <th className="num">Новых игр</th>
                <th className="num">Собрано</th>
                <th className="num">Нал</th>
                <th className="num">Безнал</th>
                <th className="num">Себест. игрушек</th>
              </tr>
            </thead>
            <tbody>
              {technicians.map((row) => (
                <tr key={String(row.id)}>
                  <td>{String(row.full_name)}</td>
                  <td className="num">{String(row.services)}</td>
                  <td className="num">{String(row.machines)}</td>
                  <td className="num">{String(row.toys_given)}</td>
                  <td className="num">{formatGames(String(row.new_games))}</td>
                  <td className="num">{formatMoney(String(row.revenue))} ₽</td>
                  <td className="num">{formatMoney(String(row.cash))} ₽</td>
                  <td className="num">{formatMoney(String(row.cashless))} ₽</td>
                  <td className="num">{formatMoney(String(row.toy_cost))} ₽</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report && (
        <>
          <div className="card">
            <div className="muted">Итого за период</div>
            <div className="big mono">{formatMoney(report.totals.revenue)} ₽</div>
            <div className="muted mono">
              нал {formatMoney(report.totals.cash)} · безнал {formatMoney(report.totals.cashless)} ·
              игры {formatGames(report.totals.newGames)}
            </div>
          </div>

          {report.locations.map((location) => (
            <div className="card" key={location.locationId}>
              <div
                className="row tappable"
                onClick={() => setExpanded(expanded === location.locationId ? null : location.locationId)}
              >
                <div>
                  <strong>{location.locationName}</strong>
                  <div className="muted">{location.machines.length} аппаратов · {location.services} обсл.</div>
                </div>
                <div className="right mono">
                  <strong>{formatMoney(location.revenue)} ₽</strong>
                  <div className="muted">{expanded === location.locationId ? 'свернуть' : 'детализация'}</div>
                </div>
              </div>

              {expanded === location.locationId && (
                <div className="table-wrap scroll-x" style={{ marginTop: 10 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Аппарат</th>
                        <th className="right">Игры</th>
                        <th className="right">Выручка</th>
                        <th className="right">Нал</th>
                        <th className="right">Безнал</th>
                        <th className="right">Выручка/себест.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {location.machines.map((machine) => (
                        <tr key={machine.machineNumber}>
                          <td>
                            № {machine.machineNumber}
                            {Number(machine.counterDivisor) !== 1 && (
                              <span className="divisor-tag" style={{ marginLeft: 6 }}>
                                ÷{Number(machine.counterDivisor)}
                              </span>
                            )}
                          </td>
                          <td className="right mono">{formatGames(machine.newGames)}</td>
                          <td className="right mono">{formatMoney(machine.revenue)}</td>
                          <td className="right mono">{formatMoney(machine.cash)}</td>
                          <td className="right mono">{formatMoney(machine.cashless)}</td>
                          <td className="right mono">
                            {/* Значение приходит с сервера; клиент его не пересчитывает. */}
                            {machine.lastRevenueToCostRatio === null
                              ? <span className="muted">нет данных</span>
                              : Number(machine.lastRevenueToCostRatio).toLocaleString('ru-RU', {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </>
  );
}
