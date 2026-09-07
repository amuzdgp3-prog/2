import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { createService, deleteService, updateService, type ServiceInput } from '../commands/services.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { assertAdmin, assertMachineInScope, machineScopePredicate } from '../lib/scope.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const serviceBodySchema = {
  type: 'object',
  required: ['localId', 'machineNumber', 'occurredAt', 'gameCounter', 'prizeCounter', 'photoObjectKey'],
  properties: {
    localId: { type: 'string', format: 'uuid' },
    machineNumber: { type: 'string', minLength: 1 },
    occurredAt: { type: 'string' },
    gameCounter: { type: 'integer', minimum: 0 },
    prizeCounter: { type: 'integer', minimum: 0 },
    testGames: { type: 'integer', minimum: 0 },
    photoObjectKey: { type: 'string', minLength: 1 },
    notes: { type: 'string' },
    toys: {
      type: 'array',
      items: {
        type: 'object',
        required: ['toyId', 'quantity'],
        properties: { toyId: { type: 'integer' }, quantity: { type: 'integer', minimum: 1 } },
      },
    },
  },
} as const;

export async function registerServiceRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: app.authenticate };

  /**
   * Counter photo upload. The object key is derived deterministically from the Service localId,
   * so a retried offline upload overwrites its own object instead of creating a new one.
   * The permanent association happens only when the Service transaction commits; objects that
   * never get a Service are removed by the orphan cleanup endpoint.
   */
  app.post('/api/photos', auth, async (request) => {
    const file = await request.file();
    if (!file) throw badRequest('FILE_REQUIRED', 'нужен файл фотографии');

    const localId = (file.fields.localId as { value?: string } | undefined)?.value;
    if (!localId || !UUID_PATTERN.test(localId)) {
      throw badRequest('LOCAL_ID_REQUIRED', 'нужен корректный идентификатор localId');
    }

    const extension = file.mimetype === 'image/png' ? 'png' : 'jpg';
    const objectKey = `services/${localId}.${extension}`;
    const absolutePath = join(config.photoDir, objectKey);
    await mkdir(dirname(absolutePath), { recursive: true });
    await pipeline(file.file, createWriteStream(absolutePath));

    if (file.file.truncated) {
      await unlink(absolutePath).catch(() => undefined);
      throw badRequest('FILE_TOO_LARGE', 'фото счётчика превышает допустимый размер');
    }

    await pool.query(
      `INSERT INTO photo_objects (object_key, local_id, uploaded_by, byte_size, content_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (object_key) DO UPDATE
         SET byte_size = EXCLUDED.byte_size, uploaded_at = now()`,
      [objectKey, localId, request.actor.id, file.file.bytesRead, file.mimetype],
    );

    return { objectKey };
  });

  app.post<{ Body: ServiceInput }>(
    '/api/services',
    { ...auth, schema: { body: serviceBodySchema } },
    async (request) =>
      withTransaction((client) => createService(client, request.actor, request.body)),
  );

  /**
   * Offline sync. Every queued Service is applied in its own transaction so that one rejected
   * record does not block the rest of the queue; `local_id` makes replays idempotent.
   */
  app.post<{ Body: { services: ServiceInput[] } }>('/api/services/sync', auth, async (request) => {
    const results: Array<Record<string, unknown>> = [];
    for (const item of request.body.services ?? []) {
      try {
        const stored = await withTransaction((client) =>
          createService(client, request.actor, item),
        );
        results.push({
          localId: item.localId,
          status: stored.idempotentReplay ? 'DUPLICATE' : 'ACCEPTED',
          serviceId: stored.service.id,
        });
      } catch (error) {
        const appError = error as { code?: string; statusCode?: number; message: string };
        results.push({
          localId: item.localId,
          status: 'REJECTED',
          error: appError.code ?? 'ERROR',
          message: appError.message,
        });
      }
    }
    return { results };
  });

  /**
   * Журнал обслуживаний (docs/design/mockups/07_admin_service_log.html): та же таблица services,
   * что и остальной API, но с полным набором фильтров и постраничным выводом для админ-экрана.
   */
  app.get<{
    Querystring: {
      machineNumber?: string;
      from?: string;
      to?: string;
      technicianId?: string;
      locationId?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/services', auth, async (request) => {
    const params: unknown[] = [];
    const conditions: string[] = [];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (request.query.machineNumber) {
      conditions.push(`s.machine_number = ${push(request.query.machineNumber)}`);
    }
    if (request.query.from) conditions.push(`s.service_date >= ${push(request.query.from)}::date`);
    if (request.query.to) conditions.push(`s.service_date <= ${push(request.query.to)}::date`);
    if (request.query.technicianId) {
      conditions.push(`s.technician_id = ${push(Number(request.query.technicianId))}`);
    }
    if (request.query.search) {
      const needle = `%${request.query.search}%`;
      conditions.push(
        `(s.machine_number ILIKE ${push(needle)} OR m.model ILIKE ${push(needle)} OR l.name ILIKE ${push(needle)})`,
      );
    }
    if (request.query.locationId) {
      // Includes the whole subtree, same as the financial report's location filter.
      conditions.push(`p.location_id IN (
        WITH RECURSIVE subtree AS (
          SELECT id FROM locations WHERE id = ${push(Number(request.query.locationId))}
          UNION
          SELECT child.id FROM locations child JOIN subtree ON child.parent_id = subtree.id
        ) SELECT id FROM subtree)`);
    }

    const scope = machineScopePredicate(request.actor, 's.machine_number', params.length + 1);
    params.push(...scope.params);
    conditions.push(scope.sql);

    const where = conditions.join(' AND ');
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(request.query.offset) || 0, 0);

    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT s.*, l.name AS location_name, p.address, m.model AS machine_model, st.full_name AS technician_name
         FROM services s
         JOIN machine_placements p ON p.id = s.placement_id
         JOIN locations l ON l.id = p.location_id
         JOIN machines m ON m.machine_number = s.machine_number
         LEFT JOIN staff st ON st.id = s.technician_id
         WHERE ${where}
         ORDER BY s.occurred_at DESC, s.id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count
         FROM services s
         JOIN machine_placements p ON p.id = s.placement_id
         JOIN locations l ON l.id = p.location_id
         JOIN machines m ON m.machine_number = s.machine_number
         WHERE ${where}`,
        params,
      ),
    ]);

    return { rows: rows.rows, total: total.rows[0].count, limit, offset };
  });

  app.get<{ Params: { id: string } }>('/api/services/:id', auth, async (request) => {
    const scope = machineScopePredicate(request.actor, 's.machine_number', 2);
    const service = await pool.query(
      `SELECT s.* FROM services s WHERE s.id = $1 AND ${scope.sql}`,
      [Number(request.params.id), ...scope.params],
    );
    if (service.rowCount === 0) throw notFound('обслуживание не найдено');
    const toys = await pool.query(
      `SELECT td.*, t.name FROM toy_distributions td
       JOIN toys t ON t.id = td.toy_id WHERE td.service_id = $1`,
      [Number(request.params.id)],
    );
    return { ...service.rows[0], toys: toys.rows };
  });

  app.patch<{ Params: { id: string }; Body: Parameters<typeof updateService>[3] }>(
    '/api/services/:id',
    auth,
    async (request) =>
      withTransaction((client) =>
        updateService(client, request.actor, Number(request.params.id), request.body),
      ),
  );

  app.delete<{ Params: { id: string } }>('/api/services/:id', auth, async (request) => {
    await withTransaction((client) =>
      deleteService(client, request.actor, Number(request.params.id)),
    );
    return { deleted: true };
  });

  /**
   * Counter photos are served through the API so that authentication still applies. An <img> tag
   * cannot send an Authorization header, so this route also accepts the same token as a query
   * parameter; everything else keeps using the header.
   */
  const authenticatePhoto = async (request: Parameters<typeof app.authenticate>[0]) => {
    const queryToken = (request.query as { token?: string } | undefined)?.token;
    if (queryToken && !request.headers.authorization) {
      request.headers.authorization = `Bearer ${queryToken}`;
    }
    await app.authenticate(request);
  };

  app.get<{ Params: { '*': string }; Querystring: { token?: string } }>(
    '/api/photos/*',
    { preHandler: authenticatePhoto },
    async (request, reply) => {
      const objectKey = request.params['*'];
      if (objectKey.includes('..')) throw badRequest('BAD_OBJECT_KEY', 'некорректный идентификатор файла');

      const stored = await pool.query(
        `SELECT po.content_type, po.uploaded_by, s.machine_number
         FROM photo_objects po
         LEFT JOIN services s ON s.photo_object_key = po.object_key
         WHERE po.object_key = $1`,
        [objectKey],
      );
      if (stored.rowCount === 0) return reply.code(404).send({ error: 'NOT_FOUND' });

      const row = stored.rows[0];
      if (row.machine_number) {
        const client = await pool.connect();
        try {
          await assertMachineInScope(client, request.actor, row.machine_number);
        } finally {
          client.release();
        }
      } else if (request.actor.role === 'TECHNICIAN' && row.uploaded_by !== request.actor.id) {
        throw forbidden('фото вне зоны ответственности техника');
      }

      return reply
        .type(row.content_type)
        .send(createReadStream(join(config.photoDir, objectKey)));
    },
  );

  /** Orphan photo cleanup: objects never associated with a committed Service. */
  app.post('/api/photos/cleanup', auth, async (request) => {
    assertAdmin(request.actor);
    const orphans = await pool.query(
      `DELETE FROM photo_objects po
       WHERE po.uploaded_at < now() - ($1 || ' hours')::interval
         AND NOT EXISTS (SELECT 1 FROM services s WHERE s.photo_object_key = po.object_key)
       RETURNING object_key`,
      [config.orphanPhotoTtlHours],
    );
    for (const row of orphans.rows) {
      await unlink(join(config.photoDir, row.object_key)).catch(() => undefined);
    }
    return { removed: orphans.rowCount };
  });
}
