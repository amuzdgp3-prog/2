import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, createToy, installTestMachine, pool, type TestContext } from './helpers.js';

/** Backend support for the admin "machine card" screen (docs/design/mockups/06): routes, toys, technicians tabs. */
describe('machine card tabs: routes, initial toys, technicians', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('lists and unassigns the routes a machine belongs to', async () => {
    await installTestMachine(context, { machineNumber: 'MC-1', pricePerGame: 10 });
    const route = await context.app.inject({
      method: 'POST',
      url: '/api/routes',
      headers: authHeader(context.adminToken),
      payload: { name: 'Маршрут 1' },
    });

    await context.app.inject({
      method: 'POST',
      url: '/api/routes/assign',
      headers: authHeader(context.adminToken),
      payload: { machineNumber: 'MC-1', routeId: route.json().id },
    });

    const listed = await context.app.inject({
      method: 'GET',
      url: '/api/machines/MC-1/routes',
      headers: authHeader(context.adminToken),
    });
    assert.equal(listed.json().length, 1);
    assert.equal(listed.json()[0].name, 'Маршрут 1');

    const unassigned = await context.app.inject({
      method: 'DELETE',
      url: '/api/routes/assign',
      headers: authHeader(context.adminToken),
      payload: { machineNumber: 'MC-1', routeId: route.json().id },
    });
    assert.equal(unassigned.statusCode, 200);

    const afterRemoval = await context.app.inject({
      method: 'GET',
      url: '/api/machines/MC-1/routes',
      headers: authHeader(context.adminToken),
    });
    assert.equal(afterRemoval.json().length, 0);

    const audit = await pool.query(
      `SELECT action FROM audit_log WHERE entity = 'machine_route' AND entity_id LIKE 'MC-1:%' ORDER BY id`,
    );
    assert.deepEqual(audit.rows.map((row) => row.action), ['INSERT', 'DELETE']);
  });

  it('returns the initial toys of the active placement', async () => {
    const toyId = await createToy(context, 'Единорог средний', '34.00');
    await installTestMachine(context, {
      machineNumber: 'MC-2',
      pricePerGame: 10,
      initialToys: [{ toyId, quantity: 15 }],
    });

    const toys = await context.app.inject({
      method: 'GET',
      url: '/api/machines/MC-2/initial-toys',
      headers: authHeader(context.adminToken),
    });
    assert.deepEqual(toys.json(), [
      { toy_id: toyId, name: 'Единорог средний', quantity: 15, unit_cost_snapshot: '34.00' },
    ]);
  });

  it('lists technicians reachable via location scope and via point assignment', async () => {
    const { locationId } = await installTestMachine(context, { machineNumber: 'MC-3', pricePerGame: 10 });
    await installTestMachine(context, { machineNumber: 'MC-4', pricePerGame: 10 });

    // context.technicianId gets scope to MC-3's location; a second technician gets point access to MC-4 only.
    await context.app.inject({
      method: 'POST',
      url: '/api/staff/scope',
      headers: authHeader(context.adminToken),
      payload: { staffId: context.technicianId, locationId },
    });

    const pointTech = await context.app.inject({
      method: 'POST',
      url: '/api/staff',
      headers: authHeader(context.adminToken),
      payload: { login: 'point-tech', fullName: 'Точечный техник', role: 'TECHNICIAN', password: 'x' },
    });
    await context.app.inject({
      method: 'POST',
      url: '/api/staff/scope',
      headers: authHeader(context.adminToken),
      payload: { staffId: pointTech.json().id, machineNumber: 'MC-4' },
    });

    const forMC3 = await context.app.inject({
      method: 'GET',
      url: '/api/machines/MC-3/technicians',
      headers: authHeader(context.adminToken),
    });
    const namesMC3 = (forMC3.json() as Array<{ full_name: string; source: string }>).map((r) => r.full_name);
    assert.ok(namesMC3.includes('tech'), 'the location-scoped technician must see MC-3');

    const forMC4 = await context.app.inject({
      method: 'GET',
      url: '/api/machines/MC-4/technicians',
      headers: authHeader(context.adminToken),
    });
    const rowsMC4 = forMC4.json() as Array<{ full_name: string; source: string }>;
    assert.ok(rowsMC4.some((r) => r.full_name === 'Точечный техник' && r.source === 'machine'));
    assert.ok(!rowsMC4.some((r) => r.full_name === 'tech'), 'scope on MC-3 location must not leak into MC-4');
  });
});
