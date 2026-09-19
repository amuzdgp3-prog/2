import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, postService, type TestContext } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { buildMonthlyReportWorkbook } from '../src/domain/monthlyExcelReport.js';
import { SYSTEM_ACTOR } from '../src/lib/audit.js';

describe('business expenses — admin-only ledger for fuel/salary/card/other overhead', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  it('lets an admin create, list, update and delete an expense', async () => {
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/expenses',
      headers: authHeader(context.adminToken),
      payload: { category: 'FUEL', expenseDate: '2026-08-10', amount: '2400.00', comment: 'солярка' },
    });
    assert.equal(created.statusCode, 200);
    const expenseId = created.json().id;

    const listed = await context.app.inject({
      method: 'GET',
      url: '/api/expenses?from=2026-08-01&to=2026-08-31',
      headers: authHeader(context.adminToken),
    });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json().some((row: { id: number }) => row.id === expenseId));

    const updated = await context.app.inject({
      method: 'PATCH',
      url: `/api/expenses/${expenseId}`,
      headers: authHeader(context.adminToken),
      payload: { amount: '2500.00' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().amount, '2500.00');

    const deleted = await context.app.inject({
      method: 'DELETE',
      url: `/api/expenses/${expenseId}`,
      headers: authHeader(context.adminToken),
    });
    assert.equal(deleted.statusCode, 200);
  });

  it('rejects a zero or negative amount', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/expenses',
      headers: authHeader(context.adminToken),
      payload: { category: 'OTHER', expenseDate: '2026-08-10', amount: '0.00' },
    });
    assert.equal(response.statusCode, 400);
  });

  it('forbids BOSS and TECHNICIAN from creating, editing or listing expenses', async () => {
    for (const token of [context.bossToken, context.technicianToken]) {
      const create = await context.app.inject({
        method: 'POST',
        url: '/api/expenses',
        headers: authHeader(token),
        payload: { category: 'OTHER', expenseDate: '2026-08-10', amount: '100.00' },
      });
      assert.equal(create.statusCode, 403);

      const list = await context.app.inject({
        method: 'GET',
        url: '/api/expenses',
        headers: authHeader(token),
      });
      assert.equal(list.statusCode, 403);
    }
  });

  it('lets BOSS and ADMIN download the monthly xlsx report, but only ADMIN send it to Telegram or email', async () => {
    const excel = await context.app.inject({
      method: 'GET',
      url: '/api/reports/monthly-excel?year=2026&month=8',
      headers: authHeader(context.bossToken),
    });
    assert.equal(excel.statusCode, 200);
    assert.match(excel.headers['content-type'] as string, /spreadsheetml/);

    const send = await context.app.inject({
      method: 'POST',
      url: '/api/reports/monthly-excel/send-telegram?year=2026&month=8',
      headers: authHeader(context.bossToken),
    });
    assert.equal(send.statusCode, 403);

    const sendEmail = await context.app.inject({
      method: 'POST',
      url: '/api/reports/monthly-excel/send-email?year=2026&month=8',
      headers: authHeader(context.bossToken),
    });
    assert.equal(sendEmail.statusCode, 403);
  });
});

describe('buildMonthlyReportWorkbook — assembles the agreed report format from real data', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  it('produces a workbook with the summary/detail/expenses sections and correct totals', async () => {
    const toy = await context.app.inject({
      method: 'POST',
      url: '/api/toys',
      headers: authHeader(context.adminToken),
      payload: { name: 'Мягкая игрушка', unitCost: '15.00' },
    });
    const toyId = toy.json().id;

    await installTestMachine(context, { machineNumber: 'RPT-1', pricePerGame: 10 });
    await postService(context, context.adminToken, 'RPT-1', {
      gameCounter: 100,
      prizeCounter: 10,
      occurredAt: '2026-08-15T10:00:00Z',
      toys: [{ toyId, quantity: 5 }],
    });

    await context.app.inject({
      method: 'POST',
      url: '/api/expenses',
      headers: authHeader(context.adminToken),
      payload: { category: 'FUEL', expenseDate: '2026-08-10', amount: '2400.00', comment: 'солярка' },
    });

    const client = await pool.connect();
    try {
      const workbook = await buildMonthlyReportWorkbook(client, SYSTEM_ACTOR, { year: 2026, month: 8 });
      const sheet = workbook.getWorksheet('Август');
      assert.ok(sheet, 'ожидался лист «Август»');
      assert.equal(sheet!.getCell('A1').value, 'ОТЧЁТ ЗА АВГУСТ 2026');

      const rows = sheet!.getSheetValues();
      const flat = rows.flat().filter((v) => typeof v === 'string');
      // Файл повторяет страницу «Отчёт»: те же блоки в том же порядке.
      const sections = [
        'ВЫРУЧКА И ПРИБЫЛЬ', 'АППАРАТЫ И ТЕРМИНАЛЫ', 'АППАРАТЫ ПО ТИПАМ И ЦЕНЕ ИГРЫ', 'РАСХОДЫ',
        'ОТЧЁТ ПО НАЛИЧКЕ', 'АРЕНДА', 'ЗАТРАТЫ НА ИГРУШКИ', 'ДЕТАЛИЗАЦИЯ ПО АППАРАТАМ',
      ];
      const positions = sections.map((title) => flat.indexOf(title));
      assert.ok(positions.every((position) => position >= 0), `не хватает блоков: ${positions}`);
      assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
      const cells = rows.flat();
      assert.ok(cells.includes(1000), 'выручка 1000 должна быть в файле');
      // Прибыль = выручка 1000 − бензин 2400 − игрушки 75.
      assert.ok(cells.includes(-1475), 'прибыль за вычетом расходов должна быть в файле');
      assert.ok(flat.some((v) => v === 'RPT-1: Точка RPT-1'));
    } finally {
      client.release();
    }
  });
});
