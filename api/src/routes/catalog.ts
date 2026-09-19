import type { FastifyInstance } from 'fastify';
import { pool, withTransaction } from '../db/pool.js';
import {
  applyDivisorToHistory,
  installMachine,
  moveMachine,
  replaceMachine,
  updateMachine,
  updateMachineAddress,
} from '../commands/machines.js';
import { closeLocation, createLocation, setLocationStatus, updateLocation } from '../commands/locations.js';
import { getLocationRentHistory, setLocationRent } from '../commands/locationRent.js';
import {
  addLocationToClassifier,
  addMachineToClassifier,
  createClassifier,
  deleteClassifier,
  grantClassifierScope,
  removeLocationFromClassifier,
  removeMachineFromClassifier,
  revokeClassifierScope,
  updateClassifier,
} from '../commands/classifiers.js';
import { bindTerminal, createTerminal, unbindTerminal } from '../commands/terminals.js';
import { previewMachineChain } from '../domain/counterChain.js';
import { resolveServiceInterval } from '../domain/serviceIntervals.js';
import { auditDelete, auditInsert, auditUpdate } from '../lib/audit.js';
import { hashPassword } from '../lib/password.js';
import { deleteStaff, setStaffPassword, updateStaffProfile } from '../commands/staff.js';
import { badRequest, notFound } from '../lib/errors.js';
import {
  createMachineType,
  deleteMachineType,
  listMachineTypes,
  renameMachineType,
  setMachineTypeActive,
} from '../commands/machineTypes.js';
import {
  applyToySetInBulk,
  assignToySetToMachine,
  createToySet,
  updateToySet,
} from '../commands/toySets.js';
import {
  assertAdmin,
  assertMachineInScope,
  listScopedMachineNumbers,
  machineScopePredicate,
} from '../lib/scope.js';

const machineBodySchema = {
  type: 'object',
  properties: {
    machineType: { type: 'string' },
    model: { type: 'string' },
    pricePerGame: { type: ['number', 'string'] },
    counterDivisor: { type: ['number', 'string'] },
    minServiceDays: { type: ['integer', 'null'] },
    maxServiceDays: { type: ['integer', 'null'] },
    status: { type: 'string', enum: ['ACTIVE', 'RETIRED'] },
  },
} as const;

export async function registerCatalogRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: app.authenticate };

  // ---------------------------------------------------------------- locations
  app.get('/api/locations', auth, async () => {
    const result = await pool.query(
      `SELECT id, parent_id, name, address, timezone, status,
              min_service_days, max_service_days, closed_at
       FROM locations ORDER BY name`,
    );
    return result.rows;
  });

  app.post<{ Body: Parameters<typeof createLocation>[2] }>(
    '/api/locations',
    {
      ...auth,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'timezone'],
          properties: {
            name: { type: 'string', minLength: 1 },
            address: { type: 'string' },
            timezone: { type: 'string', minLength: 1 },
            parentId: { type: ['integer', 'null'] },
            minServiceDays: { type: ['integer', 'null'] },
            maxServiceDays: { type: ['integer', 'null'] },
          },
        },
      },
    },
    async (request) =>
      withTransaction((client) => createLocation(client, request.actor, request.body)),
  );

  app.patch<{ Params: { id: string }; Body: Parameters<typeof updateLocation>[3] }>(
    '/api/locations/:id',
    {
      ...auth,
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            address: { type: 'string' },
            timezone: { type: 'string', minLength: 1 },
            parentId: { type: ['integer', 'null'] },
            minServiceDays: { type: ['integer', 'null'] },
            maxServiceDays: { type: ['integer', 'null'] },
          },
        },
      },
    },
    async (request) =>
      withTransaction((client) =>
        updateLocation(client, request.actor, Number(request.params.id), request.body),
      ),
  );

  app.post<{ Params: { id: string }; Body: { status: 'ACTIVE' | 'DEACTIVATED' } }>(
    '/api/locations/:id/status',
    auth,
    async (request) =>
      withTransaction((client) =>
        setLocationStatus(client, request.actor, Number(request.params.id), request.body.status),
      ),
  );

  app.post<{
    Params: { id: string };
    Body: { occurredAt: string; finalCounters: Parameters<typeof closeLocation>[4] };
  }>('/api/locations/:id/close', auth, async (request) =>
    withTransaction((client) =>
      closeLocation(
        client,
        request.actor,
        Number(request.params.id),
        request.body.occurredAt,
        request.body.finalCounters ?? [],
      ),
    ),
  );

  /**
   * Полная история Адреса: когда появился/закрылся, какие аппараты и когда на нём стояли (с
   * начальными и конечными показаниями), финансы за 3 периода с разбивкой нал/безнал, и какие
   * терминалы были привязаны. Не фильтруется по scope — как и список /api/locations, адрес сам
   * по себе не считается защищаемой единицей, защита действует на уровне аппаратов.
   */
  app.get<{ Params: { id: string } }>('/api/locations/:id/history', auth, async (request) => {
    const locationId = Number(request.params.id);
    const location = await pool.query(
      'SELECT id, name, status, created_at, closed_at FROM locations WHERE id = $1',
      [locationId],
    );
    if (location.rowCount === 0) throw notFound('точка не существует');

    const placements = await pool.query(
      `SELECT p.id, p.machine_number, p.started_at, p.ended_at,
              p.initial_game_counter, p.initial_prize_counter,
              COALESCE(last.game_counter, p.initial_game_counter) AS final_game_counter,
              COALESCE(last.prize_counter, p.initial_prize_counter) AS final_prize_counter
       FROM machine_placements p
       LEFT JOIN LATERAL (
         SELECT game_counter, prize_counter FROM services
         WHERE placement_id = p.id ORDER BY occurred_at DESC, id DESC LIMIT 1
       ) last ON TRUE
       WHERE p.location_id = $1
       ORDER BY p.started_at DESC`,
      [locationId],
    );

    const finance = await pool.query(
      `SELECT
         SUM(s.revenue) FILTER (WHERE s.service_date >= date_trunc('month', now())::date) AS month_revenue,
         SUM(s.cash_amount) FILTER (WHERE s.service_date >= date_trunc('month', now())::date) AS month_cash,
         SUM(s.cashless_amount) FILTER (WHERE s.service_date >= date_trunc('month', now())::date) AS month_cashless,
         SUM(s.revenue) FILTER (
           WHERE s.service_date >= date_trunc('month', now() - interval '1 month')::date
             AND s.service_date < date_trunc('month', now())::date) AS last_month_revenue,
         SUM(s.cash_amount) FILTER (
           WHERE s.service_date >= date_trunc('month', now() - interval '1 month')::date
             AND s.service_date < date_trunc('month', now())::date) AS last_month_cash,
         SUM(s.cashless_amount) FILTER (
           WHERE s.service_date >= date_trunc('month', now() - interval '1 month')::date
             AND s.service_date < date_trunc('month', now())::date) AS last_month_cashless,
         SUM(s.revenue) AS all_time_revenue,
         SUM(s.cash_amount) AS all_time_cash,
         SUM(s.cashless_amount) AS all_time_cashless
       FROM services s
       JOIN machine_placements p ON p.id = s.placement_id
       WHERE p.location_id = $1`,
      [locationId],
    );
    const f = finance.rows[0];
    const zero = (value: unknown) => String(value ?? '0.00');

    // terminal_bindings.location_id is a snapshot taken at bind time (commands/terminals.ts) and
    // can go stale if the machine is later moved elsewhere while the terminal stays bound — joined
    // through machine_placements by overlapping time range instead of trusted directly.
    const terminals = await pool.query(
      `SELECT DISTINCT t.id, t.serial, t.label, tb.machine_number, tb.started_at, tb.ended_at
       FROM terminal_bindings tb
       JOIN terminals t ON t.id = tb.terminal_id
       JOIN machine_placements p ON p.machine_number = tb.machine_number
         AND tstzrange(p.started_at, p.ended_at) && tstzrange(tb.started_at, tb.ended_at)
       WHERE p.location_id = $1
       ORDER BY tb.started_at DESC`,
      [locationId],
    );

    return {
      ...location.rows[0],
      placements: placements.rows,
      finance: {
        monthToDate: { revenue: zero(f.month_revenue), cash: zero(f.month_cash), cashless: zero(f.month_cashless) },
        lastMonth: {
          revenue: zero(f.last_month_revenue), cash: zero(f.last_month_cash), cashless: zero(f.last_month_cashless),
        },
        allTime: { revenue: zero(f.all_time_revenue), cash: zero(f.all_time_cash), cashless: zero(f.all_time_cashless) },
      },
      terminals: terminals.rows,
    };
  });

  /** История аренды точки — используется формой установки аппарата (подсказать текущую ставку)
   * и карточкой аппарата (задать/сменить ставку). Доступ на чтение — как у истории точки, без
   * привязки к scope аппаратов. */
  app.get<{ Params: { id: string } }>('/api/locations/:id/rent', auth, async (request) => {
    const client = await pool.connect();
    try {
      return await getLocationRentHistory(client, Number(request.params.id));
    } finally {
      client.release();
    }
  });

  app.post<{ Params: { id: string }; Body: { monthlyAmount: string; effectiveFrom?: string } }>(
    '/api/locations/:id/rent',
    auth,
    async (request) =>
      withTransaction((client) =>
        setLocationRent(client, request.actor, Number(request.params.id), request.body),
      ),
  );

  // ------------------------------------------------------------- classifiers (Каталог)
  app.get('/api/classifiers', auth, async (request) => {
    assertAdmin(request.actor);
    const classifiers = await pool.query('SELECT id, name, parent_id FROM classifiers ORDER BY name');
    const locationMemberships = await pool.query(
      `SELECT lc.classifier_id, l.id AS location_id, l.name AS location_name
       FROM location_classifiers lc JOIN locations l ON l.id = lc.location_id
       ORDER BY l.name`,
    );
    const machineMemberships = await pool.query(
      `SELECT mc.classifier_id, m.machine_number
       FROM machine_classifiers mc JOIN machines m ON m.machine_number = mc.machine_number
       ORDER BY m.machine_number`,
    );
    const byClassifier = new Map<number, Array<{ id: number; name: string }>>();
    for (const row of locationMemberships.rows) {
      const list = byClassifier.get(row.classifier_id) ?? [];
      list.push({ id: row.location_id, name: row.location_name });
      byClassifier.set(row.classifier_id, list);
    }
    const machinesByClassifier = new Map<number, string[]>();
    for (const row of machineMemberships.rows) {
      const list = machinesByClassifier.get(row.classifier_id) ?? [];
      list.push(row.machine_number);
      machinesByClassifier.set(row.classifier_id, list);
    }
    return classifiers.rows.map((c) => ({
      ...c,
      locations: byClassifier.get(c.id) ?? [],
      machines: machinesByClassifier.get(c.id) ?? [],
    }));
  });

  app.post<{ Body: { name: string; parentId?: number | null } }>('/api/classifiers', auth, async (request) =>
    withTransaction((client) =>
      createClassifier(client, request.actor, request.body.name, request.body.parentId),
    ),
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; parentId?: number | null } }>(
    '/api/classifiers/:id',
    auth,
    async (request) =>
      withTransaction((client) =>
        updateClassifier(client, request.actor, Number(request.params.id), request.body),
      ),
  );

  app.delete<{ Params: { id: string } }>('/api/classifiers/:id', auth, async (request) => {
    await withTransaction((client) => deleteClassifier(client, request.actor, Number(request.params.id)));
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { locationId: number } }>(
    '/api/classifiers/:id/locations',
    auth,
    async (request) => {
      await withTransaction((client) =>
        addLocationToClassifier(client, request.actor, Number(request.params.id), request.body.locationId),
      );
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string }; Body: { locationId: number } }>(
    '/api/classifiers/:id/locations',
    auth,
    async (request) => {
      await withTransaction((client) =>
        removeLocationFromClassifier(client, request.actor, Number(request.params.id), request.body.locationId),
      );
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { machineNumber: string } }>(
    '/api/classifiers/:id/machines',
    auth,
    async (request) => {
      await withTransaction((client) =>
        addMachineToClassifier(client, request.actor, Number(request.params.id), request.body.machineNumber),
      );
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string }; Body: { machineNumber: string } }>(
    '/api/classifiers/:id/machines',
    auth,
    async (request) => {
      await withTransaction((client) =>
        removeMachineFromClassifier(client, request.actor, Number(request.params.id), request.body.machineNumber),
      );
      return { ok: true };
    },
  );

  // ----------------------------------------------------------------- machines
  /**
   * Scoped machine list. It carries everything the PWA needs to work offline: the current
   * counters to compare against, the machine price and the counter divisor for the technician's
   * reference calculation, and the resolved service interval.
   */
  app.get('/api/machines', auth, async (request) => {
    const scope = machineScopePredicate(request.actor, 'm.machine_number', 1);
    const result = await pool.query(
      `SELECT m.machine_number, m.machine_type, m.model, m.price_per_game, m.counter_divisor,
              m.status, m.min_service_days, m.max_service_days,
              p.id AS placement_id, p.started_at AS placement_started_at, p.address,
              p.initial_game_counter, p.initial_prize_counter,
              l.id AS location_id, l.name AS location_name, l.timezone, l.status AS location_status,
              last.occurred_at AS last_service_at,
              COALESCE(last.game_counter, p.initial_game_counter)   AS previous_game_counter,
              COALESCE(last.prize_counter, p.initial_prize_counter) AS previous_prize_counter,
              last.new_games AS last_new_games,
              last.revenue AS last_revenue,
              last.toy_cost AS last_toy_cost,
              last.revenue_to_cost_ratio AS last_revenue_to_cost_ratio,
              last_toys.items AS last_toy_quantities,
              ts.id AS default_toy_set_id, ts.name AS default_toy_set_name,
              default_set_items.items AS default_toy_set_items,
              term.id AS terminal_id, term.serial AS terminal_serial,
              binding.started_at AS terminal_bound_since
       FROM machines m
       LEFT JOIN toy_sets ts ON ts.id = m.default_toy_set_id
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(tsi.toy_id, tsi.quantity) AS items
         FROM toy_set_items tsi WHERE tsi.set_id = m.default_toy_set_id
       ) default_set_items ON TRUE
       LEFT JOIN machine_placements p
              ON p.machine_number = m.machine_number AND p.ended_at IS NULL
       LEFT JOIN locations l ON l.id = p.location_id
       LEFT JOIN LATERAL (
         -- По номеру аппарата, а не по текущему размещению: moveMachine переносит аппарат на
         -- новую точку, открывая новое размещение с нулём обслуживаний в нём, но это тот же
         -- физический аппарат — «обслуживание ещё не было» после простого переноса было бы
         -- неправдой, вся реальная история должна остаться видна.
         SELECT s.id, s.occurred_at, s.game_counter, s.prize_counter,
                s.new_games, s.revenue, s.toy_cost, s.revenue_to_cost_ratio
         FROM services s
         WHERE s.machine_number = m.machine_number
         ORDER BY s.occurred_at DESC, s.id DESC
         LIMIT 1
       ) last ON TRUE
       LEFT JOIN LATERAL (
         -- Предыдущее количество каждой игрушки на этом аппарате — «было N» в форме
         -- обслуживания (без этого техник не видит, сколько игрушек было в прошлый раз).
         SELECT jsonb_object_agg(td.toy_id, td.quantity) AS items
         FROM toy_distributions td
         WHERE td.service_id = last.id
       ) last_toys ON TRUE
       LEFT JOIN terminal_bindings binding
              ON binding.machine_number = m.machine_number AND binding.ended_at IS NULL
       LEFT JOIN terminals term ON term.id = binding.terminal_id
       WHERE ${scope.sql}
       ORDER BY m.machine_number`,
      scope.params,
    );
    return result.rows;
  });

  /**
   * Последние N значений ROI аппарата — для спарклайна в форме обслуживания.
   * Не пересчитывает метрику: отдаёт то же revenue_to_cost_ratio, что хранится на Service.
   */
  app.get<{ Params: { machineNumber: string }; Querystring: { limit?: string } }>(
    '/api/machines/:machineNumber/roi-trend',
    auth,
    async (request) => {
      const client = await pool.connect();
      try {
        await assertMachineInScope(client, request.actor, request.params.machineNumber);
      } finally {
        client.release();
      }

      const limit = Math.min(Math.max(Number(request.query.limit) || 8, 1), 30);
      const result = await pool.query(
        `SELECT service_date, revenue_to_cost_ratio
         FROM services
         WHERE machine_number = $1
         ORDER BY occurred_at DESC, id DESC
         LIMIT $2`,
        [request.params.machineNumber, limit],
      );
      return result.rows.reverse();
    },
  );

  /**
   * Контекст аппарата на произвольный момент времени — что технику показать как «было N»,
   * если он вводит обслуживание задним числом или между уже существующими записями.
   * Без этого форма всегда предлагала бы последнее ПО ВРЕМЕНИ обслуживание, а не то, что
   * реально предшествует выбранной дате, и подсказка вводила бы в заблуждение при вставке
   * записи в середину истории (хотя пересчёт цепочки на сервере в любом случае верен).
   */
  app.get<{ Params: { machineNumber: string }; Querystring: { occurredAt: string } }>(
    '/api/machines/:machineNumber/context-at',
    auth,
    async (request) => {
      const client = await pool.connect();
      try {
        await assertMachineInScope(client, request.actor, request.params.machineNumber);

        const placement = await client.query(
          `SELECT id, initial_game_counter, initial_prize_counter, started_at
           FROM machine_placements WHERE machine_number = $1 AND ended_at IS NULL`,
          [request.params.machineNumber],
        );
        if (placement.rowCount === 0) return { previous: null, next: null, placementStartedAt: null };

        const occurredAt = request.query.occurredAt;
        const previous = await client.query(
          `SELECT occurred_at, game_counter, prize_counter FROM services
           WHERE placement_id = $1 AND occurred_at < $2::timestamptz
           ORDER BY occurred_at DESC, id DESC LIMIT 1`,
          [placement.rows[0].id, occurredAt],
        );
        const next = await client.query(
          `SELECT occurred_at, game_counter FROM services
           WHERE placement_id = $1 AND occurred_at > $2::timestamptz
           ORDER BY occurred_at ASC, id ASC LIMIT 1`,
          [placement.rows[0].id, occurredAt],
        );

        return {
          previous: previous.rows[0] ?? {
            occurred_at: placement.rows[0].started_at,
            game_counter: placement.rows[0].initial_game_counter,
            prize_counter: placement.rows[0].initial_prize_counter,
          },
          next: next.rows[0] ?? null,
        };
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { machineNumber: string } }>(
    '/api/machines/:machineNumber/interval',
    auth,
    async (request) => {
      const client = await pool.connect();
      try {
        await assertMachineInScope(client, request.actor, request.params.machineNumber);
        return await resolveServiceInterval(client, request.params.machineNumber);
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { machineNumber: string } }>(
    '/api/machines/:machineNumber/chain',
    auth,
    async (request) => {
      assertAdmin(request.actor);
      const client = await pool.connect();
      try {
        return await previewMachineChain(client, request.params.machineNumber);
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Body: Parameters<typeof installMachine>[2] }>(
    '/api/machines/install',
    {
      ...auth,
      schema: {
        body: {
          type: 'object',
          required: [
            'machineNumber',
            'pricePerGame',
            'locationId',
            'startedAt',
            'initialGameCounter',
            'initialPrizeCounter',
          ],
          properties: {
            ...machineBodySchema.properties,
            machineNumber: { type: 'string', minLength: 1 },
            locationId: { type: 'integer' },
            startedAt: { type: 'string' },
            initialGameCounter: { type: 'integer', minimum: 0 },
            initialPrizeCounter: { type: 'integer', minimum: 0 },
            address: { type: ['string', 'null'] },
            initialToys: {
              type: 'array',
              items: {
                type: 'object',
                required: ['toyId', 'quantity'],
                properties: { toyId: { type: 'integer' }, quantity: { type: 'integer', minimum: 1 } },
              },
            },
          },
        },
      },
    },
    async (request) =>
      withTransaction((client) => installMachine(client, request.actor, request.body)),
  );

  app.patch<{ Params: { machineNumber: string }; Body: Parameters<typeof updateMachine>[3] }>(
    '/api/machines/:machineNumber',
    { ...auth, schema: { body: machineBodySchema } },
    async (request) =>
      withTransaction((client) =>
        updateMachine(client, request.actor, request.params.machineNumber, request.body),
      ),
  );

  /**
   * Deliberate correction of history after a wrongly configured divisor. Editing the machine
   * alone never rewrites past revenue.
   */
  app.post<{ Params: { machineNumber: string }; Body: { from?: string } }>(
    '/api/machines/:machineNumber/apply-divisor-to-history',
    auth,
    async (request) =>
      withTransaction((client) =>
        applyDivisorToHistory(
          client,
          request.actor,
          request.params.machineNumber,
          request.body?.from,
        ),
      ),
  );

  app.post<{ Body: Parameters<typeof replaceMachine>[2] }>(
    '/api/machines/replace',
    auth,
    async (request) =>
      withTransaction((client) => replaceMachine(client, request.actor, request.body)),
  );

  /**
   * Moves a machine to a different Location — a pure administrative reassignment (e.g.
   * reorganising a location hierarchy after the fact), not a service visit: no photo, no final
   * counter reading, the machine_number is never retired. See moveMachine's own comment for why
   * this exists.
   */
  app.post<{ Params: { machineNumber: string }; Body: Parameters<typeof moveMachine>[3] }>(
    '/api/machines/:machineNumber/move',
    auth,
    async (request) =>
      withTransaction((client) =>
        moveMachine(client, request.actor, request.params.machineNumber, request.body),
      ),
  );

  app.patch<{ Params: { machineNumber: string }; Body: { address: string | null } }>(
    '/api/machines/:machineNumber/address',
    auth,
    async (request) =>
      withTransaction((client) =>
        updateMachineAddress(client, request.actor, request.params.machineNumber, request.body.address),
      ),
  );

  // --------------------------------------------------------------------- toys
  app.get('/api/toys', auth, async () => {
    const result = await pool.query('SELECT * FROM toys ORDER BY is_active DESC, name');
    return result.rows;
  });

  app.post<{ Body: { name: string; unitCost: string | number } }>(
    '/api/toys',
    auth,
    async (request) =>
      withTransaction(async (client) => {
        assertAdmin(request.actor);
        const inserted = await client.query(
          'INSERT INTO toys (name, unit_cost) VALUES ($1, $2) RETURNING *',
          [request.body.name, String(request.body.unitCost)],
        );
        await auditInsert(client, request.actor, 'toy', inserted.rows[0].id, inserted.rows[0]);
        return inserted.rows[0];
      }),
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string; unitCost?: string | number; isActive?: boolean };
  }>('/api/toys/:id', auth, async (request) =>
    withTransaction(async (client) => {
      assertAdmin(request.actor);
      const id = Number(request.params.id);
      const before = await client.query('SELECT * FROM toys WHERE id = $1', [id]);
      if (before.rowCount === 0) throw notFound('игрушка не существует');

      const after = await client.query(
        `UPDATE toys SET
           name      = COALESCE($2, name),
           unit_cost = COALESCE($3, unit_cost),
           is_active = COALESCE($4, is_active)
         WHERE id = $1 RETURNING *`,
        [
          id,
          request.body.name ?? null,
          request.body.unitCost === undefined ? null : String(request.body.unitCost),
          request.body.isActive ?? null,
        ],
      );
      await auditUpdate(client, request.actor, 'toy', id, before.rows[0], after.rows[0]);
      return after.rows[0];
    }),
  );

  // ----------------------------------------------------------------- toy sets
  app.get('/api/toy-sets', auth, async () => {
    const result = await pool.query(
      `SELECT ts.id, ts.name,
              COALESCE(jsonb_agg(jsonb_build_object('toyId', tsi.toy_id, 'name', t.name, 'quantity', tsi.quantity)
                       ORDER BY t.name) FILTER (WHERE tsi.toy_id IS NOT NULL), '[]') AS items
       FROM toy_sets ts
       LEFT JOIN toy_set_items tsi ON tsi.set_id = ts.id
       LEFT JOIN toys t ON t.id = tsi.toy_id
       GROUP BY ts.id, ts.name
       ORDER BY ts.name`,
    );
    return result.rows;
  });

  app.post<{ Body: { name: string; items: Array<{ toyId: number; quantity: number }> } }>(
    '/api/toy-sets',
    auth,
    async (request) => withTransaction((client) => createToySet(client, request.actor, request.body)),
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string; items?: Array<{ toyId: number; quantity: number }> };
  }>('/api/toy-sets/:id', auth, async (request) =>
    withTransaction((client) => updateToySet(client, request.actor, Number(request.params.id), request.body)),
  );

  app.post<{ Params: { machineNumber: string }; Body: { setId: number | null } }>(
    '/api/machines/:machineNumber/toy-set',
    auth,
    async (request) =>
      withTransaction(async (client) => {
        await assignToySetToMachine(client, request.actor, request.params.machineNumber, request.body.setId);
        return { ok: true };
      }),
  );

  app.post<{
    Params: { id: string };
    Body: { machineType?: string; routeId?: number; locationId?: number; machineNumbers?: string[] };
  }>('/api/toy-sets/:id/apply-bulk', auth, async (request) =>
    withTransaction((client) => applyToySetInBulk(client, request.actor, Number(request.params.id), request.body)),
  );

  // ------------------------------------------------------------------- routes
  app.get('/api/routes', auth, async () => {
    const result = await pool.query('SELECT * FROM routes ORDER BY sort_order, id');
    return result.rows;
  });

  app.post<{
    Body: { name: string; sortOrder?: number; minServiceDays?: number; maxServiceDays?: number };
  }>('/api/routes', auth, async (request) =>
    withTransaction(async (client) => {
      assertAdmin(request.actor);
      const inserted = await client.query(
        `INSERT INTO routes (name, sort_order, min_service_days, max_service_days)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [
          request.body.name,
          request.body.sortOrder ?? 0,
          request.body.minServiceDays ?? null,
          request.body.maxServiceDays ?? null,
        ],
      );
      await auditInsert(client, request.actor, 'route', inserted.rows[0].id, inserted.rows[0]);
      return inserted.rows[0];
    }),
  );

  /** Маршруты, к которым привязан конкретный аппарат — вкладка «Маршруты» карточки аппарата. */
  app.get<{ Params: { machineNumber: string } }>(
    '/api/machines/:machineNumber/routes',
    auth,
    async (request) => {
      const client = await pool.connect();
      try {
        await assertMachineInScope(client, request.actor, request.params.machineNumber);
        const result = await client.query(
          `SELECT r.* FROM machine_routes mr
           JOIN routes r ON r.id = mr.route_id
           WHERE mr.machine_number = $1
           ORDER BY r.sort_order, r.id`,
          [request.params.machineNumber],
        );
        return result.rows;
      } finally {
        client.release();
      }
    },
  );

  /**
   * Техники, которые могут обслуживать этот аппарат: через дерево точек (scope) или через
   * точечное назначение — обе ветки формируют один и тот же реальный доступ на сервере.
   */
  app.get<{ Params: { machineNumber: string } }>(
    '/api/machines/:machineNumber/technicians',
    auth,
    async (request) => {
      assertAdmin(request.actor);
      const result = await pool.query(
        `WITH RECURSIVE machine_location AS (
           SELECT location_id FROM machine_placements
           WHERE machine_number = $1 AND ended_at IS NULL
         ),
         location_ancestors AS (
           SELECT l.id, l.parent_id FROM locations l
           WHERE l.id IN (SELECT location_id FROM machine_location)
           UNION ALL
           SELECT parent.id, parent.parent_id FROM locations parent
           JOIN location_ancestors child ON parent.id = child.parent_id
         )
         SELECT DISTINCT st.id, st.full_name, st.login,
                CASE WHEN mt.staff_id IS NOT NULL THEN 'machine' ELSE 'location' END AS source
         FROM staff st
         LEFT JOIN staff_location_scope sls ON sls.staff_id = st.id AND sls.location_id IN (SELECT id FROM location_ancestors)
         LEFT JOIN machine_technicians mt ON mt.staff_id = st.id AND mt.machine_number = $1
         WHERE st.role = 'TECHNICIAN' AND (sls.staff_id IS NOT NULL OR mt.staff_id IS NOT NULL)
         ORDER BY st.full_name`,
        [request.params.machineNumber],
      );
      return result.rows;
    },
  );

  /** Начальные игрушки текущей установки аппарата — вкладка «Игрушки» карточки аппарата. */
  app.get<{ Params: { machineNumber: string } }>(
    '/api/machines/:machineNumber/initial-toys',
    auth,
    async (request) => {
      const client = await pool.connect();
      try {
        await assertMachineInScope(client, request.actor, request.params.machineNumber);
        const result = await client.query(
          `SELECT t.id AS toy_id, t.name, pit.quantity, pit.unit_cost_snapshot
           FROM machine_placements p
           JOIN placement_initial_toys pit ON pit.placement_id = p.id
           JOIN toys t ON t.id = pit.toy_id
           WHERE p.machine_number = $1 AND p.ended_at IS NULL
           ORDER BY t.name`,
          [request.params.machineNumber],
        );
        return result.rows;
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Body: { machineNumber: string; routeId: number } }>(
    '/api/routes/assign',
    auth,
    async (request) =>
      withTransaction(async (client) => {
        assertAdmin(request.actor);
        const inserted = await client.query(
          `INSERT INTO machine_routes (machine_number, route_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING RETURNING *`,
          [request.body.machineNumber, request.body.routeId],
        );
        if (inserted.rowCount) {
          await auditInsert(
            client,
            request.actor,
            'machine_route',
            `${request.body.machineNumber}:${request.body.routeId}`,
            inserted.rows[0],
          );
        }
        return { assigned: true };
      }),
  );

  app.delete<{ Body: { machineNumber: string; routeId: number } }>(
    '/api/routes/assign',
    auth,
    async (request) =>
      withTransaction(async (client) => {
        assertAdmin(request.actor);
        const removed = await client.query(
          'DELETE FROM machine_routes WHERE machine_number = $1 AND route_id = $2 RETURNING *',
          [request.body.machineNumber, request.body.routeId],
        );
        if (removed.rowCount) {
          await auditDelete(
            client,
            request.actor,
            'machine_route',
            `${request.body.machineNumber}:${request.body.routeId}`,
            removed.rows[0],
          );
        }
        return { unassigned: true };
      }),
  );

  // -------------------------------------------------------------------- staff
  app.get('/api/staff', auth, async (request) => {
    // Руководителю нужен только список техников для фильтра журнала — без логинов и админов.
    if (request.actor.role === 'BOSS') {
      const technicians = await pool.query(
        `SELECT id, full_name, role FROM staff WHERE role = 'TECHNICIAN' ORDER BY full_name`,
      );
      return technicians.rows;
    }
    assertAdmin(request.actor);
    const result = await pool.query(
      'SELECT id, login, full_name, role, is_active, is_field_technician FROM staff ORDER BY full_name',
    );
    return result.rows;
  });

  app.patch<{
    Params: { id: string };
    Body: {
      fullName?: string;
      role?: 'ADMIN' | 'TECHNICIAN' | 'BOSS';
      isActive?: boolean;
      isFieldTechnician?: boolean;
    };
  }>('/api/staff/:id', auth, async (request) =>
    withTransaction((client) =>
      updateStaffProfile(client, request.actor, Number(request.params.id), request.body),
    ),
  );

  app.delete<{ Params: { id: string } }>('/api/staff/:id', auth, async (request) => {
    await withTransaction((client) => deleteStaff(client, request.actor, Number(request.params.id)));
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { password: string } }>(
    '/api/staff/:id/password',
    auth,
    async (request) => {
      await withTransaction((client) =>
        setStaffPassword(client, request.actor, Number(request.params.id), request.body.password),
      );
      return { ok: true };
    },
  );

  app.post<{
    Body: { login: string; fullName: string; role: 'ADMIN' | 'TECHNICIAN' | 'BOSS'; password: string };
  }>('/api/staff', auth, async (request) => {
    assertAdmin(request.actor);
    const passwordHash = await hashPassword(request.body.password);
    return withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO staff (login, full_name, role, password_hash)
         VALUES ($1, $2, $3::staff_role, $4)
         RETURNING id, login, full_name, role, is_active`,
        [request.body.login, request.body.fullName, request.body.role, passwordHash],
      );
      await auditInsert(client, request.actor, 'staff', inserted.rows[0].id, inserted.rows[0]);
      return inserted.rows[0];
    });
  });

  app.post<{ Body: { staffId: number; locationId?: number; classifierId?: number; machineNumber?: string } }>(
    '/api/staff/scope',
    auth,
    async (request) =>
      withTransaction(async (client) => {
        assertAdmin(request.actor);
        if (request.body.locationId) {
          const inserted = await client.query(
            `INSERT INTO staff_location_scope (staff_id, location_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING RETURNING *`,
            [request.body.staffId, request.body.locationId],
          );
          if (inserted.rowCount) {
            await auditInsert(
              client,
              request.actor,
              'staff_location_scope',
              `${request.body.staffId}:${request.body.locationId}`,
              inserted.rows[0],
            );
          }
        }
        if (request.body.classifierId) {
          await grantClassifierScope(client, request.actor, request.body.staffId, request.body.classifierId);
        }
        if (request.body.machineNumber) {
          const inserted = await client.query(
            `INSERT INTO machine_technicians (machine_number, staff_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING RETURNING *`,
            [request.body.machineNumber, request.body.staffId],
          );
          if (inserted.rowCount) {
            await auditInsert(
              client,
              request.actor,
              'machine_technician',
              `${request.body.machineNumber}:${request.body.staffId}`,
              inserted.rows[0],
            );
          }
        }
        return { ok: true };
      }),
  );

  /** What a staff member (technician or boss) can actually reach, so the admin can see and correct it. */
  app.get<{ Params: { id: string } }>('/api/staff/:id/scope', auth, async (request) => {
    assertAdmin(request.actor);
    const staffId = Number(request.params.id);

    const staffRow = await pool.query<{ id: number; login: string; role: 'ADMIN' | 'TECHNICIAN' | 'BOSS' }>(
      'SELECT id, login, role FROM staff WHERE id = $1',
      [staffId],
    );
    if (staffRow.rowCount === 0) throw notFound('сотрудник не существует');

    const locations = await pool.query(
      `SELECT l.id, l.name FROM staff_location_scope s
       JOIN locations l ON l.id = s.location_id
       WHERE s.staff_id = $1 ORDER BY l.name`,
      [staffId],
    );
    const classifiers = await pool.query(
      `SELECT c.id, c.name FROM staff_classifier_scope s
       JOIN classifiers c ON c.id = s.classifier_id
       WHERE s.staff_id = $1 ORDER BY c.name`,
      [staffId],
    );
    const machines = await pool.query(
      `SELECT machine_number FROM machine_technicians WHERE staff_id = $1 ORDER BY machine_number`,
      [staffId],
    );
    // Same recursive resolution every protected endpoint uses (lib/scope.ts) — this used to be a
    // hand-duplicated copy that also ignored the previewed staff member's role entirely, always
    // running the technician-shaped query regardless of whether they were TECHNICIAN or BOSS.
    const scopeClient = await pool.connect();
    let reachableMachines: string[];
    try {
      reachableMachines = await listScopedMachineNumbers(scopeClient, {
        id: staffRow.rows[0].id,
        login: staffRow.rows[0].login,
        role: staffRow.rows[0].role,
      });
    } finally {
      scopeClient.release();
    }

    return {
      locations: locations.rows,
      classifiers: classifiers.rows,
      machines: machines.rows.map((row) => row.machine_number),
      reachableMachines,
    };
  });

  app.delete<{ Body: { staffId: number; locationId?: number; classifierId?: number; machineNumber?: string } }>(
    '/api/staff/scope',
    auth,
    async (request) =>
      withTransaction(async (client) => {
        assertAdmin(request.actor);
        if (request.body.locationId) {
          const removed = await client.query(
            'DELETE FROM staff_location_scope WHERE staff_id = $1 AND location_id = $2 RETURNING *',
            [request.body.staffId, request.body.locationId],
          );
          for (const row of removed.rows) {
            await auditDelete(
              client,
              request.actor,
              'staff_location_scope',
              `${request.body.staffId}:${request.body.locationId}`,
              row,
            );
          }
        }
        if (request.body.classifierId) {
          await revokeClassifierScope(client, request.actor, request.body.staffId, request.body.classifierId);
        }
        if (request.body.machineNumber) {
          const removed = await client.query(
            'DELETE FROM machine_technicians WHERE staff_id = $1 AND machine_number = $2 RETURNING *',
            [request.body.staffId, request.body.machineNumber],
          );
          for (const row of removed.rows) {
            await auditDelete(
              client,
              request.actor,
              'machine_technician',
              `${request.body.machineNumber}:${request.body.staffId}`,
              row,
            );
          }
        }
        return { ok: true };
      }),
  );

  app.get('/api/staff/my-machines', auth, async (request) => {
    const client = await pool.connect();
    try {
      return await listScopedMachineNumbers(client, request.actor);
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------- terminals
  app.get('/api/terminals', auth, async () => {
    const result = await pool.query(
      // unmatched_* — безнал этого терминала, который не попал ни в одну привязку. Админке это
      // нужно, чтобы при привязке предложить дату начала с первой такой транзакции: иначе
      // терминал, физически поставленный раньше, чем его завели в систему, оставит эти дни
      // непривязанными — ровно так в миграции 06.09 повисли 88 250 ₽ (DECISION-038/043).
      // Одна группировка по непривязанным строкам вместо подзапроса на каждый терминал: частичный
      // индекс cashless_unmatched_idx не содержит номера терминала, и LATERAL-вариант пробегал его
      // заново для каждого из 85 терминалов.
      `SELECT t.*, b.machine_number AS bound_machine, b.started_at AS bound_since,
              coalesce(u.unmatched_count, 0) AS unmatched_count,
              coalesce(u.unmatched_amount, 0) AS unmatched_amount,
              u.earliest_unmatched
       FROM terminals t
       LEFT JOIN terminal_bindings b ON b.terminal_id = t.id AND b.ended_at IS NULL
       LEFT JOIN (
         SELECT terminal_external_id,
                count(*)::int AS unmatched_count,
                sum(amount) AS unmatched_amount,
                min(occurred_at) AS earliest_unmatched
         FROM cashless_transactions
         WHERE match_status = 'UNMATCHED'
         GROUP BY terminal_external_id
       ) u ON u.terminal_external_id = t.serial
       ORDER BY t.serial`,
    );
    return result.rows;
  });

  app.post<{ Body: { serial: string; provider: string; label?: string } }>(
    '/api/terminals',
    auth,
    async (request) =>
      withTransaction((client) => createTerminal(client, request.actor, request.body)),
  );

  app.post<{ Body: { terminalId: number; machineNumber: string; startedAt: string } }>(
    '/api/terminals/bind',
    auth,
    async (request) =>
      withTransaction((client) => bindTerminal(client, request.actor, request.body)),
  );

  app.post<{ Body: { terminalId: number; endedAt: string } }>(
    '/api/terminals/unbind',
    auth,
    async (request) =>
      withTransaction((client) => unbindTerminal(client, request.actor, request.body)),
  );

  app.get<{ Params: { id: string } }>('/api/terminals/:id/history', auth, async (request) => {
    const result = await pool.query(
      `SELECT * FROM terminal_bindings WHERE terminal_id = $1 ORDER BY started_at`,
      [Number(request.params.id)],
    );
    return result.rows;
  });

  // ----------------------------------------------------------- типы аппаратов
  app.get('/api/machine-types', auth, async (request) =>
    withTransaction((client) => listMachineTypes(client, request.actor)));

  app.post<{ Body: { name: string } }>('/api/machine-types', auth, async (request) =>
    withTransaction((client) => createMachineType(client, request.actor, request.body)));

  app.patch<{ Params: { name: string }; Body: { name?: string; isActive?: boolean } }>(
    '/api/machine-types/:name',
    auth,
    async (request) =>
      withTransaction(async (client) => {
        const current = decodeURIComponent(request.params.name);
        // Переименование и переключение активности приходят одним PATCH, но выполняются по
        // очереди: после переименования дальше работаем уже с новым именем.
        let name = current;
        let row = null;
        if (request.body.name !== undefined) {
          row = await renameMachineType(client, request.actor, current, { name: request.body.name });
          name = row.name;
        }
        if (request.body.isActive !== undefined) {
          row = await setMachineTypeActive(client, request.actor, name, request.body.isActive);
        }
        if (!row) throw badRequest('NOTHING_TO_UPDATE', 'не передано ни одного изменяемого поля');
        return row;
      }));

  app.delete<{ Params: { name: string } }>('/api/machine-types/:name', auth, async (request) =>
    withTransaction(async (client) => {
      await deleteMachineType(client, request.actor, decodeURIComponent(request.params.name));
      return { ok: true };
    }));
}
