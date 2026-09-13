import { Fragment, useEffect, useState } from 'react';
import { api } from '../../api';
import { PageSizeSelect } from '../../components/ui/PageSizeSelect';
import type { TabProps } from './types';

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

export function AuditTab({ onError }: TabProps) {
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
