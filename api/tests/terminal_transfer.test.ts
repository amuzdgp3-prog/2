import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, type TestContext } from './helpers.js';

/**
 * Перенос терминала с аппарата на аппарат (DECISION-048). Отдельной операции для этого нет и не
 * нужно: привязка уже занятого терминала закрывает прежнюю привязку ровно тем моментом, с которого
 * начинается новая. Здесь проверяется главное следствие — деньги не утекают ни в одну сторону:
 * транзакции до момента переноса остаются за прежним аппаратом, после — уходят новому, и
 * пересопоставление, которое bindTerminal запускает само, этого не ломает.
 */
describe('перенос терминала между аппаратами', () => {
  let context: TestContext;
  let terminalId: number;

  const TRANSFER_AT = '2026-02-10T12:00:00Z';

  before(async () => {
    context = await bootstrap();
    await installTestMachine(context, {
      machineNumber: 'TR-OLD',
      pricePerGame: 10,
      startedAt: '2026-01-01T08:00:00Z',
    });
    await installTestMachine(context, {
      machineNumber: 'TR-NEW',
      pricePerGame: 10,
      startedAt: '2026-01-01T08:00:00Z',
    });

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: authHeader(context.adminToken),
      payload: { serial: 'T-TR', provider: 'demo' },
    });
    assert.equal(created.statusCode, 200, created.body);
    terminalId = created.json().id;

    const bound = await context.app.inject({
      method: 'POST',
      url: '/api/terminals/bind',
      headers: authHeader(context.adminToken),
      payload: { terminalId, machineNumber: 'TR-OLD', startedAt: '2026-01-05T00:00:00Z' },
    });
    assert.equal(bound.statusCode, 200, bound.body);

    // По одной транзакции с каждой стороны от момента переноса и одна ровно в этот момент:
    // граница интервала привязки полуоткрытая, поэтому транзакция «ровно в момент» относится уже
    // к новому аппарату.
    const imported = await context.app.inject({
      method: 'POST',
      url: '/api/cashless/import',
      headers: authHeader(context.adminToken),
      payload: {
        provider: 'demo',
        transactions: [
          { providerTransactionId: 'tr-before', terminalExternalId: 'T-TR', occurredAt: '2026-02-01T12:00:00Z', amount: '100.00', paymentType: 'CARD' },
          { providerTransactionId: 'tr-exact', terminalExternalId: 'T-TR', occurredAt: TRANSFER_AT, amount: '200.00', paymentType: 'CARD' },
          { providerTransactionId: 'tr-after', terminalExternalId: 'T-TR', occurredAt: '2026-02-20T12:00:00Z', amount: '300.00', paymentType: 'CARD' },
        ],
      },
    });
    assert.equal(imported.statusCode, 200, imported.body);
  });

  after(async () => {
    await context.app.close();
  });

  const matchedMachine = async (providerTransactionId: string) => {
    const row = await pool.query(
      `SELECT matched_machine_number, match_status FROM cashless_transactions
       WHERE provider_transaction_id = $1`,
      [providerTransactionId],
    );
    return row.rows[0];
  };

  it('до переноса все транзакции принадлежат первому аппарату', async () => {
    for (const id of ['tr-before', 'tr-exact', 'tr-after']) {
      assert.equal((await matchedMachine(id)).matched_machine_number, 'TR-OLD', id);
    }
  });

  it('перенос делит транзакции по моменту, ничего не теряя и не задваивая', async () => {
    const transferred = await context.app.inject({
      method: 'POST',
      url: '/api/terminals/bind',
      headers: authHeader(context.adminToken),
      payload: { terminalId, machineNumber: 'TR-NEW', startedAt: TRANSFER_AT },
    });
    assert.equal(transferred.statusCode, 200, transferred.body);

    assert.equal((await matchedMachine('tr-before')).matched_machine_number, 'TR-OLD');
    assert.equal((await matchedMachine('tr-exact')).matched_machine_number, 'TR-NEW');
    assert.equal((await matchedMachine('tr-after')).matched_machine_number, 'TR-NEW');

    const total = await pool.query(
      `SELECT count(*)::int AS c, sum(amount) AS s FROM cashless_transactions WHERE terminal_external_id = 'T-TR'`,
    );
    assert.equal(total.rows[0].c, 3, 'ни одна транзакция не потерялась и не задвоилась');
    assert.equal(Number(total.rows[0].s), 600);
  });

  it('прежняя привязка закрыта тем же моментом, которым открыта новая', async () => {
    const bindings = await pool.query(
      `SELECT machine_number, started_at, ended_at FROM terminal_bindings
       WHERE terminal_id = $1 ORDER BY started_at`,
      [terminalId],
    );
    assert.equal(bindings.rowCount, 2);
    assert.equal(bindings.rows[0].machine_number, 'TR-OLD');
    assert.equal(bindings.rows[1].machine_number, 'TR-NEW');
    assert.equal(
      new Date(bindings.rows[0].ended_at).toISOString(),
      new Date(bindings.rows[1].started_at).toISOString(),
      'между привязками не должно быть ни зазора, ни нахлёста',
    );
  });

  it('выручка аппаратов сошлась по разделённому безналу', async () => {
    const byMachine = await pool.query(
      `SELECT matched_machine_number, sum(amount) AS s FROM cashless_transactions
       WHERE terminal_external_id = 'T-TR' GROUP BY 1 ORDER BY 1`,
    );
    const map = new Map(byMachine.rows.map((row) => [row.matched_machine_number, Number(row.s)]));
    assert.equal(map.get('TR-OLD'), 100);
    assert.equal(map.get('TR-NEW'), 500);
  });
});
