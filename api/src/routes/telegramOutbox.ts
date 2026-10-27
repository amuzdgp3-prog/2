import type { FastifyInstance } from 'fastify';
import { pool, withTransaction } from '../db/pool.js';
import { buildMonthlyReportWorkbook } from '../domain/monthlyExcelReport.js';
import {
  getTelegramMessage,
  listPendingTelegramMessages,
  markTelegramMessageFailed,
  markTelegramMessageSent,
} from '../commands/telegramOutbox.js';
import { badRequest } from '../lib/errors.js';

/**
 * API для внешнего релея (commands/telegramOutbox.ts объясняет, зачем он нужен). Релей логинится
 * обычным /api/auth/login под тем же ADMIN_LOGIN/ADMIN_PASSWORD, что уже есть в .env, и дальше
 * ходит сюда как любой другой ADMIN-клиент — отдельного механизма авторизации не заводим.
 */
export async function registerTelegramOutboxRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: app.authenticate };

  app.get('/api/telegram-outbox/pending', auth, async (request) =>
    withTransaction((client) => listPendingTelegramMessages(client, request.actor)));

  /** Для kind='monthly_report' — файл не хранится в очереди, пересобирается на момент отправки:
   *  к моменту, когда релей его заберёт, данные успевают устареть меньше, чем если бы отчёт
   *  строился сразу при постановке в очередь и ждал отправки часами. */
  app.get<{ Params: { id: string } }>('/api/telegram-outbox/:id/file', auth, async (request, reply) => {
    const id = Number(request.params.id);
    const client = await pool.connect();
    try {
      const message = await getTelegramMessage(client, request.actor, id);
      if (message.kind !== 'monthly_report') {
        throw badRequest('NOT_A_FILE_MESSAGE', 'у этого сообщения нет файла');
      }
      const { year, month } = message.payload as { year: number; month: number };
      const workbook = await buildMonthlyReportWorkbook(client, request.actor, { year, month });
      const buffer = await workbook.xlsx.writeBuffer();
      const filename = `Отчет ${year}-${String(month).padStart(2, '0')}.xlsx`;
      reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
        .send(Buffer.from(buffer));
    } finally {
      client.release();
    }
  });

  app.post<{ Params: { id: string } }>('/api/telegram-outbox/:id/ack', auth, async (request) => {
    await withTransaction((client) =>
      markTelegramMessageSent(client, request.actor, Number(request.params.id)));
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { error: string } }>(
    '/api/telegram-outbox/:id/fail',
    auth,
    async (request) => {
      await withTransaction((client) =>
        markTelegramMessageFailed(client, request.actor, Number(request.params.id), request.body?.error ?? ''));
      return { ok: true };
    },
  );
}
