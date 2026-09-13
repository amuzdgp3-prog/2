import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, type TestContext } from './helpers.js';

/**
 * Видимость застрявших черновиков администратору (DECISION-048). Черновик живёт в браузере
 * техника, и до этой доработки о его отказе не знал никто, пока техник сам не позвонит.
 */
describe('застрявшие черновики техников', () => {
  let context: TestContext;
  const localId = '11111111-2222-3333-4444-555555555555';

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  const report = (token: string, errorMessage: string) =>
    context.app.inject({
      method: 'POST',
      url: '/api/draft-issues',
      headers: authHeader(token),
      payload: {
        localId,
        machineNumber: 'DI-1',
        occurredAt: '2026-03-01T10:00:00Z',
        errorCode: 'GAME_COUNTER_WENT_BACK',
        errorMessage,
      },
    });

  const list = async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/draft-issues',
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as Array<Record<string, string>>;
  };

  it('техник может доложить о своём затыке', async () => {
    const reported = await report(context.technicianToken, 'Счётчик игр 100 меньше предыдущего 500');
    assert.equal(reported.statusCode, 200, reported.body);

    const rows = await list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].machine_number, 'DI-1');
    assert.match(rows[0].error_message, /меньше предыдущего/);
    // Техник берётся из токена, а не из тела запроса: приписать затык другому нельзя.
    assert.equal(rows[0].technician_name, 'tech');
  });

  it('повторный доклад обновляет причину, а не плодит строки', async () => {
    const again = await report(context.technicianToken, 'Тестовых игр больше, чем прирост');
    assert.equal(again.statusCode, 200, again.body);

    const rows = await list();
    assert.equal(rows.length, 1, 'строка должна остаться одна');
    assert.match(rows[0].error_message, /Тестовых игр/);
  });

  it('техник не видит общий список, это инструмент администратора', async () => {
    const forbidden = await context.app.inject({
      method: 'GET',
      url: '/api/draft-issues',
      headers: authHeader(context.technicianToken),
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
  });

  it('починенный черновик снимается из списка', async () => {
    const resolved = await context.app.inject({
      method: 'DELETE',
      url: `/api/draft-issues/${localId}`,
      headers: authHeader(context.technicianToken),
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal((await list()).length, 0);
  });
});
