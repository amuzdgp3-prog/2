import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, getToken } from '../../api';
import { formatMoney } from '../../calc';
import type { TabProps } from './types';
import { Section } from './shared/Section';

interface Expense {
  id: number;
  category: 'FUEL' | 'SALARY' | 'CARD' | 'OTHER';
  expense_date: string;
  amount: string;
  comment: string;
  /** ADMIN — запись владельца, TECHNICIAN — самоотчёт техника при закрытии дня (миграция 019). */
  source: 'ADMIN' | 'TECHNICIAN';
  /** Чьи это деньги: кому зарплата, кто заправлялся. Пусто у исторических записей. */
  staff_name: string | null;
  /** Кто внёс запись. У самоотчёта совпадает со staff_name. */
  created_by_name: string | null;
  /** Чек к прочей трате техника (миграция 020). */
  photo_object_key: string | null;
}

const EXPENSE_CATEGORY_LABELS: Record<Expense['category'], string> = {
  FUEL: 'Бензин',
  SALARY: 'Зарплата / аванс',
  CARD: 'На карту',
  OTHER: 'Прочее',
};

/** Значение фильтра «чей расход» для записей без техника — это собственные траты владельца. */
const OWNER = '__owner__';

function monthRangeInput(offset = 0): { from: string; to: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function humanDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-');
  return `${day}.${month}.${year}`;
}

/** Кому принадлежит расход: техник по имени или сам владелец, если техник не проставлен. */
function personKey(expense: Expense): string {
  return expense.staff_name ?? OWNER;
}

/** Чек открывается в новой вкладке; токен идёт параметром, потому что <a> не шлёт заголовки. */
function ReceiptLink({ objectKey }: { objectKey: string }) {
  return (
    <a href={`/api/photos/${objectKey}?token=${getToken() ?? ''}`} target="_blank" rel="noreferrer" title="Открыть чек">
      📷
    </a>
  );
}

/** Затраты на содержание бизнеса (бензин, зарплата/аванс, на карту, прочее) — гроссбух админа,
 * которым раньше владелец делился текстом каждый месяц для ручной вклейки в отчёт. Данные отсюда
 * попадают в раздел «РАСХОДЫ» ежемесячного xlsx-отчёта на вкладке «Отчёты».
 *
 * Список строками, а не карточками: с появлением самоотчётов техников записей за месяц стало
 * столько, что карточки листаются дольше, чем читаются. Период отбирается на сервере (он же
 * ограничивает объём выборки), а техник и категория — уже на клиенте по загруженным строкам:
 * запрошенный месяц всё равно целиком в памяти, и лишний поход на сервер ничего не уточнит. */

export function ExpensesTab({ onDone, onError }: TabProps) {
  const [range, setRange] = useState(monthRangeInput());
  const [person, setPerson] = useState('');
  const [category, setCategory] = useState('');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);

  const load = () => {
    api.get<Expense[]>(`/api/expenses?from=${range.from}&to=${range.to}`).then(setExpenses).catch(onError);
  };
  useEffect(load, [range.from, range.to]);

  // Варианты берутся из самих загруженных строк, а не из справочника сотрудников: так в списке
  // не появится человек, у которого за период нет ни одной траты, и фильтр не даст пустой экран.
  const people = useMemo(() => {
    const names = new Set<string>();
    let hasOwner = false;
    for (const expense of expenses) {
      if (expense.staff_name) names.add(expense.staff_name);
      else hasOwner = true;
    }
    return { names: [...names].sort((left, right) => left.localeCompare(right)), hasOwner };
  }, [expenses]);

  const visible = useMemo(
    () => expenses.filter((expense) => {
      if (person && personKey(expense) !== person) return false;
      if (category && expense.category !== category) return false;
      return true;
    }),
    [expenses, person, category],
  );

  // Итоги считаются по видимым строкам: отфильтровав техника, владелец хочет увидеть сумму
  // именно по нему, а не по всему месяцу.
  const totalsByCategory = (Object.keys(EXPENSE_CATEGORY_LABELS) as Expense['category'][]).map((key) => ({
    category: key,
    total: visible.filter((e) => e.category === key).reduce((sum, e) => sum + Number(e.amount), 0),
  })).filter((row) => row.total > 0);
  const grandTotal = visible.reduce((sum, e) => sum + Number(e.amount), 0);

  const filtered = person !== '' || category !== '';

  return (
    <Section title="Затраты на содержание бизнеса">
      <div className="grid-2" style={{ marginBottom: 12 }}>
        <div>
          <label>С</label>
          <input type="date" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} />
        </div>
        <div>
          <label>По</label>
          <input type="date" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} />
        </div>
        <div>
          <label>Чей расход</label>
          <select value={person} onChange={(event) => setPerson(event.target.value)}>
            <option value="">Все</option>
            {people.hasOwner && <option value={OWNER}>Мои траты</option>}
            {people.names.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        <div>
          <label>Категория</label>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">Все</option>
            {(Object.keys(EXPENSE_CATEGORY_LABELS) as Expense['category'][]).map((key) => (
              <option key={key} value={key}>{EXPENSE_CATEGORY_LABELS[key]}</option>
            ))}
          </select>
        </div>
      </div>

      {filtered && (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="muted">
            Показано {visible.length} из {expenses.length} записей за период
          </span>
          <button type="button" onClick={() => { setPerson(''); setCategory(''); }}>Сбросить фильтры</button>
        </div>
      )}

      {totalsByCategory.length > 0 && (
        <div className="chip-row" style={{ marginBottom: 12 }}>
          {totalsByCategory.map((row) => (
            <span className="chip" key={row.category}>
              {EXPENSE_CATEGORY_LABELS[row.category]}: {formatMoney(row.total)} ₽
            </span>
          ))}
          <span className="chip"><strong>Итого: {formatMoney(grandTotal)} ₽</strong></span>
        </div>
      )}

      <NewExpenseForm onDone={(message) => { onDone(message); load(); }} onError={onError} />

      <div style={{ marginTop: 12 }}>
        {visible.length === 0 && (
          <p className="muted">{filtered ? 'Под фильтр ничего не подошло' : 'За период расходов не внесено'}</p>
        )}
        {visible.length > 0 && (
          <div className="table-wrap scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Категория</th>
                  <th className="num">Сумма</th>
                  <th>Чей расход</th>
                  <th>Комментарий</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((expense) => (
                  editingId === expense.id ? (
                    <tr key={expense.id}>
                      <td colSpan={6}>
                        <EditExpenseForm
                          expense={expense}
                          onDone={(message) => { onDone(message); setEditingId(null); load(); }}
                          onError={onError}
                          onCancel={() => setEditingId(null)}
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr key={expense.id}>
                      <td className="mono">{humanDate(expense.expense_date)}</td>
                      <td>{EXPENSE_CATEGORY_LABELS[expense.category]}</td>
                      <td className="num">{formatMoney(expense.amount)} ₽</td>
                      <td>
                        {expense.staff_name ?? 'Мои траты'}
                        {expense.source === 'TECHNICIAN' && (
                          <span className="chip" style={{ marginLeft: 6, fontSize: 11 }}>со слов техника</span>
                        )}
                      </td>
                      <td className="wrap">
                        {expense.comment || '—'}
                        {expense.photo_object_key && (
                          <> <ReceiptLink objectKey={expense.photo_object_key} /></>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => setEditingId(expense.id)}>Изменить</button>
                          <button
                            onClick={async () => {
                              if (!confirm('Удалить запись о расходе?')) return;
                              try {
                                await api.delete(`/api/expenses/${expense.id}`);
                                onDone('Расход удалён');
                                load();
                              } catch (caught) {
                                onError(caught);
                              }
                            }}
                          >
                            Удалить
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Section>
  );
}

function NewExpenseForm({ onDone, onError }: TabProps) {
  const [category, setCategory] = useState<Expense['category']>('FUEL');
  const [expenseDate, setExpenseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/expenses', { category, expenseDate, amount, comment });
      onDone('Расход добавлен');
      setAmount('');
      setComment('');
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <form onSubmit={submit} className="card card-pad">
      <div className="grid-2">
        <div>
          <label>Категория</label>
          <select value={category} onChange={(event) => setCategory(event.target.value as Expense['category'])}>
            {(Object.keys(EXPENSE_CATEGORY_LABELS) as Expense['category'][]).map((key) => (
              <option key={key} value={key}>{EXPENSE_CATEGORY_LABELS[key]}</option>
            ))}
          </select>
        </div>
        <div>
          <label>Дата</label>
          <input type="date" value={expenseDate} onChange={(event) => setExpenseDate(event.target.value)} required />
        </div>
        <div>
          <label>Сумма, ₽</label>
          <input type="number" step="0.01" min="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required />
        </div>
        <div>
          <label>Комментарий</label>
          <input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="напр. бенз Дима" />
        </div>
      </div>
      <button className="btn btn-primary" type="submit" style={{ marginTop: 10 }}>Добавить расход</button>
    </form>
  );
}

function EditExpenseForm({
  expense, onDone, onError, onCancel,
}: TabProps & { expense: Expense; onCancel: () => void }) {
  const [category, setCategory] = useState(expense.category);
  const [expenseDate, setExpenseDate] = useState(expense.expense_date.slice(0, 10));
  const [amount, setAmount] = useState(expense.amount);
  const [comment, setComment] = useState(expense.comment);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.patch(`/api/expenses/${expense.id}`, { category, expenseDate, amount, comment });
      onDone('Расход изменён');
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="grid-2">
        <div>
          <label>Категория</label>
          <select value={category} onChange={(event) => setCategory(event.target.value as Expense['category'])}>
            {(Object.keys(EXPENSE_CATEGORY_LABELS) as Expense['category'][]).map((key) => (
              <option key={key} value={key}>{EXPENSE_CATEGORY_LABELS[key]}</option>
            ))}
          </select>
        </div>
        <div>
          <label>Дата</label>
          <input type="date" value={expenseDate} onChange={(event) => setExpenseDate(event.target.value)} required />
        </div>
        <div>
          <label>Сумма, ₽</label>
          <input type="number" step="0.01" min="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required />
        </div>
        <div>
          <label>Комментарий</label>
          <input value={comment} onChange={(event) => setComment(event.target.value)} />
        </div>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 10 }}>
        <button className="btn btn-primary" type="submit">Сохранить</button>
        <button type="button" onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}
