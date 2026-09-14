import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import {
  aggregateByLocation,
  divideDecimal,
  monthlyReport,
  queryMachineRows,
  sumDecimal,
  technicianReport,
  toCsv,
  type ReportFilters,
} from '../domain/reports.js';
import { technicianEffectiveness } from '../domain/technicianEffectiveness.js';
import { buildMonthlyReportWorkbook } from '../domain/monthlyExcelReport.js';
import { machineToyConsumption, toyMonthlyTrend } from '../domain/toyAnalysis.js';
import { sendTelegramDocument } from '../integrations/telegram.js';
import { sendReportEmail } from '../integrations/email.js';
import { badRequest } from '../lib/errors.js';
import { assertAdmin, machineScopePredicate } from '../lib/scope.js';

function parseFilters(query: Record<string, string | undefined>): ReportFilters {
  return {
    from: query.from,
    to: query.to,
    locationId: query.locationId ? Number(query.locationId) : undefined,
    classifierId: query.classifierId ? Number(query.classifierId) : undefined,
    machineNumber: query.machineNumber,
    machineType: query.machineType,
    technicianId: query.technicianId ? Number(query.technicianId) : undefined,
    routeId: query.routeId ? Number(query.routeId) : undefined,
    limit: query.limit ? Number(query.limit) : undefined,
    offset: query.offset ? Number(query.offset) : undefined,
  };
}

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: app.authenticate };

  /** Reports, dashboard and export all read through the same calculation layer. */
  app.get<{ Querystring: Record<string, string> }>('/api/reports/financial', auth, async (request) => {
    const client = await pool.connect();
    try {
      const rows = await queryMachineRows(client, request.actor, parseFilters(request.query));
      const locations = aggregateByLocation(rows);
      return {
        locations,
        totals: {
          services: rows.reduce((total, row) => total + row.services, 0),
          newGames: sumDecimal(rows.map((row) => row.newGames), 4),
          revenue: sumDecimal(rows.map((row) => row.revenue), 2),
          cashless: sumDecimal(rows.map((row) => row.cashless), 2),
          cash: sumDecimal(rows.map((row) => row.cash), 2),
          toyCost: sumDecimal(rows.map((row) => row.toyCost), 2),
        },
      };
    } finally {
      client.release();
    }
  });

  app.get<{ Querystring: Record<string, string> }>('/api/reports/monthly', auth, async (request) => {
    const client = await pool.connect();
    try {
      return await monthlyReport(client, request.actor, {
        locationId: request.query.locationId ? Number(request.query.locationId) : undefined,
        classifierId: request.query.classifierId ? Number(request.query.classifierId) : undefined,
        months: request.query.months ? Number(request.query.months) : undefined,
      });
    } finally {
      client.release();
    }
  });

  app.get<{ Querystring: Record<string, string> }>('/api/reports/technicians', auth, async (request) => {
    const client = await pool.connect();
    try {
      return await technicianReport(client, request.actor, parseFilters(request.query));
    } finally {
      client.release();
    }
  });

  /**
   * Эффективность техников (DECISION-046 закрыт 14.09.2026). Отдельный эндпоинт, а не расширение
   * /api/reports/technicians: тот отчёт сознательно остаётся отчётом голых фактов, и одно не
   * должно ломать другое.
   */
  app.get<{ Querystring: Record<string, string> }>(
    '/api/reports/technician-effectiveness',
    auth,
    async (request) => {
      const client = await pool.connect();
      try {
        return await technicianEffectiveness(client, request.actor, parseFilters(request.query));
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Querystring: Record<string, string> }>('/api/reports/export.csv', auth, async (request, reply) => {
    const client = await pool.connect();
    try {
      const rows = await queryMachineRows(client, request.actor, parseFilters(request.query));
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="apixspb-report.csv"')
        .send(toCsv(rows));
    } finally {
      client.release();
    }
  });

  /** YYYY-MM-DD in UTC — matches the plain-date convention services.service_date filters use. */
  const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

  /**
   * Fixed KPI periods (10_ТЗ dashboard requirement): month-to-date, ISO week-to-date (Monday
   * start), the previous full calendar month, and year-to-date. All "to-date" periods run
   * through today; "last month" is the complete prior calendar month, not a rolling 30 days.
   *
   * The upper bound of every "to-date" period is tomorrow (UTC), not today: `service_date` is
   * resolved in the Location's own timezone (10_ТЗ), and every Russian timezone runs ahead of
   * UTC (Kaliningrad +2 through the Far East +12) — a service that just happened can already be
   * "tomorrow" locally while this server's UTC clock still reads today. Capping at UTC-today
   * would silently drop same-day revenue from any location east of Moscow. A genuinely future
   * occurred_at cannot exist in the data regardless (services.ts rejects it at creation), so
   * widening this bound only fixes the timezone-lag classification — it cannot leak real future
   * data.
   */
  function dashboardPeriods(now = new Date()) {
    const upperBound = isoDate(new Date(now.getTime() + 24 * 3_600_000));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const isoDayOfWeek = now.getUTCDay() === 0 ? 7 : now.getUTCDay(); // Monday = 1 .. Sunday = 7
    const weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() - (isoDayOfWeek - 1));
    const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    const lastMonthStart = new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 1));
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    return {
      monthToDate: { from: isoDate(monthStart), to: upperBound },
      weekToDate: { from: isoDate(weekStart), to: upperBound },
      lastMonth: { from: isoDate(lastMonthStart), to: isoDate(lastMonthEnd) },
      yearToDate: { from: isoDate(yearStart), to: upperBound },
    };
  }

  app.get('/api/dashboard', auth, async (request) => {
    const client = await pool.connect();
    try {
      // Sequential, not Promise.all: these all share one pooled client, and a pg client can only
      // run one query at a time — issuing several concurrently on it is deprecated in `pg` and
      // would otherwise silently serialize anyway.
      const periods = dashboardPeriods();
      const monthRows = await queryMachineRows(client, request.actor, periods.monthToDate);
      const weekRows = await queryMachineRows(client, request.actor, periods.weekToDate);
      const lastMonthRows = await queryMachineRows(client, request.actor, periods.lastMonth);
      const yearRows = await queryMachineRows(client, request.actor, periods.yearToDate);

      const machineScope = machineScopePredicate(request.actor, 'm.machine_number', 1);
      const machineCounts = await client.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active, COUNT(*)::int AS total
         FROM machines m WHERE ${machineScope.sql}`,
        machineScope.params,
      );
      // Terminal fleet management is admin-only, so this count is never scoped to a technician.
      const terminalCounts = await client.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'INSTALLED')::int AS active,
                COUNT(*) FILTER (WHERE status <> 'RETIRED')::int AS total
         FROM terminals`,
      );

      const scope = machineScopePredicate(request.actor, 's.machine_number', 1);
      const anomalies = await client.query(
        `SELECT s.id, s.machine_number, s.service_date, s.revenue, s.cashless_amount, s.cash_amount
         FROM services s
         WHERE s.is_financial_anomaly AND ${scope.sql}
         ORDER BY s.occurred_at DESC LIMIT 20`,
        scope.params,
      );

      const revenueRow = (row: (typeof monthRows)[number]) => ({
        machineNumber: row.machineNumber,
        locationName: row.locationName,
        revenue: row.revenue,
      });
      const roiCandidates = monthRows
        .filter((row) => Number(row.toyCost) > 0)
        .map((row) => ({
          machineNumber: row.machineNumber,
          locationName: row.locationName,
          roi: divideDecimal(row.revenue, row.toyCost, 2),
          roiValue: Number(row.revenue) / Number(row.toyCost),
        }));

      const byRevenueAsc = [...monthRows].sort((a, b) => Number(a.revenue) - Number(b.revenue));
      const byRoiAsc = [...roiCandidates].sort((a, b) => a.roiValue - b.roiValue);

      return {
        counts: {
          activeMachines: machineCounts.rows[0].active,
          totalMachines: machineCounts.rows[0].total,
          activeTerminals: terminalCounts.rows[0].active,
          totalTerminals: terminalCounts.rows[0].total,
        },
        revenue: {
          monthToDate: sumDecimal(monthRows.map((row) => row.revenue), 2),
          weekToDate: sumDecimal(weekRows.map((row) => row.revenue), 2),
          lastMonth: sumDecimal(lastMonthRows.map((row) => row.revenue), 2),
          yearToDate: sumDecimal(yearRows.map((row) => row.revenue), 2),
        },
        // Ranked over the current month to date — the same period as the primary KPI above.
        topRevenue: byRevenueAsc.slice().reverse().slice(0, 10).map(revenueRow),
        worstRevenue: byRevenueAsc.slice(0, 10).map(revenueRow),
        topRoi: [...roiCandidates].sort((a, b) => b.roiValue - a.roiValue).slice(0, 10)
          .map(({ machineNumber, locationName, roi }) => ({ machineNumber, locationName, roi })),
        worstRoi: byRoiAsc.slice(0, 10)
          .map(({ machineNumber, locationName, roi }) => ({ machineNumber, locationName, roi })),
        anomalies: anomalies.rows,
      };
    } finally {
      client.release();
    }
  });

  app.get<{ Querystring: Record<string, string> }>('/api/audit', auth, async (request) => {
    assertAdmin(request.actor);
    // Row-count display setting (50/100/500 — owner requirement): any other value is clamped
    // rather than trusted verbatim, since this becomes a LIMIT straight into SQL.
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(request.query.offset) || 0, 0);
    const result = await pool.query(
      `SELECT *, COUNT(*) OVER()::int AS total_count FROM audit_log
       WHERE ($1::text IS NULL OR entity = $1)
         AND ($2::text IS NULL OR entity_id = $2)
       ORDER BY occurred_at DESC LIMIT $3 OFFSET $4`,
      [request.query.entity ?? null, request.query.entityId ?? null, limit, offset],
    );
    const total = result.rows[0]?.total_count ?? 0;
    return { rows: result.rows.map(({ total_count, ...row }) => row), total };
  });

  /** Расход игрушек: помесячный тренд + прогноз закупки на следующий месяц (10_ТЗ дополнение). */
  app.get<{ Querystring: { months?: string } }>('/api/reports/toy-forecast', auth, async (request) => {
    const client = await pool.connect();
    try {
      return await toyMonthlyTrend(client, request.actor, Number(request.query.months) || 6);
    } finally {
      client.release();
    }
  });

  /**
   * Расход игрушек по аппаратам за период с выявлением статистических выбросов относительно
   * выручки — как «слишком щедрых» (мало выручки на единицу себестоимости), так и «слишком
   * жадных» (наоборот) относительно среднего по флоту за тот же период.
   */
  app.get<{ Querystring: Record<string, string> }>('/api/reports/toy-consumption', auth, async (request) => {
    const client = await pool.connect();
    try {
      return await machineToyConsumption(client, request.actor, {
        from: request.query.from,
        to: request.query.to,
        locationId: request.query.locationId ? Number(request.query.locationId) : undefined,
      });
    } finally {
      client.release();
    }
  });

  function parseYearMonth(query: { year?: string; month?: string }): { year: number; month: number } {
    const now = new Date();
    const year = query.year ? Number(query.year) : now.getUTCFullYear();
    const month = query.month ? Number(query.month) : now.getUTCMonth() + 1;
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      throw badRequest('INVALID_MONTH', 'некорректный год или месяц');
    }
    return { year, month };
  }

  /** Тот же ежемесячный xlsx-отчёт (шапка/детализация/расходы), что раньше собирался вручную —
   * теперь генерируется из реальных данных по кнопке. Доступен и ADMIN, и BOSS (как остальные
   * отчёты) — только скачивание готового файла, без доступа к вводу самих расходов. */
  app.get<{ Querystring: { year?: string; month?: string } }>(
    '/api/reports/monthly-excel',
    auth,
    async (request, reply) => {
      const { year, month } = parseYearMonth(request.query);
      const client = await pool.connect();
      try {
        const workbook = await buildMonthlyReportWorkbook(client, request.actor, { year, month });
        const buffer = await workbook.xlsx.writeBuffer();
        // Cyrillic can't ride in a raw Content-Disposition header value (HTTP headers are
        // ASCII-only) — RFC 5987's filename* carries the real UTF-8 name, with a plain ASCII
        // filename kept alongside for any client that ignores the extended form.
        const encodedName = encodeURIComponent(`Отчет ${year}-${String(month).padStart(2, '0')}.xlsx`);
        return reply
          .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .header(
            'content-disposition',
            `attachment; filename="report-${year}-${String(month).padStart(2, '0')}.xlsx"; filename*=UTF-8''${encodedName}`,
          )
          .send(Buffer.from(buffer));
      } finally {
        client.release();
      }
    },
  );

  /** Отправка того же файла владельцу в Telegram — только ADMIN, владелец получает его пассивно. */
  app.post<{ Querystring: { year?: string; month?: string } }>(
    '/api/reports/monthly-excel/send-telegram',
    auth,
    async (request) => {
      assertAdmin(request.actor);
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
      if (!botToken || !chatId) {
        throw badRequest('TELEGRAM_NOT_CONFIGURED', 'Telegram-бот не настроен (нет токена или chat_id)');
      }
      const { year, month } = parseYearMonth(request.query);
      const client = await pool.connect();
      try {
        const workbook = await buildMonthlyReportWorkbook(client, request.actor, { year, month });
        const buffer = await workbook.xlsx.writeBuffer();
        const filename = `Отчет ${year}-${String(month).padStart(2, '0')}.xlsx`;
        await sendTelegramDocument(botToken, chatId, Buffer.from(buffer), filename, filename);
        return { ok: true };
      } finally {
        client.release();
      }
    },
  );

  /** Второй канал доставки того же файла — электронная почта. Появился после того, как выяснилось,
   * что сеть сервера не пропускает Telegram (DECISION-074): владелец переключился на почту, но
   * код отправки в Telegram не удалён — если сеть починят (например, через уже установленный
   * VPN), кнопка выше снова заработает без доработок. */
  app.post<{ Querystring: { year?: string; month?: string } }>(
    '/api/reports/monthly-excel/send-email',
    auth,
    async (request) => {
      assertAdmin(request.actor);
      const apiKey = process.env.RESEND_API_KEY;
      const from = process.env.RESEND_FROM;
      const to = process.env.REPORT_OWNER_EMAIL;
      if (!apiKey || !from || !to) {
        throw badRequest('EMAIL_NOT_CONFIGURED', 'отправка на почту не настроена (нет ключа, отправителя или адреса получателя)');
      }
      const { year, month } = parseYearMonth(request.query);
      const client = await pool.connect();
      try {
        const workbook = await buildMonthlyReportWorkbook(client, request.actor, { year, month });
        const buffer = await workbook.xlsx.writeBuffer();
        const filename = `Отчет ${year}-${String(month).padStart(2, '0')}.xlsx`;
        await sendReportEmail(apiKey, from, to, Buffer.from(buffer), filename, filename);
        return { ok: true };
      } finally {
        client.release();
      }
    },
  );
}
