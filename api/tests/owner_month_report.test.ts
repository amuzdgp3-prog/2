import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, postService, type TestContext } from './helpers.js';

/** Единый отчёт владельца за месяц: страница «Отчёт» и xlsx читают этот же расчёт. */
describe('owner month report', () => {
  let context: TestContext;
  let year: number;
  let month: number;
  let firstLocationId: number;
  let idleLocationId: number;

  const get = (token: string) =>
    context.app.inject({
      method: 'GET',
      url: `/api/reports/owner-month?year=${year}&month=${month}`,
      headers: authHeader(token),
    });

  before(async () => {
    context = await bootstrap();
    const now = new Date();
    year = now.getUTCFullYear();
    month = now.getUTCMonth() + 1;
    const day = String(Math.min(15, now.getUTCDate())).padStart(2, '0');
    const monthText = String(month).padStart(2, '0');
    const occurredAt = `${year}-${monthText}-${day}T00:00:00Z`;
    const expenseDate = `${year}-${monthText}-${day}`;

    // Два аппарата одного типа с РАЗНОЙ ценой игры.
    const first = await installTestMachine(context, { machineNumber: 'OM-1', pricePerGame: 10, initialGameCounter: 0 });
    firstLocationId = first.locationId;
    await installTestMachine(context, { machineNumber: 'OM-2', pricePerGame: 20, initialGameCounter: 0 });

    const service1 = await postService(context, context.adminToken, 'OM-1', { gameCounter: 100, prizeCounter: 0, occurredAt });
    await postService(context, context.adminToken, 'OM-2', { gameCounter: 50, prizeCounter: 0, occurredAt });
    await pool.query(`UPDATE services SET cashless_amount = '400.00' WHERE id = $1`, [
      (service1.body.service as { id: number }).id,
    ]);

    // Терминал только у OM-1.
    const terminal = await context.app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: authHeader(context.adminToken),
      payload: { serial: 'T-OM', provider: 'demo' },
    });
    await context.app.inject({
      method: 'POST',
      url: '/api/terminals/bind',
      headers: authHeader(context.adminToken),
      payload: { terminalId: terminal.json().id, machineNumber: 'OM-1', startedAt: '2026-01-05T00:00:00Z' },
    });

    for (const [category, amount, comment] of [
      ['SALARY', '300.00', ''],
      ['FUEL', '100.00', ''],
      ['OTHER', '50.00', 'Пакеты'],
      ['CARD', '600.00', 'владельцу'],
    ]) {
      await context.app.inject({
        method: 'POST',
        url: '/api/expenses',
        headers: authHeader(context.adminToken),
        payload: { category, expenseDate, amount, comment },
      });
    }

    // Аренда: точка с аппаратом и точка без аппарата (простой).
    const idle = await context.app.inject({
      method: 'POST',
      url: '/api/locations',
      headers: authHeader(context.adminToken),
      payload: { name: 'Пустая точка', timezone: 'Europe/Moscow' },
    });
    idleLocationId = idle.json().id;
    for (const [locationId, amount] of [[firstLocationId, '5000.00'], [idleLocationId, '3000.00']] as const) {
      await context.app.inject({
        method: 'POST',
        url: `/api/locations/${locationId}/rent`,
        headers: authHeader(context.adminToken),
        payload: { monthlyAmount: amount, effectiveFrom: '2026-01-01T00:00:00Z' },
      });
    }
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('splits revenue into cash and cashless and counts machines with and without terminals', async () => {
    const report = (await get(context.adminToken)).json();
    assert.equal(report.revenue, '2000.00');
    assert.equal(report.cashless, '400.00');
    assert.equal(report.cash, '1600.00');
    assert.deepEqual(report.machines, { total: 2, withTerminal: 1, withoutTerminal: 1 });
  });

  it('shows the same machine type as separate rows for different game prices', async () => {
    const report = (await get(context.adminToken)).json();
    assert.equal(report.groups.length, 2);
    assert.deepEqual(
      report.groups.map((group: { gamePrice: string; machines: number }) => [group.gamePrice, group.machines]),
      [['20.00', 1], ['10.00', 1]],
    );
    assert.equal(report.machineRows.length, 2);
  });

  it('keeps CARD out of expenses and profit but inside the cash report', async () => {
    const report = (await get(context.adminToken)).json();
    const keys = report.expenses.lines.map((line: { key: string }) => line.key);
    assert.deepEqual(keys, ['salary', 'fuel', 'other', 'rent', 'toys']);
    // 300 + 100 + 50 + аренда 8000 + игрушки 0.
    assert.equal(report.expenses.total, '8450.00');
    assert.equal(report.profit, '-6450.00');

    const other = report.expenses.lines.find((line: { key: string }) => line.key === 'other');
    assert.equal(other.collapsed, true);
    assert.deepEqual(other.items, [{ label: 'Пакеты', amount: '50.00' }]);

    assert.deepEqual(report.cashReport, {
      collected: '1600.00',
      spentFromCash: '450.00',
      transferredToCard: '600.00',
      onHand: '550.00',
      cashless: '400.00',
      reachedOwner: '1000.00',
    });
  });

  it('separates rent of points without a machine from working points', async () => {
    const report = (await get(context.adminToken)).json();
    assert.equal(report.rent.total, '8000.00');
    assert.equal(report.rent.active, '5000.00');
    assert.equal(report.rent.idle, '3000.00');
    assert.equal(report.rent.activeLocationsCount, 1);
    assert.deepEqual(report.rent.idleLocations, [
      { locationId: idleLocationId, locationName: 'Пустая точка', amount: '3000.00' },
    ]);
  });

  it('is available to the administrator only', async () => {
    assert.notEqual((await get(context.technicianToken)).statusCode, 200);
    assert.notEqual((await get(context.bossToken)).statusCode, 200);
  });

  it('rejects an invalid month', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/reports/owner-month?year=2026&month=13',
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 400);
  });
});
