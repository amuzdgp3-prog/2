import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { lastServicesRoi } from '../src/domain/ownerMonthRoi.js';
import { bootstrap, createToy, installTestMachine, pool, postService, type TestContext } from './helpers.js';

/** ROI за последние три обслуживания на конец месяца — столбец детализации месячного отчёта. */
describe('owner month ROI over last three services', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
    const toyId = await createToy(context, 'Мишка', 100);

    // Начальные игрушки 2 × 100 = 200 ₽ — база первого обслуживания.
    await installTestMachine(context, {
      machineNumber: 'ROI-1',
      pricePerGame: 10,
      initialGameCounter: 0,
      initialToys: [{ toyId, quantity: 2 }],
    });
    // Выручка 1000 / 500 / 1000 / 500 / 1000, доложено 300 / 100 / 500 / 0 / 0 ₽.
    const visits: Array<[string, number, number]> = [
      ['2026-02-10T10:00:00Z', 100, 3],
      ['2026-03-05T10:00:00Z', 150, 1],
      ['2026-03-15T10:00:00Z', 250, 5],
      ['2026-03-25T10:00:00Z', 300, 0],
      ['2026-04-05T10:00:00Z', 400, 0],
    ];
    for (const [occurredAt, gameCounter, quantity] of visits) {
      await postService(context, context.adminToken, 'ROI-1', {
        gameCounter,
        prizeCounter: 0,
        occurredAt,
        toys: quantity ? [{ toyId, quantity }] : [],
      });
    }

    // Без начальных игрушек: у первого обслуживания базы нет.
    await installTestMachine(context, { machineNumber: 'ROI-2', pricePerGame: 10, initialGameCounter: 0 });
    await postService(context, context.adminToken, 'ROI-2', {
      gameCounter: 100, prizeCounter: 0, occurredAt: '2026-03-05T10:00:00Z', toys: [{ toyId, quantity: 2 }],
    });
    await postService(context, context.adminToken, 'ROI-2', {
      gameCounter: 150, prizeCounter: 0, occurredAt: '2026-03-15T10:00:00Z',
    });
  });

  after(async () => {
    await context.app.close();
  });

  const roi = async (machines: string[], monthLastDate: string) => {
    const client = await pool.connect();
    try {
      return await lastServicesRoi(client, machines, monthLastDate);
    } finally {
      client.release();
    }
  };

  it('sums the last three services up to the end of the month, not later ones', async () => {
    // Март: обслуживания 05, 15, 25 — выручка 2000 к базе 300 + 100 + 500 = 900.
    assert.equal((await roi(['ROI-1'], '2026-03-31')).get('ROI-1'), '2.22');
  });

  it('takes the earlier months when the month had fewer than three services', async () => {
    // Февраль: одно обслуживание — 1000 к начальным игрушкам 200.
    assert.equal((await roi(['ROI-1'], '2026-02-28')).get('ROI-1'), '5.00');
    // Апрель: 15.03, 25.03, 05.04 — выручка 2500 к базе 100 + 500 + 0 = 600.
    assert.equal((await roi(['ROI-1'], '2026-04-30')).get('ROI-1'), '4.17');
  });

  it('leaves out a service without a cost basis instead of counting its revenue', async () => {
    // Первое обслуживание без начальных игрушек не участвует: 500 к базе 200.
    assert.equal((await roi(['ROI-2'], '2026-03-31')).get('ROI-2'), '2.50');
  });

  it('has no value for a machine without services by the end of the month', async () => {
    const result = await roi(['ROI-1', 'ROI-2'], '2026-01-31');
    assert.equal(result.has('ROI-1'), false);
    assert.equal(result.has('ROI-2'), false);
  });
});
