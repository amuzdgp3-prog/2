import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { formatMoney } from '../../calc';
import type { Location, TabProps } from './types';
import { Section } from './shared/Section';
import { LocationRentCard } from './machines/LocationRentCard';

interface PlacementHistoryRow {
  id: number;
  machine_number: string;
  started_at: string;
  ended_at: string | null;
  initial_game_counter: number;
  initial_prize_counter: number;
  final_game_counter: number;
  final_prize_counter: number;
}

interface AddressFinancePeriod {
  revenue: string;
  cash: string;
  cashless: string;
}

interface AddressHistoryData {
  id: number;
  name: string;
  status: string;
  created_at: string;
  closed_at: string | null;
  placements: PlacementHistoryRow[];
  finance: { monthToDate: AddressFinancePeriod; lastMonth: AddressFinancePeriod; allTime: AddressFinancePeriod };
  terminals: Array<{ id: number; serial: string; label: string; machine_number: string; started_at: string; ended_at: string | null }>;
}

const formatDateTime = (value: string | null) => (value ? new Date(value).toLocaleString('ru-RU') : '—');

/** История одного Адреса — раскрывается прямо под карточкой при клике, без отдельного роута. */

function AddressHistory({ locationId, onError }: { locationId: number; onError: (error: unknown) => void }) {
  const [data, setData] = useState<AddressHistoryData | null>(null);
  const [period, setPeriod] = useState<'monthToDate' | 'lastMonth' | 'allTime'>('monthToDate');

  useEffect(() => {
    api.get<AddressHistoryData>(`/api/locations/${locationId}/history`).then(setData).catch(onError);
  }, [locationId]);

  if (!data) return <p className="muted">Загрузка…</p>;
  const finance = data.finance[period];

  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted">
        Создан: {formatDateTime(data.created_at)}{data.closed_at ? ` · Закрыт: ${formatDateTime(data.closed_at)}` : ''}
      </div>

      <div className="row" style={{ gap: 6, marginTop: 10 }}>
        {(['monthToDate', 'lastMonth', 'allTime'] as const).map((key) => (
          <button
            key={key}
            style={period === key ? { background: 'var(--brass)', borderColor: 'var(--brass)', color: '#fff' } : undefined}
            onClick={() => setPeriod(key)}
          >
            {key === 'monthToDate' ? 'С начала месяца' : key === 'lastMonth' ? 'Прошлый месяц' : 'Всё время'}
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 24, marginTop: 8 }}>
        <div><span className="muted">Выручка</span><div>{formatMoney(finance.revenue)}</div></div>
        <div><span className="muted">Нал</span><div>{formatMoney(finance.cash)}</div></div>
        <div><span className="muted">Безнал</span><div>{formatMoney(finance.cashless)}</div></div>
      </div>

      <div className="muted" style={{ marginTop: 14 }}>Аппараты на этом адресе</div>
      <div className="table-wrap scroll-x" style={{ marginTop: 6 }}>
        <table>
          <thead>
            <tr>
              <th>Аппарат</th><th>С</th><th>По</th><th>Счётчик старт</th><th>Счётчик сейчас</th>
            </tr>
          </thead>
          <tbody>
            {data.placements.map((p) => (
              <tr key={p.id}>
                <td>{p.machine_number}</td>
                <td>{formatDateTime(p.started_at)}</td>
                <td>{p.ended_at ? formatDateTime(p.ended_at) : 'сейчас'}</td>
                <td>{p.initial_game_counter}</td>
                <td>{p.final_game_counter}</td>
              </tr>
            ))}
            {data.placements.length === 0 && (
              <tr><td colSpan={5} className="muted">Аппаратов ещё не было.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="muted" style={{ marginTop: 14 }}>Терминалы</div>
      <div className="table-wrap scroll-x" style={{ marginTop: 6 }}>
        <table>
          <thead>
            <tr><th>Серийный</th><th>Аппарат</th><th>С</th><th>По</th></tr>
          </thead>
          <tbody>
            {data.terminals.map((t) => (
              <tr key={`${t.id}:${t.started_at}`}>
                <td>{t.serial}</td>
                <td>{t.machine_number}</td>
                <td>{formatDateTime(t.started_at)}</td>
                <td>{t.ended_at ? formatDateTime(t.ended_at) : 'сейчас'}</td>
              </tr>
            ))}
            {data.terminals.length === 0 && (
              <tr><td colSpan={4} className="muted">Терминалов не было.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Адреса — точки по договору (10_ТЗ). Организация по городам/районам/произвольным признакам
 * теперь целиком на вкладке «Каталог» (см. CatalogTab) — здесь адрес только создаётся и
 * закрывается/деактивируется; вложенность (родительская точка) в интерфейсе больше не выставляется.
 */

export function LocationsTab({ onDone, onError }: TabProps) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('Europe/Moscow');
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = () => api.get<Location[]>('/api/locations').then(setLocations).catch(onError);
  useEffect(() => {
    void load();
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/locations', { name, timezone });
      onDone(`Адрес «${name}» создан`);
      setName('');
      await load();
    } catch (caught) {
      onError(caught);
    }
  };

  const setStatus = async (id: number, status: string) => {
    try {
      await api.post(`/api/locations/${id}/status`, { status });
      onDone('Статус обновлён');
      await load();
    } catch (caught) {
      onError(caught);
    }
  };

  const active = locations.filter((l) => l.status !== 'CLOSED');
  const closed = locations.filter((l) => l.status === 'CLOSED');

  const renderCard = (location: Location) => (
    <div className="card" key={location.id}>
      <div className="row" style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === location.id ? null : location.id)}>
        <div>
          <strong>{location.name}</strong>
          <div className="muted">{location.timezone} · {location.status}</div>
        </div>
        <div className="row" style={{ gap: 6 }} onClick={(event) => event.stopPropagation()}>
          {location.status === 'ACTIVE' && (
            <button onClick={() => setStatus(location.id, 'DEACTIVATED')}>Деактивировать</button>
          )}
          {location.status === 'DEACTIVATED' && (
            <button onClick={() => setStatus(location.id, 'ACTIVE')}>Активировать</button>
          )}
        </div>
      </div>
      {location.status === 'CLOSED' && (
        <div className="muted" style={{ marginTop: 8 }}>
          Договор расторгнут. История сохранена, новые обслуживания запрещены.
        </div>
      )}
      {expanded === location.id && (
        <div className="stack" style={{ marginTop: 12 }}>
          <LocationRentCard locationId={location.id} onDone={onDone} onError={onError} />
          <AddressHistory locationId={location.id} onError={onError} />
        </div>
      )}
    </div>
  );

  return (
    <>
      <form onSubmit={create}>
        <Section title="Новый адрес">
          <div className="stack">
            <div>
              <label>Название / адрес</label>
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </div>
            <div>
              <label>Часовой пояс (IANA)</label>
              <input value={timezone} onChange={(event) => setTimezone(event.target.value)} required />
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Часовой пояс адреса — единственный источник бизнес-времени для его отчётности.
              Организация по городам/районам/типам — на вкладке «Каталог».
            </p>
            <button className="primary" type="submit">Создать</button>
          </div>
        </Section>
      </form>

      {active.map(renderCard)}

      {closed.length > 0 && (
        <details className="card">
          <summary style={{ cursor: 'pointer' }}>Закрытые адреса ({closed.length})</summary>
          <div style={{ marginTop: 10 }}>{closed.map(renderCard)}</div>
        </details>
      )}
    </>
  );
}
