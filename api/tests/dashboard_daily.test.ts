import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadDailySummary } from '../src/domain/dailySummary.js';
import { authHeader, bootstrap, installTestMachine, pool, postService, type TestContext } from './helpers.js';

describe('admin live daily summary', () => {
  let context: TestContext;
  const get = (token: string) => context.app.inject({
    method: 'GET', url: '/api/admin/daily-summary', headers: authHeader(token),
  });
  before(async () => { context = await bootstrap(); });
  after(async () => { await context.app.close(); await pool.end(); });

  it('only ADMIN may read the global technician list', async () => {
    assert.equal((await get(context.technicianToken)).statusCode, 403);
    assert.equal((await get(context.bossToken)).statusCode, 403);
    assert.equal((await context.app.inject({ method: 'GET', url: '/api/admin/daily-summary' })).statusCode, 401);
  });

  it('returns an empty Moscow day without sending messages', async () => {
    const response = await get(context.adminToken);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), {
      date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()),
      technicians: [],
    });
  });

  it('reflects new services, preserves cents/negative cash and matches Telegram data', async () => {
    await pool.query('UPDATE staff SET is_field_technician = true WHERE id = $1', [context.technicianId]);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
    for (const [i, machine] of ['DAY-1', 'DAY-2'].entries()) {
      await installTestMachine(context, { machineNumber: machine, pricePerGame: 100, initialGameCounter: 0 });
      const service = await postService(context, context.adminToken, machine, {
        gameCounter: 10, prizeCounter: 0, occurredAt: new Date(Date.now() - (2 - i) * 3_600_000).toISOString(),
      });
      assert.equal(service.status, 200, JSON.stringify(service.body));
      await pool.query(`UPDATE services SET technician_id = $1, service_date = $2, cashless_amount = $3
        WHERE machine_number = $4`, [context.technicianId, date, i === 0 ? '1200.25' : '300.50', machine]);
      const response = await get(context.adminToken);
      const body = response.json();
      assert.equal(body.technicians.length, 1);
      assert.equal(body.technicians[0].machines, i + 1);
      assert.equal(body.technicians[0].cash, i === 0 ? -200.25 : 499.25);
      assert.equal(body.technicians[0].cashless, i === 0 ? 1200.25 : 1500.75);
      const client = await pool.connect();
      try { assert.deepEqual(body, await loadDailySummary(client, date)); }
      finally { client.release(); }
    }
    // A service by the administrative account must not enter the field technicians' report.
    await installTestMachine(context, { machineNumber: 'DAY-ADMIN', pricePerGame: 100 });
    assert.equal((await postService(context, context.adminToken, 'DAY-ADMIN', {
      gameCounter: 20, prizeCounter: 0, occurredAt: new Date(Date.now() - 60_000).toISOString(),
    })).status, 200);
    assert.equal((await get(context.adminToken)).json().technicians[0].machines, 2);
    const outbox = await pool.query("SELECT count(*)::int AS n FROM telegram_outbox WHERE payload->>'text' LIKE '📋 Итоги дня%'");
    assert.equal(outbox.rows[0].n, 0);
  });
});
