import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import type { Location, TabProps, Classifier } from './types';
import { Section } from './shared/Section';
import { flattenTree } from './shared/flattenTree';

export function CatalogTab({ onDone, onError }: TabProps) {
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
