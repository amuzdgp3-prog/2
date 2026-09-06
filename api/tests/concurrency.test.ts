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

const { withTransaction } = await import('../src/db/pool.js');
const { createService, deleteService, updateService } = await import('../src/commands/services.js');
const { closeLocation, setLocationStatus } = await import('../src/commands/locations.js');
const { bindTerminal } = await import('../src/commands/terminals.js');
const { importCashless } = await import('../src/commands/cashless.js');
const { lockMachines } = await import('../src/lib/locks.js');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ADMIN = { id: 1, login: 'admin', role: 'ADMIN' as const };

async function serviceInput(machineNumber: string, options: {
  occurredAt: string;
  gameCounter: number;
  prizeCounter?: number;
  testGames?: number;
}) {
  const localId = randomUUID();
  return {
    localId,
    machineNumber,
    photoObjectKey: await preparePhoto(localId),
    occurredAt: options.occurredAt,
    gameCounter: options.gameCounter,
    prizeCounter: options.prizeCounter ?? 0,
    testGames: options.testGames ?? 0,
  };
}

/**
 * Real PostgreSQL concurrency and rollback suite required by
 * 14_BASELINE §18 and 19_REMAINING_GAPS_CLOSURE_v2 §3. Every case runs genuine parallel
 * transactions against the database; nothing here is mocked.
 */
describe('concurrency and rollback', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('serialises two concurrent services for one machine and keeps the chain consistent', async () => {
    await installTestMachine(context, {
      machineNumber: 'K-1',
      pricePerGame: 10,
      initialGameCounter: 0,
    });

    const [first, second] = await Promise.all([
      withTransaction(async (client) =>
        createService(client, ADMIN, await serviceInput('K-1', {
          occurredAt: '2026-07-01T10:00:00Z',
          gameCounter: 300,
        })),
      ),
      withTransaction(async (client) =>
        createService(client, ADMIN, await serviceInput('K-1', {
          occurredAt: '2026-07-02T10:00:00Z',
          gameCounter: 500,
        })),
      ),
    ]);

    assert.equal(first.idempotentReplay, false);
    assert.equal(second.idempotentReplay, false);

    const chain = await pool.query(
      `SELECT new_games FROM services WHERE machine_number = 'K-1' ORDER BY occurred_at`,
    );
    // Whichever transaction committed first, the final chain must read 300 then 200.
    assert.deepEqual(
      chain.rows.map((row) => row.new_games),
      ['300.0000', '200.0000'],
    );
  });

  it('serialises a concurrent service creation and deletion without corrupting the chain', async () => {
    await installTestMachine(context, {
      machineNumber: 'K-2',
      pricePerGame: 10,
      initialGameCounter: 0,
    });

    const existing = await postService(context, context.adminToken, 'K-2', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-07-01T10:00:00Z',
    });
    const existingId = (existing.body as { service: { id: number } }).service.id;

    await Promise.all([
      withTransaction(async (client) =>
        createService(client, ADMIN, await serviceInput('K-2', {
          occurredAt: '2026-07-05T10:00:00Z',
          gameCounter: 400,
        })),
      ),
      withTransaction((client) => deleteService(client, ADMIN, existingId)),
    ]);

    const remaining = await pool.query(
      `SELECT new_games FROM services WHERE machine_number = 'K-2' ORDER BY occurred_at`,
    );
    assert.equal(remaining.rowCount, 1);
    // The deleted service's growth must be folded into the survivor, never lost or double counted.
    assert.equal(remaining.rows[0].new_games, '400.0000');
  });

  it('closes the deactivation TOCTOU window in both directions', async () => {
    const { locationId } = await installTestMachine(context, {
      machineNumber: 'K-3',
      pricePerGame: 10,
      initialGameCounter: 0,
    });

    const order: string[] = [];

    // A service already in flight holds the Location row lock, so the deactivation must wait
    // for it instead of slipping between the status check and the insert.
    const inFlightService = withTransaction(async (client) => {
      const result = await createService(client, ADMIN, await serviceInput('K-3', {
        occurredAt: '2026-07-10T10:00:00Z',
        gameCounter: 200,
      }));
      await sleep(400);
      order.push('service');
      return result;
    });

    await sleep(120);
    const deactivation = withTransaction(async (client) => {
      const result = await setLocationStatus(client, ADMIN, locationId, 'DEACTIVATED');
      order.push('deactivation');
      return result;
    });

    await Promise.all([inFlightService, deactivation]);
    assert.deepEqual(order, ['service', 'deactivation'], 'deactivation must wait for the service');

    const stored = await pool.query(
      `SELECT COUNT(*)::int AS count FROM services WHERE machine_number = 'K-3'`,
    );
    assert.equal(stored.rows[0].count, 1, 'the in-flight service must not be lost');

    // The other direction: once the location is DEACTIVATED, no further service is accepted.
    const rejected = await postService(context, context.adminToken, 'K-3', {
      gameCounter: 400,
      prizeCounter: 0,
      occurredAt: '2026-07-11T10:00:00Z',
    });
    assert.equal(rejected.status, 400);
    assert.equal((rejected.body as { error: string }).error, 'LOCATION_NOT_ACTIVE');
  });

  it('keeps closeLocation and a concurrent service mutually consistent', async () => {
    const { locationId } = await installTestMachine(context, {
      machineNumber: 'K-4',
      pricePerGame: 10,
      initialGameCounter: 0,
    });

    const localId = randomUUID();
    const photoObjectKey = await preparePhoto(localId);

    const outcomes = await Promise.allSettled([
      withTransaction((client) =>
        closeLocation(client, ADMIN, locationId, '2026-08-01T12:00:00Z', [
          { machineNumber: 'K-4', localId, gameCounter: 900, prizeCounter: 0, photoObjectKey },
        ]),
      ),
      withTransaction(async (client) =>
        createService(client, ADMIN, await serviceInput('K-4', {
          occurredAt: '2026-07-25T10:00:00Z',
          gameCounter: 300,
        })),
      ),
    ]);

    const location = await pool.query('SELECT status FROM locations WHERE id = $1', [locationId]);
    const placement = await pool.query(
      `SELECT id, ended_at FROM machine_placements WHERE machine_number = 'K-4'`,
    );

    if (outcomes[0].status === 'fulfilled') {
      assert.equal(location.rows[0].status, 'CLOSED');
      assert.notEqual(placement.rows[0].ended_at, null);

      // No service may exist after the placement was closed.
      const late = await pool.query(
        `SELECT COUNT(*)::int AS count FROM services
         WHERE machine_number = 'K-4' AND occurred_at > $1`,
        [placement.rows[0].ended_at],
      );
      assert.equal(late.rows[0].count, 0, 'nothing may be recorded after the placement closed');
    } else {
      // If the close lost the race it must have rolled back completely.
      assert.equal(location.rows[0].status, 'ACTIVE');
      assert.equal(placement.rows[0].ended_at, null);
    }
  });

  it('keeps terminal rebinding and cashless matching consistent under concurrency', async () => {
    await installTestMachine(context, {
      machineNumber: 'K-5',
      pricePerGame: 10,
      initialGameCounter: 0,
    });
    await installTestMachine(context, {
      machineNumber: 'K-6',
      pricePerGame: 10,
      initialGameCounter: 0,
    });

    const terminal = await context.app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: authHeader(context.adminToken),
      payload: { serial: 'T-RACE', provider: 'demo' },
    });
    const terminalId = terminal.json().id;

    await withTransaction((client) =>
      bindTerminal(client, ADMIN, {
        terminalId,
        machineNumber: 'K-5',
        startedAt: '2026-09-01T00:00:00Z',
      }),
    );

    const occurredAt = '2026-09-05T12:00:00Z';
    await Promise.allSettled([
      withTransaction((client) =>
        bindTerminal(client, ADMIN, {
          terminalId,
          machineNumber: 'K-6',
          startedAt: '2026-09-03T00:00:00Z',
        }),
      ),
      withTransaction((client) =>
        importCashless(client, ADMIN, 'demo', [
          {
            providerTransactionId: 'race-1',
            terminalExternalId: 'T-RACE',
            occurredAt,
            amount: '150.00',
            paymentType: 'CARD',
          },
        ]),
      ),
    ]);

    // Whatever the interleaving was, the stored match must agree with the binding history.
    const expected = await pool.query(
      `SELECT b.machine_number FROM terminal_bindings b
       WHERE b.terminal_id = $1 AND tstzrange(b.started_at, b.ended_at) @> $2::timestamptz`,
      [terminalId, occurredAt],
    );
    const stored = await pool.query(
      `SELECT matched_machine_number, match_status FROM cashless_transactions
       WHERE provider_transaction_id = 'race-1'`,
    );

    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].matched_machine_number, expected.rows[0].machine_number);
    assert.equal(stored.rows[0].match_status, 'MATCHED');
  });

  it('rolls back the whole operation when the recalculation fails', async () => {
    await installTestMachine(context, {
      machineNumber: 'K-7',
      pricePerGame: 10,
      initialGameCounter: 0,
    });

    const first = await postService(context, context.adminToken, 'K-7', {
      gameCounter: 1000,
      prizeCounter: 0,
      occurredAt: '2026-07-01T10:00:00Z',
    });
    await postService(context, context.adminToken, 'K-7', {
      gameCounter: 1200,
      prizeCounter: 0,
      occurredAt: '2026-07-08T10:00:00Z',
    });

    const firstId = (first.body as { service: { id: number } }).service.id;

    // Raising the first reading above the second one makes the later service negative:
    // the recalculation must reject the edit and leave the stored history untouched.
    await assert.rejects(
      withTransaction((client) =>
        updateService(client, ADMIN, firstId, { gameCounter: 5000 }),
      ),
      /отрицательное количество новых игр/i,
    );

    const chain = await pool.query(
      `SELECT game_counter, new_games FROM services
       WHERE machine_number = 'K-7' ORDER BY occurred_at`,
    );
    assert.deepEqual(
      chain.rows.map((row) => [Number(row.game_counter), row.new_games]),
      [
        [1000, '1000.0000'],
        [1200, '200.0000'],
      ],
    );
  });

  it('takes multi-machine locks in a deterministic order and does not deadlock', async () => {
    await installTestMachine(context, { machineNumber: 'K-8', pricePerGame: 10 });
    await installTestMachine(context, { machineNumber: 'K-9', pricePerGame: 10 });

    // Two transactions request the same pair in opposite order; lockMachines sorts them, so the
    // acquisition order is identical and the classic AB/BA deadlock cannot happen.
    const both = await Promise.all([
      withTransaction(async (client) => {
        await lockMachines(client, ['K-9', 'K-8']);
        await sleep(250);
        await client.query(`UPDATE machines SET model = 'a' WHERE machine_number = 'K-8'`);
        return 'first';
      }),
      withTransaction(async (client) => {
        await lockMachines(client, ['K-8', 'K-9']);
        await sleep(250);
        await client.query(`UPDATE machines SET model = 'b' WHERE machine_number = 'K-9'`);
        return 'second';
      }),
    ]);

    assert.deepEqual(both, ['first', 'second'], 'both transactions must complete');
  });

  it('stays idempotent when the same local_id is synced twice at once', async () => {
    await installTestMachine(context, {
      machineNumber: 'K-10',
      pricePerGame: 10,
      initialGameCounter: 0,
    });

    const input = await serviceInput('K-10', {
      occurredAt: '2026-07-15T10:00:00Z',
      gameCounter: 250,
    });

    const results = await Promise.all([
      withTransaction((client) => createService(client, ADMIN, input)),
      withTransaction((client) => createService(client, ADMIN, input)),
    ]);

    const stored = await pool.query('SELECT COUNT(*)::int AS count FROM services WHERE local_id = $1', [
      input.localId,
    ]);
    assert.equal(stored.rows[0].count, 1, 'a concurrent replay must not create a second service');
    assert.equal(
      results.filter((result) => result.idempotentReplay).length,
      1,
      'exactly one of the two calls must report a replay',
    );
  });
});
