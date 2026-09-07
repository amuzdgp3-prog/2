import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, postService, type TestContext } from './helpers.js';

/**
 * Regression test for a real production incident: a machine moved to a new placement, then an
 * admin corrected a typo in the OLD (now closed) placement's last service counter. The new
 * placement's initial_game_counter had been snapshotted from that service at move time and went
 * stale, silently producing a negative new-games calculation on the technician's next service.
 * updateService must cascade the correction into the next placement's initial counters when it's
 * still safe to do so (no services recorded in it yet), and must NOT touch it once it already has
 * services of its own (that would require a full recalculation, not a bare counter overwrite).
 */
describe('correcting a service counter cascades to the next placement it fed', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('updates the next placement initial counters when it has no services yet', async () => {
    const { locationId } = await installTestMachine(context, {
      machineNumber: 'CC-1',
      pricePerGame: 10,
      initialGameCounter: 0,
      initialPrizeCounter: 0,
    });
    const otherLocation = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'CC-1 elsewhere', timezone: 'Europe/Moscow' },
    });

    // The "typo": 1000 instead of the intended 100.
    const typoService = await postService(context, context.adminToken, 'CC-1', {
      gameCounter: 1000, prizeCounter: 0, occurredAt: '2026-06-01T10:00:00Z',
    });
    assert.equal(typoService.status, 200);
    const serviceId = typoService.body.service.id;

    const move = await context.app.inject({
      method: 'POST', url: '/api/machines/CC-1/move', headers: authHeader(context.adminToken),
      payload: { locationId: otherLocation.json().id, movedAt: '2026-06-05T00:00:00Z' },
    });
    assert.equal(move.statusCode, 200);

    // Sanity check: the new placement snapshotted the (still wrong) 1000, same as move_machine.test.ts asserts.
    const machinesBefore = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(context.adminToken),
    });
    const before1 = machinesBefore.json().find((m: { machine_number: string }) => m.machine_number === 'CC-1');
    assert.equal(Number(before1.previous_game_counter), 1000);

    // Fix the typo on the old, closed placement's service.
    const fix = await context.app.inject({
      method: 'PATCH', url: `/api/services/${serviceId}`, headers: authHeader(context.adminToken),
      payload: { gameCounter: 100 },
    });
    assert.equal(fix.statusCode, 200);

    // The new (still service-less) placement's initial counter must now reflect the fix, not the stale 1000.
    const machinesAfter = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(context.adminToken),
    });
    const after1 = machinesAfter.json().find((m: { machine_number: string }) => m.machine_number === 'CC-1');
    assert.equal(Number(after1.previous_game_counter), 100, 'cascaded to the next placement, not left stale at 1000');

    // And the fix must be usable immediately: a new service posted now must not go negative.
    const nextService = await postService(context, context.adminToken, 'CC-1', {
      gameCounter: 150, prizeCounter: 0, occurredAt: '2026-06-06T10:00:00Z',
    });
    assert.equal(nextService.status, 200, JSON.stringify(nextService.body));
  });

  it('does NOT touch the next placement once it already has services of its own', async () => {
    const { locationId } = await installTestMachine(context, {
      machineNumber: 'CC-2',
      pricePerGame: 10,
      initialGameCounter: 0,
      initialPrizeCounter: 0,
    });
    const otherLocation = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'CC-2 elsewhere', timezone: 'Europe/Moscow' },
    });

    const typoService = await postService(context, context.adminToken, 'CC-2', {
      gameCounter: 1000, prizeCounter: 0, occurredAt: '2026-06-01T10:00:00Z',
    });
    const serviceId = typoService.body.service.id;

    await context.app.inject({
      method: 'POST', url: '/api/machines/CC-2/move', headers: authHeader(context.adminToken),
      payload: { locationId: otherLocation.json().id, movedAt: '2026-06-05T00:00:00Z' },
    });

    // The new placement already gets a real service of its own before the old typo is fixed.
    const realService = await postService(context, context.adminToken, 'CC-2', {
      gameCounter: 1100, prizeCounter: 0, occurredAt: '2026-06-10T10:00:00Z',
    });
    assert.equal(realService.status, 200);

    const machinesBefore = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(context.adminToken),
    });
    const initialCounterBefore = machinesBefore.json()
      .find((m: { machine_number: string }) => m.machine_number === 'CC-2');

    const fix = await context.app.inject({
      method: 'PATCH', url: `/api/services/${serviceId}`, headers: authHeader(context.adminToken),
      payload: { gameCounter: 100 },
    });
    assert.equal(fix.statusCode, 200);

    // The already-serviced next placement's chain was built on the old snapshot; the cascade must
    // leave it alone rather than silently rewriting a value real revenue was already computed from.
    const row = await pool.query(
      'SELECT initial_game_counter FROM machine_placements WHERE machine_number = $1 AND ended_at IS NULL',
      ['CC-2'],
    );
    assert.equal(Number(row.rows[0].initial_game_counter), 1000, 'left alone once the placement has its own history');
    void initialCounterBefore;
  });
});
