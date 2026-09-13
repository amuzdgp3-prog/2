import { useEffect, useState } from 'react';
import { api } from '../../api';
import { formatMoney } from '../../calc';
import { MachineTag } from '../../components/ui/MachineTag';
import { RoiBadge } from '../../components/ui/RoiBadge';
import type { TabProps } from './types';
import { Section } from './shared/Section';

interface ToyForecastRow {
  toyId: number;
  name: string;
  unitCost: string;
  monthly: Array<{ monthStart: string; quantity: number; cost: string }>;
  forecastNextMonth: { quantity: number; cost: string };
}

interface MachineConsumptionRow {
  machineNumber: string;
  locationName: string;
  services: number;
  newGames: string;
  revenue: string;
  toyCost: string;
  ratio: number | null;
  quantities: Record<string, number>;
  modifiedZScore: number | null;
  anomaly: 'HIGH_CONSUMPTION' | 'LOW_CONSUMPTION' | null;
}

interface ToyTypeTotal {
  toyId: number;
  name: string;
  quantity: number;
  cost: string;
}

const ANOMALY_LABELS: Record<string, { text: string; className: string }> = {
  HIGH_CONSUMPTION: { text: 'слишком щедрый', className: 'badge-bad' },
  LOW_CONSUMPTION: { text: 'слишком жёсткий', className: 'badge-warn' },
};

function monthStartInput(offset = 0): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 10);
}

function todayInput(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Расход игрушек (докладная владельца): план закупки на следующий месяц по каждой игрушке и
 * поиск аппаратов с аномальным соотношением себестоимости игрушек к выручке — как «слишком
 * щедрых» (игрушек тратится непропорционально много), так и «слишком жёстких» (наоборот, риск
 * того, что аппарат вообще не платит и отпугивает игроков) — относительно МЕДИАНЫ по флоту за
 * тот же период (устойчива к самим выбросам, в отличие от среднего), а не фиксированного порога.
 * Колонка «Игры» — прокси клиентского трафика, чтобы низкий ROI при большом потоке игроков и
 * низкий ROI при малом потоке не читались как один и тот же случай.
 */

export function ConsumptionTab({ onError }: TabProps) {
  const [forecast, setForecast] = useState<ToyForecastRow[]>([]);
  const [machines, setMachines] = useState<MachineConsumptionRow[]>([]);
  const [toyTotals, setToyTotals] = useState<ToyTypeTotal[]>([]);
  const [fleetStats, setFleetStats] = useState<{ meanRatio: number | null; medianRatio: number | null; mad: number | null; sampleSize: number } | null>(null);
  const [from, setFrom] = useState(monthStartInput());
  const [to, setTo] = useState(todayInput());
  const [toyNames, setToyNames] = useState<Record<string, string>>({});
  const [sortBy, setSortBy] = useState<'ratio' | 'toyCost'>('ratio');
  const [showAnomaliesOnly, setShowAnomaliesOnly] = useState(false);

  useEffect(() => {
    api.get<ToyForecastRow[]>('/api/reports/toy-forecast?months=6').then(setForecast).catch(onError);
    api.get<Array<{ id: number; name: string }>>('/api/toys').then((toys) => {
      setToyNames(Object.fromEntries(toys.map((t) => [String(t.id), t.name])));
    }).catch(() => setToyNames({}));
  }, []);

  useEffect(() => {
    api
      .get<{ machines: MachineConsumptionRow[]; toyTotals: ToyTypeTotal[]; fleetStats: typeof fleetStats }>(
        `/api/reports/toy-consumption?from=${from}&to=${to}`,
      )
      .then((data) => {
        setMachines(data.machines);
        setToyTotals(data.toyTotals);
        setFleetStats(data.fleetStats);
      })
      .catch(onError);
  }, [from, to]);

  const sortedMachines = [...machines]
    .filter((m) => !showAnomaliesOnly || m.anomaly)
    .sort((a, b) => {
      if (sortBy === 'ratio') return (a.ratio ?? Infinity) - (b.ratio ?? Infinity);
      return Number(b.toyCost) - Number(a.toyCost);
    });
  const anomalyCount = machines.filter((m) => m.anomaly).length;

  return (
    <>
      <Section title="Прогноз закупки на следующий месяц (по среднему за последние до 3 месяцев с данными)">
        <div className="table-wrap scroll-x">
          <table>
            <thead>
              <tr>
                <th>Игрушка</th>
                <th className="num">Цена</th>
                {forecast[0]?.monthly.slice(-3).map((m) => (
                  <th key={m.monthStart} className="num">{new Date(m.monthStart).toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' })}</th>
                ))}
                <th className="num">Прогноз, шт</th>
                <th className="num">Прогноз, ₽</th>
              </tr>
            </thead>
            <tbody>
              {forecast.map((row) => (
                <tr key={row.toyId}>
                  <td>{row.name}</td>
                  <td className="num mono">{formatMoney(row.unitCost)} ₽</td>
                  {row.monthly.slice(-3).map((m) => (
                    <td key={m.monthStart} className="num mono">{m.quantity}</td>
                  ))}
                  <td className="num mono"><strong>{row.forecastNextMonth.quantity}</strong></td>
                  <td className="num mono">{formatMoney(row.forecastNextMonth.cost)} ₽</td>
                </tr>
              ))}
              {forecast.length === 0 && (
                <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>Пока нет данных о расходе игрушек</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Расход по аппаратам за период — зависимость от выручки">
        <div className="filters-panel" style={{ marginBottom: 12 }}>
          <div className="fld">
            <label>Период с</label>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="fld">
            <label>по</label>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="fld">
            <label>Сортировать по</label>
            <select value={sortBy} onChange={(event) => setSortBy(event.target.value as 'ratio' | 'toyCost')}>
              <option value="ratio">ROI (сначала худшие)</option>
              <option value="toyCost">Себестоимость игрушек</option>
            </select>
          </div>
        </div>

        {fleetStats?.medianRatio != null && (
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
            ROI по флоту за период — медиана: {fleetStats.medianRatio.toFixed(2)}, среднее: {fleetStats.meanRatio?.toFixed(2) ?? '—'}
            {' '}(выборка {fleetStats.sampleSize} аппаратов, не менее 3 обслуживаний за период). Медиана устойчивее к выбросам —
            именно от неё считается отклонение аппарата.
            {anomalyCount > 0 && (
              <>
                {' '}
                <strong>Найдено отклонений: {anomalyCount}.</strong>{' '}
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ padding: '2px 10px', fontSize: 12 }}
                  onClick={() => setShowAnomaliesOnly((value) => !value)}
                >
                  {showAnomaliesOnly ? 'Показать все аппараты' : `Показать только отклонения (${anomalyCount})`}
                </button>
              </>
            )}
          </p>
        )}

        <div className="table-wrap scroll-x">
          <table>
            <thead>
              <tr>
                <th>Аппарат</th>
                <th>Точка</th>
                <th className="num">Обсл.</th>
                <th className="num">Игры</th>
                <th className="num">Выручка</th>
                <th className="num">Игрушки, ₽</th>
                <th>ROI</th>
                <th>По игрушкам</th>
                <th>Отклонение</th>
              </tr>
            </thead>
            <tbody>
              {sortedMachines.map((row) => {
                const anomaly = row.anomaly ? ANOMALY_LABELS[row.anomaly] : null;
                return (
                  <tr key={row.machineNumber}>
                    <td><MachineTag number={row.machineNumber} /></td>
                    <td>{row.locationName}</td>
                    <td className="num">{row.services}</td>
                    <td className="num mono">{Math.round(Number(row.newGames))}</td>
                    <td className="num mono">{formatMoney(row.revenue)} ₽</td>
                    <td className="num mono">{formatMoney(row.toyCost)} ₽</td>
                    <td><RoiBadge value={row.ratio} /></td>
                    <td className="muted wrap" style={{ fontSize: 12 }}>
                      {Object.entries(row.quantities).map(([toyId, qty]) => `${toyNames[toyId] ?? toyId}: ${qty}`).join(', ') || '—'}
                    </td>
                    <td>
                      {anomaly ? <span className={`badge ${anomaly.className}`}><span className="badge-dot" />{anomaly.text}</span> : '—'}
                    </td>
                  </tr>
                );
              })}
              {sortedMachines.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                    {showAnomaliesOnly ? 'Нет аппаратов с отклонением за выбранный период' : 'Нет обслуживаний за выбранный период'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Итого по видам игрушек за период">
        <div className="table-wrap scroll-x">
        <table>
          <thead>
            <tr>
              <th>Игрушка</th>
              <th className="num">Количество, шт</th>
              <th className="num">Сумма (по фактической цене выдачи), ₽</th>
            </tr>
          </thead>
          <tbody>
            {toyTotals.map((row) => (
              <tr key={row.toyId}>
                <td>{row.name}</td>
                <td className="num mono">{row.quantity}</td>
                <td className="num mono">{formatMoney(row.cost)} ₽</td>
              </tr>
            ))}
            {toyTotals.length === 0 && (
              <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 16 }}>Нет обслуживаний за выбранный период</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </Section>
    </>
  );
}
