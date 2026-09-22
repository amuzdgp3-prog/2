import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  authHeader,
  bootstrap,
  installTestMachine,
  pool,
  preparePhoto,
  type TestContext,
} from './helpers.js';

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

  /**
   * Уборка не должна зависеть от отдельного запроса с телефона: тот запрос необязателен и может
   * не дойти (связь оборвалась сразу после сохранения, истёк токен, техник переустановил
   * приложение). Раньше в этом случае строка висела у администратора вечно, хотя обслуживание
   * давно лежало в базе.
   */
  it('принятое обслуживание снимает жалобу само, без запроса от клиента', async () => {
    const sentLocalId = '99999999-8888-7777-6666-555555555555';
    const placed = await installTestMachine(context, { machineNumber: 'DI-2', pricePerGame: 50 });
    await context.app.inject({
      method: 'POST',
      url: '/api/staff/scope',
      headers: authHeader(context.adminToken),
      payload: { staffId: context.technicianId, locationId: placed.locationId },
    });

    const reported = await context.app.inject({
      method: 'POST',
      url: '/api/draft-issues',
      headers: authHeader(context.technicianToken),
      payload: {
        localId: sentLocalId,
        machineNumber: 'DI-2',
        occurredAt: '2026-03-02T10:00:00Z',
        errorCode: 'GAME_COUNTER_WENT_BACK',
        errorMessage: 'Счётчик игр 100 меньше предыдущего 500',
      },
    });
    assert.equal(reported.statusCode, 200, reported.body);
    assert.equal((await list()).length, 1);

    const photoObjectKey = await preparePhoto(sentLocalId);
    const stored = await context.app.inject({
      method: 'POST',
      url: '/api/services',
      headers: authHeader(context.technicianToken),
      payload: {
        localId: sentLocalId,
        machineNumber: 'DI-2',
        photoObjectKey,
        occurredAt: '2026-03-02T10:00:00Z',
        gameCounter: 600,
        prizeCounter: 10,
        testGames: 0,
      },
    });
    assert.equal(stored.statusCode, 200, stored.body);

    assert.equal((await list()).length, 0, 'жалоба должна уйти вместе с принятым обслуживанием');
  });

  /**
   * Страховка для строк, зависших до этой доработки: обслуживание по ним давно в базе, а строка
   * осталась. Проверяем, что список их не показывает, даже если они физически есть в таблице.
   */
  it('строка, пережившая сохранение обслуживания, в списке не показывается', async () => {
    const staleLocalId = '12121212-3434-5656-7878-909090909090';
    await pool.query(
      `INSERT INTO technician_draft_issues
         (local_id, technician_id, machine_number, occurred_at, error_code, error_message)
       VALUES ($1, $2, 'DI-2', '2026-03-02T10:00:00Z', 'GAME_COUNTER_WENT_BACK', 'старая жалоба')`,
      ['99999999-8888-7777-6666-555555555555', context.technicianId],
    );
    await pool.query(
      `INSERT INTO technician_draft_issues
         (local_id, technician_id, machine_number, occurred_at, error_code, error_message)
       VALUES ($1, $2, 'DI-2', '2026-03-03T10:00:00Z', 'GAME_COUNTER_WENT_BACK', 'живая жалоба')`,
      [staleLocalId, context.technicianId],
    );

    const rows = await list();
    assert.equal(rows.length, 1, 'показывается только та, по которой обслуживания ещё нет');
    assert.equal(rows[0].local_id, staleLocalId);
  });
});
