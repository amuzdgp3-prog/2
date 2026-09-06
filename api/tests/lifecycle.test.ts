import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  authHeader,
  bootstrap,
  installTestMachine,
  pool,
  postService,
  preparePhoto,
  type TestContext,
} from './helpers.js';

describe('lifecycle, chain integrity and DDL constraints', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('requires a counter photo before a service can be stored', async () => {
    await installTestMachine(context, { machineNumber: 'L-1', pricePerGame: 10 });

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/services',
      headers: authHeader(context.adminToken),
      payload: {
        localId: randomUUID(),
        machineNumber: 'L-1',
        occurredAt: '2026-02-01T10:00:00Z',
        gameCounter: 100,
        prizeCounter: 10,
        photoObjectKey: 'services/missing.jpg',
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'COUNTER_PHOTO_REQUIRED');
  });

  it('treats a replayed local_id as idempotent and rejects a conflicting one', async () => {
    await installTestMachine(context, { machineNumber: 'L-2', pricePerGame: 10 });

    const localId = randomUUID();
    const photoObjectKey = await preparePhoto(localId);
    const payload = {
      localId,
      machineNumber: 'L-2',
      photoObjectKey,
      occurredAt: '2026-02-01T10:00:00Z',
      gameCounter: 500,
      prizeCounter: 20,
      testGames: 0,
    };

    const first = await context.app.inject({
      method: 'POST',
      url: '/api/services',
      headers: authHeader(context.adminToken),
      payload,
    });
    const replay = await context.app.inject({
      method: 'POST',
      url: '/api/services',
      headers: authHeader(context.adminToken),
      payload,
    });

    assert.equal(first.json().idempotentReplay, false);
    assert.equal(replay.json().idempotentReplay, true);
    assert.equal(replay.json().service.id, first.json().service.id);

    const conflicting = await context.app.inject({
      method: 'POST',
      url: '/api/services',
      headers: authHeader(context.adminToken),
      payload: { ...payload, gameCounter: 999 },
    });
    assert.equal(conflicting.statusCode, 409);
    assert.equal(conflicting.json().error, 'LOCAL_ID_CONFLICT');

    const stored = await pool.query(
      'SELECT game_counter FROM services WHERE local_id = $1',
      [localId],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(Number(stored.rows[0].game_counter), 500, 'the stored service must not be overwritten');
  });

  it('repairs the dependent chain when a middle service is edited or deleted', async () => {
    await installTestMachine(context, { machineNumber: 'L-3', pricePerGame: 10 });

    await postService(context, context.adminToken, 'L-3', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-03-01T10:00:00Z',
    });
    const middle = await postService(context, context.adminToken, 'L-3', {
      gameCounter: 300,
      prizeCounter: 0,
      occurredAt: '2026-03-08T10:00:00Z',
    });
    await postService(context, context.adminToken, 'L-3', {
      gameCounter: 600,
      prizeCounter: 0,
      occurredAt: '2026-03-15T10:00:00Z',
    });

    const middleId = (middle.body as { service: { id: number } }).service.id;
    await context.app.inject({
      method: 'PATCH',
      url: `/api/services/${middleId}`,
      headers: authHeader(context.adminToken),
      payload: { gameCounter: 250 },
    });

    let chain = await pool.query(
      'SELECT new_games FROM services WHERE machine_number = $1 ORDER BY occurred_at',
      ['L-3'],
    );
    assert.deepEqual(
      chain.rows.map((row) => row.new_games),
      ['100.0000', '150.0000', '350.0000'],
      'editing the middle reading must repair the following service',
    );

    await context.app.inject({
      method: 'DELETE',
      url: `/api/services/${middleId}`,
      headers: authHeader(context.adminToken),
    });

    chain = await pool.query(
      'SELECT new_games FROM services WHERE machine_number = $1 ORDER BY occurred_at',
      ['L-3'],
    );
    assert.deepEqual(
      chain.rows.map((row) => row.new_games),
      ['100.0000', '500.0000'],
      'deleting a service must fold its growth into the next one',
    );
  });

  it('resolves the business date in the location timezone, not in the server timezone', async () => {
    await installTestMachine(context, {
      machineNumber: 'L-4',
      pricePerGame: 10,
      timezone: 'Asia/Vladivostok',
    });

    await postService(context, context.adminToken, 'L-4', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-02-01T20:00:00Z',
    });

    const stored = await pool.query(
      'SELECT service_date FROM services WHERE machine_number = $1',
      ['L-4'],
    );
    // 20:00 UTC is already 06:00 of the next day in Vladivostok (UTC+10).
    assert.equal(stored.rows[0].service_date, '2026-02-02');
  });

  it('never reuses a machine number and never allows two active placements', async () => {
    await installTestMachine(context, { machineNumber: 'L-5', pricePerGame: 10 });

    const duplicate = await context.app.inject({
      method: 'POST',
      url: '/api/machines/install',
      headers: authHeader(context.adminToken),
      payload: {
        machineNumber: 'L-5',
        pricePerGame: 10,
        locationId: 1,
        startedAt: '2026-01-01T08:00:00Z',
        initialGameCounter: 0,
        initialPrizeCounter: 0,
      },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error, 'MACHINE_NUMBER_IN_USE');

    const placement = await pool.query(
      'SELECT location_id FROM machine_placements WHERE machine_number = $1',
      ['L-5'],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO machine_placements (machine_number, location_id, started_at,
                                         initial_game_counter, initial_prize_counter)
         VALUES ($1, $2, now(), 0, 0)`,
        ['L-5', placement.rows[0].location_id],
      ),
      /placements_no_overlap/,
      'the database must reject a second active placement',
    );
  });

  it('forbids services on a deactivated location and keeps the machine in place', async () => {
    const { locationId } = await installTestMachine(context, {
      machineNumber: 'L-6',
      pricePerGame: 10,
    });

    await context.app.inject({
      method: 'POST',
      url: `/api/locations/${locationId}/status`,
      headers: authHeader(context.adminToken),
      payload: { status: 'DEACTIVATED' },
    });

    const rejected = await postService(context, context.adminToken, 'L-6', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-02-01T10:00:00Z',
    });
    assert.equal(rejected.status, 400);
    assert.equal((rejected.body as { error: string }).error, 'LOCATION_NOT_ACTIVE');

    const placement = await pool.query(
      'SELECT ended_at FROM machine_placements WHERE machine_number = $1',
      ['L-6'],
    );
    assert.equal(placement.rows[0].ended_at, null, 'deactivation must not close the placement');
  });

  it('closes a location atomically and rolls back when final counters are missing', async () => {
    const { locationId } = await installTestMachine(context, {
      machineNumber: 'L-7',
      pricePerGame: 10,
      initialGameCounter: 0,
    });

    const terminal = await context.app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: authHeader(context.adminToken),
      payload: { serial: 'T-L7', provider: 'demo' },
    });
    await context.app.inject({
      method: 'POST',
      url: '/api/terminals/bind',
      headers: authHeader(context.adminToken),
      payload: {
        terminalId: terminal.json().id,
        machineNumber: 'L-7',
        startedAt: '2026-01-02T08:00:00Z',
      },
    });

    const incomplete = await context.app.inject({
      method: 'POST',
      url: `/api/locations/${locationId}/close`,
      headers: authHeader(context.adminToken),
      payload: { occurredAt: '2026-04-01T12:00:00Z', finalCounters: [] },
    });
    assert.equal(incomplete.statusCode, 400);
    assert.equal(incomplete.json().error, 'FINAL_COUNTERS_REQUIRED');

    const stillActive = await pool.query('SELECT status FROM locations WHERE id = $1', [locationId]);
    assert.equal(stillActive.rows[0].status, 'ACTIVE', 'a failed close must roll everything back');

    const localId = randomUUID();
    const photoObjectKey = await preparePhoto(localId);
    const closed = await context.app.inject({
      method: 'POST',
      url: `/api/locations/${locationId}/close`,
      headers: authHeader(context.adminToken),
      payload: {
        occurredAt: '2026-04-01T12:00:00Z',
        finalCounters: [
          { machineNumber: 'L-7', localId, gameCounter: 900, prizeCounter: 30, photoObjectKey },
        ],
      },
    });
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.json().finalServices, 1);

    const location = await pool.query('SELECT status FROM locations WHERE id = $1', [locationId]);
    assert.equal(location.rows[0].status, 'CLOSED');

    const placement = await pool.query(
      'SELECT ended_at FROM machine_placements WHERE machine_number = $1',
      ['L-7'],
    );
    assert.notEqual(placement.rows[0].ended_at, null, 'the placement must be closed');

    const binding = await pool.query(
      `SELECT ended_at FROM terminal_bindings b
       JOIN terminals t ON t.id = b.terminal_id WHERE t.serial = 'T-L7'`,
    );
    assert.notEqual(binding.rows[0].ended_at, null, 'terminal bindings must be closed');

    const finalService = await pool.query(
      `SELECT kind, new_games FROM services WHERE machine_number = 'L-7'`,
    );
    assert.equal(finalService.rows[0].kind, 'FINAL');
    assert.equal(finalService.rows[0].new_games, '900.0000');
  });

  it('preserves negative cash and flags the financial anomaly instead of clamping it', async () => {
    await installTestMachine(context, {
      machineNumber: 'L-8',
      pricePerGame: 1,
      initialGameCounter: 0,
    });

    await postService(context, context.adminToken, 'L-8', {
      gameCounter: 10,
      prizeCounter: 0,
      occurredAt: '2026-05-01T10:00:00Z',
    });

    // A cashless total above the system revenue must stay visible as an anomaly.
    await pool.query(
      `UPDATE services SET cashless_amount = 50 WHERE machine_number = 'L-8'`,
    );
    const stored = await pool.query(
      `SELECT revenue, cashless_amount, cash_amount, is_financial_anomaly
       FROM services WHERE machine_number = 'L-8'`,
    );

    assert.equal(stored.rows[0].revenue, '10.00');
    assert.equal(stored.rows[0].cash_amount, '-40.00');
    assert.equal(stored.rows[0].is_financial_anomaly, true);
  });

  it('resolves min and max service days independently along the inheritance chain', async () => {
    const parent = await context.app.inject({
      method: 'POST',
      url: '/api/locations',
      headers: authHeader(context.adminToken),
      payload: { name: 'Регион', timezone: 'Europe/Moscow', minServiceDays: 2, maxServiceDays: 30 },
    });
    const child = await context.app.inject({
      method: 'POST',
      url: '/api/locations',
      headers: authHeader(context.adminToken),
      payload: { name: 'ТЦ', timezone: 'Europe/Moscow', parentId: parent.json().id, maxServiceDays: 21 },
    });

    await installTestMachine(context, {
      machineNumber: 'L-9',
      pricePerGame: 10,
      locationId: child.json().id,
    });

    const resolved = await context.app.inject({
      method: 'GET',
      url: '/api/machines/L-9/interval',
      headers: authHeader(context.adminToken),
    });

    // max comes from the child location, min falls through to the parent: the fields are independent.
    assert.equal(resolved.json().maxServiceDays, 21);
    assert.equal(resolved.json().minServiceDays, 2);
    assert.match(resolved.json().minSource, /^location:/);
  });
});
