import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { formatMoney } from '../../calc';
import type { Toy, ToySet, TabProps } from './types';
import { Section } from './shared/Section';

export function ToysTab({ onDone, onError }: TabProps) {
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
