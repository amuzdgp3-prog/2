import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
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
}

const EXPENSE_CATEGORY_LABELS: Record<Expense['category'], string> = {
  FUEL: 'Бензин',
  SALARY: 'Зарплата / аванс',
  CARD: 'На карту',
  OTHER: 'Прочее',
};

function monthRangeInput(offset = 0): { from: string; to: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/** Затраты на содержание бизнеса (бензин, зарплата/аванс, на карту, прочее) — гроссбух админа,
 * которым раньше владелец делился текстом каждый месяц для ручной вклейки в отчёт. Данные отсюда
 * попадают в раздел «РАСХОДЫ» ежемесячного xlsx-отчёта на вкладке «Отчёты». */

export function ExpensesTab({ onDone, onError }: TabProps) {
  const [range, setRange] = useState(monthRangeInput());
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);

  const load = () => {
    api.get<Expense[]>(`/api/expenses?from=${range.from}&to=${range.to}`).then(setExpenses).catch(onError);
  };
  useEffect(load, [range.from, range.to]);

  const totalsByCategory = (Object.keys(EXPENSE_CATEGORY_LABELS) as Expense['category'][]).map((category) => ({
    category,
    total: expenses.filter((e) => e.category === category).reduce((sum, e) => sum + Number(e.amount), 0),
  })).filter((row) => row.total > 0);
  const grandTotal = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

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
      </div>

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

      <div className="stack" style={{ marginTop: 12 }}>
        {expenses.length === 0 && <p className="muted">За период расходов не внесено</p>}
        {expenses.map((expense) => (
          <div className="card card-pad" key={expense.id}>
            {editingId === expense.id ? (
              <EditExpenseForm
                expense={expense}
                onDone={(message) => { onDone(message); setEditingId(null); load(); }}
                onError={onError}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div className="row">
                <div>
                  <strong>{formatMoney(expense.amount)} ₽</strong>
                  <span className="muted"> · {EXPENSE_CATEGORY_LABELS[expense.category]} · {expense.expense_date}</span>
                  {expense.staff_name && (
                    <span className="muted"> · {expense.staff_name}</span>
                  )}
                  {expense.source === 'TECHNICIAN' && (
                    <span className="chip" style={{ marginLeft: 8, fontSize: 11 }}>со слов техника</span>
                  )}
                  {expense.comment && <div className="muted">{expense.comment}</div>}
                </div>
                <div className="row" style={{ gap: 6 }}>
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
              </div>
            )}
          </div>
        ))}
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
