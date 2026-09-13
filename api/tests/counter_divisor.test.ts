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

describe('counter divisor', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('divisor 1 reproduces the legacy calculation: growth 200, test games 5 -> 195', async () => {
    await installTestMachine(context, {
      machineNumber: 'M-D1',
      pricePerGame: 10,
      counterDivisor: 1,
      initialGameCounter: 1000,
    });

    const created = await postService(context, context.adminToken, 'M-D1', {
      gameCounter: 1200,
      prizeCounter: 0,
      testGames: 5,
      occurredAt: '2026-02-01T10:00:00Z',
    });

    assert.equal(created.status, 200);
    const service = (created.body as { service: Record<string, string> }).service;
    assert.equal(service.new_games, '195.0000');
    assert.equal(service.counter_divisor_applied, '1.00');
    assert.equal(service.revenue, '1950.00');
  });

  it('divisor 2: growth 200, test games 5 -> 95 games and revenue from 95', async () => {
    await installTestMachine(context, {
      machineNumber: 'M-D2',
      pricePerGame: 10,
      counterDivisor: 2,
      initialGameCounter: 1000,
    });

    const created = await postService(context, context.adminToken, 'M-D2', {
      gameCounter: 1200,
      prizeCounter: 0,
      testGames: 5,
      occurredAt: '2026-02-01T10:00:00Z',
    });

    const service = (created.body as { service: Record<string, string> }).service;
    assert.equal(service.new_games, '95.0000');
    assert.equal(service.counter_divisor_applied, '2.00');
    assert.equal(service.revenue, '950.00');
  });

  it('a non-positive or missing divisor is stored and applied as 1', async () => {
    await installTestMachine(context, {
      machineNumber: 'M-D0',
      pricePerGame: 10,
      counterDivisor: 0,
      initialGameCounter: 0,
    });

    const stored = await pool.query(
      'SELECT counter_divisor FROM machines WHERE machine_number = $1',
      ['M-D0'],
    );
    assert.equal(stored.rows[0].counter_divisor, '1.00');

    const created = await postService(context, context.adminToken, 'M-D0', {
      gameCounter: 200,
      prizeCounter: 0,
      testGames: 5,
      occurredAt: '2026-02-01T10:00:00Z',
    });
    const service = (created.body as { service: Record<string, string> }).service;
    assert.equal(service.new_games, '195.0000');

    // The database itself refuses a non-positive divisor, so no broken value can reach the chain.
    await assert.rejects(
      pool.query('UPDATE machines SET counter_divisor = 0 WHERE machine_number = $1', ['M-D0']),
      /machines_counter_divisor_positive/,
    );
  });

  it('keeps fractional new games unrounded and derives revenue from them', async () => {
    await installTestMachine(context, {
      machineNumber: 'M-D3',
      pricePerGame: 10,
      counterDivisor: 3,
      initialGameCounter: 0,
    });

    const created = await postService(context, context.adminToken, 'M-D3', {
      gameCounter: 100,
      prizeCounter: 0,
      testGames: 0,
      occurredAt: '2026-02-01T10:00:00Z',
    });

    const service = (created.body as { service: Record<string, string> }).service;
    assert.equal(service.new_games, '33.3333');
    assert.equal(service.revenue, '333.33');
  });

  it('rejects a service whose growth cannot cover the test games after division', async () => {
    await installTestMachine(context, {
      machineNumber: 'M-D4',
      pricePerGame: 10,
      counterDivisor: 10,
      initialGameCounter: 0,
    });

    const created = await postService(context, context.adminToken, 'M-D4', {
      gameCounter: 50,
      prizeCounter: 0,
      testGames: 20,
      occurredAt: '2026-02-01T10:00:00Z',
    });

    assert.equal(created.status, 400);
    // Раньше здесь ожидался общий NEGATIVE_NEW_GAMES из пересчёта цепочки. С DECISION-048 этот
    // случай ловится раньше и называется своим именем: техник видит «тестовых игр указано 20, а
    // счётчик вырос всего на 5», а не «расчёт даёт отрицательное количество новых игр: проверьте
    // показания и тестовые игры», где смешаны две разные причины. Отказ тот же, причина точнее.
    assert.equal((created.body as { error: string }).error, 'TEST_GAMES_EXCEED_GROWTH');
    assert.match(String((created.body as { message: string }).message), /20/);

    const services = await pool.query('SELECT COUNT(*)::int AS count FROM services WHERE machine_number = $1', [
      'M-D4',
    ]);
    assert.equal(services.rows[0].count, 0, 'the rejected service must not be stored');
  });

  it('never rewrites recorded history when the divisor or the price changes', async () => {
    await installTestMachine(context, {
      machineNumber: 'M-D6',
      pricePerGame: 5,
      counterDivisor: 1,
      initialGameCounter: 0,
    });

    await postService(context, context.adminToken, 'M-D6', {
      gameCounter: 400,
      prizeCounter: 0,
      occurredAt: '2026-02-01T10:00:00Z',
    });

    const patched = await context.app.inject({
      method: 'PATCH',
      url: '/api/machines/M-D6',
      headers: authHeader(context.adminToken),
      payload: { counterDivisor: 4, pricePerGame: 20 },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().recalculated, 0, 'editing the machine must not touch history');

    const historical = await pool.query(
      `SELECT new_games, revenue, counter_divisor_applied, price_per_game_snapshot
       FROM services WHERE machine_number = 'M-D6'`,
    );
    assert.equal(historical.rows[0].new_games, '400.0000');
    assert.equal(historical.rows[0].revenue, '2000.00', 'past revenue stays at the old price');
    assert.equal(historical.rows[0].counter_divisor_applied, '1.00');
    assert.equal(historical.rows[0].price_per_game_snapshot, '5.00');

    // The new settings apply from the next service onwards.
    await postService(context, context.adminToken, 'M-D6', {
      gameCounter: 800,
      prizeCounter: 0,
      occurredAt: '2026-02-08T10:00:00Z',
    });

    const latest = await pool.query(
      `SELECT new_games, revenue, counter_divisor_applied, price_per_game_snapshot
       FROM services WHERE machine_number = 'M-D6' ORDER BY occurred_at DESC LIMIT 1`,
    );
    assert.equal(latest.rows[0].new_games, '100.0000', '(800-400)/4');
    assert.equal(latest.rows[0].counter_divisor_applied, '4.00');
    assert.equal(latest.rows[0].price_per_game_snapshot, '20.00');
    assert.equal(latest.rows[0].revenue, '2000.00');
  });

  it('corrects history only on the explicit admin action, optionally from a date', async () => {
    await installTestMachine(context, {
      machineNumber: 'M-D7',
      pricePerGame: 10,
      counterDivisor: 1,
      initialGameCounter: 0,
    });

    await postService(context, context.adminToken, 'M-D7', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-02-01T10:00:00Z',
    });
    await postService(context, context.adminToken, 'M-D7', {
      gameCounter: 300,
      prizeCounter: 0,
      occurredAt: '2026-02-08T10:00:00Z',
    });

    await context.app.inject({
      method: 'PATCH',
      url: '/api/machines/M-D7',
      headers: authHeader(context.adminToken),
      payload: { counterDivisor: 2 },
    });

    // Correct only the later service: the divisor was configured wrongly from 8 February.
    const applied = await context.app.inject({
      method: 'POST',
      url: '/api/machines/M-D7/apply-divisor-to-history',
      headers: authHeader(context.adminToken),
      payload: { from: '2026-02-08' },
    });
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.json().restamped, 1);

    const services = await pool.query(
      `SELECT new_games, counter_divisor_applied FROM services
       WHERE machine_number = 'M-D7' ORDER BY occurred_at`,
    );
    assert.equal(services.rows[0].new_games, '100.0000', 'earlier service keeps divisor 1');
    assert.equal(services.rows[0].counter_divisor_applied, '1.00');
    assert.equal(services.rows[1].new_games, '100.0000', '(300-100)/2');
    assert.equal(services.rows[1].counter_divisor_applied, '2.00');

    const audit = await pool.query(
      `SELECT COUNT(*)::int AS count FROM audit_log
       WHERE entity = 'service' AND context ->> 'reason' = 'counter_divisor_applied_to_history'`,
    );
    assert.equal(audit.rows[0].count, 1, 'the correction itself must be audited');
  });

  it('applies a corrected divisor to the whole history when no date is given', async () => {
    await installTestMachine(context, {
      machineNumber: 'M-D5',
      pricePerGame: 5,
      counterDivisor: 1,
      initialGameCounter: 0,
    });

    await postService(context, context.adminToken, 'M-D5', {
      gameCounter: 400,
      prizeCounter: 0,
      testGames: 0,
      occurredAt: '2026-02-01T10:00:00Z',
    });
    await postService(context, context.adminToken, 'M-D5', {
      gameCounter: 1000,
      prizeCounter: 0,
      testGames: 10,
      occurredAt: '2026-02-08T10:00:00Z',
    });

    await context.app.inject({
      method: 'PATCH',
      url: '/api/machines/M-D5',
      headers: authHeader(context.adminToken),
      payload: { counterDivisor: 4 },
    });

    const applied = await context.app.inject({
      method: 'POST',
      url: '/api/machines/M-D5/apply-divisor-to-history',
      headers: authHeader(context.adminToken),
      payload: {},
    });
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.json().restamped, 2, 'both stored services must be restamped');

    const services = await pool.query(
      `SELECT new_games, revenue, counter_divisor_applied FROM services
       WHERE machine_number = $1 ORDER BY occurred_at`,
      ['M-D5'],
    );

    // 400 / 4 = 100 games; (1000-400)/4 - 10 = 140 games.
    assert.equal(services.rows[0].new_games, '100.0000');
    assert.equal(services.rows[0].revenue, '500.00');
    assert.equal(services.rows[0].counter_divisor_applied, '4.00');
    assert.equal(services.rows[1].new_games, '140.0000');
    assert.equal(services.rows[1].revenue, '700.00');

    const audit = await pool.query(
      `SELECT COUNT(*)::int AS count FROM audit_log
       WHERE entity = 'service' AND context->>'reason' = 'counter_divisor_restamped'`,
    );
    assert.ok(audit.rows[0].count >= 2, 'every recalculated service must be audited');
  });

  it('returns the divisor through the machines API and persists an edited value', async () => {
    const machines = await context.app.inject({
      method: 'GET',
      url: '/api/machines',
      headers: authHeader(context.adminToken),
    });
    const listed = machines.json() as Array<Record<string, string>>;
    const machine = listed.find((row) => row.machine_number === 'M-D2');
    assert.equal(machine?.counter_divisor, '2.00');

    const patched = await context.app.inject({
      method: 'PATCH',
      url: '/api/machines/M-D2',
      headers: authHeader(context.adminToken),
      payload: { counterDivisor: '2.50' },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal((patched.json().machine as Record<string, string>).counter_divisor, '2.50');
  });
});
