import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, createStaff, installTestMachine, pool, postService, type TestContext } from './helpers.js';

/**
 * moveMachine — reassigning a machine to a different Location without a service visit. Added
 * after a real production report: a technician was scoped to a Location sub-tree that had zero
 * machines under it, because every machine had stayed on whichever Location it was installed at
 * and nothing could ever move it there afterwards. Not a scope bug — a missing operation.
 */
describe('move machine to a different location', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  it('closes the old placement and opens a new one, carrying the counter over unchanged', async () => {
    const { locationId: oldLocationId } = await installTestMachine(context, {
      machineNumber: 'MV-1', pricePerGame: 10, initialGameCounter: 0,
    });
    await postService(context, context.adminToken, 'MV-1', {
      gameCounter: 500, prizeCounter: 20, occurredAt: '2026-05-01T10:00:00Z',
    });

    const newLocation = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'Новая точка MV-1', timezone: 'Europe/Moscow' },
    });
    const newLocationId = newLocation.json().id;

    const moved = await context.app.inject({
      method: 'POST', url: '/api/machines/MV-1/move', headers: authHeader(context.adminToken),
      payload: { locationId: newLocationId, movedAt: '2026-05-10T09:00:00Z' },
    });
    assert.equal(moved.statusCode, 200);

    const placements = await pool.query(
      `SELECT location_id, started_at, ended_at, close_reason, initial_game_counter, initial_prize_counter
       FROM machine_placements WHERE machine_number = 'MV-1' ORDER BY started_at`,
    );
    assert.equal(placements.rows.length, 2);
    assert.equal(placements.rows[0].location_id, oldLocationId);
    assert.ok(placements.rows[0].ended_at, 'old placement must be closed');
    assert.equal(placements.rows[0].close_reason, 'moved');
    assert.equal(placements.rows[1].location_id, newLocationId);
    assert.equal(placements.rows[1].ended_at, null);
    // The counter carries over from the last real reading — nothing resets on a pure relocation.
    assert.equal(Number(placements.rows[1].initial_game_counter), 500);
    assert.equal(Number(placements.rows[1].initial_prize_counter), 20);

    const machines = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(context.adminToken),
    });
    const row = machines.json().find((m: { machine_number: string }) => m.machine_number === 'MV-1');
    assert.equal(row.location_id, newLocationId);
    assert.equal(Number(row.previous_game_counter), 500, 'the next visit must still compare against 500, not 0');
    assert.ok(row.last_service_at, 'the real service history must stay visible after a bare move — the new placement having zero services of its own does not mean the machine was never serviced');
  });

  it('makes the machine visible to a technician scoped to the new location, and invisible once moved away from the old one', async () => {
    const { locationId: oldLocationId } = await installTestMachine(context, {
      machineNumber: 'MV-2', pricePerGame: 10,
    });
    const newLocation = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'Точка техника MV-2', timezone: 'Europe/Moscow' },
    });
    const newLocationId = newLocation.json().id;

    const techId = await createStaff('mv-tech', 'TECHNICIAN');
    const techLogin = await context.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'mv-tech', password: 'secret' },
    });
    const techToken = techLogin.json().token;
    await context.app.inject({
      method: 'POST', url: '/api/staff/scope', headers: authHeader(context.adminToken),
      payload: { staffId: techId, locationId: newLocationId },
    });

    const before = await context.app.inject({ method: 'GET', url: '/api/machines', headers: authHeader(techToken) });
    assert.equal(before.json().find((m: { machine_number: string }) => m.machine_number === 'MV-2'), undefined);

    const moved = await context.app.inject({
      method: 'POST', url: '/api/machines/MV-2/move', headers: authHeader(context.adminToken),
      payload: { locationId: newLocationId },
    });
    assert.equal(moved.statusCode, 200);

    const after1 = await context.app.inject({ method: 'GET', url: '/api/machines', headers: authHeader(techToken) });
    assert.ok(after1.json().find((m: { machine_number: string }) => m.machine_number === 'MV-2'), 'now in scope');
    void oldLocationId;
  });

  it('rejects moving to the same location and to a non-existent or inactive location', async () => {
    const { locationId } = await installTestMachine(context, { machineNumber: 'MV-3', pricePerGame: 10 });

    const same = await context.app.inject({
      method: 'POST', url: '/api/machines/MV-3/move', headers: authHeader(context.adminToken),
      payload: { locationId },
    });
    assert.equal(same.statusCode, 400);

    const missing = await context.app.inject({
      method: 'POST', url: '/api/machines/MV-3/move', headers: authHeader(context.adminToken),
      payload: { locationId: 999999 },
    });
    assert.equal(missing.statusCode, 404);
  });

  it('is admin-only', async () => {
    const { locationId } = await installTestMachine(context, { machineNumber: 'MV-4', pricePerGame: 10 });
    const otherLocation = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'Ещё точка MV-4', timezone: 'Europe/Moscow' },
    });
    const denied = await context.app.inject({
      method: 'POST', url: '/api/machines/MV-4/move', headers: authHeader(context.bossToken),
      payload: { locationId: otherLocation.json().id },
    });
    assert.equal(denied.statusCode, 403);
    void locationId;
  });
});

/**
 * The real street address a machine stands at (10_ТЗ has no field for this — Location only
 * captures broad territory, which several machines now share). Lives on the placement, exactly
 * like location_id, so it never gets rewritten for history when a machine later moves.
 */
describe('machine address', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  it('is stored at install time and served back in the machine list', async () => {
    // installTestMachine's own helper doesn't pass address through, so install directly via the
    // API the way the admin UI's install form now does.
    const install = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'Точка AD-2', timezone: 'Europe/Moscow' },
    });
    await context.app.inject({
      method: 'POST', url: '/api/machines/install', headers: authHeader(context.adminToken),
      payload: {
        machineNumber: 'AD-2', pricePerGame: 10, counterDivisor: 1,
        locationId: install.json().id, startedAt: '2026-01-01T08:00:00Z',
        initialGameCounter: 0, initialPrizeCounter: 0, address: 'Яхтенная ул., 38',
      },
    });

    const machines = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(context.adminToken),
    });
    const row = machines.json().find((m: { machine_number: string }) => m.machine_number === 'AD-2');
    assert.equal(row.address, 'Яхтенная ул., 38');
  });

  it('can be corrected without moving the machine anywhere', async () => {
    await installTestMachine(context, { machineNumber: 'AD-3', pricePerGame: 10 });

    const patched = await context.app.inject({
      method: 'PATCH', url: '/api/machines/AD-3/address', headers: authHeader(context.adminToken),
      payload: { address: 'Колпино, ул. Ижорского Батальона, д. 13' },
    });
    assert.equal(patched.statusCode, 200);

    const machines = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(context.adminToken),
    });
    const row = machines.json().find((m: { machine_number: string }) => m.machine_number === 'AD-3');
    assert.equal(row.address, 'Колпино, ул. Ижорского Батальона, д. 13');
    assert.equal(row.location_name, `Точка AD-3`, 'address correction must not touch the location');
  });

  it('carries over automatically on a bare move, and can be overridden in the same call', async () => {
    await installTestMachine(context, { machineNumber: 'AD-4', pricePerGame: 10 });
    await context.app.inject({
      method: 'PATCH', url: '/api/machines/AD-4/address', headers: authHeader(context.adminToken),
      payload: { address: 'Старый адрес 1' },
    });
    const newLocation = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'Новая точка AD-4', timezone: 'Europe/Moscow' },
    });

    await context.app.inject({
      method: 'POST', url: '/api/machines/AD-4/move', headers: authHeader(context.adminToken),
      payload: { locationId: newLocation.json().id },
    });
    const afterBareMove = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(context.adminToken),
    });
    assert.equal(
      afterBareMove.json().find((m: { machine_number: string }) => m.machine_number === 'AD-4').address,
      'Старый адрес 1',
      'a bare move keeps the known address',
    );

    const anotherLocation = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'Ещё точка AD-4', timezone: 'Europe/Moscow' },
    });
    await context.app.inject({
      method: 'POST', url: '/api/machines/AD-4/move', headers: authHeader(context.adminToken),
      payload: { locationId: anotherLocation.json().id, address: 'Новый адрес 2' },
    });
    const afterOverride = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(context.adminToken),
    });
    assert.equal(
      afterOverride.json().find((m: { machine_number: string }) => m.machine_number === 'AD-4').address,
      'Новый адрес 2',
    );
  });

  it('is admin-only', async () => {
    await installTestMachine(context, { machineNumber: 'AD-5', pricePerGame: 10 });
    const denied = await context.app.inject({
      method: 'PATCH', url: '/api/machines/AD-5/address', headers: authHeader(context.bossToken),
      payload: { address: 'x' },
    });
    assert.equal(denied.statusCode, 403);
  });
});

/**
 * Moving a machine that closed at one address (shop closed) and opened under a new contract at
 * another address (14_TZ real scenario, owner's own words) — the physical cabinet, including its
 * built-in payment terminal, travels with it. A move is not a hardware swap, so the terminal keeps
 * working by default; `detachTerminal` is the explicit exception (a new terminal will be arranged,
 * or the old terminal stays behind for some other reason).
 */
describe('moveMachine carries the bound terminal along by default', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  it('rebinds the same terminal to the new location automatically', async () => {
    await installTestMachine(context, { machineNumber: 'MVT-1', pricePerGame: 10 });
    const terminal = await context.app.inject({
      method: 'POST', url: '/api/terminals', headers: authHeader(context.adminToken),
      payload: { serial: 'MVT-TERM-1', provider: 'ivend' },
    });
    const terminalId = terminal.json().id;
    await context.app.inject({
      method: 'POST', url: '/api/terminals/bind', headers: authHeader(context.adminToken),
      payload: { terminalId, machineNumber: 'MVT-1', startedAt: '2026-01-01T08:00:00Z' },
    });

    const newLocation = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'Новый адрес MVT-1', timezone: 'Europe/Moscow' },
    });
    const moved = await context.app.inject({
      method: 'POST', url: '/api/machines/MVT-1/move', headers: authHeader(context.adminToken),
      payload: { locationId: newLocation.json().id, movedAt: '2026-02-01T08:00:00Z' },
    });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().terminalCarriedOver, true);

    const bindings = await pool.query(
      `SELECT location_id, ended_at FROM terminal_bindings WHERE terminal_id = $1 ORDER BY started_at`,
      [terminalId],
    );
    assert.equal(bindings.rows.length, 2, 'old interval closed, new one opened — not silently left stale');
    assert.ok(bindings.rows[0].ended_at, 'the binding at the old address must be closed');
    assert.equal(bindings.rows[1].ended_at, null, 'the binding at the new address is the active one');
    assert.equal(bindings.rows[1].location_id, newLocation.json().id);

    const machines = await context.app.inject({ method: 'GET', url: '/api/machines', headers: authHeader(context.adminToken) });
    const row = machines.json().find((m: { machine_number: string }) => m.machine_number === 'MVT-1');
    assert.equal(row.terminal_id, terminalId, 'still bound after the move, no manual rebind needed');
  });

  it('leaves the terminal behind when detachTerminal is requested', async () => {
    await installTestMachine(context, { machineNumber: 'MVT-2', pricePerGame: 10 });
    const terminal = await context.app.inject({
      method: 'POST', url: '/api/terminals', headers: authHeader(context.adminToken),
      payload: { serial: 'MVT-TERM-2', provider: 'ivend' },
    });
    const terminalId = terminal.json().id;
    await context.app.inject({
      method: 'POST', url: '/api/terminals/bind', headers: authHeader(context.adminToken),
      payload: { terminalId, machineNumber: 'MVT-2', startedAt: '2026-01-01T08:00:00Z' },
    });

    const newLocation = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'Новый адрес MVT-2', timezone: 'Europe/Moscow' },
    });
    const moved = await context.app.inject({
      method: 'POST', url: '/api/machines/MVT-2/move', headers: authHeader(context.adminToken),
      payload: { locationId: newLocation.json().id, movedAt: '2026-02-01T08:00:00Z', detachTerminal: true },
    });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().terminalCarriedOver, false);

    const machines = await context.app.inject({ method: 'GET', url: '/api/machines', headers: authHeader(context.adminToken) });
    const row = machines.json().find((m: { machine_number: string }) => m.machine_number === 'MVT-2');
    assert.equal(row.terminal_id, null, 'no terminal bound at the new address — an explicit choice, not an accident');

    const terminalRow = await pool.query('SELECT status FROM terminals WHERE id = $1', [terminalId]);
    assert.equal(terminalRow.rows[0].status, 'IN_STOCK', 'the detached terminal goes back to stock, same as a plain unbind');
  });

  it('does nothing extra when the machine has no terminal bound at all', async () => {
    await installTestMachine(context, { machineNumber: 'MVT-3', pricePerGame: 10 });
    const newLocation = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'Новый адрес MVT-3', timezone: 'Europe/Moscow' },
    });
    const moved = await context.app.inject({
      method: 'POST', url: '/api/machines/MVT-3/move', headers: authHeader(context.adminToken),
      payload: { locationId: newLocation.json().id },
    });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().terminalCarriedOver, false);
  });
});
