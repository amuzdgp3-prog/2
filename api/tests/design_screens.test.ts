import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  authHeader,
  bootstrap,
  createToy,
  installTestMachine,
  pool,
  postService,
  type TestContext,
} from './helpers.js';

/**
 * Backend support for the technician screens adapted from the design mockups
 * (docs/design/mockups 01-04): ROI on the machine list, ROI trend for the sparkline,
 * and the previous quantity per toy for the "было N" hint.
 */
describe('machine list / roi-trend support for the reskinned technician screens', () => {
  let context: TestContext;
  let toyId: number;

  before(async () => {
    context = await bootstrap();
    toyId = await createToy(context, 'Мишка малый', '18.00');
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('returns the last service outcome and last toy quantities on the machines list', async () => {
    await installTestMachine(context, {
      machineNumber: 'D-1',
      pricePerGame: 10,
      initialGameCounter: 0,
      initialToys: [{ toyId, quantity: 5 }],
    });

    const before = await context.app.inject({
      method: 'GET',
      url: '/api/machines',
      headers: authHeader(context.adminToken),
    });
    const beforeRow = (before.json() as Array<Record<string, unknown>>).find(
      (row) => row.machine_number === 'D-1',
    );
    assert.equal(beforeRow?.last_revenue_to_cost_ratio, null, 'no service yet — нет данных');
    assert.equal(beforeRow?.last_toy_quantities, null);

    await postService(context, context.adminToken, 'D-1', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-04-01T10:00:00Z',
      toys: [{ toyId, quantity: 42 }],
    });

    const after = await context.app.inject({
      method: 'GET',
      url: '/api/machines',
      headers: authHeader(context.adminToken),
    });
    const row = (after.json() as Array<Record<string, unknown>>).find(
      (r) => r.machine_number === 'D-1',
    );
    assert.equal(row?.last_new_games, '100.0000');
    assert.equal(row?.last_revenue, '1000.00');
    assert.equal(row?.last_revenue_to_cost_ratio, '11.1111', '1000 / 90 (5 начальных игрушек по 18 ₽)');
    assert.deepEqual(row?.last_toy_quantities, { [toyId]: 42 });
  });

  it('serves the ROI trend in chronological order, scoped to the technician', async () => {
    await installTestMachine(context, {
      machineNumber: 'D-2',
      pricePerGame: 10,
      initialGameCounter: 0,
      initialToys: [{ toyId, quantity: 10 }],
    });

    for (const [gameCounter, occurredAt] of [
      [100, '2026-04-01T10:00:00Z'],
      [200, '2026-04-08T10:00:00Z'],
      [300, '2026-04-15T10:00:00Z'],
    ] as const) {
      await postService(context, context.adminToken, 'D-2', {
        gameCounter,
        prizeCounter: 0,
        occurredAt,
      });
    }

    const trend = await context.app.inject({
      method: 'GET',
      url: '/api/machines/D-2/roi-trend?limit=2',
      headers: authHeader(context.adminToken),
    });
    const rows = trend.json() as Array<{ service_date: string; revenue_to_cost_ratio: string | null }>;
    assert.equal(rows.length, 2, 'limit is honoured');
    assert.ok(
      rows[0].service_date < rows[1].service_date,
      'the trend is returned oldest-first for a left-to-right sparkline',
    );

    const foreignAccess = await context.app.inject({
      method: 'GET',
      url: '/api/machines/D-2/roi-trend',
      headers: authHeader(context.technicianToken),
    });
    assert.equal(foreignAccess.statusCode, 403, 'a technician out of scope must not read the trend');
  });
});
