import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, createToy, installTestMachine, pool, postService, type TestContext } from './helpers.js';

/**
 * Отчёт по техникам — факты, а не метрики эффективности (DECISION-046/049). Проверяется главное:
 * служебная запись в отчёт не попадает. На боевых данных под такой записью залита вся история, и
 * без фильтра она заняла бы первую строку с отрывом в два порядка, обесценив сравнение живых людей.
 */
describe('отчёт по техникам', () => {
  let context: TestContext;
  let toyId: number;

  const report = async (query = '') => {
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/reports/technicians${query}`,
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as Array<Record<string, string | number>>;
  };

  before(async () => {
    context = await bootstrap();
    toyId = await createToy(context, 'Мишка', '15.00');
    await installTestMachine(context, { machineNumber: 'TR-A', pricePerGame: 10, startedAt: '2026-01-01T08:00:00Z' });
    await installTestMachine(context, { machineNumber: 'TR-B', pricePerGame: 10, startedAt: '2026-01-01T08:00:00Z' });

    // Обслуживания заводит администратор, а техник проставляется напрямую: у техника нет
    // назначенного доступа к этим аппаратам, а проверяется здесь агрегация отчёта, не права.
    for (const [machine, counter] of [['TR-A', 300], ['TR-B', 500]] as const) {
      const posted = await postService(context, context.adminToken, machine, {
        gameCounter: counter,
        prizeCounter: 0,
        occurredAt: '2026-02-10T10:00:00Z',
        toys: [{ toyId, quantity: 7 }],
      });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
    }
    await pool.query('UPDATE services SET technician_id = $1', [context.technicianId]);
  });

  after(async () => {
    await context.app.close();
  });

  it('считает выезды, аппараты, игрушки и собранные деньги', async () => {
    const rows = await report();
    const tech = rows.find((row) => row.full_name === 'tech');
    assert.ok(tech, 'техник должен быть в отчёте');
    assert.equal(tech!.services, 2);
    assert.equal(tech!.machines, 2, 'два разных аппарата');
    assert.equal(tech!.toys_given, 14, 'по 7 игрушек на каждый выезд');
    assert.equal(Number(tech!.revenue), 8000, '(300 + 500) игр по 10 ₽');
    assert.equal(Number(tech!.toy_cost), 210, '14 игрушек по 15 ₽');
  });

  it('служебная запись не попадает в отчёт', async () => {
    await pool.query(`UPDATE staff SET is_field_technician = FALSE WHERE login = 'tech'`);
    const rows = await report();
    assert.ok(!rows.some((row) => row.full_name === 'tech'), 'снятый флаг убирает запись из отчёта');
    await pool.query(`UPDATE staff SET is_field_technician = TRUE WHERE login = 'tech'`);
    assert.ok((await report()).some((row) => row.full_name === 'tech'), 'и возвращает обратно');
  });

  it('фильтр по периоду сужает выборку', async () => {
    assert.equal((await report('?from=2026-03-01')).length, 0, 'после периода выездов нет');
    assert.ok((await report('?from=2026-02-01&to=2026-02-28')).length > 0);
  });

  it('фильтр по конкретному технику', async () => {
    const rows = await report('?technicianId=999999');
    assert.equal(rows.length, 0, 'несуществующий техник даёт пустой отчёт');
  });
});
