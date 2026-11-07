import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { authHeader, bootstrap, createStaff, installTestMachine, pool, type TestContext } from './helpers.js';

describe('cash bag reconciliation', () => {
  let ctx: TestContext;
  let placementId: number;
  let otherId: number;
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) => ctx.app.inject({
    method, url, headers: authHeader(token ?? ctx.adminToken), ...(payload === undefined ? {} : { payload }),
  });
  const preview = async (to = '2026-11-02', technicianId?: number) => {
    const response = await call('GET', `/api/cash-collections/preview?technicianId=${technicianId ?? ctx.technicianId}&to=${to}`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const save = async (to = '2026-11-02', technicianId?: number) => {
    const data = await preview(to, technicianId);
    const response = await call('POST', '/api/cash-collections', { technicianId: technicianId ?? ctx.technicianId, to, receivedOn: '2026-11-04', token: data.token });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const service = async (date: string, revenue: string, cashless = '0', staffId?: number) => pool.query(
    `INSERT INTO services (local_id,placement_id,machine_number,service_date,occurred_at,technician_id,
      game_counter,prize_counter,new_games,new_prizes,price_per_game_snapshot,revenue,cashless_amount,photo_object_key)
     VALUES ($1,$2,'COLLECT',$3,$3::date+interval '10 hours',$4,1000,0,1000,0,100,$5,$6,'test.jpg')`,
    [randomUUID(), placementId, date, staffId ?? ctx.technicianId, revenue, cashless],
  );
  const expense = async (date: string, category: string, amount: string, source = 'TECHNICIAN', staffId?: number) => pool.query(
    `INSERT INTO business_expenses (expense_date,category,amount,source,staff_id,created_by,comment)
     VALUES ($1,$2,$3,$4,$5,$5,'fixture') RETURNING id`, [date, category, amount, source, staffId ?? ctx.technicianId],
  );
  before(async () => {
    // This suite deliberately rebuilds a schema. Also verify isolation before invoking the suite;
    // a test-like name alone is not proof that a database has no user data.
    const db = new URL(process.env.DATABASE_URL!);
    assert.match(db.pathname, /^\/(?:cash_collections_test_[a-z0-9_]+|apixspb_test)$/);
    assert.ok(['127.0.0.1', 'localhost'].includes(db.hostname));
    const identity = await pool.query('SELECT current_database() AS name');
    assert.equal('/' + identity.rows[0].name, db.pathname);
    ctx = await bootstrap();
    otherId = await createStaff('other', 'TECHNICIAN');
    placementId = (await installTestMachine(ctx, { machineNumber: 'COLLECT', pricePerGame: 100 })).placementId;
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE cash_collections, services, business_expenses RESTART IDENTITY CASCADE');
  });
  after(async () => { await ctx?.app.close(); await pool.end(); });

  it('starts on November 1, counts inclusive dates, cash only and own technician expenses', async () => {
    await service('2026-10-31', '99999');
    await service('2026-11-01', '80000', '10000');
    await service('2026-11-02', '40000', '10000');
    await service('2026-11-03', '90000');
    await service('2026-11-04', '77777', '0', otherId);
    await expense('2026-11-01', 'SALARY', '35000');
    await expense('2026-11-02', 'FUEL', '10000');
    await expense('2026-11-02', 'OTHER', '5000');
    await expense('2026-11-02', 'OTHER', '999', 'ADMIN');
    await expense('2026-11-02', 'OTHER', '888', 'TECHNICIAN', otherId);
    const data = await preview();
    assert.equal(data.from, '2026-11-01');
    assert.equal(data.cash, '100000.00');
    assert.equal(data.expected, '50000.00');
    assert.equal(data.services.length, 2);
    assert.equal(data.expenses.length, 3);
  });

  it('starts the next period after the saved cutoff independently for each technician', async () => {
    await service('2026-11-01', '1000');
    await service('2026-11-02', '2000');
    await save('2026-11-01');
    const data = await preview();
    assert.equal(data.from, '2026-11-02');
    assert.equal(data.expected, '2000.00');
    assert.equal((await preview('2026-11-02', otherId)).from, '2026-11-01');
  });

  it('updates open-period tile totals after services and expenses', async () => {
    const read = async () => (await call('GET', '/api/cash-collections')).json().technicians
      .find((row: { id: number }) => row.id === ctx.technicianId).current;
    assert.deepEqual(await read(), { id: ctx.technicianId, from: '2026-11-01', cash: '0.00',
      expenses: '0.00', adjustment: '0.00', expected: '0.00' });
    await service('2026-11-01', '1000');
    await expense('2026-11-01', 'FUEL', '150');
    assert.equal((await read()).cash, '1000.00');
    assert.equal((await read()).expected, '850.00');
    await save('2026-11-01');
    assert.equal((await read()).from, '2026-11-02');
    assert.equal((await read()).cash, '0.00');
  });

  it('records the counted amount together with a handover', async () => {
    await service('2026-11-01', '1000');
    const data = await preview('2026-11-01');
    const response = await call('POST', '/api/cash-collections', {
      technicianId: ctx.technicianId, to: data.to, receivedOn: data.to, token: data.token,
      actual: '900.00', comment: 'Пересчитано при получении',
    });
    assert.equal(response.statusCode, 200, response.body);
    const overview = (await call('GET', '/api/cash-collections')).json();
    assert.equal(overview.history[0].difference, '-100.00');
    assert.equal(overview.history[0].comment, 'Пересчитано при получении');
    assert.ok(overview.history[0].counted_at);
    assert.equal((await call('POST', `/api/cash-collections/${response.json().id}/count`, { actual: '900', comment: '' })).statusCode, 409);
  });

  it('uses the technician app day-close and item expenses without duplicating repeated salary submissions', async () => {
    await service('2026-11-01', '10000');
    for (const salary of ['5000', '4000']) {
      const response = await call('POST', '/api/day-close', { workDate: '2026-11-01', salary, fuel: '500' }, ctx.technicianToken);
      assert.equal(response.statusCode, 200, response.body);
    }
    const response = await call('POST', '/api/day-close/other', { workDate: '2026-11-01', amount: '300', comment: 'Парковка' }, ctx.technicianToken);
    assert.equal(response.statusCode, 200, response.body);
    const data = await preview();
    assert.equal(data.salary, '4000.00');
    assert.equal(data.fuel, '500.00');
    assert.equal(data.other, '300.00');
    assert.equal(data.expected, '5200.00');
    assert.equal(data.expenses.length, 3);
  });

  it('records actual cash and shortage once without carrying a technician debt', async () => {
    await service('2026-11-01', '1000');
    const row = await save('2026-11-01');
    let response = await call('POST', `/api/cash-collections/${row.id}/count`, { actual: '900', comment: 'Проверить' });
    assert.equal(response.statusCode, 200, response.body);
    response = await call('POST', `/api/cash-collections/${row.id}/count`, { actual: '900', comment: '' });
    assert.equal(response.statusCode, 409);
    const overview = (await call('GET', '/api/cash-collections')).json();
    assert.equal(overview.history[0].difference, '-100.00');
    assert.equal(overview.history[0].comment, 'Проверить');
    assert.equal((await preview()).expected, '0.00');
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE entity='cash_collection'")).rows[0].n >= 2, true);
  });

  it('freezes the bag and applies a late expense exactly once as a visible correction', async () => {
    await service('2026-11-01', '1000');
    const first = await save('2026-11-01');
    await expense('2026-11-01', 'OTHER', '100');
    await service('2026-11-02', '500');
    const data = await preview();
    assert.equal(data.adjustment, '-100.00');
    assert.equal(data.expected, '400.00');
    assert.equal(data.corrections[0].delta, '-100.00');
    await save();
    assert.equal((await preview('2026-11-03')).adjustment, '0.00');
    const overview = (await call('GET', '/api/cash-collections')).json();
    const old = overview.history.find((row: { id: number }) => row.id === first.id);
    assert.equal(old.expected, '1000.00');
    assert.equal(old.snapshot.expenses.length, 0);
    assert.equal(old.source_delta, '-100.00');
  });

  it('invalidates a preview if new or edited entries arrive', async () => {
    await service('2026-11-01', '1000');
    const data = await preview();
    await expense('2026-11-02', 'OTHER', '1');
    const response = await call('POST', '/api/cash-collections', { technicianId: ctx.technicianId, to: data.to, receivedOn: data.to, token: data.token });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'PREVIEW_CHANGED');
  });

  it('serialises simultaneous duplicate handovers', async () => {
    const data = await preview();
    const body = { technicianId: ctx.technicianId, to: data.to, receivedOn: data.to, token: data.token };
    const responses = await Promise.all([call('POST', '/api/cash-collections', body), call('POST', '/api/cash-collections', body)]);
    assert.deepEqual(responses.map(row => row.statusCode).sort(), [200, 409]);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM cash_collections')).rows[0].n, 1);
  });

  it('rejects closed, pre-start, future and invalid dates and receipt before cutoff', async () => {
    for (const to of ['2026-10-31', '2026-11-31', '2099-01-01', 'nonsense']) {
      assert.equal((await call('GET', `/api/cash-collections/preview?technicianId=${ctx.technicianId}&to=${to}`)).statusCode, 400);
    }
    const data = await preview();
    assert.equal((await call('POST', '/api/cash-collections', { technicianId: ctx.technicianId, to: data.to, receivedOn: '2026-11-01', token: data.token })).statusCode, 400);
    await save();
    assert.equal((await call('GET', `/api/cash-collections/preview?technicianId=${ctx.technicianId}&to=2026-11-01`)).statusCode, 409);
  });

  it('rejects invalid count amounts, accepts zero, and keeps positive surplus', async () => {
    const row = await save();
    for (const actual of ['-1', 'NaN', '1.234', '1e5', '', '1000000000000']) {
      assert.equal((await call('POST', `/api/cash-collections/${row.id}/count`, { actual, comment: '' })).statusCode, 400);
    }
    assert.equal((await call('POST', `/api/cash-collections/${row.id}/count`, { actual: '0', comment: '' })).statusCode, 200);
    const second = await save('2026-11-03');
    await call('POST', `/api/cash-collections/${second.id}/count`, { actual: '0.01', comment: '' });
    assert.equal((await call('GET', '/api/cash-collections')).json().history[0].difference, '0.01');
  });

  it('keeps negative cash anomalies visible and blocks a negative bag', async () => {
    await service('2026-11-01', '100', '150');
    const data = await preview();
    assert.equal(data.cash, '-50.00');
    const response = await call('POST', '/api/cash-collections', { technicianId: ctx.technicianId, to: data.to, receivedOn: data.to, token: data.token });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'NEGATIVE_BAG');
  });

  it('handles deleted historical expenses and fractional kopecks without double correction', async () => {
    await service('2026-11-01', '1.03');
    const e = await expense('2026-11-01', 'OTHER', '0.02');
    assert.equal((await save('2026-11-01')).expected, '1.01');
    await pool.query('DELETE FROM business_expenses WHERE id=$1', [e.rows[0].id]);
    assert.equal((await preview()).adjustment, '0.02');
    await save();
    assert.equal((await preview('2026-11-03')).expected, '0.00');
  });

  it('denies technicians, bosses and anonymous users on all routes', async () => {
    for (const token of [ctx.technicianToken, ctx.bossToken]) {
      for (const [method, url, body] of [
        ['GET', '/api/cash-collections', undefined],
        ['GET', `/api/cash-collections/preview?technicianId=${ctx.technicianId}&to=2026-11-02`, undefined],
        ['POST', '/api/cash-collections', { technicianId: ctx.technicianId, to: '2026-11-02', receivedOn: '2026-11-02', token: 'x' }],
        ['POST', '/api/cash-collections/1/count', { actual: '0', comment: '' }],
      ] as const) assert.equal((await call(method, url, body, token)).statusCode, 403);
    }
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/cash-collections' })).statusCode, 401);
  });

  it('retains inactive technicians and their history without mixing equal names', async () => {
    await save();
    await pool.query('UPDATE staff SET full_name=(SELECT full_name FROM staff WHERE id=$1) WHERE id=$2', [ctx.technicianId, otherId]);
    await pool.query('UPDATE staff SET is_active=false,is_field_technician=false WHERE id=$1', [ctx.technicianId]);
    const overview = (await call('GET', '/api/cash-collections')).json();
    assert.ok(overview.technicians.some((row: { id: number }) => row.id === ctx.technicianId));
    assert.equal(overview.history[0].technician_id, ctx.technicianId);
    assert.equal(overview.technicians.filter((row: { full_name: string }) => row.full_name === overview.history[0].full_name).length, 2);
    assert.equal((await preview('2026-11-03')).expected, '0.00');
  });
});
