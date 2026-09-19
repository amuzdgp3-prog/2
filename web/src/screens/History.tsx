import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, getToken } from '../api';
import { useAuth } from '../auth';
import { formatGames, formatMoney } from '../calc';
import { MachineTag } from '../components/ui/MachineTag';
import { Odometer } from '../components/ui/Odometer';
import { PhotoThumbnail } from '../components/ui/PhotoLightbox';
import { machineQrValue, QrCode } from '../components/ui/QrCode';
import { RoiBadge } from '../components/ui/RoiBadge';
import { ReplaceMachineForm } from './ReplaceMachine';

interface ServiceRow {
  id: number;
  service_date: string;
  occurred_at: string;
  game_counter: number;
  prize_counter: number;
  test_games: number;
  new_games: string;
  new_prizes: number;
  revenue: string;
  cash_amount: string;
  cashless_amount: string;
  toy_cost: string;
  counter_divisor_applied: string;
  price_per_game_snapshot: string;
  revenue_to_cost_ratio: string | null;
  is_financial_anomaly: boolean;
  photo_object_key: string;
  notes: string;
  kind: string;
  technician_name: string | null;
  location_name: string;
}

interface RouteRow {
  id: number;
  name: string;
}

interface TechnicianRow {
  id: number;
  full_name: string;
  login: string;
  source: 'location' | 'machine';
}

interface InitialToyRow {
  toy_id: number;
  name: string;
  quantity: number;
  unit_cost_snapshot: string;
}

type Tab = 'history' | 'toys' | 'routes' | 'technicians';

/** Карточка аппарата (docs/design/mockups/06_admin_machine_card.html): статистика + вкладки. */
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
  const [openPhoto, setOpenPhoto] = useState<number | null>(null);

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
    const ratios = rows.map((row) => row.revenue_to_cost_ratio).filter((v): v is string => v !== null);
    const averageRoi = ratios.length > 0 ? ratios.reduce((a, b) => a + Number(b), 0) / ratios.length : null;
    return { revenue, averageRoi, count: rows.length, currentCounter: rows[0].game_counter };
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
    <>
      <div className="mc-header">
        <div className="left">
          <MachineTag number={machineNumber} size="lg" />
          <div>
            <h1 style={{ fontSize: 20 }}>{rows[0]?.location_name ? rows[0].location_name : `Аппарат № ${machineNumber}`}</h1>
            <div className="sub">{rows.length > 0 ? `${rows.length} обслуживаний в истории` : 'обслуживаний ещё не было'}</div>
          </div>
        </div>
        <div className="btns">
          {user?.role === 'ADMIN' && (
            <button className="btn btn-ghost" onClick={() => setShowReplace(!showReplace)}>
              ⇄ Заменить аппарат
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => setShowQr(!showQr)}>▥ QR-код</button>
          {user?.role !== 'BOSS' && (
            <Link to={`/service/${encodeURIComponent(machineNumber)}`}>
              <button className="btn btn-primary">Новое обслуживание</button>
            </Link>
          )}
        </div>
      </div>

      {showQr && (
        <div className="card card-pad" style={{ marginBottom: 16, textAlign: 'center' }}>
          <QrCode value={machineQrValue(machineNumber)} />
          <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
            Наклейте на корпус аппарата — сканирование откроет форму обслуживания напрямую
          </p>
        </div>
      )}

      {showReplace && user?.role === 'ADMIN' && (
        <ReplaceMachineForm
          oldMachineNumber={machineNumber}
          onDone={(message) => {
            setNotice(message);
            setShowReplace(false);
          }}
          onError={(caught) => setError((caught as Error).message)}
        />
      )}

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      {stats && (
        <div className="mc-stats">
          <div className="kpi">
            <div className="lbl">Счётчик игр</div>
            <div className="val"><Odometer value={stats.currentCounter} /></div>
          </div>
          <div className="kpi">
            <div className="lbl">Выручка (загружено)</div>
            <div className="val mono">{formatMoney(stats.revenue)} ₽</div>
          </div>
          <div className="kpi">
            <div className="lbl">Средний ROI</div>
            <div className="val"><RoiBadge value={stats.averageRoi} /></div>
          </div>
          <div className="kpi">
            <div className="lbl">Обслуживаний</div>
            <div className="val">{stats.count}</div>
          </div>
        </div>
      )}

      <div className="mc-tabs">
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>История</button>
        <button className={tab === 'toys' ? 'active' : ''} onClick={() => setTab('toys')}>Игрушки</button>
        <button className={tab === 'routes' ? 'active' : ''} onClick={() => setTab('routes')}>Маршруты</button>
        <button className={tab === 'technicians' ? 'active' : ''} onClick={() => setTab('technicians')}>Техники</button>
      </div>

      {tab === 'history' && (
        <>
          {rows.length === 0 && !error && <p className="muted">Обслуживаний пока нет.</p>}
          {rows.map((row) => (
            <div className="card card-pad" key={row.id} style={{ marginBottom: 12 }}>
              <div className="row">
                <div>
                  <strong>{row.service_date}</strong>
                  {row.kind === 'FINAL' && <span className="chip" style={{ marginLeft: 8 }}>финальное</span>}
                  <div className="muted">
                    {new Date(row.occurred_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    {row.technician_name ? ` · ${row.technician_name}` : ''}
                  </div>
                </div>
                <div className="right">
                  <div className="mono big">{formatMoney(row.revenue)} ₽</div>
                  <div className="muted mono">{formatGames(row.new_games)} игр</div>
                </div>
              </div>

              {row.is_financial_anomaly && (
                <div className="alert warn" style={{ marginTop: 10, marginBottom: 0 }}>
                  Безнал больше выручки — расхождение отмечено, значения не подгонялись.
                </div>
              )}

              <div className="table-wrap scroll-x" style={{ marginTop: 10 }}>
                <table>
                  <tbody>
                    <tr>
                      <td className="wrap">Счётчик игр / призов</td>
                      <td className="right mono">{row.game_counter} / {row.prize_counter}</td>
                    </tr>
                    <tr>
                      <td className="wrap">Тестовые игры</td>
                      <td className="right mono">{row.test_games}</td>
                    </tr>
                    <tr>
                      <td className="wrap">Коэффициент и цена на момент записи</td>
                      <td className="right mono">
                        ÷{Number(row.counter_divisor_applied)} · {formatMoney(row.price_per_game_snapshot)} ₽
                      </td>
                    </tr>
                    <tr>
                      <td className="wrap">Нал / безнал</td>
                      <td className="right mono">{formatMoney(row.cash_amount)} / {formatMoney(row.cashless_amount)}</td>
                    </tr>
                    <tr>
                      <td className="wrap">Себестоимость игрушек</td>
                      <td className="right mono">{formatMoney(row.toy_cost)} ₽</td>
                    </tr>
                    <tr>
                      <td className="wrap">Выручка / себестоимость</td>
                      <td className="right mono">
                        {row.revenue_to_cost_ratio === null ? <span className="muted">нет данных</span> : Number(row.revenue_to_cost_ratio).toFixed(2)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {row.notes && <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>{row.notes}</p>}

              <div className="row" style={{ marginTop: 10 }}>
                <button onClick={() => setOpenPhoto(openPhoto === row.id ? null : row.id)}>
                  {openPhoto === row.id ? 'Скрыть фото' : 'Фото счётчика'}
                </button>
                {user?.role === 'ADMIN' && (
                  <div className="row" style={{ gap: 6 }}>
                    <button onClick={() => setEditing(editing === row.id ? null : row.id)}>
                      {editing === row.id ? 'Отмена' : 'Изменить'}
                    </button>
                    <button className="icon-btn danger" onClick={() => remove(row.id)}>✕</button>
                  </div>
                )}
              </div>

              {openPhoto === row.id && (
                <PhotoThumbnail src={`/api/photos/${row.photo_object_key}?token=${getToken()}`} alt="Фото счётчика" />
              )}

              {editing === row.id && (
                <EditServiceForm
                  row={row}
                  onDone={async (message) => {
                    setNotice(message);
                    setEditing(null);
                    await load();
                  }}
                  onError={(caught) => setError((caught as Error).message)}
                />
              )}
            </div>
          ))}
        </>
      )}

      {tab === 'toys' && <ToysTab machineNumber={machineNumber} />}
      {tab === 'routes' && <RoutesTab machineNumber={machineNumber} isAdmin={user?.role === 'ADMIN'} />}
      {tab === 'technicians' && <TechniciansTab machineNumber={machineNumber} isAdmin={user?.role === 'ADMIN'} />}
    </>
  );
}

function ToysTab({ machineNumber }: { machineNumber: string }) {
  const [toys, setToys] = useState<InitialToyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<InitialToyRow[]>(`/api/machines/${encodeURIComponent(machineNumber)}/initial-toys`)
      .then(setToys)
      .catch((caught) => setError((caught as Error).message));
  }, [machineNumber]);

  if (error) return <div className="alert error">{error}</div>;
  if (!toys) return <p className="muted">Загрузка…</p>;

  return (
    <div className="card card-pad">
      <div className="muted" style={{ marginBottom: 8 }}>
        Начальные игрушки текущей установки — состояние при монтаже, не входят в себестоимость первого обслуживания
      </div>
      {toys.length === 0 && <p className="muted" style={{ marginBottom: 0 }}>Начальных игрушек не указано.</p>}
      {toys.length > 0 && (
        <table>
          <thead><tr><th>Игрушка</th><th className="num">Количество</th><th className="num">Цена на момент установки</th></tr></thead>
          <tbody>
            {toys.map((toy) => (
              <tr key={toy.toy_id}>
                <td>{toy.name}</td>
                <td className="num">{toy.quantity}</td>
                <td className="num">{formatMoney(toy.unit_cost_snapshot)} ₽</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
        Техники, у которых есть доступ к этому аппарату — через точку или точечное назначение
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
                <td>{tech.source === 'machine' ? 'точечно' : 'через точку'}</td>
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
