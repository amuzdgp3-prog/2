import type { FastifyInstance } from 'fastify';
import { pool, withTransaction } from '../db/pool.js';
import { createExpense, deleteExpense, listExpenses, updateExpense } from '../commands/expenses.js';
import { closeDay, listMyDayCloses, type DayCloseInput } from '../commands/dayClose.js';

export async function registerExpenseRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: app.authenticate };

  /**
   * Закрытие дня техником. Отдельный эндпоинт, а не POST /api/expenses: тот — гроссбух владельца
   * и требует прав администратора, здесь же техник пишет только на себя и только две категории.
   */
  app.post<{ Body: DayCloseInput }>(
    '/api/day-close',
    {
      ...auth,
      schema: {
        body: {
          type: 'object',
          required: ['workDate', 'salary', 'fuel'],
          properties: {
            workDate: { type: 'string' },
            salary: { type: ['string', 'number'] },
            fuel: { type: ['string', 'number'] },
          },
        },
      },
    },
    async (request) =>
      withTransaction((client) => closeDay(client, request.actor, {
        workDate: request.body.workDate,
        salary: String(request.body.salary),
        fuel: String(request.body.fuel),
      })),
  );

  /** Последние закрытые дни самого техника — чтобы видел, что уже сдал. */
  app.get<{ Querystring: { limit?: string } }>('/api/day-close/mine', auth, async (request) => {
    const client = await pool.connect();
    try {
      return await listMyDayCloses(client, request.actor, Number(request.query.limit) || 14);
    } finally {
      client.release();
    }
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/expenses', auth, async (request) => {
    const client = await pool.connect();
    try {
      return await listExpenses(client, request.actor, request.query);
    } finally {
      client.release();
    }
  });

  app.post<{ Body: Parameters<typeof createExpense>[2] }>('/api/expenses', auth, async (request) =>
    withTransaction((client) => createExpense(client, request.actor, request.body)),
  );

  app.patch<{ Params: { id: string }; Body: Parameters<typeof updateExpense>[3] }>(
    '/api/expenses/:id',
    auth,
    async (request) =>
      withTransaction((client) =>
        updateExpense(client, request.actor, Number(request.params.id), request.body),
      ),
  );

  app.delete<{ Params: { id: string } }>('/api/expenses/:id', auth, async (request) => {
    await withTransaction((client) => deleteExpense(client, request.actor, Number(request.params.id)));
    return { ok: true };
  });
}
