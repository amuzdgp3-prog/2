import type { FastifyInstance } from 'fastify';
import { pool, withTransaction } from '../db/pool.js';
import { createExpense, deleteExpense, listExpenses, updateExpense } from '../commands/expenses.js';

export async function registerExpenseRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: app.authenticate };

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
