import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, preparePhoto, type TestContext } from './helpers.js';

/**
 * Уведомление в Telegram о черновике на разбор (DECISION-092). Отдельный файл, а не ещё один it в
 * service_reviews.test.ts: те тесты считают длину списка проверок, и лишняя запись их ломала бы.
 */
describe('черновик на разбор → очередь Telegram', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
    const { locationId } = await installTestMachine(context, {
      machineNumber: 'TG-1',
      pricePerGame: 100,
      initialGameCounter: 1000,
      initialPrizeCounter: 100,
      startedAt: '2026-01-01T00:00:00Z',
    });
    await pool.query(
      `UPDATE machine_placements SET address = 'Тестовая улица, 7' WHERE machine_number = 'TG-1' AND ended_at IS NULL`,
    );
    await context.app.inject({
      method: 'POST',
      url: '/api/staff/scope',
      headers: authHeader(context.adminToken),
      payload: { staffId: context.technicianId, locationId },
    });
    const first = await send(randomUUID(), { gameCounter: 2000, prizeCounter: 150, occurredAt: '2026-01-10T12:00:00Z' });
    assert.equal(first.statusCode, 200, first.body);
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  const photos = new Map<string, string>();
  async function send(localId: string, fields: Record<string, unknown>) {
    if (!photos.has(localId)) photos.set(localId, await preparePhoto(localId));
    return context.app.inject({
      method: 'POST',
      url: '/api/services',
      headers: authHeader(context.technicianToken),
      payload: { localId, machineNumber: 'TG-1', photoObjectKey: photos.get(localId), ...fields },
    });
  }

  const queuedTexts = async () =>
    (await pool.query(`SELECT payload->>'text' AS text FROM telegram_outbox WHERE kind = 'text' ORDER BY id`)).rows.map(
      (row) => row.text as string,
    );

  it('новый черновик ставит сообщение с адресом аппарата, а не только с номером', async () => {
    const before = (await queuedTexts()).length;
    const response = await send(randomUUID(), { gameCounter: 1500, prizeCounter: 200, occurredAt: '2026-01-20T12:00:00Z' });
    assert.equal(response.statusCode, 202, response.body);

    const texts = await queuedTexts();
    assert.equal(texts.length, before + 1);
    const text = texts[texts.length - 1];
    assert.match(text, /^Черновик на разбор: Тестовая улица, 7 \(аппарат TG-1\)\./);
  });

  it('повторная отправка того же черновика с телефона не плодит уведомления', async () => {
    const localId = randomUUID();
    const fields = { gameCounter: 1400, prizeCounter: 210, occurredAt: '2026-01-21T12:00:00Z' };
    const first = await send(localId, fields);
    assert.equal(first.statusCode, 202, first.body);
    const afterFirst = (await queuedTexts()).length;

    const retry = await send(localId, fields);
    assert.equal(retry.statusCode, 202, retry.body);
    assert.equal((await queuedTexts()).length, afterFirst, 'повтор не должен ставить второе сообщение');
  });
});
