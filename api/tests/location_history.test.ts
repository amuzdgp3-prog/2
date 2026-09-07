import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, postService, type TestContext } from './helpers.js';

describe('GET /api/locations/:id/history — Адрес detail page', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  it('returns creation date, placement history with counters, and financial totals across three periods', async () => {
    const { locationId } = await installTestMachine(context, {
      machineNumber: 'LH-1',
      pricePerGame: 10,
      initialGameCounter: 100,
    });

    const service = await postService(context, context.adminToken, 'LH-1', {
      gameCounter: 150,
      prizeCounter: 0,
      occurredAt: new Date().toISOString(),
    });
    assert.equal(service.status, 200);

    const history = await context.app.inject({
      method: 'GET',
      url: `/api/locations/${locationId}/history`,
      headers: authHeader(context.adminToken),
    });
    assert.equal(history.statusCode, 200);
    const body = history.json();

    assert.equal(body.status, 'ACTIVE');
    assert.ok(body.created_at);
    assert.equal(body.closed_at, null);

    assert.equal(body.placements.length, 1);
    assert.equal(body.placements[0].machine_number, 'LH-1');
    assert.equal(Number(body.placements[0].initial_game_counter), 100);
    assert.equal(Number(body.placements[0].final_game_counter), 150);
    assert.equal(body.placements[0].ended_at, null);

    // 50 new games * 10 per game = 500 revenue, all-time only (no cashless matched, so all cash).
    assert.equal(body.finance.allTime.revenue, '500.00');
    assert.equal(body.finance.monthToDate.revenue, '500.00');
    assert.equal(body.finance.lastMonth.revenue, '0.00');

    assert.deepEqual(body.terminals, []);
  });

  it('404s for a location that does not exist', async () => {
    const missing = await context.app.inject({
      method: 'GET',
      url: '/api/locations/999999/history',
      headers: authHeader(context.adminToken),
    });
    assert.equal(missing.statusCode, 404);
  });
});
