import { useEffect, useMemo, useState } from 'react';
import { api, getToken } from '../api';
import { formatGames, formatMoney } from '../calc';
import { MachineTag } from '../components/ui/MachineTag';
import { PageSizeSelect } from '../components/ui/PageSizeSelect';
import { PhotoThumbnail } from '../components/ui/PhotoLightbox';
import { RoiBadge } from '../components/ui/RoiBadge';

interface ServiceLogRow {
  id: number;
  occurred_at: string;
  machine_number: string;
  machine_model: string;
  location_name: string;
  address: string | null;
  technician_name: string | null;
  new_games: string;
  revenue: string;
  toy_cost: string;
  revenue_to_cost_ratio: string | null;
  notes: string;
  photo_object_key: string;
}

interface StaffOption {
  id: number;
  full_name: string;
  role: string;
}

interface LocationOption {
  id: number;
  name: string;
}

/** Журнал обслуживаний (docs/design/mockups/07_admin_service_log.html): фильтруемая таблица всех Service. */
export default function ServiceLogScreen() {
  const [rows, setRows] = useState<ServiceLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [technicianId, setTechnicianId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [technicians, setTechnicians] = useState<StaffOption[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.get<StaffOption[]>('/api/staff').then((staff) => setTechnicians(staff.filter((s) => s.role === 'TECHNICIAN'))).catch(() => setTechnicians([]));
    api.get<LocationOption[]>('/api/locations').then(setLocations).catch(() => setLocations([]));
  }, []);

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    if (search) params.set('search', search);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (technicianId) params.set('technicianId', technicianId);
    if (locationId) params.set('locationId', locationId);
    return params.toString();
  }, [search, from, to, technicianId, locationId, page, pageSize]);

  const load = () => {
    api
      .get<{ rows: ServiceLogRow[]; total: number }>(`/api/services?${query}`)
      .then((response) => {
        setRows(response.rows);
        setTotal(response.total);
      })
      .catch((caught) => setError((caught as Error).message));
  };

  useEffect(load, [query]);

  // Any filter or page-size change should jump back to page 1, otherwise you can land on an empty page.
  useEffect(() => setPage(0), [search, from, to, technicianId, locationId, pageSize]);

  const remove = async (id: number) => {
    if (!confirm('Удалить обслуживание? Цепочка аппарата будет пересчитана.')) return;
    try {
      await api.delete(`/api/services/${id}`);
      setNotice('Обслуживание удалено, цепочка пересчитана');
      load();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const shownFrom = total === 0 ? 0 : page * pageSize + 1;
  const shownTo = Math.min(total, (page + 1) * pageSize);

  const downloadCsv = async () => {
    // Export ignores the on-screen page/page-size: it always pulls up to the server's own cap
    // (500), independent of whatever page size is currently selected for display.
    const exportParams = new URLSearchParams(query);
    exportParams.set('limit', '500');
    exportParams.set('offset', '0');
    const response = await api.get<{ rows: ServiceLogRow[] }>(`/api/services?${exportParams.toString()}`);
    const header = ['Дата', 'Аппарат', 'Адрес', 'Техник', 'Новых игр', 'Выручка', 'Себестоимость', 'ROI'];
    const lines = response.rows.map((row) =>
      [
        new Date(row.occurred_at).toLocaleString('ru-RU'),
        row.machine_number,
        `"${(row.address || row.machine_model || '').replaceAll('"', '""')}"`,
        row.technician_name ?? '',
        row.new_games,
        row.revenue,
        row.toy_cost,
        row.revenue_to_cost_ratio ?? '',
      ].join(','),
    );
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'service-log.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Журнал обслуживаний</h2>
        <button className="btn btn-ghost" onClick={downloadCsv}>⇩ Экспорт</button>
      </div>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      <div className="filters-panel">
        <div className="fld">
          <label>Аппарат / адрес</label>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Номер или адрес" />
        </div>
        <div className="fld">
          <label>Дата с</label>
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </div>
        <div className="fld">
          <label>Дата по</label>
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </div>
        <div className="fld">
          <label>Техник</label>
          <select value={technicianId} onChange={(event) => setTechnicianId(event.target.value)}>
            <option value="">Все</option>
            {technicians.map((tech) => (
              <option key={tech.id} value={tech.id}>{tech.full_name}</option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label>Точка</label>
          <select value={locationId} onChange={(event) => setLocationId(event.target.value)}>
            <option value="">Все</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>{location.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="table-wrap scroll-x">
        <table>
          <thead>
            <tr>
              <th>Дата / время</th>
              <th className="num">№</th>
              <th>Адрес</th>
              <th>Техник</th>
              <th className="num">Новых игр</th>
              <th className="num">Выручка</th>
              <th className="num">Себест.</th>
              <th>ROI</th>
              <th>Фото</th>
              <th>Комментарий</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="mono">
                  {new Date(row.occurred_at).toLocaleString('ru-RU', {
                    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                  })}
                </td>
                <td className="num"><MachineTag number={row.machine_number} /></td>
                <td className="wrap">{row.address || row.machine_model || '—'}<div className="muted" style={{ fontSize: 11 }}>{row.location_name}</div></td>
                <td>{row.technician_name ?? '—'}</td>
                <td className="num">+{formatGames(row.new_games)}</td>
                <td className="num">{formatMoney(row.revenue)} ₽</td>
                <td className="num">{formatMoney(row.toy_cost)} ₽</td>
                <td><RoiBadge value={row.revenue_to_cost_ratio} /></td>
                <td>
                  <PhotoCell objectKey={row.photo_object_key} />
                </td>
                <td className="muted wrap">{row.notes || '—'}</td>
                <td><button className="icon-btn danger" onClick={() => remove(row.id)}>✕</button></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 24 }}>Ничего не найдено</td></tr>
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

/** Раскрывающаяся по клику миниатюра фото счётчика — не занимает место в строке, пока не нужна. */
function PhotoCell({ objectKey }: { objectKey: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-btn" onClick={() => setOpen(!open)} title="Фото счётчика">📷</button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <PhotoThumbnail src={`/api/photos/${objectKey}?token=${getToken()}`} alt="Фото счётчика" />
        </div>
      )}
    </>
  );
}
