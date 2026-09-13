import type { Client } from '../db/pool.js';
import { auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertAdmin, listScopedMachineNumbers } from '../lib/scope.js';

/**
 * Задачи техникам (DECISION-050, 018_technician_tasks.sql).
 *
 * Ключевое решение о видимости: техник видит задачи, назначенные лично ему, ПЛЮС незакреплённые по
 * аппаратам из своей зоны ответственности. Незакреплённую задачу берёт первый доехавший — это
 * список дел на маршрут, а не диспетчеризация, и заставлять владельца назначать каждое поручение
 * поимённо значило бы создать ему работу там, где её можно не создавать.
 *
 * Закрытие задачи идемпотентно по замыслу: техник работает офлайн, и повторная отправка одного и
 * того же закрытия при пересинхронизации — норма, а не ошибка. Поэтому повторное закрытие уже
 * закрытой задачи возвращает её как есть, не меняя ни автора, ни момента закрытия и не порождая
 * второй записи в аудите.
 */
export interface TaskRow {
  id: number;
  machine_number: string | null;
  location_id: number | null;
  assigned_to: number | null;
  title: string;
  details: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  due_date: string | null;
  closed_at: Date | null;
  close_note: string;
}

const SELECT_TASK = `
  SELECT t.*, m.model AS machine_model, p.address AS machine_address,
         l.name AS location_name, st.full_name AS assigned_name,
         cb.full_name AS closed_by_name, cr.full_name AS created_by_name
  FROM technician_tasks t
  LEFT JOIN machines m ON m.machine_number = t.machine_number
  LEFT JOIN machine_placements p ON p.machine_number = t.machine_number AND p.ended_at IS NULL
  LEFT JOIN locations l ON l.id = t.location_id
  LEFT JOIN staff st ON st.id = t.assigned_to
  LEFT JOIN staff cb ON cb.id = t.closed_by
  LEFT JOIN staff cr ON cr.id = t.created_by`;

export async function createTask(
  client: Client,
  actor: Actor,
  input: {
    title: string;
    details?: string;
    machineNumber?: string | null;
    locationId?: number | null;
    assignedTo?: number | null;
    dueDate?: string | null;
  },
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  const title = input.title.trim();
  if (!title) throw badRequest('EMPTY_TASK_TITLE', 'у задачи должно быть название');

  const inserted = await client.query(
    `INSERT INTO technician_tasks
       (machine_number, location_id, assigned_to, title, details, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7)
     RETURNING *`,
    [
      input.machineNumber ?? null,
      input.locationId ?? null,
      input.assignedTo ?? null,
      title,
      (input.details ?? '').trim(),
      input.dueDate ?? null,
      actor.id,
    ],
  );
  await auditInsert(client, actor, 'technician_task', inserted.rows[0].id, inserted.rows[0]);
  return inserted.rows[0];
}

export async function listTasks(
  client: Client,
  actor: Actor,
  filters: { status?: string; assignedTo?: number; mine?: boolean },
): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = [];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions: string[] = [];

  if (filters.status) conditions.push(`t.status = ${push(filters.status)}::task_status`);
  if (filters.assignedTo) conditions.push(`t.assigned_to = ${push(filters.assignedTo)}`);

  if (actor.role !== 'ADMIN') {
    // Техник видит своё и ничьё по своим аппаратам. Задача без аппарата и без исполнителя видна
    // всем: это общие поручения вроде «забрать ключи», адресованные тому, кто доедет первым.
    const scoped = await listScopedMachineNumbers(client, actor);
    conditions.push(
      `(t.assigned_to = ${push(actor.id)}
        OR (t.assigned_to IS NULL
            AND (t.machine_number IS NULL OR t.machine_number = ANY(${push(scoped)}::text[]))))`,
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await client.query(
    `${SELECT_TASK} ${where}
     ORDER BY t.status = 'OPEN' DESC, t.due_date NULLS LAST, t.created_at DESC
     LIMIT 500`,
    params,
  );
  return result.rows;
}

/**
 * Закрытие задачи техником. Идемпотентно: повторная отправка того же закрытия при пересинхронизации
 * после офлайна возвращает уже закрытую задачу, не переписывая автора и момент закрытия.
 */
export async function closeTask(
  client: Client,
  actor: Actor,
  taskId: number,
  input: { note?: string; cancel?: boolean },
): Promise<Record<string, unknown>> {
  const before = await client.query(
    'SELECT * FROM technician_tasks WHERE id = $1 FOR UPDATE',
    [taskId],
  );
  if (before.rowCount === 0) throw notFound('задача не существует');
  if (before.rows[0].status !== 'OPEN') return before.rows[0];

  // Отменить задачу может только администратор: «передумали» — решение того, кто поручал, а не
  // того, кто исполняет. Техник может её выполнить, но не отменить.
  if (input.cancel) assertAdmin(actor);

  if (!input.cancel && actor.role !== 'ADMIN') {
    const assignedTo = before.rows[0].assigned_to as number | null;
    if (assignedTo !== null && Number(assignedTo) !== Number(actor.id)) {
      throw badRequest('TASK_ASSIGNED_TO_OTHER', 'эта задача назначена другому технику');
    }
  }

  const after = await client.query(
    `UPDATE technician_tasks
     SET status = $2::task_status, closed_at = now(), closed_by = $3,
         close_note = $4, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [taskId, input.cancel ? 'CANCELLED' : 'DONE', actor.id, (input.note ?? '').trim()],
  );
  await auditUpdate(client, actor, 'technician_task', taskId, before.rows[0], after.rows[0], {
    reason: input.cancel ? 'cancelled' : 'done',
  });
  return after.rows[0];
}

/** Возврат задачи в работу — админская правка ошибочного закрытия. */
export async function reopenTask(
  client: Client,
  actor: Actor,
  taskId: number,
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  const before = await client.query('SELECT * FROM technician_tasks WHERE id = $1', [taskId]);
  if (before.rowCount === 0) throw notFound('задача не существует');
  if (before.rows[0].status === 'OPEN') return before.rows[0];

  const after = await client.query(
    `UPDATE technician_tasks
     SET status = 'OPEN', closed_at = NULL, closed_by = NULL, close_note = '', updated_at = now()
     WHERE id = $1 RETURNING *`,
    [taskId],
  );
  await auditUpdate(client, actor, 'technician_task', taskId, before.rows[0], after.rows[0], {
    reason: 'reopened',
  });
  return after.rows[0];
}
