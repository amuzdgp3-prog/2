import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  authHeader,
  bootstrap,
  installTestMachine,
  pool,
  postService,
  type TestContext,
} from './helpers.js';

/**
 * Verifies fixes made in response to the user's hands-on feedback on the admin panel:
 * scope visibility/revocation, and price/divisor being a snapshot rather than something that
 * rewrites already-recorded revenue.
 */
describe('admin panel feedback fixes', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('shows an empty scope by default and reflects grants/revocations immediately', async () => {
    const empty = await context.app.inject({
      method: 'GET',
      url: `/api/staff/${context.technicianId}/scope`,
      headers: authHeader(context.adminToken),
    });
    assert.deepEqual(empty.json(), { locations: [], classifiers: [], machines: [], reachableMachines: [] });

    const { locationId } = await installTestMachine(context, {
      machineNumber: 'F-1',
      pricePerGame: 10,
    });

    const granted = await context.app.inject({
      method: 'POST',
      url: '/api/staff/scope',
      headers: authHeader(context.adminToken),
      payload: { staffId: context.technicianId, locationId },
    });
    assert.equal(granted.statusCode, 200);

    const afterGrant = await context.app.inject({
      method: 'GET',
      url: `/api/staff/${context.technicianId}/scope`,
      headers: authHeader(context.adminToken),
    });
    assert.deepEqual(afterGrant.json().reachableMachines, ['F-1']);
    assert.equal(afterGrant.json().locations[0].id, locationId);

    const revoked = await context.app.inject({
      method: 'DELETE',
      url: '/api/staff/scope',
      headers: authHeader(context.adminToken),
      payload: { staffId: context.technicianId, locationId },
    });
    assert.equal(revoked.statusCode, 200);

    const afterRevoke = await context.app.inject({
      method: 'GET',
      url: `/api/staff/${context.technicianId}/scope`,
      headers: authHeader(context.adminToken),
    });
    assert.deepEqual(afterRevoke.json().reachableMachines, []);

    const audit = await pool.query(
      `SELECT action FROM audit_log
       WHERE entity = 'staff_location_scope' AND entity_id = $1 ORDER BY id`,
      [`${context.technicianId}:${locationId}`],
    );
    assert.deepEqual(audit.rows.map((row) => row.action), ['INSERT', 'DELETE']);
  });

  it('a machine created for a technician stays invisible until scope is explicitly granted', async () => {
    await installTestMachine(context, { machineNumber: 'F-2', pricePerGame: 10 });

    const machines = await context.app.inject({
      method: 'GET',
      url: '/api/machines',
      headers: authHeader(context.technicianToken),
    });
    assert.ok(
      !(machines.json() as Array<{ machine_number: string }>).some((m) => m.machine_number === 'F-2'),
      'creating a machine must not implicitly grant technician visibility',
    );
  });

  it('changing price or divisor never rewrites revenue already recorded', async () => {
    await installTestMachine(context, {
      machineNumber: 'F-3',
      pricePerGame: 10,
      counterDivisor: 1,
      initialGameCounter: 0,
    });

    await postService(context, context.adminToken, 'F-3', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-03-01T10:00:00Z',
    });

    const patched = await context.app.inject({
      method: 'PATCH',
      url: '/api/machines/F-3',
      headers: authHeader(context.adminToken),
      payload: { pricePerGame: 20, counterDivisor: 5 },
    });
    assert.equal(patched.json().recalculated, 0);

    const stored = await pool.query(
      `SELECT revenue, price_per_game_snapshot, counter_divisor_applied
       FROM services WHERE machine_number = 'F-3'`,
    );
    assert.equal(stored.rows[0].revenue, '1000.00', 'past revenue must survive a later price change');
    assert.equal(stored.rows[0].price_per_game_snapshot, '10.00');
    assert.equal(stored.rows[0].counter_divisor_applied, '1.00');

    // The new settings apply starting with the next recorded service.
    const next = await postService(context, context.adminToken, 'F-3', {
      gameCounter: 600,
      prizeCounter: 0,
      occurredAt: '2026-03-08T10:00:00Z',
    });
    const nextService = (next.body as { service: Record<string, string> }).service;
    assert.equal(nextService.price_per_game_snapshot, '20.00');
    assert.equal(nextService.counter_divisor_applied, '5.00');
    assert.equal(nextService.new_games, '100.0000'); // (600-100)/5
    assert.equal(nextService.revenue, '2000.00');
  });

  it('only an explicit history-correction call changes already recorded revenue', async () => {
    await installTestMachine(context, {
      machineNumber: 'F-4',
      pricePerGame: 10,
      counterDivisor: 1,
      initialGameCounter: 0,
    });

    await postService(context, context.adminToken, 'F-4', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-03-01T10:00:00Z',
    });

    await context.app.inject({
      method: 'PATCH',
      url: '/api/machines/F-4',
      headers: authHeader(context.adminToken),
      payload: { counterDivisor: 2 },
    });

    const corrected = await context.app.inject({
      method: 'POST',
      url: '/api/machines/F-4/apply-divisor-to-history',
      headers: authHeader(context.adminToken),
      payload: {},
    });
    assert.equal(corrected.statusCode, 200);
    assert.equal(corrected.json().restamped, 1);

    const stored = await pool.query(
      `SELECT id, new_games, counter_divisor_applied FROM services WHERE machine_number = 'F-4'`,
    );
    assert.equal(stored.rows[0].new_games, '50.0000');
    assert.equal(stored.rows[0].counter_divisor_applied, '2.00');

    // The audit row for this restamp must record what the divisor actually was before the
    // correction, not an empty object — otherwise the audit log cannot answer "what changed".
    const audit = await pool.query(
      `SELECT old_data, new_data FROM audit_log
       WHERE entity = 'service' AND entity_id = $1 AND (context->>'reason') = 'counter_divisor_applied_to_history'
       ORDER BY id DESC LIMIT 1`,
      [String(stored.rows[0].id)],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].old_data.counter_divisor_applied, '1.00');
    assert.equal(audit.rows[0].new_data.counter_divisor_applied, '2.00');
  });
});
