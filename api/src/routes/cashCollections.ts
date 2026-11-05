import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../db/pool.js';
import { collectionOverview, countCollection, createCollection, previewCollection } from '../commands/cashCollections.js';

export async function registerCashCollectionRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };
  app.get('/api/cash-collections', auth, request => withTransaction(client => collectionOverview(client, request.actor)));
  app.get<{ Querystring: { technicianId: string; to: string } }>('/api/cash-collections/preview', {
    ...auth, schema: { querystring: { type: 'object', required: ['technicianId', 'to'], properties: {
      technicianId: { type: 'integer', minimum: 1 }, to: { type: 'string' },
    } } },
  }, request => withTransaction(client => previewCollection(client, request.actor, Number(request.query.technicianId), request.query.to)));
  app.post<{ Body: Parameters<typeof createCollection>[2] }>('/api/cash-collections', {
    ...auth, schema: { body: { type: 'object', additionalProperties: false, required: ['technicianId', 'to', 'receivedOn', 'token'], properties: {
      technicianId: { type: 'integer', minimum: 1 }, to: { type: 'string' }, receivedOn: { type: 'string' }, token: { type: 'string', maxLength: 64 },
    } } },
  }, request => withTransaction(client => createCollection(client, request.actor, request.body)));
  app.post<{ Params: { id: string }; Body: { actual: string; comment: string } }>('/api/cash-collections/:id/count', {
    ...auth, schema: { params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } },
      body: { type: 'object', additionalProperties: false, required: ['actual', 'comment'], properties: {
        actual: { type: 'string' }, comment: { type: 'string', maxLength: 2000 },
      } } },
  }, request => withTransaction(client => countCollection(client, request.actor, Number(request.params.id), request.body)));
}
