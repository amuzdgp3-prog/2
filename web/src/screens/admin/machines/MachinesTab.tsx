import { useEffect, useState } from 'react';
import { api } from '../../../api';
import { PageSizeSelect } from '../../../components/ui/PageSizeSelect';
import type { Machine, ToySet, Terminal, Location, TabProps } from '../types';
import { EditMachineForm } from './EditMachineForm';
import { InstallMachineForm } from './InstallMachineForm';

export function MachinesTab({ onDone, onError }: TabProps) {
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
