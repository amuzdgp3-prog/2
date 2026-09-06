import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  authHeader,
  bootstrap,
  createToy,
  installTestMachine,
  pool,
  postService,
  preparePhoto,
  type TestContext,
} from './helpers.js';

/**
 * Acceptance suite for 19_REMAINING_GAPS_CLOSURE_v2:
 * §1 «Отношение выручка / себестоимость», §2 audit покрытия статусных мутаций,
 * §5 переоткрытие CLOSED-локации.
 */
describe('remaining gaps closure v2', () => {
  let context: TestContext;
  let toyId: number;

  before(async () => {
    context = await bootstrap();
    toyId = await createToy(context, 'Мягкая игрушка', '100.00');
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  // ------------------------------------------------------------------ §1 metric

  it('uses the previous service toy cost as the denominator', async () => {
    await installTestMachine(context, {
      machineNumber: 'R-1',
      pricePerGame: 10,
      initialGameCounter: 0,
      initialToys: [{ toyId, quantity: 2 }], // база первого обслуживания: 200.00
    });

    // Первое обслуживание: выручка 1000, база — начальные игрушки Placement (200).
    await postService(context, context.adminToken, 'R-1', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-03-01T10:00:00Z',
      toys: [{ toyId, quantity: 5 }], // себестоимость 500 — база для следующего
    });

    // Второе обслуживание: выручка 2000, база — 500 от предыдущего.
    await postService(context, context.adminToken, 'R-1', {
      gameCounter: 300,
      prizeCounter: 0,
      occurredAt: '2026-03-08T10:00:00Z',
      toys: [{ toyId, quantity: 1 }],
    });

    const services = await pool.query(
      `SELECT revenue, toy_cost, revenue_to_cost_ratio FROM services
       WHERE machine_number = 'R-1' ORDER BY occurred_at`,
    );

    assert.equal(services.rows[0].revenue, '1000.00');
    assert.equal(services.rows[0].revenue_to_cost_ratio, '5.0000', '1000 / 200 начальных игрушек');
    assert.equal(services.rows[1].revenue, '2000.00');
    assert.equal(services.rows[1].revenue_to_cost_ratio, '4.0000', '2000 / 500 предыдущего');
  });

  it('reports "нет данных" when the denominator is absent or zero', async () => {
    await installTestMachine(context, {
      machineNumber: 'R-2',
      pricePerGame: 10,
      initialGameCounter: 0,
    });

    // Начальных игрушек нет — знаменателя не существует.
    await postService(context, context.adminToken, 'R-2', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-03-01T10:00:00Z',
    });

    // У предыдущего обслуживания себестоимость 0 — деление не выполняется.
    await postService(context, context.adminToken, 'R-2', {
      gameCounter: 200,
      prizeCounter: 0,
      occurredAt: '2026-03-08T10:00:00Z',
    });

    const services = await pool.query(
      `SELECT revenue_to_cost_ratio FROM services
       WHERE machine_number = 'R-2' ORDER BY occurred_at`,
    );

    assert.equal(services.rows[0].revenue_to_cost_ratio, null, 'нет базы — нет данных');
    assert.equal(services.rows[1].revenue_to_cost_ratio, null, 'нулевая база — нет данных');
  });

  it('recalculates the metric when an earlier service is edited', async () => {
    const before = await pool.query(
      `SELECT id, revenue_to_cost_ratio FROM services
       WHERE machine_number = 'R-1' ORDER BY occurred_at`,
    );

    // Удваиваем себестоимость первого обслуживания: знаменатель второго должен вырасти вдвое.
    await context.app.inject({
      method: 'PATCH',
      url: `/api/services/${before.rows[0].id}`,
      headers: authHeader(context.adminToken),
      payload: { toys: [{ toyId, quantity: 10 }] },
    });

    const after = await pool.query(
      `SELECT toy_cost, revenue_to_cost_ratio FROM services
       WHERE machine_number = 'R-1' ORDER BY occurred_at`,
    );

    assert.equal(after.rows[0].toy_cost, '1000.00');
    assert.equal(after.rows[1].revenue_to_cost_ratio, '2.0000', '2000 / 1000 после правки');
  });

  it('serves the same metric to report, dashboard and CSV export', async () => {
    const report = await context.app.inject({
      method: 'GET',
      url: '/api/reports/financial?machineNumber=R-1',
      headers: authHeader(context.adminToken),
    });
    const machineRow = report.json().locations[0].machines[0];

    const latest = await pool.query(
      `SELECT revenue_to_cost_ratio FROM services
       WHERE machine_number = 'R-1' ORDER BY occurred_at DESC LIMIT 1`,
    );
    assert.equal(machineRow.lastRevenueToCostRatio, latest.rows[0].revenue_to_cost_ratio);

    const csv = await context.app.inject({
      method: 'GET',
      url: '/api/reports/export.csv?machineNumber=R-1',
      headers: authHeader(context.adminToken),
    });
    assert.ok(csv.body.includes('revenue_to_cost_ratio'), 'колонка присутствует в выгрузке');
    assert.ok(
      csv.body.includes(String(latest.rows[0].revenue_to_cost_ratio)),
      'CSV и отчёт показывают одно и то же значение',
    );

    const csvNoData = await context.app.inject({
      method: 'GET',
      url: '/api/reports/export.csv?machineNumber=R-2',
      headers: authHeader(context.adminToken),
    });
    assert.ok(csvNoData.body.includes('нет данных'), 'отсутствие базы выгружается как «нет данных»');
  });

  // ------------------------------------------------------------------- §2 audit

  it('audits the terminal status transitions on bind and unbind', async () => {
    await installTestMachine(context, { machineNumber: 'R-3', pricePerGame: 10 });

    const terminal = await context.app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: authHeader(context.adminToken),
      payload: { serial: 'T-AUDIT', provider: 'demo' },
    });
    const terminalId = terminal.json().id;

    await context.app.inject({
      method: 'POST',
      url: '/api/terminals/bind',
      headers: authHeader(context.adminToken),
      payload: { terminalId, machineNumber: 'R-3', startedAt: '2026-04-01T10:00:00Z' },
    });
    await context.app.inject({
      method: 'POST',
      url: '/api/terminals/unbind',
      headers: authHeader(context.adminToken),
      payload: { terminalId, endedAt: '2026-04-10T10:00:00Z' },
    });

    const audit = await pool.query(
      `SELECT old_data ->> 'status' AS old_status, new_data ->> 'status' AS new_status,
              context ->> 'reason' AS reason
       FROM audit_log
       WHERE entity = 'terminal' AND entity_id = $1 AND action = 'UPDATE'
       ORDER BY id`,
      [String(terminalId)],
    );

    assert.deepEqual(
      audit.rows.map((row) => [row.reason, row.old_status, row.new_status]),
      [
        ['terminal_bound', 'IN_STOCK', 'INSTALLED'],
        ['terminal_unbound', 'INSTALLED', 'IN_STOCK'],
      ],
    );

    const stored = await pool.query('SELECT status FROM terminals WHERE id = $1', [terminalId]);
    assert.equal(stored.rows[0].status, 'IN_STOCK');
  });

  it('audits the machine retirement performed by a replacement', async () => {
    const { locationId } = await installTestMachine(context, {
      machineNumber: 'R-4',
      pricePerGame: 10,
      initialGameCounter: 0,
    });
    void locationId;

    const localId = randomUUID();
    const photoObjectKey = await preparePhoto(localId);
    const replaced = await context.app.inject({
      method: 'POST',
      url: '/api/machines/replace',
      headers: authHeader(context.adminToken),
      payload: {
        oldMachineNumber: 'R-4',
        occurredAt: '2026-05-01T10:00:00Z',
        finalGameCounter: 500,
        finalPrizeCounter: 20,
        localId,
        photoObjectKey,
        newMachine: {
          machineNumber: 'R-4-NEW',
          pricePerGame: 10,
          counterDivisor: 1,
          initialGameCounter: 0,
          initialPrizeCounter: 0,
        },
      },
    });
    assert.equal(replaced.statusCode, 200);

    const audit = await pool.query(
      `SELECT old_data ->> 'status' AS old_status, new_data ->> 'status' AS new_status
       FROM audit_log
       WHERE entity = 'machine' AND entity_id = 'R-4' AND context ->> 'reason' = 'machine_replaced'`,
    );
    assert.deepEqual(audit.rows, [{ old_status: 'ACTIVE', new_status: 'RETIRED' }]);
  });

  it('rolls the status mutation back when the audit write fails', async () => {
    await installTestMachine(context, { machineNumber: 'R-5', pricePerGame: 10 });

    const terminal = await context.app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: authHeader(context.adminToken),
      payload: { serial: 'T-ROLLBACK', provider: 'demo' },
    });
    const terminalId = terminal.json().id;

    const { withTransaction } = await import('../src/db/pool.js');
    const { bindTerminal } = await import('../src/commands/terminals.js');

    // Актор, которого нет в staff: запись в audit_log нарушит внешний ключ и обязана
    // откатить вместе с собой всю бизнес-операцию.
    await assert.rejects(
      withTransaction((client) =>
        bindTerminal(
          client,
          { id: 999_999, login: 'ghost', role: 'ADMIN' },
          { terminalId, machineNumber: 'R-5', startedAt: '2026-04-01T10:00:00Z' },
        ),
      ),
      /audit_log_actor_id_fkey|violates foreign key/,
    );

    const stored = await pool.query('SELECT status FROM terminals WHERE id = $1', [terminalId]);
    assert.equal(stored.rows[0].status, 'IN_STOCK', 'статус не должен измениться');

    const bindings = await pool.query(
      'SELECT COUNT(*)::int AS count FROM terminal_bindings WHERE terminal_id = $1',
      [terminalId],
    );
    assert.equal(bindings.rows[0].count, 0, 'привязка не должна сохраниться');
  });

  // ------------------------------------------------------------- §5 reopening

  it('reopens a CLOSED location without restoring machines automatically', async () => {
    const { locationId } = await installTestMachine(context, {
      machineNumber: 'R-6',
      pricePerGame: 10,
      initialGameCounter: 0,
    });

    const localId = randomUUID();
    const photoObjectKey = await preparePhoto(localId);
    await context.app.inject({
      method: 'POST',
      url: `/api/locations/${locationId}/close`,
      headers: authHeader(context.adminToken),
      payload: {
        occurredAt: '2026-06-01T12:00:00Z',
        finalCounters: [
          { machineNumber: 'R-6', localId, gameCounter: 400, prizeCounter: 10, photoObjectKey },
        ],
      },
    });

    const reopened = await context.app.inject({
      method: 'POST',
      url: `/api/locations/${locationId}/status`,
      headers: authHeader(context.adminToken),
      payload: { status: 'ACTIVE' },
    });
    assert.equal(reopened.statusCode, 200);
    assert.equal(reopened.json().status, 'ACTIVE');

    const placements = await pool.query(
      'SELECT ended_at FROM machine_placements WHERE machine_number = $1',
      ['R-6'],
    );
    assert.equal(placements.rowCount, 1);
    assert.notEqual(placements.rows[0].ended_at, null, 'старая установка остаётся закрытой');

    // Машина не возвращается сама: обслуживание невозможно до новой операции установки.
    const attempt = await postService(context, context.adminToken, 'R-6', {
      gameCounter: 500,
      prizeCounter: 15,
      occurredAt: '2026-06-05T10:00:00Z',
    });
    assert.equal(attempt.status, 400);
    assert.equal((attempt.body as { error: string }).error, 'NO_ACTIVE_PLACEMENT');

    // Номер закрытого аппарата не переиспользуется — возвращается новый физический аппарат.
    const installed = await context.app.inject({
      method: 'POST',
      url: '/api/machines/install',
      headers: authHeader(context.adminToken),
      payload: {
        machineNumber: 'R-6-RETURN',
        pricePerGame: 10,
        locationId,
        startedAt: '2026-06-10T09:00:00Z',
        initialGameCounter: 0,
        initialPrizeCounter: 0,
      },
    });
    assert.equal(installed.statusCode, 200);

    const history = await pool.query(
      'SELECT COUNT(*)::int AS count FROM machine_placements WHERE location_id = $1',
      [locationId],
    );
    assert.equal(history.rows[0].count, 2, 'история установок сохраняется целиком');
  });
});
