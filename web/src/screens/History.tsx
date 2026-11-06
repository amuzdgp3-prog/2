import { formatDate, formatTime } from '../dateFormat';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { formatMoney } from '../calc';
import { machineQrValue, QrCode } from '../components/ui/QrCode';
import { RoiBadge } from '../components/ui/RoiBadge';
import { ReplaceMachineForm } from './ReplaceMachine';
import { MachineClawPanel } from '../components/claw/MachineClawPanel';
import { readCachedMachines, type CachedMachine } from '../db';
import { ServiceHistory } from './history/ServiceHistory';
import type { ServiceRow } from './history/types';
import './history/MachineCard.css';

interface RouteRow {
  id: number;
  name: string;
}

interface TechnicianRow {
  id: number;
  full_name: string;
  login: string;
  source: 'location' | 'machine' | 'classifier';
}

type Tab = 'history' | 'claw' | 'routes' | 'technicians';

/** Карточка аппарата: согласованный вариант «Обзор и журнал», DECISION-099. */
export default function HistoryScreen() {
  const { machineNumber = '' } = useParams();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('history');
  const [showQr, setShowQr] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [machineInfo, setMachineInfo] = useState<CachedMachine | undefined>();
  // Сначала офлайн-каталог, затем актуальные данные: прямая ссылка работает и с пустым кэшем.
  const hasClaw = Boolean(machineInfo?.claw_state);
  const band = machineInfo?.claw_state?.band.target != null ? machineInfo.claw_state.band : undefined;
  useEffect(() => {
    let cancelled = false;
    setMachineInfo(undefined);
    const apply = (machines: CachedMachine[]) => {
      if (!cancelled) setMachineInfo(machines.find((item) => item.machine_number === machineNumber));
    };
    void (async () => {
      try { apply(await readCachedMachines()); } catch { /* Пустой/недоступный кэш не блокирует сеть. */ }
      try { apply(await api.get<CachedMachine[]>('/api/machines')); } catch { /* Офлайн остаётся кэш. */ }
    })();
    return () => { cancelled = true; };
  }, [machineNumber]);

  const load = () =>
    api
      .get<{ rows: ServiceRow[] }>(`/api/services?machineNumber=${encodeURIComponent(machineNumber)}&limit=200`)
      .then((response) => setRows(response.rows))
      .catch((caught) => setError((caught as Error).message));

  useEffect(() => {
    void load();
  }, [machineNumber]);

  const stats = useMemo(() => {
    if (rows.length === 0) return null;
    const revenue = rows.reduce((total, row) => total + Number(row.revenue), 0);
    const cash = rows.reduce((total, row) => total + Number(row.cash_amount), 0);
    const cashless = rows.reduce((total, row) => total + Number(row.cashless_amount), 0);
    const toyCost = rows.reduce((total, row) => total + Number(row.toy_cost), 0);
    const ratios = rows.map((row) => row.revenue_to_cost_ratio).filter((v): v is string => v !== null);
    const averageRoi = ratios.length > 0 ? ratios.reduce((a, b) => a + Number(b), 0) / ratios.length : null;

    const toyTotals = new Map<string, { quantity: number; cost: number }>();
    for (const row of rows) {
      for (const toy of row.toys ?? []) {
        const entry = toyTotals.get(toy.name) ?? { quantity: 0, cost: 0 };
        entry.quantity += toy.quantity;
        entry.cost += toy.quantity * Number(toy.unitCost);
        toyTotals.set(toy.name, entry);
      }
    }
    const toyBreakdown = [...toyTotals.entries()]
      .map(([name, totals]) => ({ name, ...totals }))
      .sort((a, b) => b.cost - a.cost);

    return { revenue, cash, cashless, toyCost, averageRoi, toyBreakdown, count: rows.length, currentCounter: rows[0].game_counter };
  }, [rows]);

  const remove = async (id: number) => {
    if (!confirm('Удалить обслуживание? Цепочка аппарата будет пересчитана.')) return;
    try {
      await api.delete(`/api/services/${id}`);
      setNotice('Обслуживание удалено, цепочка пересчитана');
      await load();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  return (
    <div className="machine-card-overview">
      <nav className="mch-breadcrumb" aria-label="Навигация карточки">
        <Link to="/">Аппараты</Link><span aria-hidden="true">›</span><span>Карточка аппарата</span>
      </nav>
      <header className="mch-header">
        <div className="mch-identity">
          <span className="mch-machine-number" aria-label={`Аппарат № ${machineNumber}`}>{machineNumber}</span>
          <div>
            <h1>{machineInfo?.location_name || rows[0]?.location_name || `Аппарат № ${machineNumber}`}</h1>
            <div className="mch-meta">
              {machineInfo && <><span>{machineInfo.machine_type}</span><span>Цена игры {formatMoney(machineInfo.price_per_game)} ₽</span></>}
              <span>{rows.length > 0 ? `Обслуживаний: ${rows.length}` : 'Обслуживаний ещё не было'}</span>
            </div>
          </div>
        </div>
        <div className="mch-header-actions">
          {user?.role !== 'BOSS' && <Link className="mch-button mch-primary" to={`/service/${encodeURIComponent(machineNumber)}`}><span aria-hidden="true">＋</span> Обслуживание</Link>}
          <details className="mch-more">
            <summary className="mch-button" aria-label="Другие действия с аппаратом"><span aria-hidden="true">⋯</span></summary>
            <div className="mch-more-menu">
              <button type="button" onClick={(event) => { setShowQr(!showQr); event.currentTarget.closest('details')?.removeAttribute('open'); }}>QR-код аппарата</button>
              {user?.role === 'ADMIN' && <button type="button" onClick={(event) => { setShowReplace(!showReplace); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Заменить аппарат</button>}
            </div>
          </details>
        </div>
      </header>

      {showQr && <div className="mch-qr-panel">
        <QrCode value={machineQrValue(machineNumber)} />
        <p>Наклейте на корпус аппарата — сканирование откроет форму обслуживания напрямую</p>
        <button type="button" onClick={() => setShowQr(false)}>Скрыть QR-код</button>
      </div>}
      {showReplace && user?.role === 'ADMIN' && <ReplaceMachineForm oldMachineNumber={machineNumber} onDone={(message) => { setNotice(message); setShowReplace(false); }} onError={(caught) => setError((caught as Error).message)} />}
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert ok" role="status">{notice}</div>}

      {stats && <>
        <div className="mch-stats">
          <div className="mch-stat"><div className="mch-stat-label">Выручка</div><div className="mch-stat-value">{formatMoney(stats.revenue)} <small>₽</small></div><div className="mch-stat-note">Нал {formatMoney(stats.cash)} · безнал {formatMoney(stats.cashless)}</div></div>
          <div className="mch-stat"><div className="mch-stat-label">Себестоимость игрушек</div><div className="mch-stat-value">{formatMoney(stats.toyCost)} <small>₽</small></div><div className="mch-stat-note">Добавлено при обслуживании</div></div>
          <div className="mch-stat"><div className="mch-stat-label">Средний ROI</div><div className="mch-stat-value">{stats.averageRoi === null ? '—' : stats.averageRoi.toFixed(2)}</div><div className="mch-stat-note"><RoiBadge value={stats.averageRoi} band={band} /></div></div>
          <div className="mch-stat"><div className="mch-stat-label">Счётчик игр</div><div className="mch-stat-value">{stats.currentCounter}</div><div className="mch-stat-note">Показание от {formatDate(rows[0].service_date)}</div></div>
        </div>
        <div className="mch-range"><span>Сводка по последним обслуживаниям: {stats.count}{stats.count === 200 ? ' (не более 200 последних)' : ''}</span><span>Последнее: {formatDate(rows[0].service_date)}, {formatTime(rows[0].occurred_at)}</span></div>
      </>}

      <div className="mch-tabs" role="tablist" aria-label="Разделы карточки аппарата">
        {([
          { id: 'history', label: 'История', visible: true },
          { id: 'claw', label: 'Клешня и отдача', visible: hasClaw },
          { id: 'routes', label: 'Маршруты', visible: true },
          { id: 'technicians', label: 'Техники', visible: user?.role === 'ADMIN' },
        ] as const).filter((item) => item.visible).map((item) => <button key={item.id} type="button" id={`mch-tab-${item.id}`} role="tab" aria-controls="mch-active-panel" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>

      <section id="mch-active-panel" className="mch-active-panel" role="tabpanel" aria-labelledby={`mch-tab-${tab}`}>
        {tab === 'history' && <>
          <div className="mch-section-heading"><h2>История обслуживаний</h2><span>{rows.length} записей</span></div>
          {rows.length === 0 && !error && <p className="muted">Обслуживаний пока нет.</p>}
          {rows.length > 0 && <ServiceHistory rows={rows} isAdmin={user?.role === 'ADMIN'} editing={editing} onEdit={setEditing} onRemove={remove} renderEditor={(row) => <EditServiceForm row={row} onDone={async (message) => { setNotice(message); setEditing(null); await load(); }} onError={(caught) => setError((caught as Error).message)} />} />}
          {stats && stats.toyBreakdown.length > 0 && <details className="mch-toy-breakdown">
            <summary><span>Себестоимость игрушек по видам <span className="mch-muted">· {formatMoney(stats.toyCost)} ₽</span></span><span aria-hidden="true">⌄</span></summary>
            <div className="mch-table-scroll"><table>
              <thead><tr><th>Игрушка</th><th className="num">Количество</th><th className="num">Сумма</th></tr></thead>
              <tbody>{stats.toyBreakdown.map((toy) => <tr key={toy.name}><td>{toy.name}</td><td className="num">{toy.quantity}</td><td className="num">{formatMoney(toy.cost)} ₽</td></tr>)}</tbody>
            </table></div>
          </details>}
        </>}
        {tab === 'claw' && <MachineClawPanel machineNumber={machineNumber} canEditTarget={user?.role === 'ADMIN'} canEditValues={user?.role === 'ADMIN' || user?.role === 'TECHNICIAN'} />}
        {tab === 'routes' && <RoutesTab machineNumber={machineNumber} isAdmin={user?.role === 'ADMIN'} />}
        {tab === 'technicians' && <TechniciansTab machineNumber={machineNumber} isAdmin={user?.role === 'ADMIN'} />}
      </section>
    </div>
  );
}

function RoutesTab({ machineNumber, isAdmin }: { machineNumber: string; isAdmin: boolean }) {
  const [assigned, setAssigned] = useState<RouteRow[]>([]);
  const [all, setAll] = useState<RouteRow[]>([]);
  const [choice, setChoice] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.get<RouteRow[]>(`/api/machines/${encodeURIComponent(machineNumber)}/routes`).then(setAssigned).catch((e) => setError((e as Error).message));
    api.get<RouteRow[]>('/api/routes').then(setAll).catch(() => setAll([]));
  };

  useEffect(load, [machineNumber]);

  const available = all.filter((route) => !assigned.some((a) => a.id === route.id));

  const assign = async () => {
    if (!choice) return;
    try {
      await api.post('/api/routes/assign', { machineNumber, routeId: Number(choice) });
      setNotice('Маршрут привязан');
      setChoice('');
      load();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const unassign = async (routeId: number) => {
    try {
      await api.delete('/api/routes/assign', { machineNumber, routeId });
      setNotice('Маршрут отвязан');
      load();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  return (
    <div className="card card-pad">
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      {assigned.length === 0 && <p className="muted">Аппарат не привязан ни к одному маршруту.</p>}
      <div className="chip-row">
        {assigned.map((route) => (
          <span className="chip" key={route.id}>
            {route.name}
            {isAdmin && <button onClick={() => unassign(route.id)} title="Отвязать">×</button>}
          </span>
        ))}
      </div>

      {isAdmin && (
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <select value={choice} onChange={(event) => setChoice(event.target.value)}>
            <option value="">— выберите маршрут —</option>
            {available.map((route) => (
              <option key={route.id} value={route.id}>{route.name}</option>
            ))}
          </select>
          <button className="btn btn-ghost" disabled={!choice} onClick={assign}>Привязать</button>
        </div>
      )}
    </div>
  );
}

function TechniciansTab({ machineNumber, isAdmin }: { machineNumber: string; isAdmin: boolean }) {
  const [technicians, setTechnicians] = useState<TechnicianRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get<TechnicianRow[]>(`/api/machines/${encodeURIComponent(machineNumber)}/technicians`)
      .then(setTechnicians)
      .catch((caught) => setError((caught as Error).message));
  }, [machineNumber, isAdmin]);

  if (!isAdmin) return <p className="muted">Доступно только администратору.</p>;
  if (error) return <div className="alert error">{error}</div>;
  if (!technicians) return <p className="muted">Загрузка…</p>;

  return (
    <div className="card card-pad">
      <div className="muted" style={{ marginBottom: 8 }}>
        Техники, у которых есть доступ к этому аппарату — через точку, каталог или точечное назначение
      </div>
      {technicians.length === 0 && <p className="muted" style={{ marginBottom: 0 }}>Ни один техник ещё не имеет доступа.</p>}
      {technicians.length > 0 && (
        <table>
          <thead><tr><th>Техник</th><th>Логин</th><th>Источник доступа</th></tr></thead>
          <tbody>
            {technicians.map((tech) => (
              <tr key={tech.id}>
                <td>{tech.full_name}</td>
                <td className="mono">{tech.login}</td>
                <td>{tech.source === 'machine' ? 'точечно' : tech.source === 'classifier' ? 'через каталог' : 'через точку'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EditServiceForm({
  row,
  onDone,
  onError,
}: {
  row: ServiceRow;
  onDone: (message: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [gameCounter, setGameCounter] = useState(String(row.game_counter));
  const [prizeCounter, setPrizeCounter] = useState(String(row.prize_counter));
  const [testGames, setTestGames] = useState(String(row.test_games));
  const [notes, setNotes] = useState(row.notes);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.patch(`/api/services/${row.id}`, {
        gameCounter: Number(gameCounter),
        prizeCounter: Number(prizeCounter),
        testGames: Number(testGames),
        notes,
      });
      await onDone('Запись изменена, цепочка пересчитана');
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <form onSubmit={submit} style={{ marginTop: 12 }}>
      <div className="stack">
        <div className="grid-2">
          <div>
            <label>Счётчик игр</label>
            <input type="number" value={gameCounter} onChange={(e) => setGameCounter(e.target.value)} />
          </div>
          <div>
            <label>Счётчик призов</label>
            <input type="number" value={prizeCounter} onChange={(e) => setPrizeCounter(e.target.value)} />
          </div>
        </div>
        <div>
          <label>Тестовые игры</label>
          <input type="number" value={testGames} onChange={(e) => setTestGames(e.target.value)} />
        </div>
        <div>
          <label>Комментарий</label>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Наличные и безнал не редактируются — сервер пересчитает их сам, вместе со всеми
          последующими обслуживаниями аппарата.
        </p>
        <button className="btn btn-primary" type="submit">Сохранить</button>
      </div>
    </form>
  );
}
