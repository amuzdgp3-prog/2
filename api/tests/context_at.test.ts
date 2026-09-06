import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, postService, type TestContext } from './helpers.js';

/**
 * GET /api/machines/:id/context-at — the technician-facing "было N" hint must reflect the
 * service immediately preceding the CHOSEN date, not just the machine's latest service, so
 * inserting a backdated record between two existing ones shows correct context.
 */
describe('machine context at an arbitrary date', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
    await installTestMachine(context, {
      machineNumber: 'CTX-1',
      pricePerGame: 10,
      initialGameCounter: 0,
      startedAt: '2026-01-01T08:00:00Z',
    });
    await postService(context, context.adminToken, 'CTX-1', {
      gameCounter: 50,
      prizeCounter: 0,
      occurredAt: '2026-01-15T10:00:00Z',
    });
    await postService(context, context.adminToken, 'CTX-1', {
      gameCounter: 100,
      prizeCounter: 0,
      occurredAt: '2026-02-01T10:00:00Z',
    });
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('resolves the initial counters when inserting before the first service', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/machines/CTX-1/context-at?occurredAt=2026-01-05T10:00:00Z',
      headers: authHeader(context.adminToken),
    });
    const body = response.json();
    assert.equal(body.previous.game_counter, 0, 'falls back to the placement initial counter');
    assert.equal(body.next.game_counter, 50, 'the next service chronologically is the 15 Jan one');
  });

  it('resolves the previous service when inserting between two existing ones', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/machines/CTX-1/context-at?occurredAt=2026-01-22T10:00:00Z',
      headers: authHeader(context.adminToken),
    });
    const body = response.json();
    assert.equal(body.previous.game_counter, 50, 'not the machine\'s latest (100), but the one right before this date');
    assert.equal(body.next.game_counter, 100);
  });

  it('has no "next" when inserting after the latest service', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/machines/CTX-1/context-at?occurredAt=2026-03-01T10:00:00Z',
      headers: authHeader(context.adminToken),
    });
    const body = response.json();
    assert.equal(body.previous.game_counter, 100);
    assert.equal(body.next, null);
  });

  it('rejects a technician out of scope', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/machines/CTX-1/context-at?occurredAt=2026-03-01T10:00:00Z',
      headers: authHeader(context.technicianToken),
    });
    assert.equal(response.statusCode, 403);
  });
});
