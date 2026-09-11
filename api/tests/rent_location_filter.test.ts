import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, postService, type TestContext } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { monthlyReport } from '../src/domain/reports.js';
import { SYSTEM_ACTOR } from '../src/lib/audit.js';

/**
 * Аренда привязана к точке, поэтому отчёт по одной точке должен вычитать только её аренду.
 * Раньше rentByMonth брал общий итог на весь бизнес, и выручка одной точки уменьшалась на аренду
 * всех остальных адресов. Расходы на топливо/зарплату/переводы такой привязки не имеют и остаются
 * общими по явному решению владельца — это здесь не проверяется, потому что не менялось.
 */
describe('monthly report — аренда сужается тем же фильтром, что и выручка', () => {
  let context: TestContext;
  let locationA: number;
  let locationB: number;

  const setRent = async (locationId: number, amount: string) => {
    const response = await context.app.inject({
      method: 'POST',
      url: `/api/locations/${locationId}/rent`,
      headers: authHeader(context.adminToken),
      payload: { monthlyAmount: amount, effectiveFrom: '2026-08-01T00:00:00Z' },
    });
    assert.equal(response.statusCode, 200, response.body);
  };

  before(async () => {
    context = await bootstrap();
    for (const [machine, amount] of [['RENTF-A', '10000.00'], ['RENTF-B', '25000.00']] as const) {
      const { locationId } = await installTestMachine(context, {
        machineNumber: machine,
        pricePerGame: 10,
        startedAt: '2026-08-01T00:00:00Z',
      });
      if (machine === 'RENTF-A') locationA = locationId;
      else locationB = locationId;
      await setRent(locationId, amount);
      const posted = await postService(context, context.adminToken, machine, {
        gameCounter: 100,
        prizeCounter: 10,
        occurredAt: '2026-08-20T10:00:00Z',
      });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
    }
  });

  after(async () => {
    await context.app.close();
  });

  const augustExpenses = async (filters: { locationId?: number }): Promise<number> => {
    const client = await pool.connect();
    try {
      const rows = await monthlyReport(client, SYSTEM_ACTOR, { months: 6, ...filters });
      const august = rows.find((row) => String(row.monthStart).startsWith('2026-08'));
      assert.ok(august, 'ожидалась строка за август 2026');
      return Number(august!.expensesTotal);
    } finally {
      client.release();
    }
  };

  it('без фильтра суммирует аренду обеих точек', async () => {
    assert.ok(Math.abs((await augustExpenses({})) - 35000) < 1);
  });

  it('с фильтром по точке берёт аренду только этой точки', async () => {
    assert.ok(Math.abs((await augustExpenses({ locationId: locationA })) - 10000) < 1);
    assert.ok(Math.abs((await augustExpenses({ locationId: locationB })) - 25000) < 1);
  });
});
