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

export async function listExpenses(
  client: Client,
  actor: Actor,
  filters: { from?: string; to?: string },
): Promise<Array<Record<string, unknown>>> {
  assertAdmin(actor);
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filters.from) { params.push(filters.from); conditions.push(`expense_date >= $${params.length}::date`); }
  if (filters.to) { params.push(filters.to); conditions.push(`expense_date <= $${params.length}::date`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await client.query(
    `SELECT * FROM business_expenses ${where} ORDER BY expense_date DESC, id DESC`,
    params,
  );
  return result.rows;
}
