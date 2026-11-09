import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { lockPhoto, normalizePhoto, openRasterPhoto, photoPath, storeImmutablePhoto } from '../lib/photos.js';
import { assertAdmin } from '../lib/scope.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function slotNumber(value: unknown): 1 | 2 {
  if (value === '1' || value === 1) return 1;
  if (value === '2' || value === 2) return 2;
  throw badRequest('INVALID_PHOTO_SLOT', 'нужно выбрать два фото аппарата');
}

export async function registerServiceVisitPhotoRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: app.authenticate };

  app.post('/api/service-photos', auth, async (request) => {
    if (request.actor.role !== 'TECHNICIAN') throw forbidden('фото обслуживания загружает техник');
    const file = await request.file();
    if (!file) throw badRequest('FILE_REQUIRED', 'нужен файл фотографии');
    const localId = (file.fields.localId as { value?: string } | undefined)?.value;
    const slot = slotNumber((file.fields.slot as { value?: string } | undefined)?.value);
    if (!localId || !UUID.test(localId)) throw badRequest('LOCAL_ID_REQUIRED', 'нужен корректный localId');

    const photo = await normalizePhoto(await file.toBuffer());
    if (photo.bytes.length > config.maxPhotoBytes) throw badRequest('FILE_TOO_LARGE', 'фото аппарата слишком велико');
    const digest = createHash('sha256').update(String(request.actor.id)).update(':').update(photo.bytes).digest('hex');
    const objectKey = `visits/${localId.toLowerCase()}-${slot}-${digest}.${photo.extension}`;

    return withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('visit-photo:' || $1, 0))", [`${localId}:${slot}`]);
      const owner = await client.query<{ technician_id: number }>(
        `SELECT technician_id FROM services WHERE local_id = $1
         UNION ALL SELECT technician_id FROM service_reviews WHERE local_id = $1 LIMIT 1`,
        [localId],
      );
      if (owner.rows[0] && Number(owner.rows[0].technician_id) !== request.actor.id) {
        throw forbidden('обслуживание другого техника');
      }
      const existing = await client.query<{ object_key: string }>(
        'SELECT object_key FROM service_visit_photos WHERE local_id = $1 AND slot = $2',
        [localId, slot],
      );
      if (existing.rows[0]?.object_key === objectKey) return { objectKey };
      // An accepted service has immutable photos. A retry after a lost response returns its key.
      if (existing.rows[0] && (await client.query('SELECT 1 FROM services WHERE local_id = $1', [localId])).rowCount) {
        return { objectKey: existing.rows[0].object_key };
      }

      await lockPhoto(client, objectKey);
      await client.query(
        `INSERT INTO photo_objects (object_key, local_id, uploaded_by, byte_size, content_type)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (object_key) DO NOTHING`,
        [objectKey, localId, request.actor.id, photo.bytes.length, photo.contentType],
      );
      await storeImmutablePhoto(photoPath(config.photoDir, objectKey), photo.bytes);
      await client.query(
        `INSERT INTO service_visit_photos (local_id, slot, object_key, uploaded_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (local_id, slot) DO UPDATE
         SET object_key = EXCLUDED.object_key, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
        [localId, slot, objectKey, request.actor.id],
      );
      return { objectKey };
    });
  });

  app.get<{ Querystring: { from?: string; to?: string; technicianId?: string; search?: string; limit?: string; offset?: string } }>(
    '/api/service-photos', auth, async (request) => {
      assertAdmin(request.actor);
      const { from, to, technicianId, search } = request.query;
      if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw badRequest('INVALID_DATE', 'неверная дата');
      if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw badRequest('INVALID_DATE', 'неверная дата');
      const params: unknown[] = [];
      const where: string[] = [];
      const push = (value: unknown) => { params.push(value); return `$${params.length}`; };
      if (from) where.push(`s.service_date >= ${push(from)}::date`);
      if (to) where.push(`s.service_date <= ${push(to)}::date`);
      if (technicianId) {
        const id = Number(technicianId);
        if (!Number.isInteger(id) || id <= 0) throw badRequest('INVALID_TECHNICIAN', 'неверный техник');
        where.push(`s.technician_id = ${push(id)}`);
      }
      if (search?.trim()) {
        where.push(`(s.machine_number ILIKE ${push(`%${search.trim()}%`)} OR p.address ILIKE $${params.length} OR l.name ILIKE $${params.length})`);
      }
      const condition = where.length ? `AND ${where.join(' AND ')}` : '';
      const limit = Math.min(Math.max(Number(request.query.limit) || 30, 1), 100);
      const offset = Math.max(Number(request.query.offset) || 0, 0);
      const base = `FROM services s
        JOIN machine_placements p ON p.id = s.placement_id
        JOIN locations l ON l.id = p.location_id
        LEFT JOIN staff st ON st.id = s.technician_id
        LEFT JOIN service_visit_photos first_photo ON first_photo.local_id = s.local_id
          AND first_photo.slot = 1 AND first_photo.uploaded_by = s.technician_id
          AND first_photo.uploaded_at >= now() - interval '30 days'
        LEFT JOIN service_visit_photos second_photo ON second_photo.local_id = s.local_id
          AND second_photo.slot = 2 AND second_photo.uploaded_by = s.technician_id
          AND second_photo.uploaded_at >= now() - interval '30 days'
        WHERE (first_photo.object_key IS NOT NULL OR second_photo.object_key IS NOT NULL) ${condition}`;
      const [rows, total] = await Promise.all([
        pool.query(
          `SELECT s.local_id, s.service_date, s.occurred_at, s.machine_number,
                  COALESCE(NULLIF(p.address, ''), l.name) AS address, st.full_name AS technician_name,
                  first_photo.object_key AS photo_1, second_photo.object_key AS photo_2
           ${base} ORDER BY s.occurred_at DESC, s.id DESC LIMIT ${limit} OFFSET ${offset}`,
          params,
        ),
        pool.query(`SELECT COUNT(*)::int AS count ${base}`, params),
      ]);
      return { rows: rows.rows, total: total.rows[0].count, limit, offset };
    },
  );

  const authenticateImage = async (request: Parameters<typeof app.authenticate>[0]) => {
    const token = (request.query as { token?: string } | undefined)?.token;
    if (token && !request.headers.authorization) request.headers.authorization = `Bearer ${token}`;
    await app.authenticate(request);
  };

  app.get<{ Params: { localId: string; slot: string }; Querystring: { token?: string } }>(
    '/api/service-photos/:localId/:slot', { preHandler: authenticateImage }, async (request, reply) => {
      if (!UUID.test(request.params.localId)) throw notFound('фото не найдено');
      const slot = slotNumber(request.params.slot);
      const result = await pool.query<{ object_key: string; uploaded_by: number }>(
        `SELECT object_key, uploaded_by FROM service_visit_photos
         WHERE local_id = $1 AND slot = $2 AND uploaded_at >= now() - interval '30 days'`,
        [request.params.localId, slot],
      );
      const row = result.rows[0];
      if (!row) throw notFound('фото не найдено');
      if (request.actor.role !== 'ADMIN' && Number(row.uploaded_by) !== request.actor.id) {
        throw forbidden('фото другого техника');
      }
      const opened = await openRasterPhoto(photoPath(config.photoDir, row.object_key));
      if (!opened) throw notFound('фото не найдено');
      return reply.type(opened.contentType)
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(opened.stream);
    },
  );
}

/** Runs only in the API process, not when tests create an in-memory Fastify instance. */
export async function cleanupExpiredVisitPhotos(): Promise<number> {
  return withTransaction(async (client) => {
    const expired = await client.query<{ object_key: string }>(
      `SELECT object_key FROM service_visit_photos
       WHERE uploaded_at < now() - interval '30 days'
       ORDER BY uploaded_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
    );
    for (const row of expired.rows) {
      await unlink(photoPath(config.photoDir, row.object_key)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await client.query('DELETE FROM photo_objects WHERE object_key = $1', [row.object_key]);
    }
    return expired.rowCount ?? 0;
  });
}

export function startVisitPhotoCleanup(): void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    cleanupExpiredVisitPhotos()
      .then((removed) => { if (removed) console.log(`expired visit photos removed: ${removed}`); })
      .catch((error) => console.error('visit photo cleanup failed:', error))
      .finally(() => { running = false; });
  };
  run();
  setInterval(run, 60 * 60_000);
}
