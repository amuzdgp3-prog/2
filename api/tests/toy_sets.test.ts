import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, createToy, installTestMachine, pool, type TestContext } from './helpers.js';

describe('toy management: catalogue, sets, individual and bulk assignment', () => {
  let context: TestContext;
  let toyBear: number;
  let toyUnicorn: number;

  before(async () => {
    context = await bootstrap();
    toyBear = await createToy(context, 'Мишка малый', '18.00');
    toyUnicorn = await createToy(context, 'Единорог средний', '34.00');
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('edits and deactivates a toy without deleting it', async () => {
    const patched = await context.app.inject({
      method: 'PATCH',
      url: `/api/toys/${toyBear}`,
      headers: authHeader(context.adminToken),
      payload: { unitCost: '20.00' },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().unit_cost, '20.00');

    const deactivated = await context.app.inject({
      method: 'PATCH',
      url: `/api/toys/${toyBear}`,
      headers: authHeader(context.adminToken),
      payload: { isActive: false },
    });
    assert.equal(deactivated.json().is_active, false);

    const listed = await context.app.inject({
      method: 'GET',
      url: '/api/toys',
      headers: authHeader(context.adminToken),
    });
    assert.ok(
      listed.json().some((t: { id: number }) => t.id === toyBear),
      'a deactivated toy is not deleted, only hidden from active use',
    );

    await context.app.inject({
      method: 'PATCH',
      url: `/api/toys/${toyBear}`,
      headers: authHeader(context.adminToken),
      payload: { isActive: true },
    });
  });

  it('creates a named set and lists its items', async () => {
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/toy-sets',
      headers: authHeader(context.adminToken),
      payload: {
        name: 'Стандартный набор',
        items: [{ toyId: toyBear, quantity: 40 }, { toyId: toyUnicorn, quantity: 15 }],
      },
    });
    assert.equal(created.statusCode, 200);

    const list = await context.app.inject({
      method: 'GET',
      url: '/api/toy-sets',
      headers: authHeader(context.adminToken),
    });
    const set = list.json().find((s: { name: string }) => s.name === 'Стандартный набор');
    assert.equal(set.items.length, 2);
    assert.ok(set.items.some((i: { toyId: number; quantity: number }) => i.toyId === toyBear && i.quantity === 40));
  });

  it('replaces a set\'s items on update rather than appending', async () => {
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/toy-sets',
      headers: authHeader(context.adminToken),
      payload: { name: 'Малый набор', items: [{ toyId: toyBear, quantity: 10 }] },
    });
    const setId = created.json().id;

    await context.app.inject({
      method: 'PATCH',
      url: `/api/toy-sets/${setId}`,
      headers: authHeader(context.adminToken),
      payload: { items: [{ toyId: toyUnicorn, quantity: 5 }] },
    });

    const list = await context.app.inject({
      method: 'GET',
      url: '/api/toy-sets',
      headers: authHeader(context.adminToken),
    });
    const set = list.json().find((s: { id: number }) => s.id === setId);
    assert.equal(set.items.length, 1);
    assert.equal(set.items[0].toyId, toyUnicorn);
  });

  it('assigns a set to a single machine and exposes it through /api/machines', async () => {
    await installTestMachine(context, { machineNumber: 'TOY-1', pricePerGame: 10 });
    const set = await context.app.inject({
      method: 'POST',
      url: '/api/toy-sets',
      headers: authHeader(context.adminToken),
      payload: { name: 'Набор для TOY-1', items: [{ toyId: toyBear, quantity: 25 }] },
    });

    const assigned = await context.app.inject({
      method: 'POST',
      url: '/api/machines/TOY-1/toy-set',
      headers: authHeader(context.adminToken),
      payload: { setId: set.json().id },
    });
    assert.equal(assigned.statusCode, 200);

    const machines = await context.app.inject({
      method: 'GET',
      url: '/api/machines',
      headers: authHeader(context.adminToken),
    });
    const row = machines.json().find((m: { machine_number: string }) => m.machine_number === 'TOY-1');
    assert.equal(row.default_toy_set_id, set.json().id);
    assert.equal(row.default_toy_set_name, 'Набор для TOY-1');
    assert.deepEqual(row.default_toy_set_items, { [toyBear]: 25 });

    const audit = await pool.query(
      `SELECT context ->> 'reason' AS reason FROM audit_log
       WHERE entity = 'machine' AND entity_id = 'TOY-1' AND context ->> 'reason' = 'default_toy_set_changed'`,
    );
    assert.equal(audit.rows.length, 1);
  });

  it('refuses a bulk apply with no filter, and applies correctly with one', async () => {
    await installTestMachine(context, { machineNumber: 'TOY-2', pricePerGame: 10 });
    await installTestMachine(context, { machineNumber: 'TOY-3', pricePerGame: 10 });
    const set = await context.app.inject({
      method: 'POST',
      url: '/api/toy-sets',
      headers: authHeader(context.adminToken),
      payload: { name: 'Массовый набор', items: [{ toyId: toyUnicorn, quantity: 12 }] },
    });
    const setId = set.json().id;

    const noFilter = await context.app.inject({
      method: 'POST',
      url: `/api/toy-sets/${setId}/apply-bulk`,
      headers: authHeader(context.adminToken),
      payload: {},
    });
    assert.equal(noFilter.statusCode, 400);
    assert.equal(noFilter.json().error, 'FILTER_REQUIRED');

    const byList = await context.app.inject({
      method: 'POST',
      url: `/api/toy-sets/${setId}/apply-bulk`,
      headers: authHeader(context.adminToken),
      payload: { machineNumbers: ['TOY-2', 'TOY-3'] },
    });
    assert.equal(byList.statusCode, 200);
    assert.equal(byList.json().updated, 2);

    const machines = await context.app.inject({
      method: 'GET',
      url: '/api/machines',
      headers: authHeader(context.adminToken),
    });
    const rows = machines.json() as Array<{ machine_number: string; default_toy_set_id: number | null }>;
    assert.equal(rows.find((m) => m.machine_number === 'TOY-2')?.default_toy_set_id, setId);
    assert.equal(rows.find((m) => m.machine_number === 'TOY-3')?.default_toy_set_id, setId);

    const audit = await pool.query(
      `SELECT COUNT(*)::int AS count FROM audit_log
       WHERE entity = 'machine' AND context ->> 'reason' = 'default_toy_set_bulk_applied'`,
    );
    assert.equal(audit.rows[0].count, 2, 'each affected machine gets its own audit row');
  });

  it('boss cannot manage toys or sets', async () => {
    const attempt = await context.app.inject({
      method: 'POST',
      url: '/api/toy-sets',
      headers: authHeader(context.bossToken),
      payload: { name: 'x', items: [] },
    });
    assert.equal(attempt.statusCode, 403);
  });
});
