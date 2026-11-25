// Run from /app in the API container using: node --input-type=module < this-file.
// Default: read-only preview. Apply only after a verified server-side database backup,
// with SITE2_APPLY_TERMINAL_HISTORY=1 and SITE2_BACKUP_CONFIRMED=1.
// Owner confirmed that all historical payments of these five terminals belong to
// their current addresses. No other terminal, placement, counter or parser checkpoint is changed.
import assert from 'node:assert/strict';

const { pool, withTransaction } = await import(`file://${process.cwd()}/dist/db/pool.js`);
const { importCashless, rematchCashless } = await import(`file://${process.cwd()}/dist/commands/cashless.js`);
const { ivendLogin, fetchIvendMachines } = await import(`file://${process.cwd()}/dist/integrations/ivend.js`);
const { SYSTEM_ACTOR, auditUpdate } = await import(`file://${process.cwd()}/dist/lib/audit.js`);
const { lockLocationLifecycle, lockMachines } = await import(`file://${process.cwd()}/dist/lib/locks.js`);

const targets = ['101', '102', '103', '104', '105'];
const apply = process.env.SITE2_APPLY_TERMINAL_HISTORY === '1';
const until = Date.now();
const reason = 'owner_confirmed_terminal_history_addresses_20261125';
const query = `query getSalesByMachine($filter: MachineSalesFilterInput!, $sort: SortInput!, $machineId: Int!, $pagination: PaginationInput!) {
  getSalesByMachine(filter:$filter,sort:$sort,machineId:$machineId,pagination:$pagination) {
    sales { id type price createdAt }
  }
}`;
const cents = value => {
  const text = String(value);
  assert.match(text, /^-?\d+(\.\d{1,2})?$/, 'Unexpected money scale');
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * (text.startsWith('-') ? -1n : 1n);
};
const money = value => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;

async function fetchAllSales(token, machineId) {
  const all = [];
  for (let page = 0; page < 1000; page += 1) {
    let body;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(process.env.IVEND_GRAPHQL_URL ?? 'https://graphql.ivend.pro/graphql', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ operationName: 'getSalesByMachine', query, variables: {
            machineId, filter: { name: '', type: null, period: { from: 0, to: until } },
            sort: { sortField: 'createdAt', sortOrder: 'DESC' }, pagination: { page, pageSize: 200 },
          } }), signal: AbortSignal.timeout(30000),
        });
        assert.ok(response.ok, `iVend HTTP ${response.status}`);
        body = await response.json();
        assert.ok(!body.errors?.length && Array.isArray(body.data?.getSalesByMachine?.sales), 'Invalid iVend sales response');
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    const sales = body.data.getSalesByMachine.sales;
    // The provider's totalRecords does not reliably describe the filtered window.
    // An explicit empty page is required, even after a short nonempty page.
    if (sales.length === 0) {
      assert.equal(new Set(all.map(sale => String(sale.id))).size, all.length, 'Repeated source payment IDs');
      return all;
    }
    for (const sale of sales) {
      assert.ok(Number.isSafeInteger(sale.createdAt) && sale.createdAt >= 0 && sale.createdAt <= until, 'Invalid source timestamp');
      assert.ok(Number.isFinite(sale.price) && sale.price >= 0, 'Invalid source amount');
      assert.ok(sale.id !== null && sale.id !== undefined, 'Missing source payment ID');
    }
    all.push(...sales);
  }
  throw new Error('Source pagination limit reached; refusing incomplete history');
}

async function loadBindings(client) {
  return (await client.query(`SELECT b.*, t.serial, p.id AS placement_id, p.started_at AS placement_start
    FROM terminal_bindings b JOIN terminals t ON t.id=b.terminal_id
    JOIN machine_placements p ON p.machine_number=b.machine_number AND p.ended_at IS NULL
    WHERE b.machine_number=ANY($1::text[]) AND b.ended_at IS NULL ORDER BY b.machine_number`, [targets])).rows;
}

async function services(client) {
  return (await client.query(`SELECT id,machine_number,placement_id,service_date,occurred_at,technician_id,kind,
    game_counter,prize_counter,test_games,new_games,new_prizes,price_per_game_snapshot,counter_divisor_applied,
    revenue,toy_cost,cashless_amount,cash_amount FROM services
    WHERE machine_number=ANY($1::text[]) ORDER BY id`, [targets])).rows;
}

function deltas(before, after) {
  assert.equal(before.length, after.length, 'Services changed during correction');
  const totals = new Map();
  for (let i = 0; i < before.length; i += 1) {
    const old = before[i], next = after[i];
    for (const key of Object.keys(old).filter(key => !['cashless_amount', 'cash_amount'].includes(key))) {
      assert.equal(String(next[key]), String(old[key]), `Unexpected service mutation: ${old.id}/${key}`);
    }
    const cashless = cents(next.cashless_amount) - cents(old.cashless_amount);
    assert.equal(cents(next.cash_amount) - cents(old.cash_amount), -cashless, 'Cash conservation failed');
    const key = `${old.technician_id ?? 'unassigned'}:${old.service_date.slice(0, 7)}`;
    const item = totals.get(key) ?? { technicianId: old.technician_id, month: old.service_date.slice(0, 7), cashless: 0n };
    item.cashless += cashless;
    totals.set(key, item);
  }
  return [...totals.values()].filter(row => row.cashless !== 0n)
    .map(row => ({ technicianId: row.technicianId, month: row.month, cashlessIncrease: money(row.cashless), cashDecrease: money(-row.cashless) }));
}

try {
  if (apply) assert.equal(process.env.SITE2_BACKUP_CONFIRMED, '1', 'A verified database backup is required');
  const prep = await withTransaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const bindings = await loadBindings(client);
    assert.deepEqual(bindings.map(row => row.machine_number), targets, 'Expected exactly five active bindings and placements');
    const settings = (await client.query("SELECT login,password FROM parser_settings WHERE provider='ivend'")).rows[0];
    assert.ok(settings?.login && settings.password, 'Missing iVend configuration');
    return { bindings, settings };
  });
  const auth = await ivendLogin(prep.settings.login, prep.settings.password);
  assert.ok(auth.ok && auth.token, 'iVend authentication failed');
  const inventory = await fetchIvendMachines(auth.token);
  assert.ok(inventory.machines.length < 2000, 'Inventory pagination may be incomplete');
  const plans = [];
  for (const binding of prep.bindings) {
    const sources = [...new Map(inventory.machines.filter(row => row.terminalUid === binding.serial)
      .map(row => [row.machineId, row])).values()];
    assert.equal(sources.length, 1, 'Terminal must identify exactly one iVend machine');
    const source = sources[0];
    const sales = (await fetchAllSales(auth.token, source.machineId)).filter(sale => sale.type === 'CASHLESS');
    assert.ok(sales.length > 0, 'No source cashless history');
    const first = new Date(Math.min(...sales.map(sale => sale.createdAt)));
    assert.ok(first >= new Date(binding.placement_start), 'Source predates active placement; requires separate review');
    const startedAt = new Date(Math.min(first.getTime(), new Date(binding.started_at).getTime())).toISOString();
    const payments = sales.map(sale => ({ providerTransactionId: String(sale.id), terminalExternalId: binding.serial,
      occurredAt: new Date(sale.createdAt).toISOString(), amount: sale.price, paymentType: 'CASHLESS',
      raw: { machineId: source.machineId, machineName: source.name } }));
    plans.push({ binding, startedAt, payments });
  }
  const allIds = plans.flatMap(plan => plan.payments.map(payment => payment.providerTransactionId));
  assert.equal(new Set(allIds).size, allIds.length, 'Payment IDs overlap across terminals');
  const result = await withTransaction(async client => {
    if (!apply) await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='90s'");
    if (apply) {
      for (const id of [...new Set(prep.bindings.map(row => Number(row.location_id)))].sort((a,b) => a-b)) await lockLocationLifecycle(client, id);
      for (const id of [...new Set(prep.bindings.map(row => Number(row.terminal_id)))].sort((a,b) => a-b)) await client.query('SELECT id FROM terminals WHERE id=$1 FOR UPDATE', [id]);
      await lockMachines(client, targets);
    }
    const current = await loadBindings(client);
    assert.deepEqual(current, prep.bindings, 'Bindings or placements changed during network fetch');
    const before = await services(client);
    const report = [];
    for (const plan of plans) {
      const { binding, startedAt, payments } = plan;
      const history = (await client.query('SELECT * FROM terminal_bindings WHERE terminal_id=$1', [binding.terminal_id])).rows;
      assert.equal(history.length, 1, 'Terminal has other historical bindings; requires review');
      const overlaps = await client.query(`SELECT 1 FROM terminal_bindings WHERE machine_number=$1 AND terminal_id<>$2
        AND tstzrange(started_at,ended_at) && tstzrange($3::timestamptz,NULL) LIMIT 1`,
      [binding.machine_number, binding.terminal_id, startedAt]);
      assert.equal(overlaps.rowCount, 0, 'Another terminal covers the proposed historical period');
      const conflicts = await client.query(`SELECT 1 FROM cashless_transactions WHERE terminal_external_id=$1
        AND matched_machine_number IS NOT NULL AND matched_machine_number<>$2 LIMIT 1`, [binding.serial, binding.machine_number]);
      assert.equal(conflicts.rowCount, 0, 'Terminal history belongs to another machine');
      const existing = (await client.query(`SELECT provider_transaction_id,terminal_external_id,occurred_at,amount
        FROM cashless_transactions WHERE provider='ivend' AND provider_transaction_id=ANY($1::text[])`,
      [payments.map(payment => payment.providerTransactionId)])).rows;
      const byId = new Map(existing.map(row => [row.provider_transaction_id, row]));
      for (const payment of payments) {
        const old = byId.get(payment.providerTransactionId);
        if (!old) continue;
        assert.equal(old.terminal_external_id, binding.serial, 'Existing payment belongs to another terminal');
        assert.equal(new Date(old.occurred_at).toISOString(), payment.occurredAt, 'Existing source timestamp differs');
        assert.equal(cents(old.amount), cents(payment.amount), 'Existing source amount differs');
      }
      let imported, rematched;
      if (apply) {
        if (new Date(binding.started_at).toISOString() !== startedAt) {
          const after = (await client.query('UPDATE terminal_bindings SET started_at=$2 WHERE id=$1 RETURNING *', [binding.id, startedAt])).rows[0];
          await auditUpdate(client, SYSTEM_ACTOR, 'terminal_binding', binding.id, history[0], after, { reason });
        }
        imported = await importCashless(client, SYSTEM_ACTOR, 'ivend', payments);
        rematched = await rematchCashless(client, SYSTEM_ACTOR, { terminalId: binding.terminal_id });
        const stored = (await client.query(`SELECT provider_transaction_id,terminal_external_id,occurred_at,amount,
          match_status,matched_machine_number FROM cashless_transactions
          WHERE provider='ivend' AND provider_transaction_id=ANY($1::text[])`, [payments.map(payment => payment.providerTransactionId)])).rows;
        assert.equal(stored.length, payments.length, 'Not all source payments were saved');
        for (const row of stored) {
          assert.equal(row.match_status, 'MATCHED', 'Source payment remains unmatched');
          assert.equal(row.matched_machine_number, binding.machine_number, 'Source payment was assigned to another machine');
        }
        const unmatched = await client.query(`SELECT 1 FROM cashless_transactions WHERE terminal_external_id=$1
          AND (match_status<>'MATCHED' OR matched_machine_number IS DISTINCT FROM $2) LIMIT 1`, [binding.serial, binding.machine_number]);
        assert.equal(unmatched.rowCount, 0, 'Some stored terminal payments remain unmatched');
      }
      report.push({ machine: binding.machine_number, from: startedAt, sourceCount: payments.length,
        missingCount: payments.length - existing.length,
        missingAmount: money(payments.filter(payment => !byId.has(payment.providerTransactionId)).reduce((sum,payment) => sum+cents(payment.amount),0n)),
        inserted: imported?.inserted, rematched: rematched?.processed });
    }
    if (!apply) return { mode: 'preview', report };
    const mismatch = await client.query(`WITH chain AS (
      SELECT s.*, COALESCE(lag(s.occurred_at) OVER (PARTITION BY s.placement_id ORDER BY s.occurred_at,s.id),p.started_at) AS period_start
      FROM services s JOIN machine_placements p ON p.id=s.placement_id WHERE s.machine_number=ANY($1::text[])
    ) SELECT c.id FROM chain c WHERE c.cashless_amount <> COALESCE((SELECT sum(t.amount)
      FROM cashless_transactions t WHERE t.match_status='MATCHED' AND t.matched_machine_number=c.machine_number
      AND t.occurred_at>=c.period_start AND t.occurred_at<c.occurred_at),0)`, [targets]);
    assert.equal(mismatch.rowCount, 0, 'Independent service cashless verification failed');
    return { mode: 'committed', report, changes: deltas(before, await services(client)) };
  });
  // This targeted backfill intentionally does not create a global parser SUCCESS checkpoint.
  console.log(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
