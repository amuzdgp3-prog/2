import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import sharp from 'sharp';
import { authHeader, bootstrap, pool, type TestContext } from './helpers.js';

let context: TestContext;

before(async () => { context = await bootstrap(); });
after(async () => { await context?.app.close(); await pool.end(); });

function upload(token: string, localId: string, bytes: Buffer, claimedType: string) {
  const boundary = 'photo-security-test';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="localId"\r\n\r\n${localId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: ${claimedType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return context.app.inject({
    method: 'POST', url: '/api/photos', payload,
    headers: { ...authHeader(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}

const png = (background: string) => sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer();

it('rejects active contents even with an image MIME type', async () => {
  const response = await upload(context.technicianToken, randomUUID(), Buffer.from('<html>not an image</html>'), 'image/jpeg');
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'INVALID_PHOTO');
});

it('stores immutable photos and serves the detected raster type with private headers', async () => {
  const localId = randomUUID();
  const first = await png('white');
  const saved = await upload(context.adminToken, localId, first, 'text/html');
  assert.equal(saved.statusCode, 200, saved.body);
  const { objectKey } = saved.json();
  const retry = await upload(context.adminToken, localId, first, 'image/png');
  assert.equal(retry.json().objectKey, objectKey);
  const replacement = await upload(context.adminToken, localId, await png('black'), 'image/png');
  assert.notEqual(replacement.json().objectKey, objectKey);
  const differentActor = await upload(context.technicianToken, localId, first, 'image/png');
  assert.notEqual(differentActor.json().objectKey, objectKey);

  const url = `/api/photos/${objectKey}`;
  const denied = await context.app.inject({ url, headers: authHeader(context.technicianToken) });
  assert.equal(denied.statusCode, 403);
  const photo = await context.app.inject({ url, headers: authHeader(context.adminToken) });
  assert.equal(photo.statusCode, 200);
  assert.match(photo.headers['content-type'] ?? '', /^image\/png/);
  assert.equal(photo.headers['cache-control'], 'private, no-store');
  assert.equal(photo.headers['x-content-type-options'], 'nosniff');
  const pixels = await sharp(photo.rawPayload).raw().toBuffer();
  assert(pixels.every(value => value === 255));
});
