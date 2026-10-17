import type { FastifyInstance } from 'fastify';
import { recordClientEvents, type ClientEventsBody } from '../commands/clientEvents.js';
import { withTransaction } from '../db/pool.js';

export async function registerClientEventRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ClientEventsBody }>(
    '/api/client-events',
    {
      preHandler: app.authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['appVersion', 'events'],
          properties: {
            appVersion: { type: 'string', minLength: 1, maxLength: 64 },
            events: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                type: 'object',
                required: ['at', 'kind'],
                properties: {
                  at: { type: 'string', maxLength: 40 },
                  kind: { type: 'string', minLength: 1, maxLength: 64 },
                  screen: { type: 'string', maxLength: 200 },
                  detail: { type: 'object' },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      await withTransaction((client) =>
        recordClientEvents(client, request.actor, request.body, request.headers['user-agent']));
      return { ok: true };
    },
  );
}
