import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../../api';
import type { Machine, TabProps, Classifier } from '../types';
import { flattenTree } from '../shared/flattenTree';
import { LocationRentCard } from './LocationRentCard';

export function EditMachineForm({ machine, onDone, onError }: TabProps & { machine: Machine }) {
  const [pricePerGame, setPricePerGame] = useState(machine.price_per_game);
  const [counterDivisor, setCounterDivisor] = useState(machine.counter_divisor);
  const [minDays, setMinDays] = useState(machine.min_service_days?.toString() ?? '');
  const [maxDays, setMaxDays] = useState(machine.max_service_days?.toString() ?? '');
  const [address, setAddress] = useState(machine.address ?? '');
  const [machineType, setMachineType] = useState(machine.machine_type);
  const [machineTypes, setMachineTypes] = useState<Array<{ name: string; is_active: boolean }>>([]);
  const [applyFrom, setApplyFrom] = useState('');
  const [classifiers, setClassifiers] = useState<Classifier[]>([]);
  const [addTagChoice, setAddTagChoice] = useState('');

  const loadClassifiers = () => api.get<Classifier[]>('/api/classifiers').then(setClassifiers).catch(onError);
  useEffect(() => {
    void loadClassifiers();
    // Текущий тип аппарата показывается в списке, даже если его потом отключили в справочнике —
    // иначе выпадающий список у уже установленного аппарата открывался бы без его же значения.
    api
      .get<Array<{ name: string; is_active: boolean }>>('/api/machine-types')
      .then((rows) =>
        setMachineTypes(
          rows.some((row) => row.name === machine.machine_type)
            ? rows
            : [...rows, { name: machine.machine_type, is_active: false }],
        ),
      )
      .catch(onError);
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
        machineType,
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
        <div>
          <label>Тип аппарата</label>
          <select value={machineType} onChange={(event) => setMachineType(event.target.value)}>
            {machineTypes.map((type) => (
              <option key={type.name} value={type.name}>
                {type.name}
                {!type.is_active ? ' (отключён в справочнике)' : ''}
              </option>
            ))}
          </select>
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

        {machine.location_id && (
          <LocationRentCard locationId={machine.location_id} onDone={onDone} onError={onError} />
        )}

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

/** Аренда точки — привязана к адресу, не к аппарату (см. DECISION), поэтому карточка любого
 * аппарата на этой точке показывает и редактирует одну и ту же историю ставок. Правка не
 * переписывает прошлое: закрывает текущий период и открывает новый с указанной даты, старые
 * месяцы в отчётах считаются по прежней ставке. */
