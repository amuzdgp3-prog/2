import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, createToy, installTestMachine, pool, postService, type TestContext } from './helpers.js';

/** Backend support for the financial report's monthly chart (docs/design/mockups/08). */
describe('monthly report aggregation', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('aggregates revenue, toy cost and ROI per calendar month across machines', async () => {
    const toyId = await createToy(context, 'Мишка', '10.00');
    await installTestMachine(context, {
      machineNumber: 'MO-1',
      pricePerGame: 10,
      initialGameCounter: 0,
      initialToys: [{ toyId, quantity: 5 }], // база 50.00 для первого обслуживания
    });
    await installTestMachine(context, {
      machineNumber: 'MO-2',
      pricePerGame: 10,
      initialGameCounter: 0,
      initialToys: [{ toyId, quantity: 5 }],
    });

    // Must stay in the current calendar month but never in the future (services can't be dated
    // ahead of "now"), so pick day-of-month min(15, today) rather than a fixed 15th.
    const now = new Date();
    const day = String(Math.min(15, now.getUTCDate())).padStart(2, '0');
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${day}T00:00:00Z`;

    await postService(context, context.adminToken, 'MO-1', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: thisMonth,
      toys: [{ toyId, quantity: 3 }], // toy_cost этой записи 30, но себестоимость БАЗЫ для ROI — начальные игрушки (50)
    });
    await postService(context, context.adminToken, 'MO-2', {
      gameCounter: 200,
      prizeCounter: 0,
      occurredAt: thisMonth,
      toys: [{ toyId, quantity: 2 }],
    });

    const monthly = await context.app.inject({
      method: 'GET',
      url: '/api/reports/monthly?months=1',
      headers: authHeader(context.adminToken),
    });
    const rows = monthly.json() as Array<Record<string, string | number | null>>;
    assert.equal(rows.length, 1, 'only the current month has data with months=1');

    const row = rows[0];
    // revenue: 1000 (MO-1) + 2000 (MO-2) = 3000; toy_cost of THESE services: 30 + 20 = 50.
    assert.equal(row.revenue, '3000.00');
    assert.equal(row.toyCost, '50.00');
    assert.equal(row.profit, '2950.00');
    assert.equal(row.services, 2);
    assert.equal(row.newGames, '300.0000');
    // Monthly ROI is an aggregate ratio (revenue/cost of the month), not an average of per-service ROI.
    assert.equal(row.roi, (3000 / 50).toFixed(2));
  });

  it('respects the location filter (including the subtree) and technician scope', async () => {
    const outsideLocation = await context.app.inject({
      method: 'POST',
      url: '/api/locations',
      headers: authHeader(context.adminToken),
      payload: { name: 'Другая точка', timezone: 'Europe/Moscow' },
    });
    await installTestMachine(context, {
      machineNumber: 'MO-3',
      pricePerGame: 10,
      initialGameCounter: 0,
      locationId: outsideLocation.json().id,
    });
    await postService(context, context.adminToken, 'MO-3', {
      gameCounter: 500,
      prizeCounter: 0,
      occurredAt: new Date().toISOString(),
    });

    const machinesResponse = await context.app.inject({
      method: 'GET',
      url: '/api/machines',
      headers: authHeader(context.adminToken),
    });
    const mo1 = (machinesResponse.json() as Array<{ machine_number: string; location_id: number }>).find(
      (m) => m.machine_number === 'MO-1',
    );

    const filtered = await context.app.inject({
      method: 'GET',
      url: `/api/reports/monthly?months=1&locationId=${mo1!.location_id}`,
      headers: authHeader(context.adminToken),
    });
    const revenueWithFilter = Number((filtered.json() as Array<{ revenue: string }>)[0].revenue);

    const unfiltered = await context.app.inject({
      method: 'GET',
      url: '/api/reports/monthly?months=1',
      headers: authHeader(context.adminToken),
    });
    const revenueWithoutFilter = Number((unfiltered.json() as Array<{ revenue: string }>)[0].revenue);

    assert.ok(
      revenueWithFilter < revenueWithoutFilter,
      'filtering by location must exclude MO-3 revenue from another location',
    );
  });

  it('splits how much actually reached the owner (cashless + CARD transfers) and keeps CARD out of expenses and netProfit', async () => {
    await installTestMachine(context, {
      machineNumber: 'MO-4',
      pricePerGame: 10,
      initialGameCounter: 0,
    });
    const occurredAt = new Date().toISOString();
    const posted = await postService(context, context.adminToken, 'MO-4', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt,
    });
    // cashless_amount обычно проставляется сопоставлением cashless_transactions (см.
    // rbac_cashless_reports.test.ts) — здесь та часть не тестируется повторно, важна только
    // агрегация SUM(s.cashless_amount) по месяцу в monthlyReport.
    const createdService = posted.body.service as { id: number };
    await pool.query(`UPDATE services SET cashless_amount = '400.00' WHERE id = $1`, [createdService.id]);

    await context.app.inject({
      method: 'POST',
      url: '/api/expenses',
      headers: authHeader(context.adminToken),
      payload: { category: 'CARD', expenseDate: occurredAt.slice(0, 10), amount: '600.00', comment: 'владельцу' },
    });

    const monthly = await context.app.inject({
      method: 'GET',
      url: '/api/reports/monthly?months=1',
      headers: authHeader(context.adminToken),
    });
    const row = (monthly.json() as Array<Record<string, string | number | null>>)[0];

    assert.equal(row.cashless, '400.00');
    assert.equal(row.paidToOwner, '600.00');
    assert.equal(row.reachedOwner, '1000.00');
    // CARD — не расход: владелец получает эти деньги себе (уточнение 19.09.2026, DECISION-080).
    assert.equal(row.expensesTotal, '0.00');
    assert.equal(
      Number(row.netProfit),
      Number(row.revenue) - Number(row.toyCost) - Number(row.expensesTotal),
      'CARD не должен уменьшать чистую прибыль',
    );
  });
});
