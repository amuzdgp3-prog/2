import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const token = 'counter-photo-test-token';
process.env.COUNTER_PHOTO_TOKEN = token;
const { authHeader, bootstrap, installTestMachine, pool, preparePhoto } = await import('./helpers.js');

test('сверка сохранённых обслуживаний и разбор расхождений', async (t) => {
  const context = await bootstrap();
  const { app, adminToken, technicianToken, technicianId } = context;
  t.after(() => app.close());
  const { locationId } = await installTestMachine(context, {
    machineNumber: 'OCR-1', pricePerGame: 10, initialGameCounter: 1000, initialPrizeCounter: 100,
    startedAt: '2026-01-01T00:00:00Z',
  });
  const scope = await app.inject({
    method: 'POST', url: '/api/staff/scope', headers: authHeader(adminToken),
    payload: { staffId: technicianId, locationId },
  });
  assert.ok(scope.statusCode < 300, scope.body);
  const base = '/api/counter-photo-checks';
  const worker = authHeader(token);
  const admin = authHeader(adminToken);
  const tech = authHeader(technicianToken);
  assert.equal((await app.inject({ url: `${base}/pending` })).statusCode, 401);
  assert.equal((await app.inject({ url: `${base}/pending`, headers: tech })).statusCode, 401);
  assert.equal((await app.inject({ url: `${base}/reviews`, headers: tech })).statusCode, 403);
  assert.equal((await app.inject({ url: `${base}/reviews`, headers: worker })).statusCode, 401);

  async function save(day: number, games: number, prizes: number, prizesEntered?: boolean) {
    const localId = randomUUID();
    const photoObjectKey = await preparePhoto(localId);
    const payload = {
      localId, photoObjectKey, machineNumber: 'OCR-1', gameCounter: games, prizeCounter: prizes,
      prizeCounterEntered: prizesEntered, occurredAt: `2026-01-${day}T12:00:00Z`,
    };
    const send = () => app.inject({ method: 'POST', url: '/api/services', headers: tech, payload });
    const response = await send();
    assert.equal(response.statusCode, 200, response.body);
    const replay = await send();
    assert.equal(replay.statusCode, 200, replay.body);
    return { id: Number(response.json().service.id), photoObjectKey };
  }

  const matched = await save(10, 1010, 101);
  const mismatch = await save(11, 1020, 102, true);
  const unreadable = await save(12, 1030, 103);
  const pending = await app.inject({ url: `${base}/pending`, headers: worker });
  assert.deepEqual(pending.json(), [matched, mismatch, unreadable]);

  const result = async (id: number, values: [number, number] | null) => {
    const response = await app.inject({
      method: 'POST', url: `${base}/${id}/result`, headers: worker, payload: { values },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().status;
  };
  assert.equal(await result(matched.id, [104, 1010]), 'MATCH');
  assert.equal(await result(mismatch.id, [101, 1020]), 'MISMATCH');
  assert.equal(await result(mismatch.id, [1020, 102]), 'MISMATCH');
  assert.equal(await result(unreadable.id, [1030, 1030]), 'UNREADABLE');
  const reviews = await app.inject({ url: `${base}/reviews`, headers: admin });
  assert.deepEqual(reviews.json().map((row: { id: number }) => row.id), [unreadable.id, mismatch.id]);
  assert.equal(reviews.json()[1].currentPrizes, 102);
  assert.equal(reviews.json()[1].detectedPrizes, 101);

  const patch = await app.inject({
    method: 'PATCH', url: `/api/services/${mismatch.id}`, headers: admin,
    payload: { prizeCounter: 101, gameCounter: 1021 },
  });
  assert.equal(patch.statusCode, 200, patch.body);
  const close = () => app.inject({ method: 'POST', url: `${base}/${mismatch.id}/resolve`, headers: admin });
  assert.equal((await close()).json().status, 'RESOLVED');
  assert.equal((await close()).json().status, 'RESOLVED');
  assert.equal((await pool.query('SELECT game_counter FROM services WHERE id = $1', [mismatch.id])).rows[0].game_counter, 1021);
});
