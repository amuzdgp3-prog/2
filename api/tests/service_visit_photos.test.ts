import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import { authHeader, bootstrap, createStaff, installTestMachine, pool, preparePhoto, type TestContext } from './helpers.js';
import { cleanupExpiredVisitPhotos } from '../src/routes/serviceVisitPhotos.js';

const WHITE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWP4jwMwDC0JALoev0GybL49AAAAAElFTkSuQmCC', 'base64');
const BLACK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgGB4AAADIAAH4XVuUAAAAAElFTkSuQmCC', 'base64');

let context: TestContext;
before(async () => {
  context = await bootstrap();
  const { locationId } = await installTestMachine(context, { machineNumber: 'VISIT-1', pricePerGame: 10 });
  await context.app.inject({
    method: 'POST', url: '/api/staff/scope', headers: authHeader(context.adminToken),
    payload: { staffId: context.technicianId, locationId },
  });
});
after(async () => { await context?.app.close(); await pool.end(); });

function upload(localId: string, slot: number, bytes: Buffer, token = context.technicianToken, machineNumber = 'VISIT-1') {
  const boundary = 'visit-photo-test';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="localId"\r\n\r\n${localId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="machineNumber"\r\n\r\n${machineNumber}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="slot"\r\n\r\n${slot}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return context.app.inject({
    method: 'POST', url: '/api/service-photos', payload,
    headers: { ...authHeader(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}

function uploadCounter(localId: string, token: string) {
  const boundary = 'counter-photo-test';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="localId"\r\n\r\n${localId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="counter.png"\r\nContent-Type: image/png\r\n\r\n`),
    WHITE_PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return context.app.inject({
    method: 'POST', url: '/api/photos', payload,
    headers: { ...authHeader(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}

it('keeps two photos beside a service, filters the gallery, and expires only those files', async () => {
  const localId = randomUUID();
  const first = await upload(localId, 1, WHITE_PNG);
  const second = await upload(localId, 2, BLACK_PNG);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.notEqual(first.json().objectKey, second.json().objectKey);
  assert.equal((await upload(localId, 1, WHITE_PNG)).json().objectKey, first.json().objectKey);

  const counterKey = await preparePhoto(localId);
  const saved = await context.app.inject({
    method: 'POST', url: '/api/services', headers: authHeader(context.technicianToken),
    payload: {
      localId, machineNumber: 'VISIT-1', occurredAt: '2026-11-08T10:00:00Z',
      gameCounter: 100, prizeCounter: 0, photoObjectKey: counterKey,
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);

  const gallery = await context.app.inject({
    url: '/api/service-photos?from=2026-11-08&to=2026-11-08&search=VISIT-1',
    headers: authHeader(context.adminToken),
  });
  assert.equal(gallery.statusCode, 200, gallery.body);
  assert.equal(gallery.json().total, 1);
  assert.equal(gallery.json().rows[0].photo_1, first.json().objectKey);
  assert.equal(gallery.json().rows[0].photo_2, second.json().objectKey);
  // Later reassignment of a service must not detach its photos from the gallery.
  await pool.query('UPDATE services SET technician_id = NULL WHERE local_id = $1', [localId]);
  const reassigned = await context.app.inject({ url: '/api/service-photos', headers: authHeader(context.adminToken) });
  assert.equal(reassigned.json().rows[0].photo_1, first.json().objectKey);
  await pool.query('UPDATE services SET technician_id = $2 WHERE local_id = $1', [localId, context.technicianId]);
  assert.equal((await context.app.inject({
    url: '/api/service-photos?from=2026-11-07&to=2026-11-07', headers: authHeader(context.adminToken),
  })).json().total, 0);
  assert.equal((await context.app.inject({
    url: '/api/service-photos', headers: authHeader(context.technicianToken),
  })).statusCode, 403);

  const imageUrl = `/api/service-photos/${localId}/1`;
  assert.equal((await context.app.inject({ url: imageUrl, headers: authHeader(context.adminToken) })).statusCode, 200);
  const thumbnail = await context.app.inject({ url: `${imageUrl}?thumbnail=1`, headers: authHeader(context.adminToken) });
  assert.equal(thumbnail.statusCode, 200);
  assert.match(thumbnail.headers['content-type'] ?? '', /^image\/jpeg/);
  assert.equal((await context.app.inject({
    url: `/api/photos/${first.json().objectKey}`, headers: authHeader(context.adminToken),
  })).statusCode, 404);
  assert.equal((await context.app.inject({ url: imageUrl, headers: authHeader(context.bossToken) })).statusCode, 403);

  // The existing orphan cleaner must not remove a new photo while its visit link exists.
  await pool.query("UPDATE photo_objects SET uploaded_at = now() - interval '25 hours' WHERE object_key = $1", [first.json().objectKey]);
  await context.app.inject({ method: 'POST', url: '/api/photos/cleanup', headers: authHeader(context.adminToken) });
  assert.equal((await pool.query('SELECT 1 FROM photo_objects WHERE object_key = $1', [first.json().objectKey])).rowCount, 1);

  await pool.query("UPDATE service_visit_photos SET uploaded_at = now() - interval '31 days' WHERE local_id = $1", [localId]);
  assert.equal((await context.app.inject({ url: imageUrl, headers: authHeader(context.adminToken) })).statusCode, 404);
  assert.equal((await context.app.inject({ url: `${imageUrl}?thumbnail=1`, headers: authHeader(context.adminToken) })).statusCode, 404);
  assert.equal((await cleanupExpiredVisitPhotos()), 2);
  assert.equal((await pool.query('SELECT 1 FROM service_visit_photos WHERE local_id = $1', [localId])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM photo_objects WHERE object_key = $1', [counterKey])).rowCount, 1);
});

it('lets an admin upload every photo and safely retry services with and without an assigned technician', async () => {
  const otherTechnicianId = await createStaff('visit-other', 'TECHNICIAN');
  const admin = await pool.query<{ id: number }>("SELECT id FROM staff WHERE login = 'admin'");

  for (const [index, technicianId] of [null, otherTechnicianId].entries()) {
    const machineNumber = `ADMIN-VISIT-${index}`;
    const { locationId } = await installTestMachine(context, { machineNumber, pricePerGame: 10 });
    const localId = randomUUID();
    const first = await upload(localId, 1, WHITE_PNG, context.adminToken, machineNumber);
    const second = await upload(localId, 2, BLACK_PNG, context.adminToken, machineNumber);
    const counter = await uploadCounter(localId, context.adminToken);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(counter.statusCode, 200, counter.body);

    const payload = {
      localId, machineNumber, occurredAt: '2026-11-09T10:00:00Z',
      gameCounter: 100, prizeCounter: 0, photoObjectKey: counter.json().objectKey,
      ...(technicianId === null ? {} : { technicianId }),
    };
    const saved = await context.app.inject({
      method: 'POST', url: '/api/services', headers: authHeader(context.adminToken), payload,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().idempotentReplay, false);
    assert.equal(saved.json().service.technician_id === null ? null : Number(saved.json().service.technician_id), technicianId);
    assert.equal(Number(saved.json().service.created_by), Number(admin.rows[0].id));

    const gallery = await context.app.inject({
      url: `/api/service-photos?search=${machineNumber}`, headers: authHeader(context.adminToken),
    });
    assert.equal(gallery.statusCode, 200, gallery.body);
    assert.equal(gallery.json().total, 1);
    assert.equal(gallery.json().rows[0].photo_1, first.json().objectKey);
    assert.equal(gallery.json().rows[0].photo_2, second.json().objectKey);

    // Reproduce the whole outbox retry after a lost service response, including every upload.
    const firstReplay = await upload(localId, 1, WHITE_PNG, context.adminToken, machineNumber);
    const secondReplay = await upload(localId, 2, BLACK_PNG, context.adminToken, machineNumber);
    const counterReplay = await uploadCounter(localId, context.adminToken);
    assert.equal(firstReplay.statusCode, 200, firstReplay.body);
    assert.equal(secondReplay.statusCode, 200, secondReplay.body);
    assert.equal(counterReplay.statusCode, 200, counterReplay.body);
    assert.equal(firstReplay.json().objectKey, first.json().objectKey);
    assert.equal(secondReplay.json().objectKey, second.json().objectKey);
    assert.equal(counterReplay.json().objectKey, counter.json().objectKey);
    const replay = await context.app.inject({
      method: 'POST', url: '/api/services', headers: authHeader(context.adminToken), payload,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().idempotentReplay, true);
    assert.equal(replay.json().service.id, saved.json().service.id);
    assert.equal((await pool.query('SELECT 1 FROM services WHERE local_id = $1', [localId])).rowCount, 1);

    const replacement = await upload(localId, 1, BLACK_PNG, context.adminToken, machineNumber);
    assert.equal(replacement.statusCode, 200, replacement.body);
    assert.equal(replacement.json().objectKey, first.json().objectKey, 'accepted photos remain immutable');
    assert.equal((await pool.query('SELECT 1 FROM photo_objects WHERE local_id = $1', [localId])).rowCount, 3);

    const wrongMachine = await upload(localId, 1, WHITE_PNG, context.adminToken, 'VISIT-1');
    assert.equal(wrongMachine.statusCode, 403, wrongMachine.body);

    // Even an in-scope technician cannot overwrite a service created for someone else.
    const granted = await context.app.inject({
      method: 'POST', url: '/api/staff/scope', headers: authHeader(context.adminToken),
      payload: { staffId: context.technicianId, locationId },
    });
    assert.equal(granted.statusCode, 200, granted.body);
    const otherOwner = await upload(localId, 1, WHITE_PNG, context.technicianToken, machineNumber);
    assert.equal(otherOwner.statusCode, 403, otherOwner.body);
  }
});

it('still rejects a boss upload and a technician upload outside their machine scope', async () => {
  const machineNumber = 'UNSCOPED-VISIT';
  await installTestMachine(context, { machineNumber, pricePerGame: 10 });
  const localId = randomUUID();
  const boss = await upload(localId, 1, WHITE_PNG, context.bossToken, machineNumber);
  assert.equal(boss.statusCode, 403, boss.body);
  const technician = await upload(localId, 1, WHITE_PNG, context.technicianToken, machineNumber);
  assert.equal(technician.statusCode, 403, technician.body);
  assert.equal((await pool.query('SELECT 1 FROM service_visit_photos WHERE local_id = $1', [localId])).rowCount, 0);
});
