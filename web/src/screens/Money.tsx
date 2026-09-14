import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { formatMoney } from '../calc';
import { queueDayClose, readDayCloseOutbox } from '../db';
import { syncOutbox } from '../sync';

/**
 * «Деньги» — техник в конце отработанного дня вводит свою зарплату за этот день и потраченный
 * бензин. Суммы уходят в общий гроссбух расходов и попадают в чистую прибыль (миграция 019).
 *
 * Экран офлайновый по той же причине, что и обслуживания: день закрывают в машине по дороге
 * домой, связи может не быть. Ввод кладётся в очередь и уходит при первой связи; повторная
 * отправка за ту же дату перезаписывает сумму и на телефоне, и на сервере, поэтому задвоить
 * зарплату нельзя ни двойным нажатием, ни повтором очереди.
 */

interface DayRow {
  workDate: string;
  salary: string;
  fuel: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function humanDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

export default function MoneyScreen() {
  const [workDate, setWorkDate] = useState(today());
  const [salary, setSalary] = useState('');
  const [fuel, setFuel] = useState('');
  const [days, setDays] = useState<DayRow[]>([]);
  const [queued, setQueued] = useState<DayRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadQueued = async () => {
    const items = await readDayCloseOutbox();
    setQueued(items.map((item) => ({ workDate: item.workDate, salary: item.salary, fuel: item.fuel })));
  };

  const load = async () => {
    await loadQueued();
    try {
      setDays(await api.get<DayRow[]>('/api/day-close/mine'));
    } catch {
      // Нет связи — показываем только то, что лежит в очереди на телефоне.
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await queueDayClose(workDate, salary || '0', fuel || '0');
      await loadQueued();
      setNotice('Сохранено. Уйдёт на сервер при первой связи.');
      setSalary('');
      setFuel('');
      void syncOutbox().then(load);
    } finally {
      setBusy(false);
    }
  };

  // Дни из очереди показываются поверх серверных: если техник только что поправил сумму, он
  // должен видеть свою правку, а не старое значение с сервера.
  const queuedDates = new Set(queued.map((row) => row.workDate));
  const rows = [...queued, ...days.filter((row) => !queuedDates.has(row.workDate))]
    .sort((left, right) => right.workDate.localeCompare(left.workDate))
    .slice(0, 14);

  return (
    <div className="stack">
      <h2>Деньги за день</h2>
      <p className="muted" style={{ marginTop: -8 }}>
        Заполните в конце рабочего дня. Если ошиблись — введите этот же день заново, сумма
        заменится.
      </p>

      {notice && <div className="alert">{notice}</div>}

      <form className="card stack" onSubmit={submit}>
        <div>
          <label htmlFor="workDate">День</label>
          <input
            id="workDate"
            type="date"
            value={workDate}
            max={today()}
            onChange={(event) => setWorkDate(event.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="salary">Зарплата за этот день, ₽</label>
          <input
            id="salary"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="0"
            value={salary}
            onChange={(event) => setSalary(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="fuel">Бензин за этот день, ₽</label>
          <input
            id="fuel"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="0"
            value={fuel}
            onChange={(event) => setFuel(event.target.value)}
          />
        </div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Сохраняю…' : 'Сохранить день'}
        </button>
      </form>

      <h3>Последние дни</h3>
      {rows.length === 0 && <p className="muted">Пока ничего не внесено</p>}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>День</th>
                <th className="num">Зарплата</th>
                <th className="num">Бензин</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.workDate}>
                  <td className="mono">{humanDate(row.workDate)}</td>
                  <td className="num">{formatMoney(row.salary)} ₽</td>
                  <td className="num">{formatMoney(row.fuel)} ₽</td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {queuedDates.has(row.workDate) ? 'ждёт отправки' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
