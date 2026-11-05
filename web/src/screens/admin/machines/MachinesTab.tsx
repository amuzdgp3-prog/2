import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../../api';
import { PageSizeSelect } from '../../../components/ui/PageSizeSelect';
import type { Machine, ToySet, Terminal, Location, TabProps } from '../types';
import { EditMachineForm } from './EditMachineForm';
import { InstallMachineForm } from './InstallMachineForm';
import { StickerSheet } from './StickerSheet';
import { MachineDialog } from './MachineDialog';
import './MachinesTab.css';

type Action = 'install' | 'edit' | 'bind' | 'unbind' | 'toys' | 'remove-toys' | 'move' | 'retire' | 'restore';
type Operation = { action: Action; machineNumber?: string };
const actionTitles: Record<Action, string> = {
  install: 'Установить аппарат', edit: 'Параметры аппарата', bind: 'Привязать терминал',
  unbind: 'Снять терминал?', toys: 'Назначить набор игрушек', 'remove-toys': 'Снять набор игрушек?',
  move: 'Переместить аппарат', retire: 'Списать аппарат?', restore: 'Вернуть аппарат в строй?',
};

function MachineStatus({ machine }: { machine: Machine }) {
  const retired = machine.status === 'RETIRED';
  const label = retired ? 'Списан' : !machine.location_id ? 'Нет установки' : !machine.terminal_id ? 'Без терминала' : 'В работе';
  return <span className={`am-status${retired ? ' am-status-retired' : ''}`}>{label}</span>;
}

export function MachinesTab({ onDone, onError }: TabProps) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [toySets, setToySets] = useState<ToySet[]>([]);
  const [machineTypes, setMachineTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [terminalFilter, setTerminalFilter] = useState('');
  const [scope, setScope] = useState<'active' | 'retired'>('active');
  // The full fleet is also required for the technician's offline cache. Limit rendering only.
  const [pageSize, setPageSize] = useState(50);
  const [stickerMode, setStickerMode] = useState(false);
  const [selectedStickers, setSelectedStickers] = useState<Set<string>>(new Set());
  const [operation, setOperation] = useState<Operation | null>(null);
  const [choice, setChoice] = useState('');
  const [detachTerminal, setDetachTerminal] = useState(false);
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const load = () => {
    setLoading(true);
    setLoadFailed(false);
    api.get<Machine[]>('/api/machines').then(setMachines).catch((error) => {
      setLoadFailed(true);
      onError(error);
    }).finally(() => setLoading(false));
    api.get<Location[]>('/api/locations').then(setLocations).catch(onError);
    api.get<Terminal[]>('/api/terminals').then(setTerminals).catch(onError);
    api.get<ToySet[]>('/api/toy-sets').then(setToySets).catch(onError);
    api.get<Array<{ name: string }>>('/api/machine-types')
      .then((rows) => setMachineTypes(rows.map((row) => row.name)))
      .catch(() => setMachineTypes([]));
  };
  useEffect(load, []);

  const freeTerminals = terminals.filter((terminal) => !terminal.bound_machine);
  // Moving must target an address, never a parent branch such as a city or region.
  const parentIds = new Set(locations.map((location) => location.parent_id).filter((id): id is number => id != null));
  const addressLocations = locations.filter((location) => !parentIds.has(location.id));
  const activeMachines = machines.filter((machine) => machine.status !== 'RETIRED');
  const retiredMachines = machines.filter((machine) => machine.status === 'RETIRED');
  const needle = search.trim().toLowerCase();
  const filteredMachines = (scope === 'active' ? activeMachines : retiredMachines).filter((machine) =>
    (!needle || [machine.machine_number, machine.address ?? '', machine.location_name ?? '', machine.machine_type]
      .join(' ').toLowerCase().includes(needle)) &&
    (!typeFilter || machine.machine_type === typeFilter) &&
    (!terminalFilter || Boolean(machine.terminal_id) === (terminalFilter === 'bound')),
  );
  const stickerable = filteredMachines.filter((machine) => machine.status !== 'RETIRED' && machine.address);
  // The actual print sheet and count use only selected records still eligible for printing.
  const selectedMachines = stickerable.filter((machine) => selectedStickers.has(machine.machine_number));
  const machine = machines.find((item) => item.machine_number === operation?.machineNumber);
  const open = (action: Action, item?: Machine) => {
    setChoice(''); setDetachTerminal(false); setDialogError('');
    setOperation({ action, machineNumber: item?.machine_number });
  };
  const close = () => { if (!pending) setOperation(null); };
  const reportDialogError = (error: unknown) => {
    setDialogError(error instanceof Error ? error.message : 'Не удалось выполнить действие');
  };
  const done = (message: string) => { setOperation(null); onDone(message); load(); };
  const toggleSticker = (number: string) => setSelectedStickers((current) => {
    const next = new Set(current);
    if (next.has(number)) next.delete(number); else next.add(number);
    return next;
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!machine || !operation || pending) return;
    setPending(true); setDialogError('');
    const number = encodeURIComponent(machine.machine_number);
    try {
      switch (operation.action) {
        case 'bind':
          await api.post('/api/terminals/bind', { terminalId: Number(choice), machineNumber: machine.machine_number, startedAt: new Date().toISOString() });
          done('Терминал привязан, безналичные транзакции пересопоставлены'); break;
        case 'unbind':
          await api.post('/api/terminals/unbind', { terminalId: machine.terminal_id, endedAt: new Date().toISOString() });
          done('Терминал снят и возвращён на склад'); break;
        case 'toys':
        case 'remove-toys':
          await api.post(`/api/machines/${number}/toy-set`, { setId: operation.action === 'toys' ? Number(choice) : null });
          done(operation.action === 'toys' ? 'Набор игрушек назначен' : 'Набор игрушек снят'); break;
        case 'move': {
          const result = await api.post<{ terminalCarriedOver: boolean }>(`/api/machines/${number}/move`, { locationId: Number(choice), detachTerminal });
          done(result.terminalCarriedOver ? 'Аппарат перемещён, терминал переехал вместе с ним' : 'Аппарат перемещён на новую точку'); break;
        }
        case 'retire':
        case 'restore':
          await api.patch(`/api/machines/${number}`, { status: operation.action === 'retire' ? 'RETIRED' : 'ACTIVE' });
          done(operation.action === 'retire' ? 'Аппарат списан' : 'Аппарат возвращён в строй'); break;
      }
    } catch (error) { reportDialogError(error); }
    finally { setPending(false); }
  };
  const needsChoice = operation && ['bind', 'toys', 'move'].includes(operation.action);
  const availableLocations = addressLocations.filter((location) => location.status === 'ACTIVE' && location.id !== machine?.location_id);
  const typeOptions = Array.from(new Set([...machineTypes, ...machines.map((item) => item.machine_type)]));

  return (
    <section className="admin-machines" aria-label="Управление аппаратами">
      <div className="am-heading">
        <div><h2>Аппараты</h2><p>Размещение, оборудование и настройки парка</p></div>
        <div className="am-actions">
          <button aria-pressed={stickerMode} onClick={() => { setStickerMode(!stickerMode); setSelectedStickers(new Set()); }}>{stickerMode ? 'Завершить выбор' : 'Наклейки'}</button>
          <button className="primary" onClick={() => open('install')}>＋ Установить аппарат</button>
        </div>
      </div>
      <div className="am-stats" aria-label="Сводка по всему парку">
        <div><span>В работе</span><strong>{loading ? '…' : activeMachines.length}</strong></div>
        <div><span>Без терминала</span><strong>{loading ? '…' : activeMachines.filter((item) => !item.terminal_id).length}</strong></div>
        <div><span>Списано</span><strong>{loading ? '…' : retiredMachines.length}</strong></div>
      </div>
      <div className="am-scopes" aria-label="Статус аппаратов">
        <button aria-pressed={scope === 'active'} onClick={() => { setScope('active'); setSelectedStickers(new Set()); }}>В работе <span>{activeMachines.length}</span></button>
        <button aria-pressed={scope === 'retired'} onClick={() => { setScope('retired'); setSelectedStickers(new Set()); }}>Списанные <span>{retiredMachines.length}</span></button>
      </div>
      <div className="am-filters">
        <input type="search" aria-label="Поиск аппарата" placeholder="Номер, адрес или точка" value={search} onChange={(event) => { setSearch(event.target.value); setSelectedStickers(new Set()); }} />
        <select aria-label="Тип аппарата" value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value); setSelectedStickers(new Set()); }}><option value="">Все типы</option>{typeOptions.map((name) => <option key={name}>{name}</option>)}</select>
        <select aria-label="Наличие терминала" value={terminalFilter} onChange={(event) => { setTerminalFilter(event.target.value); setSelectedStickers(new Set()); }}><option value="">Любой терминал</option><option value="missing">Без терминала</option><option value="bound">С терминалом</option></select>
      </div>
      {stickerMode && <div className="am-selection">
        <strong>Выбрано: {selectedMachines.length}</strong>
        <button onClick={() => setSelectedStickers(new Set(stickerable.map((item) => item.machine_number)))}>Выбрать доступные</button>
        <button onClick={() => setSelectedStickers(new Set())}>Снять выбор</button>
        <button className="primary" disabled={!selectedMachines.length} onClick={() => window.print()}>Печать наклеек ({selectedMachines.length})</button>
        <p>Выбираются все аппараты по текущему фильтру. Для наклейки нужен адрес; списанные аппараты не печатаются.</p>
      </div>}
      <div className="am-list-head"><span>{loading ? 'Загрузка аппаратов…' : `Показано ${Math.min(filteredMachines.length, pageSize)} из ${filteredMachines.length}`}</span><PageSizeSelect value={pageSize} onChange={setPageSize} /></div>
      {loadFailed ? <div className="am-empty" role="alert"><strong>Не удалось загрузить аппараты</strong><button onClick={load}>Повторить</button></div> : !loading && !filteredMachines.length && <div className="am-empty"><strong>Аппараты не найдены</strong><p>Попробуйте другой номер, адрес или измените фильтры.</p><button onClick={() => { setSearch(''); setTypeFilter(''); setTerminalFilter(''); }}>Сбросить фильтры</button></div>}
      {!loadFailed && filteredMachines.slice(0, pageSize).map((item) => (
        <div className={`am-item${stickerMode ? ' am-item-selectable' : ''}`} key={item.machine_number}>
          {stickerMode && <input className="am-sticker" type="checkbox" aria-label={`Наклейка аппарата ${item.machine_number}`} disabled={!item.address || item.status === 'RETIRED'} title={!item.address ? 'Для наклейки нужен адрес' : undefined} checked={selectedMachines.some((selected) => selected.machine_number === item.machine_number)} onChange={() => toggleSticker(item.machine_number)} />}
          <details>
            <summary className="am-summary">
              <span className="am-number">{item.machine_number}</span>
              <span className="am-place"><strong>{item.address || 'Адрес не указан'}</strong><small>{item.location_name || 'Нет активной установки'} · {item.machine_type}</small></span>
              <span className="am-terminal"><small>Терминал</small><span>{item.terminal_serial || 'Не привязан'}</span></span>
              <span className="am-summary-status"><MachineStatus machine={item} /></span><span className="am-chevron" aria-hidden="true">⌄</span>
            </summary>
            <div className="am-detail">
              <div className="am-detail-top"><div><h3>Аппарат № {item.machine_number}</h3><MachineStatus machine={item} /></div>{item.status !== 'RETIRED' && <button onClick={() => open('edit', item)}>Изменить параметры</button>}</div>
              <dl className="am-facts">
                <div><dt>Тип аппарата</dt><dd>{item.machine_type}</dd></div>
                <div><dt>Цена игры</dt><dd>{item.price_per_game} ₽</dd></div>
                <div><dt>Коэффициент счётчика</dt><dd>× {item.counter_divisor}</dd></div>
                <div><dt>Интервал обслуживания</dt><dd>{item.min_service_days == null && item.max_service_days == null ? 'Не задан' : `${item.min_service_days == null ? '' : `от ${item.min_service_days} `}${item.max_service_days == null ? '' : `до ${item.max_service_days} `}дн.`}</dd></div>
                <div><dt>Терминал</dt><dd><span className="am-fact-value">{item.terminal_serial || 'Не привязан'}</span>{item.status !== 'RETIRED' && <button className="am-link" onClick={() => open(item.terminal_id ? 'unbind' : 'bind', item)}>{item.terminal_id ? 'Снять' : 'Привязать'}</button>}</dd></div>
                <div><dt>Набор игрушек</dt><dd><span className="am-fact-value">{item.default_toy_set_name || 'Не назначен'}</span>{item.status !== 'RETIRED' && <span className="am-fact-actions"><button className="am-link" onClick={() => open('toys', item)}>{item.default_toy_set_id ? 'Заменить' : 'Назначить'}</button>{item.default_toy_set_id != null && <button className="am-link" onClick={() => open('remove-toys', item)}>Снять</button>}</span>}</dd></div>
              </dl>
              <div className="am-detail-bottom">{item.status === 'RETIRED' ? <button onClick={() => open('restore', item)}>Вернуть в строй</button> : <><button onClick={() => open('move', item)}>Переместить аппарат</button><button className="danger" onClick={() => open('retire', item)}>Списать аппарат</button></>}</div>
            </div>
          </details>
        </div>
      ))}
      <StickerSheet machines={selectedMachines} />
      {operation && <MachineDialog title={`${actionTitles[operation.action]}${machine ? ` · № ${machine.machine_number}` : ''}`} onClose={close} pending={pending}>
        {dialogError && <div className="alert error" role="alert">{dialogError}</div>}
        {operation.action === 'install' ? <InstallMachineForm locations={addressLocations} terminals={freeTerminals} onDone={done} onError={reportDialogError} /> : operation.action === 'edit' && machine ? <EditMachineForm key={machine.machine_number} machine={machine} onDone={done} onError={reportDialogError} /> : machine && <form onSubmit={submit}>
          {operation.action === 'bind' && <label>Свободный терминал<select required value={choice} onChange={(event) => setChoice(event.target.value)}><option value="">Выберите терминал</option>{freeTerminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.serial}</option>)}</select>{!freeTerminals.length && <span className="am-hint">Свободных терминалов нет. Добавьте их во вкладке «Терминалы».</span>}</label>}
          {operation.action === 'unbind' && <p>Терминал {machine.terminal_serial} будет снят с аппарата и возвращён на склад.</p>}
          {operation.action === 'toys' && <label>Набор игрушек<select required value={choice} onChange={(event) => setChoice(event.target.value)}><option value="">Выберите набор</option>{toySets.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}</select>{!toySets.length && <span className="am-hint">Сначала создайте набор во вкладке «Игрушки».</span>}</label>}
          {operation.action === 'remove-toys' && <p>Набор «{machine.default_toy_set_name}» больше не будет назначен этому аппарату по умолчанию.</p>}
          {operation.action === 'move' && <><label>Новая точка<select required value={choice} onChange={(event) => setChoice(event.target.value)}><option value="">Выберите точку</option>{availableLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>{!availableLocations.length && <p className="am-hint">Нет других активных адресов для перемещения.</p>}{machine.terminal_id != null && <><p className="am-hint">По умолчанию терминал {machine.terminal_serial} переезжает вместе с аппаратом.</p><label className="am-checkbox"><input type="checkbox" checked={detachTerminal} onChange={(event) => setDetachTerminal(event.target.checked)} />Не переносить терминал на новую точку</label></>}</>}
          {operation.action === 'retire' && <p>Аппарат перейдёт в раздел «Списанные». История обслуживаний сохранится.</p>}
          {operation.action === 'restore' && <p>Аппарат снова появится в основном списке.</p>}
          <div className="am-dialog-actions"><button type="button" disabled={pending} onClick={close}>Отмена</button><button type="submit" className={operation.action === 'retire' ? 'danger' : 'primary'} disabled={pending || Boolean(needsChoice && !choice)}>{pending ? 'Сохранение…' : operation.action === 'retire' ? 'Списать аппарат' : 'Подтвердить'}</button></div>
        </form>}
      </MachineDialog>}
    </section>
  );
}
