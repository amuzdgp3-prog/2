import type { Client } from '../db/pool.js';
import { auditDelete, auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, forbidden } from '../lib/errors.js';

/**
 * Закрытие дня техником: в конце отработанного дня он вводит со своего телефона зарплату за этот
 * день и потраченный бензин. Суммы ложатся в тот же гроссбух `business_expenses`, что и записи
 * владельца, — поэтому в чистой прибыли и в месячном отчёте они учитываются сами, без единой
 * правки отчётного слоя (миграция 019 объясняет, почему не отдельная таблица).
 *
 * Запись помечается `source = 'TECHNICIAN'` и `staff_id` того, чьи это деньги. Повторная отправка
 * за тот же день ПЕРЕЗАПИСЫВАЕТ сумму, а не добавляет вторую строку: форма на телефоне, связь
 * рвётся, офлайн-очередь может доставить запись дважды — задвоенная зарплата в отчёте была бы
 * куда хуже, чем потерянная правка.
 */

/** Что техник вводит при закрытии дня. Ноль — допустимая сумма: в этот день не тратил. */
export interface DayCloseInput {
  /** Дата отработанного дня. Сегодня по умолчанию, но вчерашний день закрыть тоже можно. */
  workDate: string;
  /** Зарплата техника за этот день. */
  salary: string;
  /** Бензин за этот день. */
  fuel: string;
}

export interface DayCloseRow {
  workDate: string;
  salary: string;
  fuel: string;
}

const DAY_CLOSE_CATEGORIES = { salary: 'SALARY', fuel: 'FUEL' } as const;

function assertAmount(value: string, field: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw badRequest('INVALID_AMOUNT', `${field}: сумма не может быть отрицательной`);
  }
  return amount;
}

/**
 * Дата не должна убегать в будущее: день закрывают по факту, а опечатка в годе иначе спрячет
 * расход далеко вперёд, где его никто не заметит. Запас в сутки — на часовые пояса.
 */
function assertWorkDate(workDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    throw badRequest('INVALID_DATE', 'дата дня указана неверно');
  }
  const limit = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (workDate > limit) {
    throw badRequest('FUTURE_DATE', 'нельзя закрыть день, который ещё не наступил');
  }
}

/**
 * Пишет одну категорию: создаёт запись или перезаписывает уже существующую за этот день.
 * Нулевая сумма удаляет запись — техник поправил себя, указав, что в этот день не тратил.
 */
async function upsertCategory(
  client: Client,
  actor: Actor,
  staffId: number,
  workDate: string,
  category: 'SALARY' | 'FUEL',
  amount: number,
): Promise<void> {
  const existing = await client.query(
    `SELECT * FROM business_expenses
     WHERE staff_id = $1 AND expense_date = $2::date AND category = $3 AND source = 'TECHNICIAN'`,
    [staffId, workDate, category],
  );

  if (amount === 0) {
    if (existing.rowCount === 0) return;
    // Сумму обнулили: ограничение таблицы требует amount > 0, поэтому строка удаляется целиком.
    await client.query('DELETE FROM business_expenses WHERE id = $1', [existing.rows[0].id]);
    await auditDelete(client, actor, 'business_expense', existing.rows[0].id, existing.rows[0], {
      reason: 'day_close_zeroed',
    });
    return;
  }

  if (existing.rowCount === 0) {
    const inserted = await client.query(
      `INSERT INTO business_expenses
         (category, expense_date, amount, comment, created_by, staff_id, source)
       VALUES ($1, $2::date, $3, '', $4, $5, 'TECHNICIAN')
       RETURNING *`,
      [category, workDate, amount, actor.id, staffId],
    );
    await auditInsert(client, actor, 'business_expense', inserted.rows[0].id, inserted.rows[0]);
    return;
  }

  const updated = await client.query(
    'UPDATE business_expenses SET amount = $2 WHERE id = $1 RETURNING *',
    [existing.rows[0].id, amount],
  );
  await auditUpdate(client, actor, 'business_expense', existing.rows[0].id, existing.rows[0], updated.rows[0], {
    reason: 'day_close_resubmitted',
  });
}

/**
 * Техник закрывает свой день. Записывает всегда на СЕБЯ: подставить чужой staff_id нельзя, иначе
 * один человек мог бы записать расход на другого. Владелец правит чужие суммы обычным способом,
 * через гроссбух затрат.
 */
export async function closeDay(
  client: Client,
  actor: Actor,
  input: DayCloseInput,
): Promise<DayCloseRow> {
  if (actor.id === null) throw forbidden('нужна учётная запись сотрудника');
  assertWorkDate(input.workDate);
  const salary = assertAmount(input.salary, 'Зарплата');
  const fuel = assertAmount(input.fuel, 'Бензин');

  await upsertCategory(client, actor, actor.id, input.workDate, DAY_CLOSE_CATEGORIES.salary, salary);
  await upsertCategory(client, actor, actor.id, input.workDate, DAY_CLOSE_CATEGORIES.fuel, fuel);

  return { workDate: input.workDate, salary: salary.toFixed(2), fuel: fuel.toFixed(2) };
}

/**
 * Прочая трата техника: парковка, мойка, запчасть. В отличие от зарплаты и бензина, таких за день
 * может быть несколько, поэтому каждая — отдельная запись со своим назначением и своим чеком,
 * а не перезаписываемая величина дня (миграция 020 сужает под это уникальный индекс).
 */
export interface OtherExpenseInput {
  workDate: string;
  amount: string;
  /** На что потрачено. Без этого чек и сумма ни о чём не говорят при разборе в конце месяца. */
  comment: string;
  /** Фото чека. Необязательно: чек дают не везде, и отказ принять трату был бы хуже. */
  photoObjectKey?: string | null;
}

export async function addOtherExpense(
  client: Client,
  actor: Actor,
  input: OtherExpenseInput,
): Promise<Record<string, unknown>> {
  if (actor.id === null) throw forbidden('нужна учётная запись сотрудника');
  assertWorkDate(input.workDate);
  const amount = assertAmount(input.amount, 'Сумма');
  if (amount === 0) throw badRequest('INVALID_AMOUNT', 'сумма должна быть больше нуля');
  if (!input.comment?.trim()) {
    throw badRequest('COMMENT_REQUIRED', 'укажите, на что потрачено');
  }

  const inserted = await client.query(
    `INSERT INTO business_expenses
       (category, expense_date, amount, comment, created_by, staff_id, source, photo_object_key)
     VALUES ('OTHER', $1::date, $2, $3, $4, $4, 'TECHNICIAN', $5)
     RETURNING *`,
    [input.workDate, amount, input.comment.trim(), actor.id, input.photoObjectKey ?? null],
  );
  await auditInsert(client, actor, 'business_expense', inserted.rows[0].id, inserted.rows[0]);
  return inserted.rows[0];
}

/** Техник убирает СВОЮ ошибочную запись. Чужие и записи владельца не трогает. */
export async function removeOwnExpense(
  client: Client,
  actor: Actor,
  id: number,
): Promise<void> {
  if (actor.id === null) throw forbidden('нужна учётная запись сотрудника');
  const removed = await client.query(
    `DELETE FROM business_expenses
     WHERE id = $1 AND staff_id = $2 AND source = 'TECHNICIAN'
     RETURNING *`,
    [id, actor.id],
  );
  if (removed.rowCount === 0) throw forbidden('это не ваша запись');
  await auditDelete(client, actor, 'business_expense', id, removed.rows[0]);
}

/** Прочие траты техника за период — списком, с чеками. */
export async function listMyOtherExpenses(
  client: Client,
  actor: Actor,
  limitDays = 30,
): Promise<Array<Record<string, unknown>>> {
  if (actor.id === null) throw forbidden('нужна учётная запись сотрудника');
  const result = await client.query(
    `SELECT id, expense_date, amount, comment, photo_object_key
     FROM business_expenses
     WHERE staff_id = $1 AND source = 'TECHNICIAN' AND category = 'OTHER'
       AND expense_date >= (now() - ($2::int || ' days')::interval)::date
     ORDER BY expense_date DESC, id DESC`,
    [actor.id, limitDays],
  );
  return result.rows;
}

/** Последние закрытые дни этого техника — чтобы он видел, что уже сдал, и не вводил второй раз. */
export async function listMyDayCloses(
  client: Client,
  actor: Actor,
  limit = 14,
): Promise<DayCloseRow[]> {
  if (actor.id === null) throw forbidden('нужна учётная запись сотрудника');
  const result = await client.query(
    `SELECT expense_date,
            COALESCE(SUM(amount) FILTER (WHERE category = 'SALARY'), 0) AS salary,
            COALESCE(SUM(amount) FILTER (WHERE category = 'FUEL'), 0)   AS fuel
     FROM business_expenses
     WHERE staff_id = $1 AND source = 'TECHNICIAN'
     GROUP BY expense_date
     ORDER BY expense_date DESC
     LIMIT $2`,
    [actor.id, limit],
  );
  return result.rows.map((row) => ({
    workDate: String(row.expense_date),
    salary: String(row.salary),
    fuel: String(row.fuel),
  }));
}
