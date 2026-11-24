// Run inside the production API container with /app as cwd:
// docker exec -i site2-api node --input-type=module < this-file
// Save a database backup on the server first. Never commit credentials or payment rows.
import assert from 'node:assert/strict';
import { pool, withTransaction } from './dist/db/pool.js';
import { importCashless, rematchCashless } from './dist/commands/cashless.js';
import { fetchIvendMachines, fetchIvendSales, ivendLogin } from './dist/integrations/ivend.js';
import { SYSTEM_ACTOR, auditUpdate } from './dist/lib/audit.js';
import { lockLocationLifecycle, lockMachines } from './dist/lib/locks.js';

const machine = '150';
const from = new Date('2026-11-12T08:00:00+03:00');
const until = new Date();
try {
  const initial = await pool.query(`
    SELECT b.*, t.serial, p.id AS placement_id, p.started_at AS placement_start
    FROM terminal_bindings b JOIN terminals t ON t.id = b.terminal_id
    JOIN machine_placements p ON p.machine_number = b.machine_number AND p.ended_at IS NULL
    WHERE b.machine_number = $1 AND b.ended_at IS NULL`, [machine]);
  assert.equal(initial.rowCount, 1, 'Expected one active terminal and placement');
  const binding = initial.rows[0];
  assert.ok(new Date(binding.placement_start) <= from, 'Binding predates installation');
  const settings = await pool.query("SELECT login, password FROM parser_settings WHERE provider = 'ivend'");
  assert.ok(settings.rows[0]?.login && settings.rows[0]?.password, 'iVend is not configured');
  const auth = await ivendLogin(settings.rows[0].login, settings.rows[0].password);
  assert.ok(auth.ok && auth.token, 'iVend login failed');
  const listing = await fetchIvendMachines(auth.token);
  const machines = [...new Map(listing.machines.filter(m => m.terminalUid === binding.serial)
    .map(m => [m.machineId, m])).values()];
  assert.equal(machines.length, 1, 'Terminal must identify exactly one iVend machine');
  const source = machines[0];
  const fetched = await fetchIvendSales(auth.token, source.machineId, from.getTime(), until.getTime());
  assert.ok(fetched.sales.length < 40000, 'Pagination limit reached; refusing incomplete import');
  assert.ok(fetched.sales.every(s => s.createdAtMs >= from.getTime() && s.createdAtMs <= until.getTime()),
    'Provider returned sales outside the requested window');
  const payments = fetched.sales.filter(s => s.type === 'CASHLESS').map(s => ({
    providerTransactionId: String(s.id), terminalExternalId: binding.serial,
    occurredAt: new Date(s.createdAtMs).toISOString(), amount: s.price, paymentType: 'CASHLESS',
    raw: { machineId: source.machineId, machineName: source.name },
  }));
  console.log(JSON.stringify({ stage: 'fetched', cashless: payments.length, pages: fetched.pagesFetched }));

  const result = await withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await lockLocationLifecycle(client, Number(binding.location_id));
    await client.query('SELECT id FROM terminals WHERE id = $1 FOR UPDATE', [binding.terminal_id]);
    await lockMachines(client, [machine]);
    const rows = await client.query('SELECT * FROM terminal_bindings WHERE terminal_id = $1 FOR UPDATE', [binding.terminal_id]);
    assert.equal(rows.rowCount, 1, 'Terminal has other historical bindings; review required');
    const before = rows.rows[0];
    assert.equal(before.id, binding.id);
    assert.equal(before.machine_number, machine);
    assert.equal(before.ended_at, null);
    assert.equal(new Date(before.started_at).getTime(), new Date(binding.started_at).getTime(), 'Binding changed during fetch');
    const placement = await client.query('SELECT * FROM machine_placements WHERE id = $1 FOR UPDATE', [binding.placement_id]);
    assert.equal(placement.rows[0]?.ended_at, null);
    assert.equal(new Date(placement.rows[0].started_at).getTime(), new Date(binding.placement_start).getTime());
    const conflicting = await client.query(`SELECT 1 FROM cashless_transactions
      WHERE terminal_external_id = $1 AND occurred_at >= $2
        AND matched_machine_number IS NOT NULL AND matched_machine_number <> $3 LIMIT 1`,
    [binding.serial, from, machine]);
    assert.equal(conflicting.rowCount, 0, 'Payments already belong to another machine');
    const updated = await client.query('UPDATE terminal_bindings SET started_at = $2 WHERE id = $1 RETURNING *', [binding.id, from]);
    await auditUpdate(client, SYSTEM_ACTOR, 'terminal_binding', binding.id, before, updated.rows[0], {
      reason: 'owner_requested_machine150_binding_date_and_cashless_backfill_20261124',
    });
    const imported = await importCashless(client, SYSTEM_ACTOR, 'ivend', payments);
    const rematched = await rematchCashless(client, SYSTEM_ACTOR, {
      from: from.toISOString(), terminalId: Number(binding.terminal_id), onlyUnmatched: true,
    });
    const missing = await client.query(`SELECT 1 FROM cashless_transactions
      WHERE terminal_external_id = $1 AND occurred_at >= $2
        AND (match_status <> 'MATCHED' OR matched_machine_number IS DISTINCT FROM $3) LIMIT 1`,
    [binding.serial, from, machine]);
    assert.equal(missing.rowCount, 0, 'Some payments in the binding period remain unmatched');
    const totals = await client.query(`SELECT match_status, matched_machine_number, count(*)::int AS count,
      sum(amount) AS amount, min(occurred_at) AS first_at, max(occurred_at) AS last_at
      FROM cashless_transactions WHERE terminal_external_id = $1 GROUP BY match_status, matched_machine_number`, [binding.serial]);
    const missingIds = await client.query(`SELECT count(*)::int AS count
      FROM unnest($1::text[]) AS expected(id) WHERE NOT EXISTS
      (SELECT 1 FROM cashless_transactions t WHERE t.provider = 'ivend' AND t.provider_transaction_id = expected.id
       AND t.matched_machine_number = $2 AND t.match_status = 'MATCHED')`, [payments.map(p => p.providerTransactionId), machine]);
    assert.equal(missingIds.rows[0].count, 0, 'Not every fetched payment was matched');
    return { inserted: imported.inserted, duplicates: imported.duplicates, rematched: rematched.processed, totals: totals.rows };
  });
  // Do not create a global parser SUCCESS checkpoint for a single-terminal backfill.
  console.log(JSON.stringify({ stage: 'committed', bindingFrom: from.toISOString(), ...result }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
