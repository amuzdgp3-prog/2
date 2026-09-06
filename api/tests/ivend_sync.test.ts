import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { test } from 'node:test';

/**
 * The iVend integration (DECISION-030) talks to a real external payment cabinet over GraphQL.
 * These tests never touch the real provider: a tiny local HTTP server plays its three operations
 * (userLogin, getMachinesSales, getSalesByMachine) with canned, schema-accurate responses, and
 * `IVEND_GRAPHQL_URL` points the client at it. The env var must be set BEFORE anything imports
 * `src/server.js` (which imports the iVend client at module load time), so this file follows the
 * same "set env, then dynamic import" pattern helpers.ts itself uses — a static top-level import
 * of helpers.js would run too early.
 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function fakeResponse(operationName: string, variables: Record<string, any>) {
  if (operationName === 'userLogin') {
    if (variables.input.password === 'right-password') {
      return { data: { userLogin: { data: { token: 'fake-token' }, response: { status: 'OK', message: '' } } } };
    }
    return {
      data: {
        userLogin: { data: null, response: { status: 'ERROR', message: 'Неверный логин или пароль' } },
      },
    };
  }
  if (operationName === 'getMachinesSales') {
    // The real client always requests the whole history in one shot (period from 0), so a given
    // machine is either "has ever sold anything" (zeroSales:false) or not — never both passes.
    const machines = variables.filter.zeroSales
      ? []
      : [{ id: 999, name: 'Тест-автомат', controller: { uid: 'TERM-1' } }];
    return { data: { getMachinesSales: { machines, pages: { totalPages: '1', totalRecords: machines.length } } } };
  }
  if (operationName === 'getSalesByMachine') {
    if (variables.pagination.page > 0) {
      return { data: { getSalesByMachine: { sales: [], pages: { totalPages: '1', totalRecords: 0 } } } };
    }
    return {
      data: {
        getSalesByMachine: {
          sales: [
            { id: 5001, type: 'CASHLESS', price: 100, createdAt: Date.now() - 3_600_000 },
            { id: 5002, type: 'CASH', price: 20, createdAt: Date.now() - 7_200_000 },
          ],
          pages: { totalPages: '1', totalRecords: 2 },
        },
      },
    };
  }
  return { errors: [{ message: `unhandled operation ${operationName}` }] };
}

async function startFakeIvend() {
  const server = createServer((req, res) => {
    readBody(req).then((raw) => {
      const { operationName, variables } = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(fakeResponse(operationName, variables)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { close: () => server.close(), url: `http://127.0.0.1:${port}/graphql` };
}

test('iVend sync: wrong credentials are rejected, correct ones import only the cashless sale', async () => {
  const fake = await startFakeIvend();
  process.env.IVEND_GRAPHQL_URL = fake.url;

  const { bootstrap, installTestMachine, authHeader, pool } = await import('./helpers.js');
  const context = await bootstrap();
  try {

  await installTestMachine(context, { machineNumber: 'IV-1', pricePerGame: 100 });
  const terminal = await context.app.inject({
    method: 'POST',
    url: '/api/terminals',
    headers: authHeader(context.adminToken),
    payload: { serial: 'TERM-1', provider: 'ivend' },
  });
  const bound = await context.app.inject({
    method: 'POST',
    url: '/api/terminals/bind',
    headers: authHeader(context.adminToken),
    // Must be at/after the machine's placement start (installTestMachine defaults to
    // 2026-01-01T08:00:00Z) — a binding starting before that has no covering placement.
    payload: { terminalId: terminal.json().id, machineNumber: 'IV-1', startedAt: '2026-01-02T00:00:00Z' },
  });
  assert.equal(bound.statusCode, 200, `terminal bind must succeed: ${bound.body}`);

  const badSave = await context.app.inject({
    method: 'PUT',
    url: '/api/parser/ivend/settings',
    headers: authHeader(context.adminToken),
    payload: { login: '9990000000', password: 'wrong', isEnabled: true },
  });
  assert.equal(badSave.json().ok, false);
  assert.match(badSave.json().message, /логин или пароль/i);

  const goodSave = await context.app.inject({
    method: 'PUT',
    url: '/api/parser/ivend/settings',
    headers: authHeader(context.adminToken),
    payload: { login: '9990000000', password: 'right-password', isEnabled: true },
  });
  assert.equal(goodSave.json().ok, true);

  const settingsRead = await context.app.inject({
    method: 'GET',
    url: '/api/parser/ivend/settings',
    headers: authHeader(context.adminToken),
  });
  const settingsBody = settingsRead.json();
  assert.equal(settingsBody.hasPassword, true);
  assert.ok(!JSON.stringify(settingsBody).includes('right-password'), 'password must never be returned to the client');

  const runResult = await context.app.inject({
    method: 'POST',
    url: '/api/parser/ivend/run',
    headers: authHeader(context.adminToken),
  });
  assert.equal(runResult.json().imported, 1, 'only the CASHLESS sale should be imported, not the CASH one');
  assert.equal(runResult.json().matched, 1);

  const stored = await pool.query(`SELECT * FROM cashless_transactions WHERE provider = 'ivend'`);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].payment_type, 'CASHLESS');
  assert.equal(stored.rows[0].amount, '100.00');
  assert.equal(stored.rows[0].provider_transaction_id, '5001');
  assert.equal(stored.rows[0].matched_machine_number, 'IV-1');

  const runs = await pool.query(`SELECT * FROM parser_runs WHERE provider = 'ivend' ORDER BY id DESC`);
  assert.equal(runs.rows[0].status, 'SUCCESS');
  assert.equal(runs.rows[0].rows_inserted, 1);
  assert.equal(runs.rows[0].rows_received, 1);
  } finally {
    await context.app.close();
    fake.close();
  }
});
