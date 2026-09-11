import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, postService, type TestContext } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { monthlyReport, rentSummary } from '../src/domain/reports.js';
import { SYSTEM_ACTOR } from '../src/lib/audit.js';

describe('location rent — effective-dated per-address rate', () => {
  let context: TestContext;
  let locationId: number;

  before(async () => {
    context = await bootstrap();
    const { locationId: id } = await installTestMachine(context, {
      machineNumber: 'RENT-1',
      pricePerGame: 10,
      startedAt: '2026-08-01T00:00:00Z',
    });
    locationId = id;
    // A real service inside August so monthlyReport (driven by `services`, like business_expenses
    // already was before this feature) actually emits an August row for the rent to fold into.
    const posted = await postService(context, context.adminToken, 'RENT-1', {
      gameCounter: 100,
      prizeCounter: 10,
      occurredAt: '2026-08-20T10:00:00Z',
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
  });

  after(async () => {
    await context.app.close();
  });

  it('sets an initial rate and reports it as current', async () => {
    const set = await context.app.inject({
      method: 'POST',
      url: `/api/locations/${locationId}/rent`,
      headers: authHeader(context.adminToken),
      payload: { monthlyAmount: '10000.00', effectiveFrom: '2026-08-01T00:00:00Z' },
    });
    assert.equal(set.statusCode, 200);

    const history = await context.app.inject({
      method: 'GET',
      url: `/api/locations/${locationId}/rent`,
      headers: authHeader(context.adminToken),
    });
    const rows = history.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ended_at, null);
    assert.equal(rows[0].monthly_amount, '10000.00');
  });

  it('rejects a negative amount', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: `/api/locations/${locationId}/rent`,
      headers: authHeader(context.adminToken),
      payload: { monthlyAmount: '-1' },
    });
    assert.equal(response.statusCode, 400);
  });

  it('forbids BOSS and TECHNICIAN from setting a rate', async () => {
    for (const token of [context.bossToken, context.technicianToken]) {
      const response = await context.app.inject({
        method: 'POST',
        url: `/api/locations/${locationId}/rent`,
        headers: authHeader(token),
        payload: { monthlyAmount: '5000.00' },
      });
      assert.equal(response.statusCode, 403);
    }
  });

  it('closes the previous period on a rate change without rewriting its own started_at/amount', async () => {
    const changed = await context.app.inject({
      method: 'POST',
      url: `/api/locations/${locationId}/rent`,
      headers: authHeader(context.adminToken),
      payload: { monthlyAmount: '15000.00', effectiveFrom: '2026-08-15T00:00:00Z' },
    });
    assert.equal(changed.statusCode, 200);

    const history = await context.app.inject({
      method: 'GET',
      url: `/api/locations/${locationId}/rent`,
      headers: authHeader(context.adminToken),
    });
    const rows = history.json() as Array<{ monthly_amount: string; started_at: string; ended_at: string | null }>;
    assert.equal(rows.length, 2);
    const closed = rows.find((r) => r.ended_at !== null)!;
    const open = rows.find((r) => r.ended_at === null)!;
    assert.equal(closed.monthly_amount, '10000.00');
    assert.equal(new Date(closed.started_at).toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(new Date(closed.ended_at as string).toISOString(), '2026-08-15T00:00:00.000Z');
    assert.equal(open.monthly_amount, '15000.00');
  });

  it('prorates August between the two rates, and a later future-dated change does not perturb it', async () => {
    const client = await pool.connect();
    try {
      const august = await rentSummary(client, { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' });
      const row = august.locations.find((l) => l.locationId === locationId)!;
      // 14 days at 10000/mo + 17 days at 15000/mo, against a 31-day August baseline.
      const expected = (10000 * 14 + 15000 * 17) / 31;
      assert.ok(Math.abs(Number(row.proratedCost) - expected) < 1, `expected ~${expected}, got ${row.proratedCost}`);

      const future = await context.app.inject({
        method: 'POST',
        url: `/api/locations/${locationId}/rent`,
        headers: authHeader(context.adminToken),
        payload: { monthlyAmount: '20000.00', effectiveFrom: '2026-10-01T00:00:00Z' },
      });
      assert.equal(future.statusCode, 200);

      const augustAgain = await rentSummary(client, { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' });
      const rowAgain = augustAgain.locations.find((l) => l.locationId === locationId)!;
      assert.equal(rowAgain.proratedCost, row.proratedCost);
    } finally {
      client.release();
    }
  });

  it('folds the same prorated figure into monthlyReport.expensesTotal/netProfit for August', async () => {
    const client = await pool.connect();
    try {
      const rows = await monthlyReport(client, SYSTEM_ACTOR, { months: 6 });
      const august = rows.find((r) => String(r.monthStart).startsWith('2026-08'));
      assert.ok(august, 'expected an August 2026 row in the monthly report window');

      const rent = await rentSummary(client, { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' });
      const expectedRent = Number(rent.total);

      assert.ok(
        Math.abs(Number(august!.expensesTotal) - expectedRent) < 1,
        `expected expensesTotal ~${expectedRent}, got ${august!.expensesTotal}`,
      );
      const expectedNetProfit = Number(august!.revenue) - Number(august!.toyCost) - expectedRent;
      assert.ok(Math.abs(Number(august!.netProfit) - expectedNetProfit) < 1);
    } finally {
      client.release();
    }
  });
});
