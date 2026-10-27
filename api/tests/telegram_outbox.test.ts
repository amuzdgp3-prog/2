import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MAX_SEND_ATTEMPTS } from '../src/commands/telegramOutbox.js';
import { authHeader, bootstrap, pool, type TestContext } from './helpers.js';

/**
 * Очередь исходящих сообщений в Telegram (DECISION-092): сервер в Telegram не стучится сам,
 * только ставит запись и отдаёт её внешнему релею по этим же роутам.
 */
describe('telegram outbox', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('постановка ежемесячного отчёта в очередь не стучится в Telegram и сразу отвечает ok', async () => {
    const now = new Date();
    const response = await context.app.inject({
      method: 'POST',
      url: `/api/reports/monthly-excel/send-telegram?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`,
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
  });

  it('очередь: отдаёт неотправленное, позволяет скачать файл отчёта и отметить отправленным', async () => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    await context.app.inject({
      method: 'POST',
      url: `/api/reports/monthly-excel/send-telegram?year=${year}&month=${month}`,
      headers: authHeader(context.adminToken),
    });

    const pending = await context.app.inject({
      method: 'GET',
      url: '/api/telegram-outbox/pending',
      headers: authHeader(context.adminToken),
    });
    assert.equal(pending.statusCode, 200);
    const rows = pending.json() as Array<{ id: number; kind: string; payload: { year: number; month: number } }>;
    const row = rows.find((r) => r.kind === 'monthly_report' && r.payload.year === year && r.payload.month === month);
    assert.ok(row, 'постановленная запись должна быть в списке неотправленного');

    const file = await context.app.inject({
      method: 'GET',
      url: `/api/telegram-outbox/${row!.id}/file`,
      headers: authHeader(context.adminToken),
    });
    assert.equal(file.statusCode, 200);
    assert.equal(
      file.headers['content-type'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    assert.ok(file.rawPayload.length > 0, 'файл должен быть непустым');

    const ack = await context.app.inject({
      method: 'POST',
      url: `/api/telegram-outbox/${row!.id}/ack`,
      headers: authHeader(context.adminToken),
    });
    assert.equal(ack.statusCode, 200);

    const pendingAfter = await context.app.inject({
      method: 'GET',
      url: '/api/telegram-outbox/pending',
      headers: authHeader(context.adminToken),
    });
    const stillThere = (pendingAfter.json() as Array<{ id: number }>).some((r) => r.id === row!.id);
    assert.equal(stillThere, false, 'отмеченная отправленной запись не должна отдаваться как неотправленная');
  });

  it('неудачная попытка остаётся в очереди и запоминает ошибку, а не теряется', async () => {
    const now = new Date();
    await context.app.inject({
      method: 'POST',
      url: `/api/reports/monthly-excel/send-telegram?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`,
      headers: authHeader(context.adminToken),
    });
    const pending = await context.app.inject({
      method: 'GET',
      url: '/api/telegram-outbox/pending',
      headers: authHeader(context.adminToken),
    });
    const [row] = pending.json() as Array<{ id: number; attempts: number }>;

    const fail = await context.app.inject({
      method: 'POST',
      url: `/api/telegram-outbox/${row.id}/fail`,
      headers: authHeader(context.adminToken),
      payload: { error: 'сеть недоступна' },
    });
    assert.equal(fail.statusCode, 200);

    const pendingAfter = await context.app.inject({
      method: 'GET',
      url: '/api/telegram-outbox/pending',
      headers: authHeader(context.adminToken),
    });
    const after = (pendingAfter.json() as Array<{ id: number; attempts: number; last_error: string }>).find(
      (r) => r.id === row.id,
    );
    assert.ok(after, 'строка после неудачной попытки должна оставаться в очереди для повтора');
    assert.equal(after!.attempts, row.attempts + 1);
    assert.equal(after!.last_error, 'сеть недоступна');
  });

  it('технику недоступна очередь — это админский инструмент', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/telegram-outbox/pending',
      headers: authHeader(context.technicianToken),
    });
    assert.equal(response.statusCode, 403);
  });

  it('POST /api/telegram-outbox: единственная внешняя точка входа, нужна backup.sh (bash, не Node)', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/telegram-outbox',
      headers: authHeader(context.adminToken),
      payload: { text: 'Бэкап 2.apixspb.ru не прошёл: тест' },
    });
    assert.equal(response.statusCode, 200);
    const { id } = response.json() as { id: number };
    assert.ok(id > 0);

    const pending = await context.app.inject({
      method: 'GET',
      url: '/api/telegram-outbox/pending',
      headers: authHeader(context.adminToken),
    });
    const row = (pending.json() as Array<{ id: number; kind: string; payload: { text: string } }>).find(
      (r) => r.id === id,
    );
    assert.equal(row?.kind, 'text');
    assert.equal(row?.payload.text, 'Бэкап 2.apixspb.ru не прошёл: тест');
  });

  it('POST /api/telegram-outbox: пустой текст отклоняется', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/telegram-outbox',
      headers: authHeader(context.adminToken),
      payload: { text: '   ' },
    });
    assert.equal(response.statusCode, 400);
  });

  it('безнадёжное сообщение перестаёт выдаваться релею после потолка попыток, а не дёргается вечно', async () => {
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/telegram-outbox',
      headers: authHeader(context.adminToken),
      payload: { text: 'никогда не уйдёт' },
    });
    const { id } = created.json() as { id: number };

    for (let i = 0; i < MAX_SEND_ATTEMPTS; i += 1) {
      const fail = await context.app.inject({
        method: 'POST',
        url: `/api/telegram-outbox/${id}/fail`,
        headers: authHeader(context.adminToken),
        payload: { error: `попытка ${i + 1}` },
      });
      assert.equal(fail.statusCode, 200);
    }

    const pending = await context.app.inject({
      method: 'GET',
      url: '/api/telegram-outbox/pending',
      headers: authHeader(context.adminToken),
    });
    const stillOffered = (pending.json() as Array<{ id: number }>).some((r) => r.id === id);
    assert.equal(stillOffered, false, 'после потолка попыток строка не должна выдаваться релею');

    // Но сама строка не исчезает: по ней видно, что не ушло и почему.
    const left = await pool.query('SELECT attempts, last_error, sent_at FROM telegram_outbox WHERE id = $1', [id]);
    assert.equal(left.rows[0].attempts, MAX_SEND_ATTEMPTS);
    assert.equal(left.rows[0].sent_at, null);
    assert.equal(left.rows[0].last_error, `попытка ${MAX_SEND_ATTEMPTS}`);
  });
});
