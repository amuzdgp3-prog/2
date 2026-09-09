import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { config } from './config.js';
import { runIvendSync } from './commands/ivendSync.js';
import { runMigrations } from './db/migrate.js';
import { pool, withTransaction } from './db/pool.js';
import { seedAdmin } from './db/seed.js';
import { AppError } from './lib/errors.js';
import { SYSTEM_ACTOR, type Actor } from './lib/audit.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCashlessRoutes } from './routes/cashless.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerExpenseRoutes } from './routes/expenses.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerServiceRoutes } from './routes/services.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
  interface FastifyInstance {
    authenticate: (request: import('fastify').FastifyRequest) => Promise<void>;
  }
}

/**
 * Database constraints are the last line of defence, but their violation messages are not
 * something a technician in the field should have to read. Known ones are translated into the
 * business rule they protect.
 */
const CONSTRAINT_MESSAGES: Record<string, { code: string; message: string }> = {
  services_one_per_placement_date: {
    code: 'SERVICE_DATE_TAKEN',
    message: 'на этот аппарат уже есть обслуживание за эту дату',
  },
  services_local_id_key: {
    code: 'LOCAL_ID_CONFLICT',
    message: 'обслуживание с таким идентификатором уже сохранено',
  },
  services_new_games_check: {
    code: 'NEGATIVE_NEW_GAMES',
    message: 'расчёт даёт отрицательное количество новых игр: проверьте показания и тестовые игры',
  },
  placements_no_overlap: {
    code: 'PLACEMENT_OVERLAP',
    message: 'у аппарата уже есть активная установка за этот период',
  },
  terminal_bindings_no_overlap: {
    code: 'TERMINAL_BINDING_OVERLAP',
    message: 'интервалы привязки терминала пересекаются',
  },
  terminal_bindings_one_active_per_machine: {
    code: 'MACHINE_TERMINAL_OCCUPIED',
    message: 'на аппарате уже есть активный терминал',
  },
  machines_counter_divisor_positive: {
    code: 'INVALID_COUNTER_DIVISOR',
    message: 'коэффициент счётчика должен быть больше нуля',
  },
};

export async function buildServer() {
  const app = Fastify({ logger: { level: config.logLevel } });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(multipart, { limits: { fileSize: config.maxPhotoBytes } });

  app.decorate('authenticate', async (request: import('fastify').FastifyRequest) => {
    await request.jwtVerify();
    const payload = request.user as { sub: number; login: string; role: Actor['role'] };
    const result = await pool.query<{ role: Actor['role']; is_active: boolean }>(
      'SELECT role, is_active FROM staff WHERE id = $1',
      [Number(payload.sub)],
    );
    const staff = result.rows[0];
    if (!staff || !staff.is_active) {
      throw new AppError(401, 'UNAUTHORIZED', 'учётная запись деактивирована');
    }
    request.actor = { id: Number(payload.sub), login: payload.login, role: staff.role };
  });

  // Fastify/Node framework errors carry their own English message and (for the ones we know
  // about) their own stable `code` — translated here so a technician never sees raw framework
  // text; anything not in the table falls back to one generic Russian message for its class.
  const FRAMEWORK_MESSAGES: Record<string, string> = {
    FST_ERR_CTP_EMPTY_JSON_BODY: 'тело запроса не может быть пустым',
    FST_ERR_CTP_INVALID_MEDIA_TYPE: 'неподдерживаемый тип содержимого запроса',
    FST_ERR_CTP_INVALID_JSON_BODY: 'тело запроса содержит некорректный JSON',
    FST_REQ_FILE_TOO_LARGE: 'файл превышает допустимый размер',
    FST_FILES_LIMIT: 'превышено допустимое количество файлов',
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message, details: error.details });
    }
    const pgError = error as { code?: string; constraint?: string; message: string };
    if (pgError.code === '23505' || pgError.code === '23514' || pgError.code === '23P01' || pgError.code === '23503') {
      const known = pgError.constraint ? CONSTRAINT_MESSAGES[pgError.constraint] : undefined;
      return reply.code(409).send({
        error: known?.code ?? 'CONSTRAINT_VIOLATION',
        message: known?.message ?? 'операция нарушает ограничение целостности данных',
        constraint: pgError.constraint,
      });
    }
    if ((error as { statusCode?: number }).statusCode === 401) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'требуется авторизация' });
    }
    if ((error as { validation?: unknown }).validation) {
      return reply
        .code(400)
        .send({ error: 'VALIDATION_FAILED', message: 'данные не прошли проверку', details: pgError.message });
    }
    const frameworkStatus = (error as { statusCode?: number }).statusCode;
    if (typeof frameworkStatus === 'number' && frameworkStatus >= 400 && frameworkStatus < 500) {
      const code = (error as { code?: string }).code ?? 'BAD_REQUEST';
      return reply
        .code(frameworkStatus)
        .send({ error: code, message: FRAMEWORK_MESSAGES[code] ?? 'некорректный запрос' });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'INTERNAL', message: 'внутренняя ошибка сервера' });
  });

  // A route that simply doesn't exist bypasses setErrorHandler entirely (Fastify's own 404, not
  // a thrown error) and would otherwise reach the client as raw English ("Route ... not found").
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'NOT_FOUND', message: 'такой маршрут не существует' });
  });

  app.get('/api/health', async () => {
    const result = await pool.query('SELECT now() AS now');
    return { status: 'ok', time: result.rows[0].now };
  });

  await registerAuthRoutes(app);
  await registerCatalogRoutes(app);
  await registerServiceRoutes(app);
  await registerCashlessRoutes(app);
  await registerReportRoutes(app);
  await registerExpenseRoutes(app);

  return app;
}

/**
 * Regular background sync for enabled parser providers (currently only iVend — DECISION-030).
 * Started only from the real process entrypoint, never from buildServer() itself, so importing
 * the test suite never triggers a real outbound call to a payment provider. Overlap-guarded: a
 * run that takes longer than the interval is never started twice concurrently.
 */
const MOSCOW_HHMM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Moscow',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const MOSCOW_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' });

async function loadIvendRunTimes(): Promise<string[]> {
  const result = await pool.query<{ schedule_cron: string }>(
    `SELECT schedule_cron FROM parser_settings WHERE provider = 'ivend'`,
  );
  const times = (result.rows[0]?.schedule_cron ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s));
  return times.length ? times : ['07:00', '19:00'];
}

/**
 * Владелец попросил парсер ходить в iVend 2 раза в сутки (время выбирает сам на странице
 * «Безнал»), а не каждые 5 минут как раньше — за постоянный опрос накопилось 150к+ строк
 * cashless_transactions на пустом месте. Расписание читается из БД на каждом тике, а не
 * один раз при старте, чтобы правка времени на странице применялась без перезапуска сервера.
 *
 * Неудачный запуск (в т.ч. транзитный сбой сети до кабинета iVend) повторяется через 5 минут,
 * и снова через 5 минут при повторном сбое — до первого успеха, а не молча ждёт следующего
 * запланированного времени (которое при одном назначенном времени может быть почти через сутки).
 * Явное решение владельца, см. DECISION-032/037 в DECISIONS.md.
 */
const RETRY_DELAY_MS = 5 * 60_000;

function startParserScheduler(): void {
  const tickMs = 60_000;
  let running = false;
  let lastFiredSlot: string | null = null;
  let retryAt: number | null = null;

  const attempt = async (): Promise<void> => {
    try {
      await withTransaction((client) => runIvendSync(client, SYSTEM_ACTOR));
      retryAt = null;
    } catch (error) {
      console.error('ivend sync failed, retrying in 5 minutes:', error);
      retryAt = Date.now() + RETRY_DELAY_MS;
    }
  };

  setInterval(() => {
    if (running) return;
    running = true;
    (async () => {
      const now = Date.now();
      if (retryAt !== null) {
        if (now >= retryAt) await attempt();
        return;
      }
      const hhmm = MOSCOW_HHMM.format(now);
      const slot = `${MOSCOW_DATE.format(now)} ${hhmm}`;
      if (slot === lastFiredSlot) return;
      const runTimes = await loadIvendRunTimes();
      if (!runTimes.includes(hhmm)) return;
      lastFiredSlot = slot;
      await attempt();
    })().finally(() => {
      running = false;
    });
  }, tickMs);
}

const isMain = process.argv[1]?.includes('server');
if (isMain) {
  const start = async () => {
    await runMigrations((message) => console.log(message));
    await seedAdmin();
    const app = await buildServer();
    await app.listen({ port: config.port, host: config.host });
    startParserScheduler();
  };
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
