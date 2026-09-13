import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, type TestContext } from './helpers.js';

/**
 * Защита от повторения истории с миграцией 06.09 (DECISION-038/043): терминал, физически
 * поставленный раньше, чем его завели в систему, копит непривязанный безнал. Список терминалов
 * теперь показывает эту сумму и дату первой такой транзакции, а привязка с этой даты сразу
 * забирает все деньги, потому что bindTerminal сам вызывает rematchCashless.
 */
describe('терминалы: сводка непривязанного безнала и привязка задним числом', () => {
  let context: TestContext;
  let terminalId: number;

  before(async () => {
    context = await bootstrap();
    await installTestMachine(context, {
      machineNumber: 'UM-1',
      pricePerGame: 10,
      startedAt: '2026-01-01T08:00:00Z',
    });
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: authHeader(context.adminToken),
      payload: { serial: 'T-UM', provider: 'demo' },
    });
    assert.equal(created.statusCode, 200, created.body);
    terminalId = created.json().id;

    const imported = await context.app.inject({
      method: 'POST',
      url: '/api/cashless/import',
      headers: authHeader(context.adminToken),
      payload: {
        provider: 'demo',
        transactions: [
          {
            providerTransactionId: 'um-1',
            terminalExternalId: 'T-UM',
            occurredAt: '2026-01-05T12:00:00Z',
            amount: '100.00',
            paymentType: 'CARD',
          },
          {
            providerTransactionId: 'um-2',
            terminalExternalId: 'T-UM',
            occurredAt: '2026-01-07T12:00:00Z',
            amount: '50.00',
            paymentType: 'CARD',
          },
        ],
      },
    });
    assert.equal(imported.statusCode, 200, imported.body);
  });

  after(async () => {
    await context.app.close();
  });

  const terminalRow = async () => {
    const list = await context.app.inject({
      method: 'GET',
      url: '/api/terminals',
      headers: authHeader(context.adminToken),
    });
    return list.json().find((row: { serial: string }) => row.serial === 'T-UM');
  };

  it('непривязанный безнал терминала виден в списке терминалов', async () => {
    const row = await terminalRow();
    assert.equal(row.unmatched_count, 2);
    assert.equal(Number(row.unmatched_amount), 150);
    assert.equal(new Date(row.earliest_unmatched).toISOString(), '2026-01-05T12:00:00.000Z');
  });

  it('привязка с даты первой непривязанной транзакции забирает весь безнал', async () => {
    const before = await terminalRow();
    const bound = await context.app.inject({
      method: 'POST',
      url: '/api/terminals/bind',
      headers: authHeader(context.adminToken),
      payload: { terminalId, machineNumber: 'UM-1', startedAt: before.earliest_unmatched },
    });
    assert.equal(bound.statusCode, 200, bound.body);

    const after = await terminalRow();
    assert.equal(after.unmatched_count, 0);

    const stored = await pool.query(
      `SELECT match_status, matched_machine_number FROM cashless_transactions WHERE terminal_external_id = 'T-UM'`,
    );
    assert.equal(stored.rowCount, 2);
    for (const row of stored.rows) {
      assert.equal(row.match_status, 'MATCHED');
      assert.equal(row.matched_machine_number, 'UM-1');
    }
  });
});
