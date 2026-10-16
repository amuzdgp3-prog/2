import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  authHeader,
  bootstrap,
  createStaff,
  installTestMachine,
  pool,
  preparePhoto,
  type TestContext,
} from './helpers.js';

/**
 * Обслуживания на проверке у администратора (DECISION-086). Отказ по сути записи от техника больше
 * не возвращается ему на доработку: запись целиком уезжает администратору, тот исправляет и
 * сохраняет её сам или отклоняет с комментарием, а техник видит итог.
 */
describe('обслуживания на проверке у администратора', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
    const { locationId } = await installTestMachine(context, {
      machineNumber: 'REV-1',
      pricePerGame: 100,
      initialGameCounter: 1000,
      initialPrizeCounter: 100,
      startedAt: '2026-01-01T00:00:00Z',
    });
    await context.app.inject({
      method: 'POST',
      url: '/api/staff/scope',
      headers: authHeader(context.adminToken),
      payload: { staffId: context.technicianId, locationId },
    });
    const first = await send(context.technicianToken, randomUUID(), {
      gameCounter: 2000,
      prizeCounter: 150,
      occurredAt: '2026-01-10T12:00:00Z',
    });
    assert.equal(first.statusCode, 200, first.body);
  });

  after(async () => {
    await context.app.close();
  });

  const photos = new Map<string, string>();
  async function send(token: string, localId: string, fields: Record<string, unknown>) {
    if (!photos.has(localId)) photos.set(localId, await preparePhoto(localId));
    return context.app.inject({
      method: 'POST',
      url: '/api/services',
      headers: authHeader(token),
      payload: { localId, machineNumber: 'REV-1', photoObjectKey: photos.get(localId), ...fields },
    });
  }

  const admin = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    context.app.inject({ method, url, headers: authHeader(context.adminToken), payload: payload as never });
  const tech = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    context.app.inject({ method, url, headers: authHeader(context.technicianToken), payload: payload as never });

  const serviceCount = async (localId: string) =>
    Number((await pool.query('SELECT COUNT(*) FROM services WHERE local_id = $1', [localId])).rows[0].count);

  it('счётчик игр назад от техника уходит на проверку, а не возвращается ему', async () => {
    const localId = randomUUID();
    // Старая жалоба по этому же черновику (от предыдущей версии приложения) должна сняться.
    await tech('POST', '/api/draft-issues', {
      localId,
      machineNumber: 'REV-1',
      occurredAt: '2026-01-20T12:00:00Z',
      errorCode: 'GAME_COUNTER_WENT_BACK',
      errorMessage: 'старая жалоба',
    });

    const response = await send(context.technicianToken, localId, {
      gameCounter: 1500,
      prizeCounter: 200,
      occurredAt: '2026-01-20T12:00:00Z',
    });
    assert.equal(response.statusCode, 202, response.body);
    const body = response.json();
    assert.equal(body.inReview, true);
    assert.equal(body.status, 'PENDING');
    assert.equal(body.errorCode, 'GAME_COUNTER_WENT_BACK');
    assert.equal(await serviceCount(localId), 0);

    const issues = await admin('GET', '/api/draft-issues');
    assert.equal(issues.json().length, 0, 'жалоба на черновик снята — запись теперь на проверке');

    const list = (await admin('GET', '/api/service-reviews')).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].localId, localId);
    assert.equal(list[0].technicianName, 'tech');

    const detail = (await admin('GET', `/api/service-reviews/${localId}`)).json();
    assert.equal(detail.payload.gameCounter, 1500);
    assert.equal(detail.photoObjectKey, photos.get(localId));

    const mine = (await tech('GET', '/api/service-reviews/mine')).json();
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, 'PENDING');

    // Повтор с телефона (ответ потерялся) — то же состояние, без новых строк.
    const replay = await send(context.technicianToken, localId, {
      gameCounter: 1500,
      prizeCounter: 200,
      occurredAt: '2026-01-20T12:00:00Z',
    });
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal((await admin('GET', '/api/service-reviews')).json().length, 1);
  });

  it('техник не может сам подтвердить откат счётчика — это делает администратор', async () => {
    const localId = randomUUID();
    const response = await send(context.technicianToken, localId, {
      gameCounter: 2100,
      prizeCounter: 120,
      occurredAt: '2026-01-21T12:00:00Z',
      confirmPrizeCounterBack: true,
      confirmCounterJump: true,
    });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json().errorCode, 'PRIZE_COUNTER_WENT_BACK');
  });

  it('технику недоступны список, разбор и чужие записи', async () => {
    assert.equal((await tech('GET', '/api/service-reviews')).statusCode, 403);
    const [first] = (await admin('GET', '/api/service-reviews')).json();
    assert.equal((await tech('POST', `/api/service-reviews/${first.localId}/approve`, {})).statusCode, 403);
    assert.equal(
      (await tech('POST', `/api/service-reviews/${first.localId}/reject`, { comment: 'x' })).statusCode,
      403,
    );
  });

  it('сохранение, которое снова не проходит, оставляет запись на проверке', async () => {
    const [first] = (await admin('GET', '/api/service-reviews')).json();
    const response = await admin('POST', `/api/service-reviews/${first.localId}/approve`, {});
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'GAME_COUNTER_WENT_BACK');
    const detail = (await admin('GET', `/api/service-reviews/${first.localId}`)).json();
    assert.equal(detail.status, 'PENDING');
    assert.equal(await serviceCount(first.localId), 0);
  });

  it('администратор исправляет цифру и сохраняет — визит засчитан технику, правка видна ему', async () => {
    const list = (await admin('GET', '/api/service-reviews')).json();
    const target = list.find((row: { errorCode: string }) => row.errorCode === 'GAME_COUNTER_WENT_BACK');
    const response = await admin('POST', `/api/service-reviews/${target.localId}/approve`, {
      gameCounter: 2500,
      comment: 'переписал счётчик по фото',
    });
    assert.equal(response.statusCode, 200, response.body);
    const approved = response.json();
    assert.equal(approved.status, 'APPROVED');
    assert.ok(approved.serviceId);
    assert.deepEqual(approved.changes, [{ field: 'gameCounter', from: 1500, to: 2500 }]);

    const service = (await pool.query('SELECT * FROM services WHERE local_id = $1', [target.localId])).rows[0];
    assert.equal(Number(service.technician_id), Number(context.technicianId));
    assert.equal(Number(service.game_counter), 2500);
    assert.equal(service.photo_object_key, photos.get(target.localId));

    // Повтор старого черновика с телефона — не конфликт, а «уже разобрано».
    const replay = await send(context.technicianToken, target.localId, {
      gameCounter: 1500,
      prizeCounter: 200,
      occurredAt: '2026-01-20T12:00:00Z',
    });
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().status, 'APPROVED');
    assert.equal(await serviceCount(target.localId), 1);

    const again = await admin('POST', `/api/service-reviews/${target.localId}/approve`, {});
    assert.equal(again.statusCode, 409);

    const mine = (await tech('GET', '/api/service-reviews/mine')).json();
    const resolved = mine.find((row: { localId: string }) => row.localId === target.localId);
    assert.equal(resolved.status, 'APPROVED');
    assert.equal(resolved.adminComment, 'переписал счётчик по фото');

    const seen = await tech('POST', `/api/service-reviews/${target.localId}/seen`);
    assert.equal(seen.statusCode, 200, seen.body);
    const mineAfter = (await tech('GET', '/api/service-reviews/mine')).json();
    assert.ok(!mineAfter.some((row: { localId: string }) => row.localId === target.localId));
  });

  it('отклонение требует комментарий; другой техник не может отметить чужую запись', async () => {
    const [pending] = (await admin('GET', '/api/service-reviews')).json();
    const noComment = await admin('POST', `/api/service-reviews/${pending.localId}/reject`, {});
    assert.equal(noComment.statusCode, 400);
    assert.equal(noComment.json().error, 'COMMENT_REQUIRED');

    const rejected = await admin('POST', `/api/service-reviews/${pending.localId}/reject`, {
      comment: 'дубль вчерашнего визита',
    });
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal(rejected.json().status, 'REJECTED');
    assert.equal(await serviceCount(pending.localId), 0);

    await createStaff('tech2', 'TECHNICIAN');
    const login = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'tech2', password: 'secret' },
    });
    const otherToken = login.json().token as string;
    const foreign = await context.app.inject({
      method: 'POST',
      url: `/api/service-reviews/${pending.localId}/seen`,
      headers: authHeader(otherToken),
    });
    assert.equal(foreign.statusCode, 403);
  });

  it('визит отключённого с тех пор техника всё равно засчитывается ему', async () => {
    const localId = randomUUID();
    const sent = await send(context.technicianToken, localId, {
      gameCounter: 1800,
      prizeCounter: 200,
      occurredAt: '2026-01-25T12:00:00Z',
    });
    assert.equal(sent.statusCode, 202, sent.body);

    await pool.query('UPDATE staff SET is_active = FALSE WHERE id = $1', [context.technicianId]);
    try {
      const approved = await admin('POST', `/api/service-reviews/${localId}/approve`, { gameCounter: 2800 });
      assert.equal(approved.statusCode, 200, approved.body);
      const service = (await pool.query('SELECT technician_id FROM services WHERE local_id = $1', [localId]))
        .rows[0];
      assert.equal(Number(service.technician_id), Number(context.technicianId));
    } finally {
      await pool.query('UPDATE staff SET is_active = TRUE WHERE id = $1', [context.technicianId]);
    }
  });

  it('администратор сохраняет откат счётчика призов как есть — галочкой', async () => {
    const localId = randomUUID();
    const sent = await send(context.technicianToken, localId, {
      gameCounter: 3000,
      prizeCounter: 10,
      occurredAt: '2026-01-26T10:00:00Z',
    });
    assert.equal(sent.statusCode, 202, sent.body);
    assert.equal(sent.json().errorCode, 'PRIZE_COUNTER_WENT_BACK');

    const approved = await admin('POST', `/api/service-reviews/${localId}/approve`, {
      confirmPrizeCounterBack: true,
    });
    assert.equal(approved.statusCode, 200, approved.body);
    const service = (await pool.query('SELECT new_prizes FROM services WHERE local_id = $1', [localId])).rows[0];
    assert.equal(Number(service.new_prizes), 0);
  });

  it('чистка фото не удаляет фото записи на проверке', async () => {
    const localId = randomUUID();
    const sent = await send(context.technicianToken, localId, {
      gameCounter: 100,
      prizeCounter: 200,
      occurredAt: '2026-01-26T12:00:00Z',
    });
    assert.equal(sent.statusCode, 202, sent.body);
    await pool.query(`UPDATE photo_objects SET uploaded_at = now() - interval '1000 days'`);

    const cleanup = await admin('POST', '/api/photos/cleanup');
    assert.equal(cleanup.statusCode, 200, cleanup.body);
    const photo = await pool.query('SELECT 1 FROM photo_objects WHERE object_key = $1', [photos.get(localId)]);
    assert.equal(photo.rowCount, 1);
  });

  it('администратор, как и раньше, получает отказ сразу, без очереди проверки', async () => {
    const localId = randomUUID();
    const response = await send(context.adminToken, localId, {
      gameCounter: 100,
      prizeCounter: 200,
      occurredAt: '2026-01-27T12:00:00Z',
    });
    assert.equal(response.statusCode, 400, response.body);
    const row = await pool.query('SELECT 1 FROM service_reviews WHERE local_id = $1', [localId]);
    assert.equal(row.rowCount, 0);
  });
});
