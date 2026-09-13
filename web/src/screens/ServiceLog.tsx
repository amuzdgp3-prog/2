import { useEffect, useMemo, useState } from 'react';
import { api, getToken } from '../api';
import { daysBetween, formatGames, formatMoney } from '../calc';
import { PageSizeSelect } from '../components/ui/PageSizeSelect';
import { PhotoThumbnail } from '../components/ui/PhotoLightbox';
import { RoiBadge } from '../components/ui/RoiBadge';

interface ToyLine {
  toyId: number;
  name: string;
  quantity: number;
  unitCost: string;
}

interface ServiceLogRow {
  id: number;
  occurred_at: string;
  machine_number: string;
  machine_model: string;
  address: string | null;
  technician_name: string | null;
  game_counter: number;
  prize_counter: number;
  test_games: number;
  price_per_game_snapshot: string;
  counter_divisor_applied: string;
  new_games: string;
  revenue: string;
  cash_amount: string;
  cashless_amount: string;
  toy_cost: string;
  revenue_to_cost_ratio: string | null;
  notes: string;
  photo_object_key: string;
  toys: ToyLine[] | null;
  prev_occurred_at: string | null;
  prev_game_counter: number | null;
  prev_prize_counter: number | null;
  prev_revenue: string | null;
  prev_toy_cost: string | null;
  prev_revenue_to_cost_ratio: string | null;
  prev_cash_amount: string | null;
  prev_cashless_amount: string | null;
  prev_toys: ToyLine[] | null;
}

interface StaffOption {
  id: number;
  full_name: string;
  role: string;
}

/** Дата и время двумя отдельными строками, а не «10.09, 09:17» в одну: так дата и время короче по
 * горизонтали в таблице (первое, что мешало таблице поместиться на мониторе без прокрутки) и
 * читаются раздельно на телефоне, где важнее дата крупно, а не точная минута. */
function splitDateTime(iso: string): { date: string; time: string } {
  const value = new Date(iso);
  return {
    date: value.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
    time: value.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
  };
}

/** Дней с прошлого обслуживания и темп — общий расчёт для табличной и карточной раскладки одной
 * и той же строки, чтобы они не разошлись при будущей правке только одной из двух вёрсток. */
function serviceMeta(row: ServiceLogRow): { periodDays: number | null; perDay: number | null } {
  const periodDays = daysBetween(row.prev_occurred_at, row.occurred_at);
  const perDay = periodDays && periodDays > 0 ? Number(row.new_games) / periodDays : null;
  return { periodDays, perDay };
}

/** Журнал обслуживаний (docs/design/mockups/07_admin_service_log.html): фильтруемый список всех
 * Service. Таблица на широком экране (DECISION-053) и карточки на телефоне — два разных markup'а
 * на одних данных, переключаемые CSS-классами (.desktop-only/.mobile-only), а не одна таблица,
 * подогнанная под оба случая сразу: 13 колонок нормально стоят в ряд на мониторе и никак не
 * смотрятся сжатыми в горизонтальный скролл на экране в 380px. */
export default function ServiceLogScreen() {
  const [rows, setRows] = useState<ServiceLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [technicianId, setTechnicianId] = useState('');
  const [machineType, setMachineType] = useState('');
  const [technicians, setTechnicians] = useState<StaffOption[]>([]);
  const [machineTypes, setMachineTypes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    api.get<StaffOption[]>('/api/staff').then((staff) => setTechnicians(staff.filter((s) => s.role === 'TECHNICIAN'))).catch(() => setTechnicians([]));
    api.get<Array<{ name: string }>>('/api/machine-types').then((rows) => setMachineTypes(rows.map((r) => r.name))).catch(() => setMachineTypes([]));
  }, []);

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    if (search) params.set('search', search);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (technicianId) params.set('technicianId', technicianId);
    if (machineType) params.set('machineType', machineType);
    return params.toString();
  }, [search, from, to, technicianId, machineType, page, pageSize]);

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
  useEffect(() => setPage(0), [search, from, to, technicianId, machineType, pageSize]);

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
          <label>Тип аппарата</label>
          <select value={machineType} onChange={(event) => setMachineType(event.target.value)}>
            <option value="">Все</option>
            {machineTypes.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="table-wrap scroll-x table-tall desktop-only">
        <table>
          <thead>
            <tr>
              <th>Дата / время</th>
              <th className="num">№</th>
              <th>Адрес</th>
              <th>Техник</th>
              <th className="num">Дней</th>
              <th className="num">Новых игр</th>
              <th className="num">Игр/день</th>
              <th className="num">Выручка</th>
              <th className="num">Себест.</th>
              <th>ROI</th>
              <th>Фото</th>
              <th>Комментарий</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const { periodDays, perDay } = serviceMeta(row);
              const { date, time } = splitDateTime(row.occurred_at);
              const isOpen = expanded === row.id;
              return (
                <>
                  <tr
                    key={row.id}
                    className="tappable"
                    onClick={() => setExpanded(isOpen ? null : row.id)}
                  >
                    <td className="mono">
                      <div>{date}</div>
                      <div className="muted" style={{ fontSize: 11 }}>{time}</div>
                    </td>
                    <td className="num mono" style={{ fontWeight: 700 }}>№ {row.machine_number}</td>
                    <td className="wrap">{row.address || row.machine_model || '—'}</td>
                    <td>{row.technician_name ?? '—'}</td>
                    <td className="num mono">{periodDays ?? '—'}</td>
                    <td className="num">+{formatGames(row.new_games)}</td>
                    <td className="num mono">{perDay === null ? '—' : perDay.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}</td>
                    <td className="num">{formatMoney(row.revenue)} ₽</td>
                    <td className="num">{formatMoney(row.toy_cost)} ₽</td>
                    <td><RoiBadge value={row.revenue_to_cost_ratio} /></td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <PhotoCell objectKey={row.photo_object_key} />
                    </td>
                    <td className="muted wrap">{row.notes || '—'}</td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <button className="icon-btn danger" onClick={() => remove(row.id)}>✕</button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${row.id}-detail`}>
                      <td colSpan={13} style={{ padding: 0 }}>
                        <ServiceDetail row={row} periodDays={periodDays} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 24 }}>Ничего не найдено</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mobile-only">
        {rows.length === 0 && (
          <div className="card muted" style={{ textAlign: 'center' }}>Ничего не найдено</div>
        )}
        {rows.map((row) => {
          const { periodDays } = serviceMeta(row);
          const { date, time } = splitDateTime(row.occurred_at);
          const isOpen = expanded === row.id;
          return (
            <div className="card" key={row.id}>
              <div className="tappable" onClick={() => setExpanded(isOpen ? null : row.id)}>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <div className="mono">
                    <div style={{ fontWeight: 600 }}>{date}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{time}</div>
                  </div>
                  <span className="mono" style={{ fontWeight: 700 }}>№ {row.machine_number}</span>
                </div>
                <div className="wrap" style={{ marginTop: 8 }}>{row.address || row.machine_model || '—'}</div>
                <div className="muted" style={{ marginTop: 2 }}>{row.technician_name ?? '—'}</div>

                <div className="row" style={{ marginTop: 10, gap: 12 }}>
                  <div>
                    <div className="muted" style={{ fontSize: 11 }}>Новых игр</div>
                    <div className="mono">+{formatGames(row.new_games)}</div>
                  </div>
                  <div>
                    <div className="muted" style={{ fontSize: 11 }}>Выручка</div>
                    <div className="mono">{formatMoney(row.revenue)} ₽</div>
                  </div>
                  <RoiBadge value={row.revenue_to_cost_ratio} />
                </div>
              </div>

              {isOpen && <ServiceDetail row={row} periodDays={periodDays} />}

              <div className="row" style={{ marginTop: 10, gap: 8 }}>
                <div onClick={(event) => event.stopPropagation()}>
                  <PhotoCell objectKey={row.photo_object_key} />
                </div>
                {row.notes && <div className="muted wrap" style={{ flex: 1, fontSize: 12.5 }}>{row.notes}</div>}
                <button className="icon-btn danger" onClick={() => remove(row.id)}>✕</button>
              </div>
            </div>
          );
        })}
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

/** Расход игрушек в столбик — по одной на строку, а не одной длинной строкой через запятую,
 * которая на телефоне переносилась куда придётся и её было тяжело читать построчно. */
function ToyList({ toys }: { toys: ToyLine[] | null }) {
  if (!toys || toys.length === 0) return <span className="muted">—</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
      {toys.map((toy) => (
        <div key={toy.toyId} className="mono" style={{ fontSize: 12 }}>
          {toy.name} ×{toy.quantity} — {formatMoney(String(Number(toy.quantity) * Number(toy.unitCost)))} ₽
        </div>
      ))}
    </div>
  );
}

/** Полная карточка обслуживания при раскрытии строки — себестоимость и разбивка по игрушкам (в
 * штуках и в рублях), плюс что было на прошлом обслуживании этой же цепочки и как текущее к нему
 * относится (Δ по дням и по счётчику). Общая и для табличной, и для карточной раскладки. */
function ServiceDetail({ row, periodDays }: { row: ServiceLogRow; periodDays: number | null }) {
  const hasPrev = row.prev_occurred_at !== null;
  return (
    <div className="readonly-prev" style={{ margin: '10px 0 0' }}>
      <div className="grid-2" style={{ gap: 16 }}>
        <div>
          <div className="lbl">ЭТО ОБСЛУЖИВАНИЕ</div>
          <div className="grid">
            <div className="cell"><b className="mono">{row.game_counter}</b><span>счётчик игр</span></div>
            <div className="cell"><b className="mono">{row.prize_counter}</b><span>счётчик призов</span></div>
            <div className="cell"><b className="mono">{row.test_games}</b><span>тестовых игр</span></div>
            <div className="cell"><b className="mono">{formatMoney(row.price_per_game_snapshot)} ₽</b><span>цена игры</span></div>
            <div className="cell"><b className="mono">{formatMoney(row.cash_amount)} ₽</b><span>нал</span></div>
            <div className="cell"><b className="mono">{formatMoney(row.cashless_amount)} ₽</b><span>безнал</span></div>
          </div>
          <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>Игрушки:</div>
          <ToyList toys={row.toys} />
          <div className="mono" style={{ marginTop: 6, fontSize: 12 }}>
            Себестоимость игрушек: <b>{formatMoney(row.toy_cost)} ₽</b>
          </div>
        </div>

        <div>
          <div className="lbl">ПРОШЛОЕ ОБСЛУЖИВАНИЕ</div>
          {!hasPrev ? (
            <p className="muted" style={{ marginTop: 4 }}>Это первое обслуживание в цепочке аппарата — сравнивать не с чем.</p>
          ) : (
            <>
              <div className="grid">
                <div className="cell">
                  <b className="mono">{new Date(row.prev_occurred_at as string).toLocaleDateString('ru-RU')}</b>
                  <span>дата</span>
                </div>
                <div className="cell"><b className="mono">{row.prev_game_counter}</b><span>счётчик игр</span></div>
                <div className="cell"><b className="mono">{formatMoney(row.prev_revenue ?? '0')} ₽</b><span>выручка</span></div>
                <div className="cell"><b className="mono">{formatMoney(row.prev_toy_cost ?? '0')} ₽</b><span>себест. игрушек</span></div>
                <div className="cell"><RoiBadge value={row.prev_revenue_to_cost_ratio} /><span>ROI</span></div>
                <div className="cell"><b className="mono">{periodDays ?? '—'} дн.</b><span>прошло с прошлого раза</span></div>
              </div>
              <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>Игрушки в прошлый раз:</div>
              <ToyList toys={row.prev_toys} />
              <div className="mono" style={{ marginTop: 6, fontSize: 12 }}>
                Δ счётчик: <b>+{row.game_counter - (row.prev_game_counter ?? row.game_counter)}</b>
                {' · '}
                Δ выручка: <b>{formatMoney(String(Number(row.revenue) - Number(row.prev_revenue ?? 0)))} ₽</b>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
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
