import { useEffect, useState } from 'react';
import { api } from '../api';

type Item = { id: number; date: string; amount: string; label: string; category: string };
type Calculation = {
  from: string; to: string; cash: string; salary: string; fuel: string; other: string;
  transferred: string; adjustment: string; expected: string; token: string;
  services: Item[]; expenses: Item[];
  corrections: Array<{ collectionId: number; from: string; to: string; delta: string }>;
};
type Technician = { id: number; full_name: string; is_active: boolean; last_to: string | null };
type Collection = {
  id: number; technician_id: number; full_name: string; period_from: string; period_to: string; received_on: string; source_delta: string;
  expected: string; actual: string | null; difference: string | null; comment: string; snapshot: Calculation;
};
type Overview = { start: string; technicians: Technician[]; history: Collection[] };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
const rub = (value: string) => `${Number(value).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
const human = (value: string) => value.split('-').reverse().join('.');
const next = (value: string) => new Date(Date.parse(value) + 86400000).toISOString().slice(0, 10);
const categories: Record<string, string> = { SALARY: 'Зарплата', FUEL: 'Бензин', OTHER: 'Прочие расходы', CARD: 'Передано на карту' };
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить операцию';

function Breakdown({ data }: { data: Calculation }) {
  return <>
    <table><tbody>
      <tr><td>Наличные по обслуживаниям</td><td>{rub(data.cash)}</td></tr>
      <tr><td>Зарплата из налички</td><td>−{rub(data.salary)}</td></tr>
      <tr><td>Бензин</td><td>−{rub(data.fuel)}</td></tr>
      <tr><td>Прочие расходы</td><td>−{rub(data.other)}</td></tr>
      {Number(data.transferred) !== 0 && <tr><td>Уже передано на карту</td><td>−{rub(data.transferred)}</td></tr>}
      {Number(data.adjustment) !== 0 && <tr><td>Корректировка закрытых периодов</td><td>{rub(data.adjustment)}</td></tr>}
      <tr><td><strong>Должно быть в мешке</strong></td><td><strong style={{ fontSize: 18 }}>{rub(data.expected)}</strong></td></tr>
    </tbody></table>
    {Number(data.adjustment) !== 0 && <p role="status">В старых периодах изменились записи. Корректировка включена в эту сумму; сохранённые результаты прошлых сверок не меняются.</p>}
    {data.services.some(item => Number(item.amount) < 0) && <p role="alert">Есть обслуживания с отрицательными наличными. Проверьте показания и безнал перед фиксацией.</p>}
    <details><summary>Обслуживания и расходы по позициям ({data.services.length + data.expenses.length})</summary>
      <div style={{ overflowX: 'auto' }}><table><thead><tr><th>Дата</th><th>Позиция</th><th>Сумма</th></tr></thead><tbody>
        {data.services.map(item => <tr key={`s${item.id}`}><td>{human(item.date)}</td><td>Аппарат {item.label} · <a href={`/history/${encodeURIComponent(item.label)}`}>история</a></td><td>{rub(item.amount)}</td></tr>)}
        {data.expenses.map(item => <tr key={`e${item.id}`}><td>{human(item.date)}</td><td>{categories[item.category] ?? item.category}{item.label ? ` · ${item.label}` : ''}</td><td>−{rub(item.amount)}</td></tr>)}
      </tbody></table></div>
      {!data.services.length && !data.expenses.length && <p className="muted">За период нет записей.</p>}
    </details>
    {data.corrections.length > 0 && <details><summary>Изменения в закрытых периодах</summary>
      <p className="muted">Изменения относительно первоначальных расчётов. Часть могла быть уже учтена последующими инкассациями; к текущему мешку применяется только строка «Корректировка» выше.</p>
      {data.corrections.map(row => <p key={row.collectionId}>Инкассация №{row.collectionId}, {human(row.from)}–{human(row.to)}: {rub(row.delta)}</p>)}
    </details>}
  </>;
}

function TechnicianCard({ technician, onSaved }: { technician: Technician; onSaved: () => Promise<void> }) {
  const from = technician.last_to ? next(technician.last_to) : '2026-11-01';
  const [to, setTo] = useState(today);
  const [receivedOn, setReceivedOn] = useState(today);
  const [preview, setPreview] = useState<Calculation | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const calculate = async () => {
    setBusy(true); setError(''); setPreview(null); setReady(false);
    try { setPreview(await api.get<Calculation>(`/api/cash-collections/preview?technicianId=${technician.id}&to=${to}`)); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!preview || !ready) return;
    setBusy(true); setError('');
    try {
      await api.post('/api/cash-collections', { technicianId: technician.id, to, receivedOn, token: preview.token });
      setPreview(null); setReady(false); await onSaved();
    } catch (error) { setError(message(error)); setPreview(null); setReady(false); }
    finally { setBusy(false); }
  };
  return <section className="card card-pad" style={{ marginBottom: 12 }}>
    <h3>{technician.full_name}{!technician.is_active ? ' · неактивен' : ''}</h3>
    <p className="muted">{technician.last_to ? `Предыдущая инкассация — по ${human(technician.last_to)}. ` : 'Первая инкассация. '}Новый период с {human(from)}.</p>
    {from > today() ? <p>Все дни по сегодня уже закрыты.</p> : <>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
        <label>Деньги по дату включительно<input type="date" min={from} max={today()} value={to} disabled={busy} onChange={event => { setTo(event.target.value); setPreview(null); setReady(false); }} /></label>
        <label>Дата получения мешка<input type="date" min={to} max={today()} value={receivedOn} disabled={busy} onChange={event => setReceivedOn(event.target.value)} /></label>
        <button onClick={() => void calculate()} disabled={busy || !to || to < from}>Рассчитать сумму</button>
      </div>
      {preview && <div style={{ marginTop: 16 }}>
        <p>Период: <strong>{human(preview.from)}–{human(preview.to)} включительно</strong></p>
        <Breakdown data={preview} />
        <label style={{ display: 'flex', gap: 8, margin: '16px 0' }}><input type="checkbox" style={{ width: 'auto' }} checked={ready} disabled={busy} onChange={event => setReady(event.target.checked)} />Все обслуживания и расходы за период отправлены с телефона; расчёт проверен, мешок получен.</label>
        {Number(preview.expected) < 0 && <p role="alert">Расходы превышают наличные. Проверьте записи перед инкассацией.</p>}
        <button className="primary" disabled={busy || !ready || !receivedOn || receivedOn < to || Number(preview.expected) < 0} onClick={() => void save()}>Зафиксировать инкассацию · {rub(preview.expected)}</button>
      </div>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}

function HistoryCard({ row, onSaved }: { row: Collection; onSaved: () => Promise<void> }) {
  const [actual, setActual] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { await api.post(`/api/cash-collections/${row.id}/count`, { actual: actual.replace(',', '.'), comment }); await onSaved(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  return <section className="card card-pad" style={{ marginBottom: 12 }}>
    <h3>№{row.id} · {row.full_name}</h3>
    <p>{human(row.period_from)}–{human(row.period_to)} · Получено {human(row.received_on)}</p>
    <p>Ожидалось: <strong>{rub(row.expected)}</strong></p>
    {Number(row.source_delta) !== 0 && <p role="status">Записи за этот период изменились на {rub(row.source_delta)} относительно сохранённого расчёта. Исходная сверка сохранена. Изменения учитываются в последующих расчётах отдельной корректировкой.</p>}
    {row.actual === null ? <>
      <p className="muted">Ожидает пересчёта</p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
        <label>Пересчитано, ₽<input inputMode="decimal" value={actual} disabled={busy} onChange={event => setActual(event.target.value)} placeholder="0,00" /></label>
        <label>Комментарий<input value={comment} maxLength={2000} disabled={busy} onChange={event => setComment(event.target.value)} /></label>
        <button disabled={busy || !/^\d{1,12}([.,]\d{1,2})?$/.test(actual)} onClick={() => void save()}>Сохранить пересчёт</button>
      </div>
      {/^\d+([.,]\d{1,2})?$/.test(actual) && <p>Расхождение: {rub((Number(actual.replace(',', '.')) - Number(row.expected)).toFixed(2))} · плюс — излишек, минус — недостача</p>}
    </> : <>
      <p>Пересчитано: <strong>{rub(row.actual)}</strong> · {Number(row.difference) === 0 ? 'Сошлось' : `${Number(row.difference) < 0 ? 'Недостача' : 'Излишек'} ${rub(String(Math.abs(Number(row.difference))))}`}</p>
      {row.comment && <p>{row.comment}</p>}
    </>}
    <details><summary>Сохранённый расчёт</summary><Breakdown data={row.snapshot} /></details>
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}

export default function CashCollectionsScreen() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const load = async () => {
    try { setData(await api.get<Overview>('/api/cash-collections')); setError(''); }
    catch (error) { setError(message(error)); }
  };
  useEffect(() => { void load(); }, []);
  return <>
    <h2>Инкассация</h2>
    <p className="muted">Учёт с 01.11.2026, начальный остаток — 0 ₽. Только наличные по обслуживаниям, за вычетом зарплаты и расходов техника из собранных денег. Расчёт по данным программы; перед фиксацией дождитесь отправки записей с телефона.</p>
    {error && <p role="alert" className="error">{error} <button onClick={() => void load()}>Обновить</button></p>}
    {!data && !error && <p>Загрузка…</p>}
    {data && <>
      <label>Техник<select value={filter} onChange={event => setFilter(event.target.value)}><option value="">Все техники</option>{data.technicians.map(row => <option key={row.id} value={row.id}>{row.full_name}</option>)}</select></label>
      <h3>Получение мешков</h3>
      {data.technicians.filter(row => !filter || String(row.id) === filter).map(row => <TechnicianCard key={`${row.id}-${row.last_to}`} technician={row} onSaved={load} />)}
      {!data.technicians.length && <p>Нет сотрудников с признаком полевого техника.</p>}
      <h3>История и пересчёт</h3>
      <p className="muted">Плюс — излишек, минус — недостача. Расхождения сохраняются для проверки и не переносятся автоматически как долг техника.</p>
      {data.history.filter(row => !filter || String(row.technician_id) === filter).map(row => <HistoryCard key={row.id} row={row} onSaved={load} />)}
      {!data.history.length && <p className="muted">Инкассаций пока нет.</p>}
    </>}
  </>;
}
