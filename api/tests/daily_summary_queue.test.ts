import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { enqueueScheduledDailySummary } from '../src/commands/dailySummary.js';
import { dailySummaryDue } from '../src/jobs/dailySummaryScheduler.js';
import { authHeader, bootstrap, pool, type TestContext } from './helpers.js';

/** Ежедневная сводка → очередь Telegram (DECISION-093). */
describe('ежедневная сводка: когда пора', () => {
  it('до 21:30 по Москве — рано, с 21:30 до полуночи — дата этого дня', () => {
    // 18:29 UTC = 21:29 МСК, 18:30 UTC = 21:30 МСК, 20:59 UTC = 23:59 МСК, 21:00 UTC = 00:00 МСК след. дня.
    assert.equal(dailySummaryDue(Date.parse('2026-10-27T18:29:00Z')), null);
    assert.equal(dailySummaryDue(Date.parse('2026-10-27T18:30:00Z')), '2026-10-27');
    assert.equal(dailySummaryDue(Date.parse('2026-10-27T20:59:00Z')), '2026-10-27');
    assert.equal(dailySummaryDue(Date.parse('2026-10-27T21:00:00Z')), null, 'после полуночи по Москве — уже новый день, и для него рано');
  });
});

describe('ежедневная сводка: постановка в очередь', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  const summaries = async () =>
    (await pool.query(`SELECT payload FROM telegram_outbox WHERE payload->>'text' LIKE '📋 Итоги дня%' ORDER BY id`)).rows.map(
      (row) => row.payload as { text: string; dailySummary?: string },
    );

  it('плановая ставится ровно один раз за дату — перезапуск API после 21:30 не дублирует', async () => {
    const client = await pool.connect();
    try {
      assert.equal(await enqueueScheduledDailySummary(client, '2026-02-01'), true);
      assert.equal(await enqueueScheduledDailySummary(client, '2026-02-01'), false);
      assert.equal(await enqueueScheduledDailySummary(client, '2026-02-02'), true, 'другая дата — своя сводка');
    } finally {
      client.release();
    }
    const dated = (await summaries()).filter((p) => p.dailySummary);
    assert.deepEqual(dated.map((p) => p.dailySummary), ['2026-02-01', '2026-02-02']);
  });

  it('ручная отправка не отменяет плановую и может повторяться', async () => {
    for (let i = 0; i < 2; i += 1) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/reports/daily-summary/send?date=2026-02-03',
        headers: authHeader(context.adminToken),
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    const client = await pool.connect();
    try {
      assert.equal(await enqueueScheduledDailySummary(client, '2026-02-03'), true, 'плановая всё равно встаёт');
    } finally {
      client.release();
    }
    const forDay = (await summaries()).filter((p) => p.text.includes('3 февраля'));
    assert.equal(forDay.length, 3, 'две ручные + одна плановая');
  });

  it('ручная отправка: только администратор, дата проверяется', async () => {
    const tech = await context.app.inject({
      method: 'POST',
      url: '/api/reports/daily-summary/send',
      headers: authHeader(context.technicianToken),
    });
    assert.equal(tech.statusCode, 403);

    const bad = await context.app.inject({
      method: 'POST',
      url: '/api/reports/daily-summary/send?date=27.10.2026',
      headers: authHeader(context.adminToken),
    });
    assert.equal(bad.statusCode, 400);
  });
});
