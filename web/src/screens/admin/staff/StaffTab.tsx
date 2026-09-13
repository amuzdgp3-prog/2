import { useEffect, useState } from 'react';
import { api } from '../../../api';
import type { Location, TabProps, Classifier } from '../types';
import type { StaffRow } from './types';
import { ROLE_LABELS } from './types';
import { flattenTree } from '../shared/flattenTree';
import { CreateStaffForm } from './StaffForms';
import { EditStaffForm } from './StaffForms';

export function StaffTab({ onDone, onError }: TabProps) {
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
