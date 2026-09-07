import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { formatMoney } from '../calc';
import { MachineTag } from '../components/ui/MachineTag';
import { PageSizeSelect } from '../components/ui/PageSizeSelect';
import { QrCode } from '../components/ui/QrCode';
import { RoiBadge } from '../components/ui/RoiBadge';

type Tab = 'machines' | 'locations' | 'catalog' | 'terminals' | 'staff' | 'cashless' | 'toys' | 'consumption' | 'audit';

interface Machine {
  machine_number: string;
  machine_type: string;
  model: string;
  price_per_game: string;
  counter_divisor: string;
  status: string;
  min_service_days: number | null;
  max_service_days: number | null;
  location_id: number | null;
  location_name: string | null;
  address: string | null;
  terminal_id: number | null;
  terminal_serial: string | null;
  default_toy_set_id: number | null;
  default_toy_set_name: string | null;
}

interface Toy {
  id: number;
  name: string;
  unit_cost: string;
  is_active: boolean;
}

interface ToySet {
  id: number;
  name: string;
  items: Array<{ toyId: number; name: string; quantity: number }>;
}

interface Terminal {
  id: number;
  serial: string;
  provider: string;
  status: string;
  bound_machine: string | null;
}

interface Location {
  id: number;
  name: string;
  timezone: string;
  status: string;
  parent_id: number | null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <div className="muted" style={{ marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

export default function AdminScreen() {
  const [tab, setTab] = useState<Tab>('machines');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = (message: string) => {
    setNotice(message);
    setError(null);
  };
  const fail = (caught: unknown) => {
    setError((caught as Error).message);
    setNotice(null);
  };

  return (
    <>
      <div className="tabs">
        <button className={tab === 'machines' ? 'active' : ''} onClick={() => setTab('machines')}>Аппараты</button>
        <button className={tab === 'locations' ? 'active' : ''} onClick={() => setTab('locations')}>Адреса</button>
        <button className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>Каталог</button>
        <button className={tab === 'terminals' ? 'active' : ''} onClick={() => setTab('terminals')}>Терминалы</button>
        <button className={tab === 'staff' ? 'active' : ''} onClick={() => setTab('staff')}>Сотрудники</button>
        <button className={tab === 'toys' ? 'active' : ''} onClick={() => setTab('toys')}>Игрушки</button>
        <button className={tab === 'consumption' ? 'active' : ''} onClick={() => setTab('consumption')}>Расход</button>
        <button className={tab === 'cashless' ? 'active' : ''} onClick={() => setTab('cashless')}>Безнал</button>
        <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>Аудит</button>
      </div>

      {notice && <div className="alert ok">{notice}</div>}
      {error && <div className="alert error">{error}</div>}

      {tab === 'machines' && <MachinesTab onDone={report} onError={fail} />}
      {tab === 'locations' && <LocationsTab onDone={report} onError={fail} />}
      {tab === 'catalog' && <CatalogTab onDone={report} onError={fail} />}
      {tab === 'terminals' && <TerminalsTab onDone={report} onError={fail} />}
      {tab === 'staff' && <StaffTab onDone={report} onError={fail} />}
      {tab === 'toys' && <ToysTab onDone={report} onError={fail} />}
      {tab === 'consumption' && <ConsumptionTab onDone={report} onError={fail} />}
      {tab === 'cashless' && <CashlessTab onDone={report} onError={fail} />}
      {tab === 'audit' && <AuditTab onDone={report} onError={fail} />}
    </>
  );
}

interface TabProps {
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}

function MachinesTab({ onDone, onError }: TabProps) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [editing, setEditing] = useState<Machine | null>(null);
  const [creating, setCreating] = useState(false);
  const [bindChoice, setBindChoice] = useState<Record<string, string>>({});
  const [toySets, setToySets] = useState<ToySet[]>([]);
  const [toySetChoice, setToySetChoice] = useState<Record<string, string>>({});
  const [moveChoice, setMoveChoice] = useState<Record<string, string>>({});
  const [detachTerminalChoice, setDetachTerminalChoice] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  // /api/machines always returns the full fleet (technicians' offline cache needs the whole
  // list), so the row-count setting only limits what this admin table renders, not the request.
  const [pageSize, setPageSize] = useState(50);

  const load = () => {
    api.get<Machine[]>('/api/machines').then(setMachines).catch(onError);
    api.get<Location[]>('/api/locations').then(setLocations).catch(onError);
    api.get<Terminal[]>('/api/terminals').then(setTerminals).catch(onError);
    api.get<ToySet[]>('/api/toy-sets').then(setToySets).catch(onError);
  };

  const assignToySet = async (machineNumber: string, setId: number | null) => {
    try {
      await api.post(`/api/machines/${encodeURIComponent(machineNumber)}/toy-set`, { setId });
      onDone(setId ? 'Набор игрушек назначен' : 'Набор игрушек снят');
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  useEffect(load, []);

  const freeTerminals = terminals.filter((terminal) => !terminal.bound_machine);

  // «Переместить» должно вести на реальный адрес, а не на широкую ветку (Юг/Север/город/область
  // и т.п.) — иначе это снова читалось бы как физический переезд аппарата туда, где на самом деле
  // просто сидят десятки разных адресов. Группировка теперь делается классификаторами, а не
  // выбором точки при переносе, поэтому сюда попадают только точки, которые сами ничей родитель.
  const parentIds = new Set(locations.map((l) => l.parent_id).filter((id): id is number => id != null));
  const addressLocations = locations.filter((location) => !parentIds.has(location.id));

  const needle = search.trim().toLowerCase();
  const filteredMachines = needle
    ? machines.filter((machine) =>
        [machine.machine_number, machine.address ?? '', machine.location_name ?? '', machine.machine_type]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : machines;
  const activeMachines = filteredMachines.filter((machine) => machine.status !== 'RETIRED');
  const retiredMachines = filteredMachines.filter((machine) => machine.status === 'RETIRED');

  const setStatus = async (machineNumber: string, status: 'ACTIVE' | 'RETIRED') => {
    if (status === 'RETIRED' && !confirm(`Списать аппарат № ${machineNumber}? Он пропадёт из основного списка (историю можно найти в разделе «Списанные»).`)) {
      return;
    }
    try {
      await api.patch(`/api/machines/${encodeURIComponent(machineNumber)}`, { status });
      onDone(status === 'RETIRED' ? 'Аппарат списан' : 'Аппарат возвращён в строй');
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  const bind = async (machineNumber: string) => {
    try {
      await api.post('/api/terminals/bind', {
        terminalId: Number(bindChoice[machineNumber]),
        machineNumber,
        startedAt: new Date().toISOString(),
      });
      onDone('Терминал привязан, безналичные транзакции пересопоставлены');
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  const move = async (machineNumber: string) => {
    try {
      const result = await api.post<{ terminalCarriedOver: boolean }>(
        `/api/machines/${encodeURIComponent(machineNumber)}/move`,
        {
          locationId: Number(moveChoice[machineNumber]),
          detachTerminal: detachTerminalChoice[machineNumber] ?? false,
        },
      );
      onDone(
        result.terminalCarriedOver
          ? 'Аппарат перемещён, терминал переехал вместе с ним'
          : 'Аппарат перемещён на новую точку',
      );
      setMoveChoice({ ...moveChoice, [machineNumber]: '' });
      setDetachTerminalChoice({ ...detachTerminalChoice, [machineNumber]: false });
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  const unbind = async (terminalId: number) => {
    try {
      await api.post('/api/terminals/unbind', {
        terminalId,
        endedAt: new Date().toISOString(),
      });
      onDone('Терминал снят и возвращён на склад');
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <>
      <button className="primary" onClick={() => setCreating(!creating)} style={{ marginBottom: 12 }}>
        {creating ? 'Отмена' : '+ Установить аппарат'}
      </button>

      {creating && (
        <InstallMachineForm
          locations={addressLocations}
          terminals={freeTerminals}
          onDone={(message) => {
            onDone(message);
            setCreating(false);
            load();
          }}
          onError={onError}
        />
      )}

      <input
        placeholder="Номер или адрес аппарата"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        style={{ marginBottom: 12 }}
      />

      <div className="row" style={{ margin: '4px 0 12px', justifyContent: 'space-between' }}>
        <span className="muted">Показано {Math.min(activeMachines.length, pageSize)} из {activeMachines.length}</span>
        <PageSizeSelect value={pageSize} onChange={setPageSize} />
      </div>

      {activeMachines.slice(0, pageSize).map((machine) => (
        <div className="card" key={machine.machine_number}>
          <div className="row">
            <div>
              <strong>№ {machine.machine_number} {machine.address ? `— ${machine.address}` : ''}</strong>
              <div className="muted">{machine.location_name ?? 'нет активной установки'} · {machine.machine_type}</div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button onClick={() => setEditing(editing?.machine_number === machine.machine_number ? null : machine)}>
                {editing?.machine_number === machine.machine_number ? 'Закрыть' : 'Изменить'}
              </button>
              <button onClick={() => setStatus(machine.machine_number, 'RETIRED')}>Списать</button>
            </div>
          </div>

          <div className="muted mono" style={{ marginTop: 8 }}>
            цена игры {machine.price_per_game} ₽ ·{' '}
            <span className="divisor-tag">коэффициент счётчика {machine.counter_divisor}</span>
            {' · '}статус {machine.status}
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <div className="muted">
              Терминал: {machine.terminal_serial ?? 'не привязан'}
            </div>
            {machine.terminal_id ? (
              <button onClick={() => unbind(machine.terminal_id as number)}>Снять терминал</button>
            ) : (
              <div className="row" style={{ gap: 6 }}>
                <select
                  value={bindChoice[machine.machine_number] ?? ''}
                  onChange={(event) =>
                    setBindChoice({ ...bindChoice, [machine.machine_number]: event.target.value })
                  }
                >
                  <option value="">— свободный терминал —</option>
                  {freeTerminals.map((terminal) => (
                    <option key={terminal.id} value={terminal.id}>{terminal.serial}</option>
                  ))}
                </select>
                <button
                  disabled={!bindChoice[machine.machine_number]}
                  onClick={() => bind(machine.machine_number)}
                >
                  Привязать
                </button>
              </div>
            )}
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <div className="muted">
              Набор игрушек: {machine.default_toy_set_name ?? 'не назначен'}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <select
                value={toySetChoice[machine.machine_number] ?? ''}
                onChange={(event) =>
                  setToySetChoice({ ...toySetChoice, [machine.machine_number]: event.target.value })
                }
              >
                <option value="">— выберите набор —</option>
                {toySets.map((set) => (
                  <option key={set.id} value={set.id}>{set.name}</option>
                ))}
              </select>
              <button
                disabled={!toySetChoice[machine.machine_number]}
                onClick={() => assignToySet(machine.machine_number, Number(toySetChoice[machine.machine_number]))}
              >
                Назначить
              </button>
              {machine.default_toy_set_id && (
                <button onClick={() => assignToySet(machine.machine_number, null)}>Снять</button>
              )}
            </div>
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <div className="muted">Точка: {machine.location_name ?? 'нет активной установки'}</div>
            <div className="row" style={{ gap: 6 }}>
              <select
                value={moveChoice[machine.machine_number] ?? ''}
                onChange={(event) =>
                  setMoveChoice({ ...moveChoice, [machine.machine_number]: event.target.value })
                }
              >
                <option value="">— переместить на —</option>
                {addressLocations
                  .filter((location) => location.status === 'ACTIVE' && location.id !== machine.location_id)
                  .map((location) => (
                    <option key={location.id} value={location.id}>{location.name}</option>
                  ))}
              </select>
              <button
                disabled={!moveChoice[machine.machine_number]}
                onClick={() => move(machine.machine_number)}
              >
                Переместить
              </button>
            </div>
          </div>

          {machine.terminal_id && moveChoice[machine.machine_number] && (
            <label className="row" style={{ marginTop: 6, gap: 6, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={detachTerminalChoice[machine.machine_number] ?? false}
                onChange={(event) =>
                  setDetachTerminalChoice({ ...detachTerminalChoice, [machine.machine_number]: event.target.checked })
                }
              />
              Не переносить терминал {machine.terminal_serial} на новую точку (по умолчанию переезжает вместе с аппаратом)
            </label>
          )}

          {editing?.machine_number === machine.machine_number && (
            <EditMachineForm
              machine={machine}
              onDone={(message) => {
                onDone(message);
                setEditing(null);
                load();
              }}
              onError={onError}
            />
          )}
        </div>
      ))}

      {retiredMachines.length > 0 && (
        <details className="card">
          <summary style={{ cursor: 'pointer' }}>Списанные аппараты ({retiredMachines.length})</summary>
          <div style={{ marginTop: 10 }}>
            {retiredMachines.map((machine) => (
              <div className="card" key={machine.machine_number}>
                <div className="row">
                  <div>
                    <strong>№ {machine.machine_number} {machine.address ? `— ${machine.address}` : ''}</strong>
                    <div className="muted">{machine.location_name ?? 'нет активной установки'} · {machine.machine_type}</div>
                  </div>
                  <button onClick={() => setStatus(machine.machine_number, 'ACTIVE')}>Вернуть в строй</button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function InstallMachineForm({
  locations,
  terminals,
  onDone,
  onError,
}: TabProps & { locations: Location[]; terminals: Terminal[] }) {
  const [form, setForm] = useState({
    machineNumber: '',
    machineType: 'CRANE',
    model: '',
    pricePerGame: '100',
    counterDivisor: '1.00',
    locationId: '',
    address: '',
    initialGameCounter: '0',
    initialPrizeCounter: '0',
    terminalId: '',
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const startedAt = new Date().toISOString();
    try {
      await api.post('/api/machines/install', {
        machineNumber: form.machineNumber,
        machineType: form.machineType,
        model: form.model,
        pricePerGame: form.pricePerGame,
        counterDivisor: form.counterDivisor,
        locationId: Number(form.locationId),
        address: form.address || null,
        startedAt,
        initialGameCounter: Number(form.initialGameCounter),
        initialPrizeCounter: Number(form.initialPrizeCounter),
      });

      // Привязка терминала — отдельная операция со своей историей интервалов, поэтому она
      // выполняется после установки, а не внутри неё.
      if (form.terminalId) {
        await api.post('/api/terminals/bind', {
          terminalId: Number(form.terminalId),
          machineNumber: form.machineNumber,
          startedAt,
        });
      }

      onDone(
        form.terminalId
          ? `Аппарат ${form.machineNumber} установлен, терминал привязан`
          : `Аппарат ${form.machineNumber} установлен`,
      );
    } catch (caught) {
      onError(caught);
    }
  };

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm({ ...form, [key]: event.target.value });

  return (
    <form onSubmit={submit}>
      <Section title="Установка аппарата — отдельная операция, не обслуживание">
        <div className="stack">
          <div className="grid-2">
            <div>
              <label>Номер аппарата</label>
              <input value={form.machineNumber} onChange={set('machineNumber')} required />
            </div>
            <div>
              <label>Тип</label>
              <input value={form.machineType} onChange={set('machineType')} />
            </div>
          </div>
          <div className="grid-2">
            <div>
              <label>Цена игры, ₽</label>
              <input type="number" step="0.01" value={form.pricePerGame} onChange={set('pricePerGame')} required />
            </div>
            <div>
              <label>Коэффициент счётчика</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={form.counterDivisor}
                onChange={set('counterDivisor')}
              />
            </div>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            Коэффициент 1.00 — одна единица счётчика равна одной игре. При 2.00 прирост счётчика
            делится на 2 до вычета тестовых игр.
          </p>
          <div className="grid-2">
            <div>
              <label>Точка</label>
              <select value={form.locationId} onChange={set('locationId')} required>
                <option value="">— выберите —</option>
                {locations.filter((location) => location.status === 'ACTIVE').map((location) => (
                  <option key={location.id} value={location.id}>{location.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label>Адрес</label>
              <input value={form.address} onChange={set('address')} placeholder="улица, дом" />
            </div>
          </div>
          <div className="grid-2">
            <div>
              <label>Начальный счётчик игр</label>
              <input type="number" value={form.initialGameCounter} onChange={set('initialGameCounter')} />
            </div>
            <div>
              <label>Начальный счётчик призов</label>
              <input type="number" value={form.initialPrizeCounter} onChange={set('initialPrizeCounter')} />
            </div>
          </div>
          <div>
            <label>Терминал (необязательно)</label>
            <select value={form.terminalId} onChange={set('terminalId')}>
              <option value="">— без терминала —</option>
              {terminals.map((terminal) => (
                <option key={terminal.id} value={terminal.id}>{terminal.serial}</option>
              ))}
            </select>
            {terminals.length === 0 && (
              <p className="muted" style={{ marginBottom: 0 }}>
                Свободных терминалов нет — добавьте их во вкладке «Терминалы».
              </p>
            )}
          </div>
          <button className="primary" type="submit">Установить</button>
        </div>
      </Section>
    </form>
  );
}

function EditMachineForm({ machine, onDone, onError }: TabProps & { machine: Machine }) {
  const [pricePerGame, setPricePerGame] = useState(machine.price_per_game);
  const [counterDivisor, setCounterDivisor] = useState(machine.counter_divisor);
  const [minDays, setMinDays] = useState(machine.min_service_days?.toString() ?? '');
  const [maxDays, setMaxDays] = useState(machine.max_service_days?.toString() ?? '');
  const [address, setAddress] = useState(machine.address ?? '');
  const [applyFrom, setApplyFrom] = useState('');
  const [classifiers, setClassifiers] = useState<Classifier[]>([]);
  const [addTagChoice, setAddTagChoice] = useState('');

  const loadClassifiers = () => api.get<Classifier[]>('/api/classifiers').then(setClassifiers).catch(onError);
  useEffect(() => {
    void loadClassifiers();
  }, []);

  const addTag = async () => {
    if (!addTagChoice) return;
    try {
      await api.post(`/api/classifiers/${addTagChoice}/machines`, { machineNumber: machine.machine_number });
      setAddTagChoice('');
      await loadClassifiers();
    } catch (caught) {
      onError(caught);
    }
  };

  const removeTag = async (classifierId: number) => {
    try {
      await api.delete(`/api/classifiers/${classifierId}/machines`, { machineNumber: machine.machine_number });
      await loadClassifiers();
    } catch (caught) {
      onError(caught);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.patch(`/api/machines/${encodeURIComponent(machine.machine_number)}`, {
        pricePerGame,
        counterDivisor,
        minServiceDays: minDays === '' ? null : Number(minDays),
        maxServiceDays: maxDays === '' ? null : Number(maxDays),
      });
      if (address !== (machine.address ?? '')) {
        await api.patch(`/api/machines/${encodeURIComponent(machine.machine_number)}/address`, {
          address: address || null,
        });
      }
      onDone('Сохранено. Новые значения применятся к следующим обслуживаниям');
    } catch (caught) {
      onError(caught);
    }
  };

  const applyToHistory = async () => {
    const scope = applyFrom
      ? `обслуживания с ${applyFrom}`
      : 'все обслуживания этого аппарата';
    if (!confirm(`Пересчитать ${scope} по коэффициенту ${counterDivisor}? Выручка в отчётах изменится.`)) {
      return;
    }
    try {
      const result = await api.post<{ restamped: number; recalculated: number }>(
        `/api/machines/${encodeURIComponent(machine.machine_number)}/apply-divisor-to-history`,
        applyFrom ? { from: applyFrom } : {},
      );
      onDone(`Исправлено обслуживаний: ${result.restamped}`);
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <form onSubmit={submit} style={{ marginTop: 12 }}>
      <div className="stack">
        <div>
          <label>Адрес</label>
          <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="улица, дом" />
        </div>
        <div className="grid-2">
          <div>
            <label>Цена игры, ₽</label>
            <input type="number" step="0.01" value={pricePerGame} onChange={(event) => setPricePerGame(event.target.value)} />
          </div>
          <div>
            <label>Коэффициент счётчика</label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={counterDivisor}
              onChange={(event) => setCounterDivisor(event.target.value)}
            />
          </div>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Цена и коэффициент фиксируются в момент записи обслуживания. Изменение здесь действует
          только на будущие обслуживания — уже закрытая финансовая история не меняется.
        </p>
        <div className="grid-2">
          <div>
            <label>Мин. интервал, дней</label>
            <input type="number" value={minDays} onChange={(event) => setMinDays(event.target.value)} />
          </div>
          <div>
            <label>Макс. интервал, дней</label>
            <input type="number" value={maxDays} onChange={(event) => setMaxDays(event.target.value)} />
          </div>
        </div>
        <button className="primary" type="submit">Сохранить</button>

        <div className="card" style={{ marginBottom: 0, background: 'var(--paper-deep)' }}>
          <div className="muted" style={{ marginBottom: 8 }}>Теги каталога — на этом аппарате напрямую</div>
          <p className="muted" style={{ marginTop: 0 }}>
            В обход адреса, для редкого случая, когда на одном адресе стоят аппараты разных типов.
            Обычные (гео/тип точки) теги наследуются от адреса автоматически — управляются на
            вкладке «Каталог».
          </p>
          <div className="chip-row">
            {classifiers.filter((c) => c.machines.includes(machine.machine_number)).map((c) => (
              <span className="chip" key={c.id}>
                {c.name}
                <button onClick={() => removeTag(c.id)} title="Убрать">×</button>
              </span>
            ))}
            {classifiers.filter((c) => c.machines.includes(machine.machine_number)).length === 0 && (
              <span className="muted">Прямых тегов нет.</span>
            )}
          </div>
          <div className="row" style={{ marginTop: 8, gap: 6 }}>
            <select value={addTagChoice} onChange={(event) => setAddTagChoice(event.target.value)}>
              <option value="">— добавить узел каталога —</option>
              {flattenTree(classifiers.filter((c) => !c.machines.includes(machine.machine_number))).map(
                ({ item: c, depth }) => (
                  <option key={c.id} value={c.id}>{'— '.repeat(depth)}{c.name}</option>
                ),
              )}
            </select>
            <button disabled={!addTagChoice} onClick={addTag} type="button">Добавить</button>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0, background: 'var(--paper-deep)' }}>
          <div className="muted" style={{ marginBottom: 8 }}>
            Исправление истории
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            Если коэффициент был указан неверно и записанные обслуживания посчитаны неправильно,
            примените текущий коэффициент к уже сохранённым записям. Операция аудируется.
          </p>
          <div className="grid-2">
            <div>
              <label>С даты (пусто — вся история)</label>
              <input type="date" value={applyFrom} onChange={(e) => setApplyFrom(e.target.value)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button type="button" onClick={applyToHistory} style={{ width: '100%' }}>
                Применить к истории
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

/**
 * Flattens a self-referencing tree (Location's parent_id, or Каталог's classifier parent_id)
 * into a depth-first list for rendering — a plain unordered list becomes unusable once there are
 * many leaf items, because a handful of organisational folders get buried among them. Within each
 * sibling group, nodes that themselves have children (folders) sort before leaves, so structure
 * surfaces at the top of each branch instead of being scattered alphabetically among plain items.
 */
function flattenTree<T extends { id: number; name: string; parent_id: number | null }>(
  items: T[],
  excludeId?: number,
): Array<{ item: T; depth: number }> {
  const childrenOf = new Map<number | null, T[]>();
  for (const item of items) {
    if (item.id === excludeId) continue;
    const key = item.parent_id;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(item);
  }
  const hasChildren = (id: number) => (childrenOf.get(id)?.length ?? 0) > 0;
  for (const list of childrenOf.values()) {
    list.sort((a, b) => {
      const aFirst = hasChildren(a.id) ? 0 : 1;
      const bFirst = hasChildren(b.id) ? 0 : 1;
      return aFirst !== bFirst ? aFirst - bFirst : a.name.localeCompare(b.name, 'ru');
    });
  }
  const result: Array<{ item: T; depth: number }> = [];
  const visit = (parentId: number | null, depth: number) => {
    for (const item of childrenOf.get(parentId) ?? []) {
      result.push({ item, depth });
      visit(item.id, depth + 1);
    }
  };
  visit(null, 0);
  return result;
}

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
function LocationsTab({ onDone, onError }: TabProps) {
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
      {expanded === location.id && <AddressHistory locationId={location.id} onError={onError} />}
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

interface Classifier {
  id: number;
  name: string;
  parent_id: number | null;
  locations: Array<{ id: number; name: string }>;
  machines: string[];
}

/**
 * Каталог — единственный инструмент организации аппаратов и адресов (город/район/тип/этаж —
 * любой признак, с произвольной вложенностью и множественной принадлежностью одному узлу сразу
 * несколько адресов/аппаратов, а одному адресу или аппарату — несколько узлов). Заменяет собой
 * прежнее дерево Точек как рабочий способ организации: тег на адресе действует, пока аппарат там
 * стоит, тег на конкретном аппарате — независимо от адреса (см. lib/scope.ts на сервере).
 */
function CatalogTab({ onDone, onError }: TabProps) {
  const [classifiers, setClassifiers] = useState<Classifier[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [machines, setMachines] = useState<Array<{ machine_number: string; address: string | null; location_name: string | null }>>([]);
  const [rootName, setRootName] = useState('');
  const [childName, setChildName] = useState<Record<number, string>>({});
  const [addLocationChoice, setAddLocationChoice] = useState<Record<number, string[]>>({});
  const [addMachineChoice, setAddMachineChoice] = useState<Record<number, string[]>>({});
  const [locationFilter, setLocationFilter] = useState<Record<number, string>>({});
  const [machineFilter, setMachineFilter] = useState<Record<number, string>>({});
  const [renaming, setRenaming] = useState<Record<number, string>>({});

  const load = () => {
    api.get<Classifier[]>('/api/classifiers').then(setClassifiers).catch(onError);
    api.get<Location[]>('/api/locations').then(setLocations).catch(onError);
    api.get<Array<{ machine_number: string; address: string | null; location_name: string | null }>>('/api/machines')
      .then(setMachines)
      .catch(onError);
  };
  useEffect(() => {
    void load();
  }, []);

  const createRoot = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/classifiers', { name: rootName });
      onDone(`Узел «${rootName}» создан`);
      setRootName('');
      await load();
    } catch (caught) {
      onError(caught);
    }
  };

  const createChild = async (parentId: number) => {
    const value = childName[parentId]?.trim();
    if (!value) return;
    try {
      await api.post('/api/classifiers', { name: value, parentId });
      onDone(`Узел «${value}» создан`);
      setChildName({ ...childName, [parentId]: '' });
      await load();
    } catch (caught) {
      onError(caught);
    }
  };

  const rename = async (id: number) => {
    const value = renaming[id]?.trim();
    if (!value) return;
    try {
      await api.patch(`/api/classifiers/${id}`, { name: value });
      onDone('Узел переименован');
      setRenaming((r) => { const next = { ...r }; delete next[id]; return next; });
      await load();
    } catch (caught) {
      onError(caught);
    }
  };

  const removeNode = async (id: number, name: string) => {
    if (!confirm(`Удалить узел «${name}»?`)) return;
    try {
      await api.delete(`/api/classifiers/${id}`);
      onDone('Узел удалён');
      await load();
    } catch (caught) {
      onError(caught);
    }
  };

  const addLocations = async (classifierId: number) => {
    const ids = addLocationChoice[classifierId] ?? [];
    if (ids.length === 0) return;
    try {
      await Promise.all(
        ids.map((locationId) => api.post(`/api/classifiers/${classifierId}/locations`, { locationId: Number(locationId) })),
      );
      onDone(`Добавлено адресов: ${ids.length}`);
      setAddLocationChoice({ ...addLocationChoice, [classifierId]: [] });
      await load();
    } catch (caught) {
      onError(caught);
    }
  };

  const removeLocation = async (classifierId: number, locationId: number) => {
    try {
      await api.delete(`/api/classifiers/${classifierId}/locations`, { locationId });
      onDone('Адрес убран из узла');
      await load();
    } catch (caught) {
      onError(caught);
    }
  };

  const addMachines = async (classifierId: number) => {
    const numbers = addMachineChoice[classifierId] ?? [];
    if (numbers.length === 0) return;
    try {
      await Promise.all(
        numbers.map((machineNumber) => api.post(`/api/classifiers/${classifierId}/machines`, { machineNumber })),
      );
      onDone(`Добавлено аппаратов: ${numbers.length}`);
      setAddMachineChoice({ ...addMachineChoice, [classifierId]: [] });
      await load();
    } catch (caught) {
      onError(caught);
    }
  };

  const removeMachine = async (classifierId: number, machineNumber: string) => {
    try {
      await api.delete(`/api/classifiers/${classifierId}/machines`, { machineNumber });
      onDone('Аппарат убран из узла');
      await load();
    } catch (caught) {
      onError(caught);
    }
  };

  const move = async (id: number, newParentId: number | null) => {
    try {
      await api.patch(`/api/classifiers/${id}`, { parentId: newParentId });
      onDone('Узел перемещён');
      await load();
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <>
      <form onSubmit={createRoot}>
        <Section title="Новый корневой узел">
          <p className="muted" style={{ marginTop: 0 }}>
            Например «СПб», «Астрахань», «Первые этажи» — под каждым можно строить сколько угодно
            вложенных узлов. Один адрес или аппарат может состоять сразу в нескольких узлах, в
            любых ветках каталога одновременно.
          </p>
          <div className="stack">
            <div>
              <label>Название</label>
              <input value={rootName} onChange={(event) => setRootName(event.target.value)} required />
            </div>
            <button className="primary" type="submit">Создать</button>
          </div>
        </Section>
      </form>

      {flattenTree(classifiers).map(({ item: classifier, depth }) => (
        <div className="card card-pad" key={classifier.id} style={{ marginLeft: depth * 20 }}>
          <div className="row">
            {renaming[classifier.id] !== undefined ? (
              <div className="row" style={{ gap: 6 }}>
                <input
                  value={renaming[classifier.id]}
                  onChange={(event) => setRenaming({ ...renaming, [classifier.id]: event.target.value })}
                  autoFocus
                />
                <button onClick={() => rename(classifier.id)}>Сохранить</button>
                <button onClick={() => setRenaming((r) => { const next = { ...r }; delete next[classifier.id]; return next; })}>
                  Отмена
                </button>
              </div>
            ) : (
              <strong>{classifier.name}</strong>
            )}
            <div className="row" style={{ gap: 6 }}>
              {renaming[classifier.id] === undefined && (
                <button onClick={() => setRenaming({ ...renaming, [classifier.id]: classifier.name })}>
                  Переименовать
                </button>
              )}
              <button className="btn-danger-ghost" onClick={() => removeNode(classifier.id, classifier.name)}>
                Удалить
              </button>
            </div>
          </div>

          <ClassifierMoveControl classifier={classifier} classifiers={classifiers} onMove={move} />

          <div className="row" style={{ marginTop: 10, gap: 6 }}>
            <input
              placeholder="название подузла"
              value={childName[classifier.id] ?? ''}
              onChange={(event) => setChildName({ ...childName, [classifier.id]: event.target.value })}
            />
            <button disabled={!childName[classifier.id]?.trim()} onClick={() => createChild(classifier.id)}>
              + подузел
            </button>
          </div>

          <div className="muted" style={{ marginTop: 10 }}>Адреса</div>
          <div className="chip-row" style={{ marginTop: 4 }}>
            {classifier.locations.length === 0 && <span className="muted">Адресов пока нет.</span>}
            {classifier.locations.map((location) => (
              <span className="chip" key={location.id}>
                {location.name}
                <button onClick={() => removeLocation(classifier.id, location.id)} title="Убрать">×</button>
              </span>
            ))}
          </div>
          <div className="stack" style={{ marginTop: 6, gap: 6 }}>
            <input
              placeholder="фильтр по названию адреса…"
              value={locationFilter[classifier.id] ?? ''}
              onChange={(event) => setLocationFilter({ ...locationFilter, [classifier.id]: event.target.value })}
            />
            <select
              multiple
              size={6}
              value={addLocationChoice[classifier.id] ?? []}
              onChange={(event) =>
                setAddLocationChoice({
                  ...addLocationChoice,
                  [classifier.id]: Array.from(event.target.selectedOptions, (o) => o.value),
                })
              }
            >
              {locations
                .filter((location) => !classifier.locations.some((l) => l.id === location.id))
                .filter((location) =>
                  location.name.toLowerCase().includes((locationFilter[classifier.id] ?? '').toLowerCase()),
                )
                .map((location) => (
                  <option key={location.id} value={location.id}>{location.name}</option>
                ))}
            </select>
            <button
              disabled={!(addLocationChoice[classifier.id]?.length)}
              onClick={() => addLocations(classifier.id)}
            >
              Добавить выбранные{addLocationChoice[classifier.id]?.length ? ` (${addLocationChoice[classifier.id].length})` : ''}
            </button>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Ctrl/Cmd+клик — выбрать несколько адресов сразу.
            </p>
          </div>

          <div className="muted" style={{ marginTop: 10 }}>Аппараты напрямую (в обход адреса)</div>
          <div className="chip-row" style={{ marginTop: 4 }}>
            {classifier.machines.length === 0 && <span className="muted">Аппаратов пока нет.</span>}
            {classifier.machines.map((machineNumber) => (
              <span className="chip" key={machineNumber}>
                {machineNumber}
                <button onClick={() => removeMachine(classifier.id, machineNumber)} title="Убрать">×</button>
              </span>
            ))}
          </div>
          <div className="stack" style={{ marginTop: 6, gap: 6 }}>
            <input
              placeholder="фильтр по номеру или адресу…"
              value={machineFilter[classifier.id] ?? ''}
              onChange={(event) => setMachineFilter({ ...machineFilter, [classifier.id]: event.target.value })}
            />
            <select
              multiple
              size={6}
              value={addMachineChoice[classifier.id] ?? []}
              onChange={(event) =>
                setAddMachineChoice({
                  ...addMachineChoice,
                  [classifier.id]: Array.from(event.target.selectedOptions, (o) => o.value),
                })
              }
            >
              {machines
                .filter((machine) => !classifier.machines.includes(machine.machine_number))
                .filter((machine) => {
                  const needle = (machineFilter[classifier.id] ?? '').toLowerCase();
                  if (!needle) return true;
                  return [machine.machine_number, machine.address ?? '', machine.location_name ?? '']
                    .join(' ')
                    .toLowerCase()
                    .includes(needle);
                })
                .map((machine) => (
                  <option key={machine.machine_number} value={machine.machine_number}>
                    № {machine.machine_number} — {machine.address || machine.location_name || 'нет адреса'}
                  </option>
                ))}
            </select>
            <button
              disabled={!(addMachineChoice[classifier.id]?.length)}
              onClick={() => addMachines(classifier.id)}
            >
              Добавить выбранные{addMachineChoice[classifier.id]?.length ? ` (${addMachineChoice[classifier.id].length})` : ''}
            </button>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Ctrl/Cmd+клик — выбрать несколько аппаратов сразу.
            </p>
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * Смена родителя уже существующего узла Каталога — без этого единственный способ выстроить
 * иерархию был создавать НОВЫЕ узлы как детей, а старые плоские узлы (например, унаследованные
 * от прежней плоской системы классификаторов) так и оставались бы отдельными корнями навсегда.
 * Список вариантов исключает собственное поддерево узла — перенос в потомка сервер и так
 * отклонит с понятной ошибкой, но предлагать его в select'е незачем.
 */
function ClassifierMoveControl({
  classifier,
  classifiers,
  onMove,
}: {
  classifier: Classifier;
  classifiers: Classifier[];
  onMove: (id: number, newParentId: number | null) => void;
}) {
  const [selected, setSelected] = useState(String(classifier.parent_id ?? ''));

  const changed = selected !== String(classifier.parent_id ?? '');

  return (
    <div className="row" style={{ marginTop: 8, gap: 8 }}>
      <select value={selected} onChange={(event) => setSelected(event.target.value)}>
        <option value="">— нет (корень) —</option>
        {flattenTree(classifiers, classifier.id).map(({ item, depth }) => (
          <option key={item.id} value={item.id}>{'— '.repeat(depth)}{item.name}</option>
        ))}
      </select>
      <button
        disabled={!changed}
        onClick={() => onMove(classifier.id, selected ? Number(selected) : null)}
      >
        Переместить
      </button>
    </div>
  );
}

function TerminalsTab({ onDone, onError }: TabProps) {
  const [terminals, setTerminals] = useState<Array<Record<string, string | number | null>>>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [serial, setSerial] = useState('');
  const [provider, setProvider] = useState('');
  const [bindTo, setBindTo] = useState<Record<number, string>>({});

  const load = () => {
    api.get<Array<Record<string, string | number | null>>>('/api/terminals').then(setTerminals).catch(onError);
    api.get<Machine[]>('/api/machines').then(setMachines).catch(onError);
  };
  useEffect(load, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/terminals', { serial, provider });
      onDone(`Терминал ${serial} добавлен`);
      setSerial('');
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <>
      <form onSubmit={create}>
        <Section title="Новый терминал">
          <div className="stack">
            <div className="grid-2">
              <div>
                <label>Серийный номер</label>
                <input value={serial} onChange={(event) => setSerial(event.target.value)} required />
              </div>
              <div>
                <label>Провайдер</label>
                <input value={provider} onChange={(event) => setProvider(event.target.value)} required />
              </div>
            </div>
            <button className="primary" type="submit">Добавить</button>
          </div>
        </Section>
      </form>

      {terminals.map((terminal) => (
        <div className="card" key={terminal.id as number}>
          <div className="row">
            <div>
              <strong>{terminal.serial}</strong>
              <div className="muted">
                {terminal.bound_machine ? `на аппарате № ${terminal.bound_machine}` : 'на складе'}
              </div>
            </div>
            {terminal.bound_machine ? (
              <button
                onClick={async () => {
                  try {
                    await api.post('/api/terminals/unbind', {
                      terminalId: terminal.id,
                      endedAt: new Date().toISOString(),
                    });
                    onDone('Терминал снят, транзакции перепривязаны');
                    load();
                  } catch (caught) {
                    onError(caught);
                  }
                }}
              >
                Снять
              </button>
            ) : (
              <div className="row" style={{ gap: 6 }}>
                <select
                  value={bindTo[terminal.id as number] ?? ''}
                  onChange={(event) =>
                    setBindTo({ ...bindTo, [terminal.id as number]: event.target.value })
                  }
                >
                  <option value="">— аппарат —</option>
                  {machines.map((machine) => (
                    <option key={machine.machine_number} value={machine.machine_number}>
                      № {machine.machine_number}{machine.address ? ` — ${machine.address}` : ''}
                    </option>
                  ))}
                </select>
                <button
                  onClick={async () => {
                    try {
                      await api.post('/api/terminals/bind', {
                        terminalId: terminal.id,
                        machineNumber: bindTo[terminal.id as number],
                        startedAt: new Date().toISOString(),
                      });
                      onDone('Терминал привязан');
                      load();
                    } catch (caught) {
                      onError(caught);
                    }
                  }}
                >
                  Привязать
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

interface StaffRow {
  id: number;
  login: string;
  full_name: string;
  role: 'ADMIN' | 'TECHNICIAN' | 'BOSS';
  is_active: boolean;
}

const ROLE_LABELS: Record<StaffRow['role'], string> = {
  ADMIN: 'Администратор',
  TECHNICIAN: 'Техник',
  BOSS: 'Руководитель (только чтение)',
};

function StaffTab({ onDone, onError }: TabProps) {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [classifiers, setClassifiers] = useState<Classifier[]>([]);
  const [scope, setScope] = useState<Record<number, string>>({});
  const [classifierScope, setClassifierScope] = useState<Record<number, string>>({});
  const [machineScope, setMachineScope] = useState<Record<number, string>>({});
  const [scopes, setScopes] = useState<
    Record<number, {
      locations: Array<{ id: number; name: string }>;
      classifiers: Array<{ id: number; name: string }>;
      machines: string[];
    }>
  >({});
  const [scopeOpenFor, setScopeOpenFor] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => {
    api.get<StaffRow[]>('/api/staff').then(setStaff).catch(onError);
    api.get<Location[]>('/api/locations').then(setLocations).catch(onError);
    api.get<Classifier[]>('/api/classifiers').then(setClassifiers).catch(onError);
  };
  useEffect(load, []);

  const loadScope = async (staffId: number) => {
    try {
      const result = await api.get<{
        locations: Array<{ id: number; name: string }>;
        classifiers: Array<{ id: number; name: string }>;
        machines: string[];
      }>(`/api/staff/${staffId}/scope`);
      setScopes((prev) => ({ ...prev, [staffId]: result }));
    } catch (caught) {
      onError(caught);
    }
  };

  const toggleScope = async (staffId: number) => {
    const next = scopeOpenFor === staffId ? null : staffId;
    setScopeOpenFor(next);
    if (next) await loadScope(staffId);
  };

  return (
    <>
      <button className="primary" onClick={() => setCreating(!creating)} style={{ marginBottom: 12 }}>
        {creating ? 'Отмена' : '+ Новый сотрудник'}
      </button>

      {creating && (
        <CreateStaffForm
          onDone={(message) => {
            onDone(message);
            setCreating(false);
            load();
          }}
          onError={onError}
        />
      )}

      {staff.map((person) => (
        <div className="card" key={person.id}>
          <div className="row">
            <div>
              <strong>{person.full_name}</strong>
              <div className="muted">логин: {person.login}</div>
            </div>
            <div className="right">
              <span className={`badge ${person.role === 'ADMIN' ? 'online' : ''}`}>
                {ROLE_LABELS[person.role]}
              </span>
              {!person.is_active && (
                <div className="muted" style={{ marginTop: 4 }}>отключён</div>
              )}
            </div>
          </div>

          <div className="row" style={{ marginTop: 10, gap: 6 }}>
            <button onClick={() => setEditing(editing === person.id ? null : person.id)}>
              {editing === person.id ? 'Закрыть' : 'Изменить'}
            </button>
            {(person.role === 'TECHNICIAN' || person.role === 'BOSS') && (
              <button onClick={() => toggleScope(person.id)}>
                {scopeOpenFor === person.id ? 'Скрыть доступ к аппаратам' : 'Доступ к аппаратам'}
              </button>
            )}
            <button
              className="btn-danger-ghost"
              onClick={async () => {
                if (!confirm(`Удалить сотрудника «${person.full_name}»? Отменить нельзя.`)) return;
                try {
                  await api.delete(`/api/staff/${person.id}`);
                  onDone('Сотрудник удалён');
                  load();
                } catch (caught) {
                  onError(caught);
                }
              }}
            >
              Удалить
            </button>
          </div>

          {editing === person.id && (
            <EditStaffForm
              person={person}
              onDone={async (message) => {
                onDone(message);
                await load();
              }}
              onError={onError}
            />
          )}

          {(person.role === 'TECHNICIAN' || person.role === 'BOSS') && scopeOpenFor === person.id && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              {person.role === 'BOSS' && (scopes[person.id]?.locations.length ?? 0) === 0
                && (scopes[person.id]?.classifiers.length ?? 0) === 0
                && (scopes[person.id]?.machines.length ?? 0) === 0 && (
                <p className="muted" style={{ marginTop: 0 }}>
                  Пока не назначено ни одного узла — руководитель видит вообще все аппараты. Как
                  только вы назначите хотя бы один узел Каталога, видимость сузится только до него.
                </p>
              )}

              <div className="muted">Каталог — основной способ выдачи доступа:</div>
              <div className="row" style={{ gap: 6, margin: '6px 0 10px' }}>
                <select
                  value={classifierScope[person.id] ?? ''}
                  onChange={(event) => setClassifierScope({ ...classifierScope, [person.id]: event.target.value })}
                >
                  <option value="">— узел каталога —</option>
                  {flattenTree(classifiers).map(({ item: classifier, depth }) => (
                    <option key={classifier.id} value={classifier.id}>{'— '.repeat(depth)}{classifier.name}</option>
                  ))}
                </select>
                <button
                  disabled={!classifierScope[person.id]}
                  onClick={async () => {
                    try {
                      await api.post('/api/staff/scope', {
                        staffId: person.id,
                        classifierId: Number(classifierScope[person.id]),
                      });
                      onDone(`${person.full_name} теперь видит аппараты всего этого узла (и вложенных в него)`);
                      await loadScope(person.id);
                    } catch (caught) {
                      onError(caught);
                    }
                  }}
                >
                  Выдать доступ
                </button>
              </div>
              {(scopes[person.id]?.classifiers.length ?? 0) === 0 && (
                <p className="muted" style={{ margin: '4px 0' }}>Ни одного узла не выдано.</p>
              )}
              <div className="chip-row">
                {scopes[person.id]?.classifiers.map((classifier) => (
                  <span className="chip" key={classifier.id}>
                    {classifier.name}
                    <button
                      onClick={async () => {
                        await api.delete('/api/staff/scope', {
                          staffId: person.id,
                          classifierId: classifier.id,
                        });
                        onDone('Доступ к узлу отозван');
                        await loadScope(person.id);
                      }}
                      title="Отозвать"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>

              <div className="muted" style={{ marginTop: 12 }}>
                Отдельный аппарат в обход каталога (для редких исключений):
              </div>
              <div className="row" style={{ gap: 6, margin: '6px 0 10px' }}>
                <input
                  placeholder="номер аппарата"
                  value={machineScope[person.id] ?? ''}
                  onChange={(event) => setMachineScope({ ...machineScope, [person.id]: event.target.value })}
                />
                <button
                  disabled={!machineScope[person.id]?.trim()}
                  onClick={async () => {
                    try {
                      await api.post('/api/staff/scope', {
                        staffId: person.id,
                        machineNumber: machineScope[person.id].trim(),
                      });
                      onDone(`${person.full_name} теперь видит аппарат № ${machineScope[person.id].trim()}`);
                      setMachineScope({ ...machineScope, [person.id]: '' });
                      await loadScope(person.id);
                    } catch (caught) {
                      onError(caught);
                    }
                  }}
                >
                  Выдать доступ
                </button>
              </div>
              {(scopes[person.id]?.machines.length ?? 0) === 0 && (
                <p className="muted" style={{ margin: '4px 0' }}>Нет.</p>
              )}
              <div className="chip-row">
                {scopes[person.id]?.machines.map((machineNumber) => (
                  <span className="chip" key={machineNumber}>
                    № {machineNumber}
                    <button
                      onClick={async () => {
                        await api.delete('/api/staff/scope', {
                          staffId: person.id,
                          machineNumber,
                        });
                        onDone('Доступ к аппарату отозван');
                        await loadScope(person.id);
                      }}
                      title="Отозвать"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>

              <details style={{ marginTop: 14 }}>
                <summary className="muted" style={{ cursor: 'pointer' }}>
                  Устаревающий способ: по дереву точек
                </summary>
                <div className="row" style={{ gap: 6, margin: '8px 0 10px' }}>
                  <select
                    value={scope[person.id] ?? ''}
                    onChange={(event) => setScope({ ...scope, [person.id]: event.target.value })}
                  >
                    <option value="">— точка для доступа —</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>{location.name}</option>
                    ))}
                  </select>
                  <button
                    disabled={!scope[person.id]}
                    onClick={async () => {
                      try {
                        await api.post('/api/staff/scope', {
                          staffId: person.id,
                          locationId: Number(scope[person.id]),
                        });
                        onDone(`${person.full_name} теперь видит аппараты точки и всех вложенных точек`);
                        await loadScope(person.id);
                      } catch (caught) {
                        onError(caught);
                      }
                    }}
                  >
                    Дать доступ к точке
                  </button>
                </div>
                <div className="chip-row">
                  {scopes[person.id]?.locations.map((location) => (
                    <span className="chip" key={location.id}>
                      {location.name}
                      <button
                        onClick={async () => {
                          await api.delete('/api/staff/scope', {
                            staffId: person.id,
                            locationId: location.id,
                          });
                          onDone('Доступ к точке отозван');
                          await loadScope(person.id);
                        }}
                        title="Отозвать"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </details>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function CreateStaffForm({ onDone, onError }: TabProps) {
  const [form, setForm] = useState({ login: '', fullName: '', role: 'TECHNICIAN', password: '' });

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/staff', form);
      onDone(`Сотрудник ${form.fullName || form.login} создан`);
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <form onSubmit={create}>
      <Section title="Новый сотрудник">
        <div className="stack">
          <div className="grid-2">
            <div>
              <label>Логин</label>
              <input value={form.login} onChange={(event) => setForm({ ...form, login: event.target.value })} required />
            </div>
            <div>
              <label>Имя</label>
              <input value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} required />
            </div>
          </div>
          <div className="grid-2">
            <div>
              <label>Роль</label>
              <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
                <option value="TECHNICIAN">Техник</option>
                <option value="ADMIN">Администратор</option>
                <option value="BOSS">Руководитель (только чтение)</option>
              </select>
            </div>
            <div>
              <label>Пароль</label>
              <input
                type="password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                required
              />
            </div>
          </div>
          <button className="primary" type="submit">Создать</button>
        </div>
      </Section>
    </form>
  );
}

function EditStaffForm({
  person,
  onDone,
  onError,
}: TabProps & { person: StaffRow }) {
  const [fullName, setFullName] = useState(person.full_name);
  const [role, setRole] = useState(person.role);
  const [isActive, setIsActive] = useState(person.is_active);
  const [newPassword, setNewPassword] = useState('');

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.patch(`/api/staff/${person.id}`, { fullName, role, isActive });
      await onDone('Данные сотрудника сохранены');
    } catch (caught) {
      onError(caught);
    }
  };

  const savePassword = async () => {
    try {
      await api.post(`/api/staff/${person.id}/password`, { password: newPassword });
      setNewPassword('');
      await onDone('Пароль изменён');
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <form onSubmit={saveProfile}>
        <div className="stack">
          <div className="grid-2">
            <div>
              <label>Имя</label>
              <input value={fullName} onChange={(event) => setFullName(event.target.value)} required />
            </div>
            <div>
              <label>Роль</label>
              <select value={role} onChange={(event) => setRole(event.target.value as StaffRow['role'])}>
                <option value="TECHNICIAN">Техник</option>
                <option value="ADMIN">Администратор</option>
                <option value="BOSS">Руководитель (только чтение)</option>
              </select>
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              style={{ width: 'auto' }}
            />
            Учётная запись активна (выключите, чтобы запретить вход без удаления истории)
          </label>
          <button className="primary" type="submit">Сохранить</button>
        </div>
      </form>

      <div className="grid-2" style={{ marginTop: 14, alignItems: 'flex-end' }}>
        <div>
          <label>Новый пароль</label>
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </div>
        <button type="button" disabled={!newPassword} onClick={savePassword}>
          Сменить пароль
        </button>
      </div>
      <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
        Ограничений на сложность пароля нет — можно ставить любой, включая короткий.
      </p>
    </div>
  );
}

interface IvendSettingsView {
  isEnabled: boolean;
  login: string;
  hasPassword: boolean;
  overlapMinutes: number;
  runTimes: string[];
  lastRun: {
    startedAt: string;
    finishedAt: string | null;
    status: string;
    rowsInserted: number;
    rowsMatched: number;
    errorMessage: string | null;
  } | null;
}

/**
 * Логин/пароль кабинета iVend редактируются прямо здесь (не в env) — по требованию владельца:
 * если провайдер сменит пароль, он вводит новый тут же и видит сразу, принят ли он кабинетом.
 */
function IvendSettingsPanel({ onDone, onError }: TabProps) {
  const [settings, setSettings] = useState<IvendSettingsView | null>(null);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [runTimes, setRunTimes] = useState<string[]>([]);
  const [scheduleBusy, setScheduleBusy] = useState(false);

  const load = () => {
    api
      .get<IvendSettingsView>('/api/parser/ivend/settings')
      .then((data) => {
        setSettings(data);
        setLogin(data.login);
        setEnabled(data.isEnabled);
        setRunTimes(data.runTimes);
      })
      .catch(onError);
  };
  useEffect(load, []);

  const saveSchedule = async (next: string[]) => {
    setScheduleBusy(true);
    try {
      const result = await api.put<{ ok: boolean; runTimes: string[] }>('/api/parser/ivend/schedule', {
        runTimes: next,
      });
      setRunTimes(result.runTimes);
      onDone('Расписание синхронизации сохранено');
    } catch (caught) {
      onError(caught);
    } finally {
      setScheduleBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setCheckResult(null);
    try {
      const result = await api.put<{ ok: boolean; message: string }>('/api/parser/ivend/settings', {
        login, password, isEnabled: enabled,
      });
      setCheckResult(result);
      setPassword('');
      load();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ skipped: boolean; imported?: number; matched?: number; error?: string }>(
        '/api/parser/ivend/run', {},
      );
      if (result.skipped) onDone('Синхронизация выключена или не настроена — данные не запрашивались');
      else if (result.error) onError(new Error(result.error));
      else onDone(`Готово: новых транзакций ${result.imported ?? 0}, сопоставлено аппаратов ${result.matched ?? 0}`);
      load();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return null;

  return (
    <div className="card card-pad" style={{ marginBottom: 14 }}>
      <div className="muted" style={{ marginBottom: 10 }}>Кабинет iVend — автосбор безналичных платежей</div>

      {checkResult && (
        <div className={`alert ${checkResult.ok ? 'ok' : 'error'}`} style={{ marginBottom: 10 }}>
          {checkResult.message}
        </div>
      )}
      {settings.lastRun?.status === 'ERROR' && !checkResult && (
        <div className="alert error" style={{ marginBottom: 10 }}>
          Последняя синхронизация не удалась: {settings.lastRun.errorMessage}
        </div>
      )}

      <div className="row2">
        <div className="fld">
          <label>Логин (телефон)</label>
          <input value={login} onChange={(event) => setLogin(event.target.value)} placeholder="9991234567" />
        </div>
        <div className="fld">
          <label>Пароль</label>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={settings.hasPassword ? 'заполнен — введите новый, если сменился' : 'введите пароль'}
          />
        </div>
      </div>

      <div className="row" style={{ marginTop: 8, gap: 12 }}>
        <label style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            style={{ width: 'auto', marginRight: 8 }}
          />
          автосинхронизация включена
        </label>
        <button onClick={save} disabled={busy}>Сохранить и проверить</button>
        <button onClick={runNow} disabled={busy}>Синхронизировать сейчас</button>
      </div>

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
        <label style={{ display: 'block', marginBottom: 8 }}>Время автосинхронизации (по Москве)</label>
        <div className="row" style={{ gap: 8 }}>
          {runTimes.map((time, index) => (
            <div key={index} className="row" style={{ gap: 4, width: 'auto' }}>
              <input
                type="time"
                value={time}
                style={{ width: 110 }}
                disabled={scheduleBusy}
                onChange={(event) => {
                  const next = [...runTimes];
                  next[index] = event.target.value;
                  setRunTimes(next);
                }}
              />
              <button
                className="icon-btn"
                disabled={scheduleBusy || runTimes.length <= 1}
                title="Убрать это время"
                onClick={() => saveSchedule(runTimes.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            disabled={scheduleBusy}
            onClick={() => setRunTimes([...runTimes, '12:00'])}
          >
            + время
          </button>
          <button disabled={scheduleBusy} onClick={() => saveSchedule(runTimes)}>
            Сохранить расписание
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
          Парсер будет заходить в кабинет iVend только в указанное время, а не постоянно
        </p>
      </div>

      {settings.lastRun && (
        <p className="muted" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
          Последний запуск: {new Date(settings.lastRun.startedAt).toLocaleString('ru-RU')}
          {settings.lastRun.status === 'SUCCESS'
            ? ` — успешно, новых транзакций ${settings.lastRun.rowsInserted}, сопоставлено аппаратов ${settings.lastRun.rowsMatched}`
            : ` — ${settings.lastRun.status === 'RUNNING' ? 'выполняется…' : 'ошибка'}`}
        </p>
      )}
    </div>
  );
}

function CashlessTab({ onDone, onError }: TabProps) {
  const [rows, setRows] = useState<Array<Record<string, string | number | null>>>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [onlyUnmatched, setOnlyUnmatched] = useState(false);

  const load = () => {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    if (onlyUnmatched) params.set('status', 'UNMATCHED');
    api
      .get<{ rows: Array<Record<string, string | number | null>>; total: number }>(`/api/cashless?${params.toString()}`)
      .then((response) => {
        setRows(response.rows);
        setTotal(response.total);
      })
      .catch(onError);
  };
  useEffect(load, [onlyUnmatched, page, pageSize]);
  useEffect(() => setPage(0), [onlyUnmatched, pageSize]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const shownFrom = total === 0 ? 0 : page * pageSize + 1;
  const shownTo = Math.min(total, (page + 1) * pageSize);

  return (
    <>
      <IvendSettingsPanel onDone={onDone} onError={onError} />

      <div className="card row">
        <label style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={onlyUnmatched}
            onChange={(event) => setOnlyUnmatched(event.target.checked)}
            style={{ width: 'auto', marginRight: 8 }}
          />
          только несопоставленные
        </label>
        <button
          onClick={async () => {
            try {
              const result = await api.post<{ processed: number }>('/api/cashless/rematch', {
                onlyUnmatched: true,
              });
              onDone(`Повторно обработано транзакций: ${result.processed}`);
              load();
            } catch (caught) {
              onError(caught);
            }
          }}
        >
          Пересопоставить
        </button>
      </div>

      <div className="table-wrap scroll-x">
        <table>
          <thead>
            <tr>
              <th>Время</th>
              <th>Терминал</th>
              <th className="right">Сумма</th>
              <th>Аппарат</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id as number}>
                <td>{new Date(row.occurred_at as string).toLocaleString('ru-RU')}</td>
                <td>{row.terminal_external_id}</td>
                <td className="right mono">{formatMoney(row.amount as string)}</td>
                <td>{(row.matched_machine_number as string) ?? '—'}</td>
                <td>
                  {row.match_status}
                  {row.unmatched_reason && <div className="muted">{row.unmatched_reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <div className="info">Показано {shownFrom}–{shownTo} из {total}</div>
        <div className="row" style={{ gap: 14 }}>
          <PageSizeSelect value={pageSize} onChange={setPageSize} />
          <div className="pg">
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
            {Array.from({ length: pageCount }).slice(0, 7).map((_, index) => (
              <button key={index} className={index === page ? 'active' : ''} onClick={() => setPage(index)}>
                {index + 1}
              </button>
            ))}
            <button disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>›</button>
          </div>
        </div>
      </div>
    </>
  );
}

interface AuditRow {
  id: number;
  actor_login: string | null;
  occurred_at: string;
  entity: string;
  entity_id: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
}

const ACTION_LABELS: Record<AuditRow['action'], string> = {
  INSERT: 'создано',
  UPDATE: 'изменено',
  DELETE: 'удалено',
};

function AuditTab({ onError }: TabProps) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [entity, setEntity] = useState('');
  const [entityId, setEntityId] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = () => {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    if (entity) params.set('entity', entity);
    if (entityId) params.set('entityId', entityId);
    api
      .get<{ rows: AuditRow[]; total: number }>(`/api/audit?${params.toString()}`)
      .then((response) => {
        setRows(response.rows);
        setTotal(response.total);
      })
      .catch(onError);
  };
  useEffect(load, [entity, entityId, page, pageSize]);
  useEffect(() => setPage(0), [entity, entityId, pageSize]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const shownFrom = total === 0 ? 0 : page * pageSize + 1;
  const shownTo = Math.min(total, (page + 1) * pageSize);

  const diffFields = (row: AuditRow): Array<[string, unknown, unknown]> => {
    const keys = new Set([...Object.keys(row.old_data ?? {}), ...Object.keys(row.new_data ?? {})]);
    const changed: Array<[string, unknown, unknown]> = [];
    for (const key of keys) {
      const oldValue = row.old_data?.[key];
      const newValue = row.new_data?.[key];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) changed.push([key, oldValue, newValue]);
    }
    return changed;
  };

  return (
    <>
      <div className="filters-panel">
        <div className="fld">
          <label>Сущность</label>
          <select value={entity} onChange={(event) => setEntity(event.target.value)}>
            <option value="">Все</option>
            {['location', 'machine', 'placement', 'service', 'toy_distribution', 'toy', 'toy_set',
              'terminal', 'terminal_binding', 'staff', 'staff_location_scope', 'machine_technician',
              'route', 'machine_route', 'cashless_transaction'].map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label>ID сущности</label>
          <input value={entityId} onChange={(event) => setEntityId(event.target.value)} placeholder="например, номер аппарата" />
        </div>
      </div>

      <div className="table-wrap scroll-x">
        <table>
          <thead>
            <tr>
              <th>Когда</th>
              <th>Кто</th>
              <th>Сущность</th>
              <th>ID</th>
              <th>Действие</th>
              <th>Причина</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.id}>
                <tr>
                  <td className="mono">{new Date(row.occurred_at).toLocaleString('ru-RU')}</td>
                  <td>{row.actor_login ?? 'система'}</td>
                  <td className="mono">{row.entity}</td>
                  <td className="mono">{row.entity_id}</td>
                  <td>{ACTION_LABELS[row.action]}</td>
                  <td className="muted wrap">{(row.context?.reason as string) ?? '—'}</td>
                  <td>
                    <button onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                      {expanded === row.id ? 'Скрыть' : 'Детали'}
                    </button>
                  </td>
                </tr>
                {expanded === row.id && (
                  <tr>
                    <td colSpan={7}>
                      {row.action === 'UPDATE' && diffFields(row).length > 0 ? (
                        <table>
                          <thead><tr><th>Поле</th><th>Было</th><th>Стало</th></tr></thead>
                          <tbody>
                            {diffFields(row).map(([field, oldValue, newValue]) => (
                              <tr key={field}>
                                <td className="mono">{field}</td>
                                <td className="mono muted">{JSON.stringify(oldValue) ?? '—'}</td>
                                <td className="mono">{JSON.stringify(newValue) ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <pre className="mono scroll-x" style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                          {JSON.stringify(row.new_data ?? row.old_data, null, 2)}
                        </pre>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>Записей нет</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <div className="info">Показано {shownFrom}–{shownTo} из {total}</div>
        <div className="row" style={{ gap: 14 }}>
          <PageSizeSelect value={pageSize} onChange={setPageSize} />
          <div className="pg">
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
            {Array.from({ length: pageCount }).slice(0, 7).map((_, index) => (
              <button key={index} className={index === page ? 'active' : ''} onClick={() => setPage(index)}>
                {index + 1}
              </button>
            ))}
            <button disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>›</button>
          </div>
        </div>
      </div>
    </>
  );
}

function ToysTab({ onDone, onError }: TabProps) {
  const [toys, setToys] = useState<Toy[]>([]);
  const [sets, setSets] = useState<ToySet[]>([]);
  const [editingToy, setEditingToy] = useState<number | null>(null);
  const [creatingSet, setCreatingSet] = useState(false);
  const [editingSet, setEditingSet] = useState<number | null>(null);
  const [applyingSet, setApplyingSet] = useState<number | null>(null);

  const load = () => {
    api.get<Toy[]>('/api/toys').then(setToys).catch(onError);
    api.get<ToySet[]>('/api/toy-sets').then(setSets).catch(onError);
  };
  useEffect(load, []);

  return (
    <>
      <Section title="Каталог игрушек">
        <div className="stack">
          {toys.map((toy) => (
            <div className="card card-pad" key={toy.id} style={!toy.is_active ? { opacity: 0.55 } : undefined}>
              {editingToy === toy.id ? (
                <EditToyForm
                  toy={toy}
                  onDone={(message) => {
                    onDone(message);
                    setEditingToy(null);
                    load();
                  }}
                  onError={onError}
                />
              ) : (
                <div className="row">
                  <div>
                    <strong>{toy.name}</strong>
                    {!toy.is_active && <span className="muted"> · отключена</span>}
                    <div className="muted mono">{formatMoney(toy.unit_cost)} ₽ / шт</div>
                  </div>
                  <button onClick={() => setEditingToy(toy.id)}>Изменить</button>
                </div>
              )}
            </div>
          ))}
          <NewToyForm onDone={(message) => { onDone(message); load(); }} onError={onError} />
        </div>
      </Section>

      <Section title="Наборы игрушек">
        <p className="muted" style={{ marginTop: 0 }}>
          Набор — это подсказка технику, какие игрушки и в каком количестве обычно заправляются на
          аппарате. Реальный расход в обслуживании всегда можно изменить — набор не ограничивает,
          только предзаполняет форму.
        </p>

        <button className="btn btn-primary" onClick={() => setCreatingSet(!creatingSet)} style={{ marginBottom: 12 }}>
          {creatingSet ? 'Отмена' : '+ Новый набор'}
        </button>

        {creatingSet && (
          <EditToySetForm
            toys={toys.filter((t) => t.is_active)}
            onDone={(message) => {
              onDone(message);
              setCreatingSet(false);
              load();
            }}
            onError={onError}
          />
        )}

        <div className="stack">
          {sets.map((set) => (
            <div className="card card-pad" key={set.id}>
              <div className="row">
                <strong>{set.name}</strong>
                <div className="row" style={{ gap: 6 }}>
                  <button onClick={() => setEditingSet(editingSet === set.id ? null : set.id)}>
                    {editingSet === set.id ? 'Закрыть' : 'Изменить'}
                  </button>
                  <button onClick={() => setApplyingSet(applyingSet === set.id ? null : set.id)}>
                    {applyingSet === set.id ? 'Закрыть' : 'Применить к группе'}
                  </button>
                </div>
              </div>
              <div className="chip-row">
                {set.items.length === 0 && <span className="muted">пусто</span>}
                {set.items.map((item) => (
                  <span className="chip" key={item.toyId}>{item.name} × {item.quantity}</span>
                ))}
              </div>

              {editingSet === set.id && (
                <EditToySetForm
                  set={set}
                  toys={toys.filter((t) => t.is_active)}
                  onDone={(message) => {
                    onDone(message);
                    setEditingSet(null);
                    load();
                  }}
                  onError={onError}
                />
              )}

              {applyingSet === set.id && (
                <ApplyToySetForm
                  setId={set.id}
                  onDone={(message) => {
                    onDone(message);
                    setApplyingSet(null);
                    load();
                  }}
                  onError={onError}
                />
              )}
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

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
function ConsumptionTab({ onError }: TabProps) {
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

function NewToyForm({ onDone, onError }: TabProps) {
  const [name, setName] = useState('');
  const [unitCost, setUnitCost] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/toys', { name, unitCost });
      onDone(`Игрушка «${name}» добавлена`);
      setName('');
      setUnitCost('');
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="grid-2">
        <div>
          <label>Название</label>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div>
          <label>Цена за штуку, ₽</label>
          <input type="number" step="0.01" value={unitCost} onChange={(event) => setUnitCost(event.target.value)} required />
        </div>
      </div>
      <button className="btn btn-primary" type="submit" style={{ marginTop: 10 }}>Добавить игрушку</button>
    </form>
  );
}

function EditToyForm({ toy, onDone, onError }: TabProps & { toy: Toy }) {
  const [name, setName] = useState(toy.name);
  const [unitCost, setUnitCost] = useState(toy.unit_cost);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.patch(`/api/toys/${toy.id}`, { name, unitCost });
      onDone('Игрушка изменена');
    } catch (caught) {
      onError(caught);
    }
  };

  const toggleActive = async () => {
    try {
      await api.patch(`/api/toys/${toy.id}`, { isActive: !toy.is_active });
      onDone(toy.is_active ? 'Игрушка отключена' : 'Игрушка снова активна');
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="grid-2">
        <div>
          <label>Название</label>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div>
          <label>Цена за штуку, ₽</label>
          <input type="number" step="0.01" value={unitCost} onChange={(event) => setUnitCost(event.target.value)} required />
        </div>
      </div>
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <button className="btn btn-primary" type="submit">Сохранить</button>
        <button type="button" className="btn btn-danger-ghost" onClick={toggleActive}>
          {toy.is_active ? 'Отключить' : 'Включить'}
        </button>
      </div>
      <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
        Игрушки не удаляются физически — отключение просто скрывает их из выбора для новых
        обслуживаний, старая история не меняется.
      </p>
    </form>
  );
}

function EditToySetForm({
  set,
  toys,
  onDone,
  onError,
}: TabProps & { set?: ToySet; toys: Toy[] }) {
  const [name, setName] = useState(set?.name ?? '');
  const [items, setItems] = useState<Array<{ toyId: number; quantity: string }>>(
    set?.items.map((item) => ({ toyId: item.toyId, quantity: String(item.quantity) })) ?? [],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const payload = {
      name,
      items: items
        .filter((item) => item.toyId && Number(item.quantity) > 0)
        .map((item) => ({ toyId: item.toyId, quantity: Number(item.quantity) })),
    };
    try {
      if (set) {
        await api.patch(`/api/toy-sets/${set.id}`, payload);
        onDone('Набор изменён');
      } else {
        await api.post('/api/toy-sets', payload);
        onDone(`Набор «${name}» создан`);
      }
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <form onSubmit={submit} style={{ marginTop: 12 }}>
      <div className="stack">
        <div>
          <label>Название набора</label>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </div>

        {items.map((item, index) => (
          <div className="grid-2" key={index}>
            <select
              value={item.toyId}
              onChange={(event) => {
                const next = [...items];
                next[index] = { ...item, toyId: Number(event.target.value) };
                setItems(next);
              }}
            >
              <option value={0}>— выберите игрушку —</option>
              {toys.map((toy) => (
                <option key={toy.id} value={toy.id}>{toy.name}</option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              value={item.quantity}
              onChange={(event) => {
                const next = [...items];
                next[index] = { ...item, quantity: event.target.value };
                setItems(next);
              }}
              placeholder="количество"
            />
          </div>
        ))}
        <button type="button" className="btn btn-ghost" onClick={() => setItems([...items, { toyId: 0, quantity: '1' }])}>
          + Добавить игрушку в набор
        </button>

        <button className="btn btn-primary" type="submit">{set ? 'Сохранить набор' : 'Создать набор'}</button>
      </div>
    </form>
  );
}

function ApplyToySetForm({
  setId,
  onDone,
  onError,
}: TabProps & { setId: number }) {
  const [machineTypes, setMachineTypes] = useState<string[]>([]);
  const [routes, setRoutes] = useState<Array<{ id: number; name: string }>>([]);
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [by, setBy] = useState<'type' | 'route' | 'location'>('type');
  const [machineType, setMachineType] = useState('');
  const [routeId, setRouteId] = useState('');
  const [locationId, setLocationId] = useState('');

  useEffect(() => {
    api.get<Array<{ machine_type: string }>>('/api/machines').then((rows) => {
      setMachineTypes([...new Set(rows.map((r) => r.machine_type))]);
    }).catch(() => setMachineTypes([]));
    api.get<Array<{ id: number; name: string }>>('/api/routes').then(setRoutes).catch(() => setRoutes([]));
    api.get<Array<{ id: number; name: string }>>('/api/locations').then(setLocations).catch(() => setLocations([]));
  }, []);

  const apply = async () => {
    const filter =
      by === 'type' ? { machineType } : by === 'route' ? { routeId: Number(routeId) } : { locationId: Number(locationId) };
    const label =
      by === 'type' ? `тип «${machineType}»` : by === 'route' ? 'маршрут' : 'точку (с вложенными)';
    if (!confirm(`Применить набор ко всем аппаратам, подходящим под ${label}? Прежнее назначение будет заменено.`)) return;

    try {
      const result = await api.post<{ updated: number }>(`/api/toy-sets/${setId}/apply-bulk`, filter);
      onDone(`Набор применён к аппаратам: ${result.updated}`);
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div className="tabs">
        <button className={by === 'type' ? 'active' : ''} onClick={() => setBy('type')}>По типу</button>
        <button className={by === 'route' ? 'active' : ''} onClick={() => setBy('route')}>По маршруту</button>
        <button className={by === 'location' ? 'active' : ''} onClick={() => setBy('location')}>По точке</button>
      </div>

      {by === 'type' && (
        <select value={machineType} onChange={(event) => setMachineType(event.target.value)}>
          <option value="">— выберите тип —</option>
          {machineTypes.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      )}
      {by === 'route' && (
        <select value={routeId} onChange={(event) => setRouteId(event.target.value)}>
          <option value="">— выберите маршрут —</option>
          {routes.map((route) => (
            <option key={route.id} value={route.id}>{route.name}</option>
          ))}
        </select>
      )}
      {by === 'location' && (
        <select value={locationId} onChange={(event) => setLocationId(event.target.value)}>
          <option value="">— выберите точку —</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>{location.name}</option>
          ))}
        </select>
      )}

      <button
        className="btn btn-primary"
        style={{ marginTop: 10 }}
        disabled={(by === 'type' && !machineType) || (by === 'route' && !routeId) || (by === 'location' && !locationId)}
        onClick={apply}
      >
        Применить ко всем подходящим аппаратам
      </button>
    </div>
  );
}
