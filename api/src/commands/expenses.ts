import type { Client } from '../db/pool.js';
import { auditDelete, auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertAdmin } from '../lib/scope.js';

export type ExpenseCategory = 'FUEL' | 'SALARY' | 'CARD' | 'OTHER';

export interface ExpenseInput {
  category: ExpenseCategory;
  expenseDate: string;
  amount: string;
  comment?: string;
}

/** Расходы на содержание бизнеса — простой гроссбух админа, не часть неизменяемой финансовой
 * цепочки счётчиков, поэтому здесь допустим обычный UPDATE/DELETE без forbid_delete. */
export async function createExpense(
  client: Client,
  actor: Actor,
  input: ExpenseInput,
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  if (!(Number(input.amount) > 0)) {
    throw badRequest('INVALID_AMOUNT', 'сумма должна быть больше нуля');
  }
  const inserted = await client.query(
    `INSERT INTO business_expenses (category, expense_date, amount, comment, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.category, input.expenseDate, input.amount, input.comment ?? '', actor.id],
  );
  await auditInsert(client, actor, 'business_expense', inserted.rows[0].id, inserted.rows[0]);
  return inserted.rows[0];
}

export async function updateExpense(
  client: Client,
  actor: Actor,
  id: number,
  patch: Partial<ExpenseInput>,
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  const before = await client.query('SELECT * FROM business_expenses WHERE id = $1', [id]);
  if (before.rowCount === 0) throw notFound('расход не найден');
  if (patch.amount !== undefined && !(Number(patch.amount) > 0)) {
    throw badRequest('INVALID_AMOUNT', 'сумма должна быть больше нуля');
  }

  const after = await client.query(
    `UPDATE business_expenses SET
       category     = COALESCE($2, category),
       expense_date = COALESCE($3, expense_date),
       amount       = COALESCE($4, amount),
       comment      = COALESCE($5, comment)
     WHERE id = $1 RETURNING *`,
    [id, patch.category ?? null, patch.expenseDate ?? null, patch.amount ?? null, patch.comment ?? null],
  );
  await auditUpdate(client, actor, 'business_expense', id, before.rows[0], after.rows[0]);
  return after.rows[0];
}

export async function deleteExpense(client: Client, actor: Actor, id: number): Promise<void> {
  assertAdmin(actor);
  const removed = await client.query('DELETE FROM business_expenses WHERE id = $1 RETURNING *', [id]);
  if (removed.rowCount === 0) throw notFound('расход не найден');
  await auditDelete(client, actor, 'business_expense', id, removed.rows[0]);
}

/** Одна строка дня в сводке: что техник записал за этот день. */
export interface ExpenseDayRow {
  date: string;
  salary: string;
  fuel: string;
  other: string;
  /** Прочие траты этого дня по отдельности — с назначением и чеком. */
  items: Array<{ id: number; amount: string; comment: string; photoObjectKey: string | null }>;
}

export interface ExpensePersonBlock {
  staffId: number | null;
  name: string;
  days: ExpenseDayRow[];
  totals: { salary: string; fuel: string; other: string; total: string };
}

export interface ExpenseSummary {
  /** По каждому технику: дни и итоги. */
  technicians: ExpensePersonBlock[];
  /** Личные траты владельца — отдельно, они не расходы на людей. */
  ownerExpenses: Array<{
    id: number;
    date: string;
    category: string;
    amount: string;
    comment: string;
    photoObjectKey: string | null;
  }>;
  totals: {
    technicians: string;
    owner: string;
    salary: string;
    fuel: string;
    other: string;
    total: string;
  };
}

/**
 * Сводка расходов для владельца: по людям и по дням, плюс отдельно его собственные траты.
 *
 * Разделение принципиальное и идёт от слов владельца: то, что вносит он сам, — его личные траты,
 * а не расходы на техников. Смешивать их в одной таблице значило бы получить сумму, из которой
 * нельзя понять, сколько стоит содержание людей.
 */
export async function expenseSummary(
  client: Client,
  actor: Actor,
  filters: { from?: string; to?: string },
): Promise<ExpenseSummary> {
  assertAdmin(actor);
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filters.from) { params.push(filters.from); conditions.push(`e.expense_date >= $${params.length}::date`); }
  if (filters.to) { params.push(filters.to); conditions.push(`e.expense_date <= $${params.length}::date`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await client.query(
    `SELECT e.id, e.category, e.expense_date, e.amount, e.comment, e.source,
            e.staff_id, e.photo_object_key, s.full_name AS staff_name
     FROM business_expenses e
     LEFT JOIN staff s ON s.id = e.staff_id
     ${where}
     ORDER BY e.expense_date DESC, e.id DESC`,
    params,
  );

  const add = (left: string, right: string): string => (Number(left) + Number(right)).toFixed(2);

  const byStaff = new Map<number, ExpensePersonBlock>();
  const ownerExpenses: ExpenseSummary['ownerExpenses'] = [];

  for (const row of result.rows) {
    const amount = String(row.amount);
    // Своими считаются записи владельца — те, что он внёс сам, без привязки к технику.
    if (row.source !== 'TECHNICIAN' || row.staff_id === null) {
      ownerExpenses.push({
        id: Number(row.id),
        date: String(row.expense_date),
        category: String(row.category),
        amount,
        comment: String(row.comment ?? ''),
        photoObjectKey: row.photo_object_key ?? null,
      });
      continue;
    }

    const staffId = Number(row.staff_id);
    const block = byStaff.get(staffId) ?? {
      staffId,
      name: String(row.staff_name ?? '—'),
      days: [],
      totals: { salary: '0.00', fuel: '0.00', other: '0.00', total: '0.00' },
    };

    const date = String(row.expense_date);
    let day = block.days.find((item) => item.date === date);
    if (!day) {
      day = { date, salary: '0.00', fuel: '0.00', other: '0.00', items: [] };
      block.days.push(day);
    }

    if (row.category === 'SALARY') {
      day.salary = add(day.salary, amount);
      block.totals.salary = add(block.totals.salary, amount);
    } else if (row.category === 'FUEL') {
      day.fuel = add(day.fuel, amount);
      block.totals.fuel = add(block.totals.fuel, amount);
    } else {
      day.other = add(day.other, amount);
      block.totals.other = add(block.totals.other, amount);
      day.items.push({
        id: Number(row.id),
        amount,
        comment: String(row.comment ?? ''),
        photoObjectKey: row.photo_object_key ?? null,
      });
    }
    block.totals.total = add(block.totals.total, amount);
    byStaff.set(staffId, block);
  }

  const technicians = [...byStaff.values()].sort((left, right) => left.name.localeCompare(right.name));
  for (const block of technicians) {
    block.days.sort((left, right) => right.date.localeCompare(left.date));
  }

  const sum = (values: string[]): string =>
    values.reduce((total, value) => total + Number(value), 0).toFixed(2);

  const techniciansTotal = sum(technicians.map((block) => block.totals.total));
  const ownerTotal = sum(ownerExpenses.map((row) => row.amount));

  return {
    technicians,
    ownerExpenses,
    totals: {
      technicians: techniciansTotal,
      owner: ownerTotal,
      salary: sum(technicians.map((block) => block.totals.salary)),
      fuel: sum(technicians.map((block) => block.totals.fuel)),
      other: sum(technicians.map((block) => block.totals.other)),
      total: sum([techniciansTotal, ownerTotal]),
    },
  };
}

export async function listExpenses(
  client: Client,
  actor: Actor,
  filters: { from?: string; to?: string },
): Promise<Array<Record<string, unknown>>> {
  assertAdmin(actor);
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filters.from) { params.push(filters.from); conditions.push(`e.expense_date >= $${params.length}::date`); }
  if (filters.to) { params.push(filters.to); conditions.push(`e.expense_date <= $${params.length}::date`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // Имена подтягиваются здесь, а не в интерфейсе: владельцу нужно видеть, ЧЬИ это деньги
  // (staff_id) и кто запись внёс (created_by) — для самоотчётов техников это разные вещи только
  // на словах, но для записей владельца за сотрудника расходятся.
  const result = await client.query(
    `SELECT e.*, owner.full_name AS staff_name, author.full_name AS created_by_name
     FROM business_expenses e
     LEFT JOIN staff owner  ON owner.id  = e.staff_id
     LEFT JOIN staff author ON author.id = e.created_by
     ${where}
     ORDER BY e.expense_date DESC, e.id DESC`,
    params,
  );
  return result.rows;
}
