import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, pool, type TestContext } from './helpers.js';

/** Журнал событий клиента (DECISION-087): вылеты на телефоне сервер иначе не видит вообще. */
describe('журнал событий клиента', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  const send = (payload: unknown, token: string | null = context.technicianToken) =>
    context.app.inject({
      method: 'POST',
      url: '/api/client-events',
      headers: { ...(token ? authHeader(token) : {}), 'user-agent': 'TestPhone/1.0' },
      payload,
    });

  it('сохраняет события техника с версией, экраном и деталями', async () => {
    const response = await send({
      appVersion: 'abc123',
      events: [
        { at: '2026-10-17T06:21:00Z', kind: 'operation_aborted', screen: '/service/X', detail: { op: 'upload', photoBytes: 5_000_000 } },
        { at: 'не дата', kind: 'error' },
      ],
    });
    assert.equal(response.statusCode, 200, response.body);

    const rows = (await pool.query(`SELECT * FROM client_events ORDER BY id`)).rows;
    assert.equal(rows.length, 2);
    // staff_id из токена, а не из тела.
    assert.equal(Number(rows[0].staff_id), context.technicianId);
    assert.equal(rows[0].app_version, 'abc123');
    assert.equal(rows[0].user_agent, 'TestPhone/1.0');
    assert.equal(rows[0].detail.photoBytes, 5_000_000);
    assert.equal(rows[0].occurred_at.toISOString(), '2026-10-17T06:21:00.000Z');
    // Битое время клиента не роняет запись.
    assert.ok(rows[1].occurred_at instanceof Date);
  });

  it('обрезает слишком большие детали', async () => {
    await pool.query('DELETE FROM client_events');
    const response = await send({ appVersion: 'v', events: [{ at: '2026-10-17T00:00:00Z', kind: 'error', detail: { stack: 'x'.repeat(5000) } }] });
    assert.equal(response.statusCode, 200, response.body);
    const { detail } = (await pool.query(`SELECT detail FROM client_events`)).rows[0];
    assert.equal(detail.truncated, true);
  });

  it('удаляет записи старше 30 дней при новой записи', async () => {
    await pool.query(
      `INSERT INTO client_events (occurred_at, received_at, app_version, kind) VALUES (now(), now() - interval '31 days', 'old', 'error')`,
    );
    await send({ appVersion: 'v', events: [{ at: '2026-10-17T00:00:00Z', kind: 'error' }] });
    const old = await pool.query(`SELECT 1 FROM client_events WHERE app_version = 'old'`);
    assert.equal(old.rowCount, 0);
  });

  it('без входа и сверх лимита — отказ', async () => {
    assert.equal((await send({ appVersion: 'v', events: [{ at: 'x', kind: 'e' }] }, null)).statusCode, 401);
    const many = Array.from({ length: 51 }, () => ({ at: 'x', kind: 'e' }));
    assert.equal((await send({ appVersion: 'v', events: many })).statusCode, 400);
  });
});
