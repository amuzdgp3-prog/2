import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

/**
 * Proves the fix in DECISION-041: before it, a single hung request to the iVend cabinet — Node's
 * global fetch has no default timeout — held the calling database transaction (and the pool
 * connection under it) open forever, and with it the scheduler's `running` flag in server.ts,
 * stalling background synchronization until the container was restarted. This file, separate from
 * ivend_sync.test.ts, gets its own process (Node's test runner isolates each test FILE into its
 * own process by default) so its env vars — a different fake server URL and a short
 * IVEND_GRAPHQL_TIMEOUT_MS — don't collide with that file's own env, and so integrations/ivend.js
 * is loaded fresh with THESE values rather than whatever the other file's test already pinned its
 * module-level constants to.
 */
async function startHangingIvend(): Promise<{ close: () => void; url: string }> {
  // No res.end()/res.write() ever — the connection is accepted and then simply never answered,
  // the exact shape of a stuck or black-holed connection to the real cabinet.
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { close: () => server.close(), url: `http://127.0.0.1:${port}/graphql` };
}

test('iVend sync: a hung request to the cabinet times out instead of blocking forever', async () => {
  const hanging = await startHangingIvend();
  process.env.IVEND_GRAPHQL_URL = hanging.url;
  process.env.IVEND_GRAPHQL_TIMEOUT_MS = '300';

  const { bootstrap, authHeader, pool } = await import('./helpers.js');
  const context = await bootstrap();
  try {
    // saveIvendSettings itself calls ivendLogin to verify the credentials before storing them —
    // this hits the hanging server too, and must not block the settings-save request forever.
    const saveStarted = Date.now();
    const saved = await context.app.inject({
      method: 'PUT',
      url: '/api/parser/ivend/settings',
      headers: authHeader(context.adminToken),
      payload: { login: '9990000000', password: 'irrelevant', isEnabled: true },
    });
    assert.ok(
      Date.now() - saveStarted < 5_000,
      'saving iVend settings must be bounded by the timeout, not hang on the unreachable cabinet',
    );
    assert.equal(saved.json().ok, false);

    // runIvendSync performs its own ivendLogin call — this is the call whose hang used to hold a
    // database transaction open indefinitely (DECISION-041). It must resolve, not hang.
    const runStarted = Date.now();
    const runResult = await context.app.inject({
      method: 'POST',
      url: '/api/parser/ivend/run',
      headers: authHeader(context.adminToken),
    });
    assert.ok(
      Date.now() - runStarted < 5_000,
      'a hung cabinet request must not block runIvendSync forever',
    );
    assert.ok(runResult.json().error, 'expected a business error, not a hang or a crash');

    const runs = await pool.query(
      `SELECT status, finished_at, started_at FROM parser_runs WHERE provider = 'ivend' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(runs.rows[0].status, 'ERROR');
    // A run record exists and is closed out — nothing was left permanently stuck at RUNNING.
    assert.ok(runs.rows[0].finished_at);
  } finally {
    await context.app.close();
    hanging.close();
  }
});
