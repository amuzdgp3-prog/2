import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  authHeader,
  bootstrap,
  installTestMachine,
  pool,
  postService,
  type TestContext,
} from './helpers.js';

describe('RBAC scope, historical cashless matching and the shared report layer', () => {
  let context: TestContext;
  let ownLocationId: number;
  let foreignLocationId: number;

  before(async () => {
    context = await bootstrap();

    const own = await installTestMachine(context, {
      machineNumber: 'S-OWN',
      pricePerGame: 10,
      initialGameCounter: 0,
    });
    ownLocationId = own.locationId;

    const foreign = await installTestMachine(context, {
      machineNumber: 'S-FOREIGN',
      pricePerGame: 10,
      initialGameCounter: 0,
    });
    foreignLocationId = foreign.locationId;

    await context.app.inject({
      method: 'POST',
      url: '/api/staff/scope',
      headers: authHeader(context.adminToken),
      payload: { staffId: context.technicianId, locationId: ownLocationId },
    });
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('limits a technician to the machines in scope across every endpoint', async () => {
    const machines = await context.app.inject({
      method: 'GET',
      url: '/api/machines',
      headers: authHeader(context.technicianToken),
    });
    const visible = (machines.json() as Array<Record<string, string>>).map((row) => row.machine_number);
    assert.deepEqual(visible, ['S-OWN']);

    const allowed = await postService(context, context.technicianToken, 'S-OWN', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-06-01T10:00:00Z',
    });
    assert.equal(allowed.status, 200);

    const denied = await postService(context, context.technicianToken, 'S-FOREIGN', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-06-01T10:00:00Z',
    });
    assert.equal(denied.status, 403);

    // A foreign machine must not leak through the indirect endpoints either.
    const services = await context.app.inject({
      method: 'GET',
      url: '/api/services?machineNumber=S-FOREIGN',
      headers: authHeader(context.technicianToken),
    });
    assert.equal((services.json() as { rows: unknown[] }).rows.length, 0);

    const report = await context.app.inject({
      method: 'GET',
      url: '/api/reports/financial',
      headers: authHeader(context.technicianToken),
    });
    const reportedMachines = report
      .json()
      .locations.flatMap((location: { machines: Array<{ machineNumber: string }> }) =>
        location.machines.map((machine) => machine.machineNumber),
      );
    assert.deepEqual(reportedMachines, ['S-OWN']);

    const csv = await context.app.inject({
      method: 'GET',
      url: '/api/reports/export.csv',
      headers: authHeader(context.technicianToken),
    });
    assert.ok(!csv.body.includes('S-FOREIGN'), 'export must not bypass technician scope');
  });

  it('rejects mutations from the read-only boss role', async () => {
    const attempt = await postService(context, context.bossToken, 'S-OWN', {
      gameCounter: 200,
      prizeCounter: 0,
      occurredAt: '2026-06-08T10:00:00Z',
    });
    assert.equal(attempt.status, 403);

    const read = await context.app.inject({
      method: 'GET',
      url: '/api/reports/financial',
      headers: authHeader(context.bossToken),
    });
    assert.equal(read.statusCode, 200);
  });

  it('matches cashless through the terminal binding that was active at occurred_at', async () => {
    await installTestMachine(context, {
      machineNumber: 'C-A',
      pricePerGame: 10,
      initialGameCounter: 0,
      locationId: foreignLocationId,
    });
    await installTestMachine(context, {
      machineNumber: 'C-B',
      pricePerGame: 10,
      initialGameCounter: 0,
      locationId: foreignLocationId,
    });

    const terminal = await context.app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: authHeader(context.adminToken),
      payload: { serial: 'T-MOVE', provider: 'demo' },
    });
    const terminalId = terminal.json().id;

    await context.app.inject({
      method: 'POST',
      url: '/api/terminals/bind',
      headers: authHeader(context.adminToken),
      payload: { terminalId, machineNumber: 'C-A', startedAt: '2026-07-01T00:00:00Z' },
    });
    await context.app.inject({
      method: 'POST',
      url: '/api/terminals/bind',
      headers: authHeader(context.adminToken),
      payload: { terminalId, machineNumber: 'C-B', startedAt: '2026-07-10T00:00:00Z' },
    });

    // The rebind closes the C-A binding: its audit row must record what it actually was before
    // (ended_at still NULL), not an empty object — otherwise the audit trail is unreadable.
    const rebindAudit = await pool.query(
      `SELECT old_data, new_data FROM audit_log
       WHERE entity = 'terminal_binding' AND (context->>'reason') = 'rebind'
       ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(rebindAudit.rowCount, 1);
    assert.equal(rebindAudit.rows[0].old_data.machine_number, 'C-A');
    assert.equal(rebindAudit.rows[0].old_data.ended_at, null);
    assert.ok(rebindAudit.rows[0].new_data.ended_at, 'the closed binding must record when it ended');

    const imported = await context.app.inject({
      method: 'POST',
      url: '/api/cashless/import',
      headers: authHeader(context.adminToken),
      payload: {
        provider: 'demo',
        transactions: [
          {
            providerTransactionId: 'tx-early',
            terminalExternalId: 'T-MOVE',
            occurredAt: '2026-07-05T12:00:00Z',
            amount: '100.00',
            paymentType: 'CARD',
          },
          {
            providerTransactionId: 'tx-late',
            terminalExternalId: 'T-MOVE',
            occurredAt: '2026-07-15T12:00:00Z',
            amount: '200.00',
            paymentType: 'CARD',
          },
          {
            providerTransactionId: 'tx-unknown-terminal',
            terminalExternalId: 'T-NOWHERE',
            occurredAt: '2026-07-15T12:00:00Z',
            amount: '50.00',
            paymentType: 'CARD',
          },
        ],
      },
    });
    assert.equal(imported.json().inserted, 3);

    const stored = await pool.query(
      `SELECT provider_transaction_id, matched_machine_number, match_status, unmatched_reason
       FROM cashless_transactions ORDER BY provider_transaction_id`,
    );
    const byId = new Map(stored.rows.map((row) => [row.provider_transaction_id, row]));

    assert.equal(byId.get('tx-early').matched_machine_number, 'C-A');
    assert.equal(byId.get('tx-late').matched_machine_number, 'C-B');
    assert.equal(byId.get('tx-unknown-terminal').match_status, 'UNMATCHED');
    assert.equal(byId.get('tx-unknown-terminal').unmatched_reason, 'unknown terminal');

    // A repeated import of the same payload must be a no-op.
    const replay = await context.app.inject({
      method: 'POST',
      url: '/api/cashless/import',
      headers: authHeader(context.adminToken),
      payload: {
        provider: 'demo',
        transactions: [
          {
            providerTransactionId: 'tx-early',
            terminalExternalId: 'T-MOVE',
            occurredAt: '2026-07-05T12:00:00Z',
            amount: '100.00',
            paymentType: 'CARD',
          },
        ],
      },
    });
    assert.equal(replay.json().inserted, 0);
    assert.equal(replay.json().duplicates, 1);
  });

  it('builds a deterministic fingerprint when the provider supplies no transaction id', async () => {
    const first = await context.app.inject({
      method: 'POST',
      url: '/api/cashless/import',
      headers: authHeader(context.adminToken),
      payload: {
        provider: 'nofid',
        transactions: [
          {
            terminalExternalId: 'T-MOVE',
            occurredAt: '2026-07-20T12:00:00Z',
            amount: '75.50',
            paymentType: 'CARD',
          },
        ],
      },
    });
    assert.equal(first.json().inserted, 1);

    const second = await context.app.inject({
      method: 'POST',
      url: '/api/cashless/import',
      headers: authHeader(context.adminToken),
      payload: {
        provider: 'nofid',
        transactions: [
          {
            terminalExternalId: 'T-MOVE',
            occurredAt: '2026-07-20T12:00:00Z',
            amount: '75.50',
            paymentType: 'CARD',
          },
        ],
      },
    });
    assert.equal(second.json().inserted, 0, 'the fingerprint must deduplicate the replay');
  });

  it('folds matched cashless into the service period and keeps location totals consistent', async () => {
    await postService(context, context.adminToken, 'C-B', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-07-31T23:00:00Z',
    });

    const service = await pool.query(
      `SELECT revenue, cashless_amount, cash_amount FROM services WHERE machine_number = 'C-B'`,
    );
    // Only the transactions that happened while C-B held the terminal belong to this period:
    // 200.00 (tx-late) plus the 75.50 fingerprint transaction, both after the 10 July rebinding.
    // The 100.00 transaction from 5 July stays with C-A and is never counted here.
    assert.equal(service.rows[0].revenue, '1000.00');
    assert.equal(service.rows[0].cashless_amount, '275.50');
    assert.equal(service.rows[0].cash_amount, '724.50');

    const machineA = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM cashless_transactions
       WHERE matched_machine_number = 'C-A'`,
    );
    assert.equal(machineA.rows[0].total, '100.00');

    const yearStart = `${new Date().getUTCFullYear()}-01-01`;
    const today = new Date().toISOString().slice(0, 10);
    const report = await context.app.inject({
      method: 'GET',
      url: `/api/reports/financial?from=${yearStart}&to=${today}`,
      headers: authHeader(context.adminToken),
    });
    const body = report.json() as {
      locations: Array<{ revenue: string; machines: Array<{ revenue: string }> }>;
    };

    for (const location of body.locations) {
      const machineSum = location.machines.reduce(
        (total, machine) => total + Number(machine.revenue),
        0,
      );
      assert.equal(
        Number(location.revenue),
        machineSum,
        'location total must equal the sum of its machine rows',
      );
    }

    const dashboard = await context.app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: authHeader(context.adminToken),
    });
    assert.equal(
      dashboard.json().revenue.yearToDate,
      report.json().totals.revenue,
      'dashboard and report must come from the same calculation layer',
    );
  });

  it('audits every business mutation inside the same transaction', async () => {
    const audit = await pool.query(
      `SELECT entity, action, COUNT(*)::int AS count FROM audit_log
       GROUP BY entity, action ORDER BY entity`,
    );
    const entities = new Set(audit.rows.map((row) => row.entity));

    for (const expected of ['location', 'machine', 'placement', 'service', 'terminal_binding']) {
      assert.ok(entities.has(expected), `audit must cover ${expected} mutations`);
    }

    const serviceAudit = await pool.query(
      `SELECT new_data FROM audit_log WHERE entity = 'service' AND action = 'INSERT' LIMIT 1`,
    );
    assert.ok(
      serviceAudit.rows[0].new_data.revenue !== undefined,
      'audit must record the stored row, not the request payload',
    );
  });
});
