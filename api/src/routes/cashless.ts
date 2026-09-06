import type { FastifyInstance } from 'fastify';
import {
  importCashless,
  rematchCashless,
  updateCashlessTransaction,
  type RawTransaction,
} from '../commands/cashless.js';
import { getIvendSettings, runIvendSync, saveIvendRunTimes, saveIvendSettings } from '../commands/ivendSync.js';
import { pool, withTransaction } from '../db/pool.js';
import { assertAdmin, machineScopePredicate } from '../lib/scope.js';

export async function registerCashlessRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: app.authenticate };

  /**
   * Importer boundary (11_АРХИТЕКТУРА §12): the parser hands normalized transactions to this
   * endpoint, which writes them idempotently and matches them historically. It never creates a
   * Service and never touches game counters. Provider credentials stay in the parser runtime.
   */
  app.post<{ Body: { provider: string; transactions: RawTransaction[] } }>(
    '/api/cashless/import',
    {
      ...auth,
      schema: {
        body: {
          type: 'object',
          required: ['provider', 'transactions'],
          properties: {
            provider: { type: 'string', minLength: 1 },
            transactions: {
              type: 'array',
              items: {
                type: 'object',
                required: ['terminalExternalId', 'occurredAt', 'amount', 'paymentType'],
                properties: {
                  providerTransactionId: { type: ['string', 'null'] },
                  terminalExternalId: { type: 'string' },
                  occurredAt: { type: 'string' },
                  amount: { type: ['number', 'string'] },
                  paymentType: { type: 'string' },
                  raw: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      assertAdmin(request.actor);
      return withTransaction((client) =>
        importCashless(client, request.actor, request.body.provider, request.body.transactions),
      );
    },
  );

  app.post<{ Body: { from?: string; terminalId?: number; onlyUnmatched?: boolean } }>(
    '/api/cashless/rematch',
    auth,
    async (request) => {
      assertAdmin(request.actor);
      return withTransaction((client) => rematchCashless(client, request.actor, request.body ?? {}));
    },
  );

  app.get<{
    Querystring: {
      from?: string; to?: string; status?: string; machineNumber?: string;
      limit?: string; offset?: string;
    };
  }>('/api/cashless', auth, async (request) => {
    const params: unknown[] = [];
    const conditions: string[] = [];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (request.query.from) conditions.push(`t.occurred_at >= ${push(request.query.from)}::timestamptz`);
    if (request.query.to) conditions.push(`t.occurred_at <= ${push(request.query.to)}::timestamptz`);
    if (request.query.status) {
      conditions.push(`t.match_status = ${push(request.query.status)}::cashless_match_status`);
    }
    if (request.query.machineNumber) {
      conditions.push(`t.matched_machine_number = ${push(request.query.machineNumber)}`);
    }

    // Unmatched rows have no machine yet, so scope can only be applied to matched ones.
    const scope = machineScopePredicate(request.actor, 't.matched_machine_number', params.length + 1);
    params.push(...scope.params);
    conditions.push(`(t.matched_machine_number IS NULL OR ${scope.sql})`);

    // Row-count display setting (50/100/500 — owner requirement).
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(request.query.offset) || 0, 0);
    const limitIndex = push(limit);
    const offsetIndex = push(offset);

    const result = await pool.query(
      `SELECT t.*, COUNT(*) OVER()::int AS total_count FROM cashless_transactions t
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY t.occurred_at DESC
       LIMIT ${limitIndex} OFFSET ${offsetIndex}`,
      params,
    );
    const total = result.rows[0]?.total_count ?? 0;
    return { rows: result.rows.map(({ total_count, ...row }) => row), total };
  });

  app.patch<{ Params: { id: string }; Body: { amount?: string; paymentType?: string } }>(
    '/api/cashless/:id',
    auth,
    async (request) => {
      assertAdmin(request.actor);
      return withTransaction((client) =>
        updateCashlessTransaction(client, request.actor, Number(request.params.id), request.body),
      );
    },
  );

  app.get('/api/parser/settings', auth, async (request) => {
    assertAdmin(request.actor);
    // The password column is never returned to the client, even to an admin.
    const result = await pool.query(
      `SELECT provider, is_enabled, schedule_cron, overlap_minutes, page_size, max_pages_per_run,
              login, (password IS NOT NULL AND password <> '') AS has_password, updated_at
       FROM parser_settings ORDER BY provider`,
    );
    return result.rows;
  });

  app.get('/api/parser/runs', auth, async (request) => {
    assertAdmin(request.actor);
    const result = await pool.query('SELECT * FROM parser_runs ORDER BY started_at DESC LIMIT 100');
    return result.rows;
  });

  app.get('/api/parser/ivend/settings', auth, async (request) => {
    return withTransaction((client) => getIvendSettings(client, request.actor));
  });

  app.put<{ Body: { login: string; password: string; isEnabled: boolean } }>(
    '/api/parser/ivend/settings',
    auth,
    async (request) => withTransaction((client) => saveIvendSettings(client, request.actor, request.body)),
  );

  app.post('/api/parser/ivend/run', auth, async (request) => {
    return withTransaction((client) => runIvendSync(client, request.actor));
  });

  app.put<{ Body: { runTimes: string[] } }>(
    '/api/parser/ivend/schedule',
    auth,
    async (request) => withTransaction((client) => saveIvendRunTimes(client, request.actor, request.body.runTimes)),
  );
}
