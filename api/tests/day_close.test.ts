import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, createStaff, pool, type TestContext } from './helpers.js';

/**
 * Закрытие дня техником: он вводит зарплату за день и бензин со своего телефона, суммы ложатся в
 * тот же гроссбух расходов, что и записи владельца, и потому сами попадают в чистую прибыль.
 *
 * Главное, что здесь проверяется, — защита от двойного счёта. Форма живёт на телефоне, связь
 * рвётся, офлайн-очередь может доставить запись дважды; задвоенная зарплата в отчёте хуже, чем
 * потерянная правка, поэтому повторная отправка обязана перезаписывать, а не добавлять.
 */
describe('закрытие дня техником', () => {
  let context: TestContext;
  let otherTechToken: string;
  let otherTechId: number;

  const closeDay = async (token: string, payload: Record<string, unknown>) => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/day-close',
      headers: authHeader(token),
      payload,
    });
    return { status: response.statusCode, body: response.json() };
  };

  const expensesOf = async (staffId: number) => {
    const result = await pool.query(
      `SELECT category, amount, source, staff_id, created_by
       FROM business_expenses WHERE staff_id = $1 ORDER BY category`,
      [staffId],
    );
    return result.rows;
  };

  before(async () => {
    context = await bootstrap();
    otherTechId = await createStaff('other-tech', 'TECHNICIAN');
    const login = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'other-tech', password: 'secret' },
    });
    otherTechToken = login.json().token;
  });

  after(async () => {
    await context.app.close();
  });

  it('техник закрывает день, суммы попадают в гроссбух расходов', async () => {
    const closed = await closeDay(context.technicianToken, {
      workDate: '2026-09-10',
      salary: '3000',
      fuel: '850.50',
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));

    const rows = await expensesOf(context.technicianId);
    assert.equal(rows.length, 2);
    const byCategory = Object.fromEntries(rows.map((row) => [row.category, row]));
    assert.equal(byCategory.SALARY.amount, '3000.00');
    assert.equal(byCategory.FUEL.amount, '850.50');
    // Обе записи помечены самоотчётом и привязаны к самому технику.
    assert.equal(byCategory.SALARY.source, 'TECHNICIAN');
    assert.equal(Number(byCategory.FUEL.staff_id), context.technicianId);
    assert.equal(Number(byCategory.FUEL.created_by), context.technicianId);
  });

  it('повторная отправка за тот же день перезаписывает, а не удваивает', async () => {
    const again = await closeDay(context.technicianToken, {
      workDate: '2026-09-10',
      salary: '3500',
      fuel: '850.50',
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));

    const rows = await expensesOf(context.technicianId);
    assert.equal(rows.length, 2, 'строк по-прежнему две, а не четыре');
    const salary = rows.find((row) => row.category === 'SALARY');
    assert.equal(salary?.amount, '3500.00', 'сумма заменилась на исправленную');
  });

  it('нулевая сумма убирает запись — техник поправил себя', async () => {
    const zeroed = await closeDay(context.technicianToken, {
      workDate: '2026-09-10',
      salary: '3500',
      fuel: '0',
    });
    assert.equal(zeroed.status, 200, JSON.stringify(zeroed.body));

    const rows = await expensesOf(context.technicianId);
    assert.equal(rows.length, 1, 'бензин за этот день больше не числится');
    assert.equal(rows[0].category, 'SALARY');
  });

  it('день другого техника — отдельная запись, чужую не трогает', async () => {
    const closed = await closeDay(otherTechToken, {
      workDate: '2026-09-10',
      salary: '2000',
      fuel: '400',
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));

    assert.equal((await expensesOf(otherTechId)).length, 2);
    assert.equal(
      (await expensesOf(context.technicianId)).length,
      1,
      'записи первого техника не изменились',
    );
  });

  it('отрицательная сумма и будущая дата отклоняются', async () => {
    const negative = await closeDay(context.technicianToken, {
      workDate: '2026-09-11',
      salary: '-100',
      fuel: '0',
    });
    assert.equal(negative.status, 400);
    assert.equal(negative.body.error, 'INVALID_AMOUNT');

    const future = await closeDay(context.technicianToken, {
      workDate: '2030-01-01',
      salary: '100',
      fuel: '0',
    });
    assert.equal(future.status, 400);
    assert.equal(future.body.error, 'FUTURE_DATE');
  });

  it('техник видит свои закрытые дни и не видит чужие', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/day-close/mine',
      headers: authHeader(otherTechToken),
    });
    assert.equal(response.statusCode, 200);
    const days = response.json() as Array<{ workDate: string; salary: string; fuel: string }>;
    assert.equal(days.length, 1);
    assert.equal(days[0].workDate, '2026-09-10');
    assert.equal(Number(days[0].salary), 2000);
    assert.equal(Number(days[0].fuel), 400);
  });

  it('прочих трат за день может быть несколько — они не перезаписывают друг друга', async () => {
    // Зарплата и бензин одни на день, а парковка, мойка и запчасть за тот же день — разные
    // записи. Если бы уникальный индекс из миграции 019 остался прежним, вторая не сохранилась бы.
    const first = await context.app.inject({
      method: 'POST',
      url: '/api/day-close/other',
      headers: authHeader(context.technicianToken),
      payload: { workDate: '2026-09-10', amount: '300', comment: 'Парковка' },
    });
    assert.equal(first.statusCode, 200, first.body);

    const second = await context.app.inject({
      method: 'POST',
      url: '/api/day-close/other',
      headers: authHeader(context.technicianToken),
      payload: { workDate: '2026-09-10', amount: '750', comment: 'Мойка', photoObjectKey: null },
    });
    assert.equal(second.statusCode, 200, second.body);

    const mine = await context.app.inject({
      method: 'GET',
      url: '/api/day-close/other',
      headers: authHeader(context.technicianToken),
    });
    const rows = mine.json() as Array<{ id: number; amount: string; comment: string }>;
    assert.equal(rows.length, 2, 'обе траты на месте');
    assert.deepEqual(rows.map((row) => row.comment).sort(), ['Мойка', 'Парковка']);
  });

  it('трату можно сохранить без чека, но нельзя без назначения', async () => {
    const noComment = await context.app.inject({
      method: 'POST',
      url: '/api/day-close/other',
      headers: authHeader(context.technicianToken),
      payload: { workDate: '2026-09-10', amount: '100', comment: '  ' },
    });
    assert.equal(noComment.statusCode, 400);
    assert.equal(noComment.json().error, 'COMMENT_REQUIRED');

    // Чек владелец разрешил не требовать: его дают не везде.
    const noReceipt = await context.app.inject({
      method: 'POST',
      url: '/api/day-close/other',
      headers: authHeader(context.technicianToken),
      payload: { workDate: '2026-09-10', amount: '100', comment: 'Без чека' },
    });
    assert.equal(noReceipt.statusCode, 200, noReceipt.body);
    assert.equal(noReceipt.json().photo_object_key, null);
  });

  it('техник убирает свою запись, но не чужую и не запись владельца', async () => {
    const mine = await context.app.inject({
      method: 'GET',
      url: '/api/day-close/other',
      headers: authHeader(context.technicianToken),
    });
    const target = (mine.json() as Array<{ id: number }>)[0];

    const byStranger = await context.app.inject({
      method: 'DELETE',
      url: `/api/day-close/other/${target.id}`,
      headers: authHeader(otherTechToken),
    });
    assert.equal(byStranger.statusCode, 403, 'чужую запись убрать нельзя');

    const byOwner = await context.app.inject({
      method: 'DELETE',
      url: `/api/day-close/other/${target.id}`,
      headers: authHeader(context.technicianToken),
    });
    assert.equal(byOwner.statusCode, 200, byOwner.body);
  });

  it('владелец видит самоотчёты в общем гроссбухе, с именем техника', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/expenses?from=2026-09-01&to=2026-09-30',
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 200);
    const rows = response.json() as Array<Record<string, unknown>>;
    const selfReported = rows.filter((row) => row.source === 'TECHNICIAN');
    assert.ok(selfReported.length >= 3, `ожидались самоотчёты, получено ${selfReported.length}`);
    assert.ok(selfReported.every((row) => typeof row.staff_name === 'string' && row.staff_name));
  });
});
