import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, postService, type TestContext } from './helpers.js';

/** Backend support for the admin "service log" screen (docs/design/mockups/07): filters + pagination. */
describe('service log filters and pagination', () => {
  let context: TestContext;
  let locationA: number;
  let locationB: number;

  before(async () => {
    context = await bootstrap();

    const a = await installTestMachine(context, { machineNumber: 'LOG-1', pricePerGame: 10 });
    locationA = a.locationId;
    const b = await installTestMachine(context, { machineNumber: 'LOG-2', pricePerGame: 10, locationId: undefined });
    locationB = b.locationId;

    for (let i = 0; i < 3; i += 1) {
      await postService(context, context.adminToken, 'LOG-1', {
        gameCounter: (i + 1) * 100,
        prizeCounter: 0,
        occurredAt: `2026-05-0${i + 1}T10:00:00Z`,
      });
    }
    await postService(context, context.adminToken, 'LOG-2', {
      gameCounter: 50,
      prizeCounter: 0,
      occurredAt: '2026-05-01T10:00:00Z',
    });
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('paginates and reports the total independent of the page size', async () => {
    const page1 = await context.app.inject({
      method: 'GET',
      url: '/api/services?limit=2&offset=0',
      headers: authHeader(context.adminToken),
    });
    const body1 = page1.json();
    assert.equal(body1.rows.length, 2);
    assert.equal(body1.total, 4);

    const page2 = await context.app.inject({
      method: 'GET',
      url: '/api/services?limit=2&offset=2',
      headers: authHeader(context.adminToken),
    });
    assert.equal(page2.json().rows.length, 2);
    assert.equal(page2.json().total, 4);
  });

  it('filters by location, including the subtree', async () => {
    const child = await context.app.inject({
      method: 'POST',
      url: '/api/locations',
      headers: authHeader(context.adminToken),
      payload: { name: 'Вложенная точка', timezone: 'Europe/Moscow', parentId: locationA },
    });
    await installTestMachine(context, {
      machineNumber: 'LOG-3',
      pricePerGame: 10,
      locationId: child.json().id,
    });
    await postService(context, context.adminToken, 'LOG-3', {
      gameCounter: 10,
      prizeCounter: 0,
      occurredAt: '2026-05-04T10:00:00Z',
    });

    const filtered = await context.app.inject({
      method: 'GET',
      url: `/api/services?locationId=${locationA}`,
      headers: authHeader(context.adminToken),
    });
    const machineNumbers = filtered.json().rows.map((row: { machine_number: string }) => row.machine_number);
    assert.ok(machineNumbers.includes('LOG-1'));
    assert.ok(machineNumbers.includes('LOG-3'), 'the subtree location must be included');
    assert.ok(!machineNumbers.includes('LOG-2'));
    void locationB;
  });

  it('filters by free-text search across machine number, model and location name', async () => {
    const bySearch = await context.app.inject({
      method: 'GET',
      url: '/api/services?search=LOG-2',
      headers: authHeader(context.adminToken),
    });
    const rows = bySearch.json().rows as Array<{ machine_number: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].machine_number, 'LOG-2');
  });

  it('filters by technician', async () => {
    await context.app.inject({
      method: 'POST',
      url: '/api/staff/scope',
      headers: authHeader(context.adminToken),
      payload: { staffId: context.technicianId, locationId: locationA },
    });

    const asTechnician = await postService(context, context.technicianToken, 'LOG-1', {
      gameCounter: 500,
      prizeCounter: 0,
      occurredAt: '2026-05-10T10:00:00Z',
    });
    void asTechnician;

    const filtered = await context.app.inject({
      method: 'GET',
      url: `/api/services?technicianId=${context.technicianId}`,
      headers: authHeader(context.adminToken),
    });
    const rows = filtered.json().rows as Array<{ technician_name: string }>;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.technician_name === 'tech'));
  });
});
