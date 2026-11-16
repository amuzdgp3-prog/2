import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  counterPhotoReviews, pendingCounterPhotos, resolveCounterPhoto, saveCounterPhotoResult,
} from '../commands/counterPhotoChecks.js';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';

const idSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' } },
} as const;

const hash = (value: string) => createHash('sha256').update(value).digest();

async function authenticateWorker(request: FastifyRequest) {
  const expected = config.counterPhotoToken;
  const header = request.headers.authorization ?? '';
  if (!expected || !timingSafeEqual(hash(header), hash(`Bearer ${expected}`))) {
    throw new AppError(401, 'UNAUTHORIZED', 'нужен ключ службы распознавания');
  }
}

export async function registerCounterPhotoRoutes(app: FastifyInstance) {
  app.get('/api/counter-photo-checks/pending', { onRequest: authenticateWorker }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return pendingCounterPhotos();
  });

  app.post<{ Params: { id: string }; Body: { values: [number, number] | null } }>(
    '/api/counter-photo-checks/:id/result',
    {
      onRequest: authenticateWorker,
      schema: {
        params: idSchema,
        body: {
          type: 'object', required: ['values'],
          properties: {
            values: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'array', minItems: 2, maxItems: 2,
                  items: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                },
              ],
            },
          },
        },
      },
    },
    async (request) => saveCounterPhotoResult(request.params.id, request.body.values),
  );

  app.get('/api/counter-photo-checks/reviews', { preHandler: app.authenticate }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return counterPhotoReviews(request.actor);
  });

  app.post<{ Params: { id: string } }>(
    '/api/counter-photo-checks/:id/resolve',
    { preHandler: app.authenticate, schema: { params: idSchema } },
    async (request) => resolveCounterPhoto(request.actor, request.params.id),
  );
}
