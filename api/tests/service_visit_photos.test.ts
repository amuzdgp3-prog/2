import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, preparePhoto, type TestContext } from './helpers.js';
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

function upload(localId: string, slot: number, bytes: Buffer) {
  const boundary = 'visit-photo-test';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="localId"\r\n\r\n${localId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="machineNumber"\r\n\r\nVISIT-1\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="slot"\r\n\r\n${slot}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return context.app.inject({
    method: 'POST', url: '/api/service-photos', payload,
    headers: { ...authHeader(context.technicianToken), 'content-type': `multipart/form-data; boundary=${boundary}` },
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
