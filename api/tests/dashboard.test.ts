import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, createToy, installTestMachine, postService, type TestContext } from './helpers.js';

/**
 * Dashboard KPIs (owner-requested): active machine/terminal counts, revenue over four fixed
 * periods, and top/worst-10 by revenue and by aggregate ROI (revenue/toy_cost for the period,
 * same convention as the monthly report — DECISION-020 — not an average of per-service ratios).
 */
describe('dashboard KPIs and rankings', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  it('reports machine/terminal counts, period revenue and revenue/ROI rankings', async () => {
    const toyId = await createToy(context, 'Мишка', '10.00');
    const occurredAt = new Date(Date.now() - 3_600_000).toISOString();

    await installTestMachine(context, { machineNumber: 'DB-1', pricePerGame: 100, initialGameCounter: 0 });
    await installTestMachine(context, { machineNumber: 'DB-2', pricePerGame: 100, initialGameCounter: 0 });
    await installTestMachine(context, { machineNumber: 'DB-3', pricePerGame: 100, initialGameCounter: 0 });

    // DB-1: revenue 1000, toy cost 100  -> roi 10.00 (best revenue, best roi)
    await postService(context, context.adminToken, 'DB-1', {
      gameCounter: 10, prizeCounter: 0, occurredAt, toys: [{ toyId, quantity: 10 }],
    });
    // DB-2: revenue 500, toy cost 250 -> roi 2.00 (middle)
    await postService(context, context.adminToken, 'DB-2', {
      gameCounter: 5, prizeCounter: 0, occurredAt, toys: [{ toyId, quantity: 25 }],
    });
    // DB-3: revenue 100, toy cost 100 -> roi 1.00 (worst revenue, worst roi)
    await postService(context, context.adminToken, 'DB-3', {
      gameCounter: 1, prizeCounter: 0, occurredAt, toys: [{ toyId, quantity: 10 }],
    });

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      counts: { activeMachines: number; totalMachines: number; activeTerminals: number; totalTerminals: number };
      revenue: { monthToDate: string; weekToDate: string; lastMonth: string; yearToDate: string };
      topRevenue: Array<{ machineNumber: string; revenue: string }>;
      worstRevenue: Array<{ machineNumber: string; revenue: string }>;
      topRoi: Array<{ machineNumber: string; roi: string }>;
      worstRoi: Array<{ machineNumber: string; roi: string }>;
    };

    assert.equal(body.counts.activeMachines, 3);
    assert.equal(body.counts.totalMachines, 3);
    assert.equal(body.counts.activeTerminals, 0);
    assert.equal(body.counts.totalTerminals, 0);

    // All three services happened "now", so month/week/year-to-date must all include the full 1600.
    assert.equal(body.revenue.monthToDate, '1600.00');
    assert.equal(body.revenue.weekToDate, '1600.00');
    assert.equal(body.revenue.yearToDate, '1600.00');
    assert.equal(body.revenue.lastMonth, '0.00');

    assert.deepEqual(body.topRevenue.map((r) => r.machineNumber), ['DB-1', 'DB-2', 'DB-3']);
    assert.deepEqual(body.worstRevenue.map((r) => r.machineNumber), ['DB-3', 'DB-2', 'DB-1']);
    assert.deepEqual(body.topRoi.map((r) => r.machineNumber), ['DB-1', 'DB-2', 'DB-3']);
    assert.deepEqual(body.worstRoi.map((r) => r.machineNumber), ['DB-3', 'DB-2', 'DB-1']);
    assert.equal(body.topRoi[0].roi, '10.00');
    assert.equal(body.worstRoi[0].roi, '1.00');
  });

  it('a technician only sees machines and revenue within their own scope', async () => {
    await installTestMachine(context, { machineNumber: 'DB-OUT', pricePerGame: 50, initialGameCounter: 0 });

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: authHeader(context.technicianToken),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { counts: { totalMachines: number } };
    assert.equal(body.counts.totalMachines, 0, 'a technician with no granted scope must see zero machines');
  });
});
