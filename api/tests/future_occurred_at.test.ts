import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, installTestMachine, postService, authHeader } from './helpers.ts';

/**
 * Found via a large-scale scenario run: nothing stopped a service from being recorded (or
 * edited) with occurred_at in the future, which a real technician visit can never have and which
 * silently skews any report that applies an explicit upper date bound.
 */
test('a service cannot be created or edited with occurred_at in the future', async (t) => {
  const context = await bootstrap();
  t.after(() => context.app.close());

  const { locationId } = await installTestMachine(context, { machineNumber: '0900', pricePerGame: 100 });
  await context.app.inject({
    method: 'POST',
    url: '/api/staff/scope',
    headers: authHeader(context.adminToken),
    payload: { staffId: context.technicianId, locationId },
  });

  const future = new Date(Date.now() + 24 * 3_600_000).toISOString();
  const created = await postService(context, context.technicianToken, '0900', {
    gameCounter: 100,
    prizeCounter: 5,
    occurredAt: future,
  });
  assert.equal(created.status, 400);
  assert.equal(created.body.error, 'FUTURE_OCCURRED_AT');

  const valid = await postService(context, context.technicianToken, '0900', {
    gameCounter: 100,
    prizeCounter: 5,
    occurredAt: '2026-01-02T08:00:00Z',
  });
  assert.equal(valid.status, 200);
  const serviceId = (valid.body as { service: { id: number } }).service.id;

  const edited = await context.app.inject({
    method: 'PATCH',
    url: `/api/services/${serviceId}`,
    headers: authHeader(context.adminToken),
    payload: { occurredAt: future },
  });
  assert.equal(edited.statusCode, 400);
  assert.equal(edited.json().error, 'FUTURE_OCCURRED_AT');
});
