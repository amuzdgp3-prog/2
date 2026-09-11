import type { Actor } from '../lib/audit.js';
import { pool, withTransaction, type Client } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { fetchIvendMachines, fetchIvendSales, ivendLogin } from '../integrations/ivend.js';
import { assertAdmin } from '../lib/scope.js';
import { importCashless, type RawTransaction } from './cashless.js';

const PROVIDER = 'ivend';

interface ParserSettingsRow {
  provider: string;
  is_enabled: boolean;
  schedule_cron: string;
  overlap_minutes: number;
  page_size: number;
  max_pages_per_run: number;
  login: string | null;
  password: string | null;
  updated_at: string;
}

async function loadRow(client: Client): Promise<ParserSettingsRow | null> {
  const result = await client.query<ParserSettingsRow>(
    'SELECT * FROM parser_settings WHERE provider = $1',
    [PROVIDER],
  );
  return result.rows[0] ?? null;
}

const RUN_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_RUN_TIMES = ['07:00', '19:00'];

/** schedule_cron хранит "HH:MM;HH:MM" (московское время) — владельцу проще двух полей времени,
 * чем cron-синтаксис, а полный cron (день/месяц/день недели) этому парсеру не нужен. */
function parseRunTimes(scheduleCron: string | undefined | null): string[] {
  const times = (scheduleCron ?? '').split(';').map((s) => s.trim()).filter((s) => RUN_TIME_RE.test(s));
  return times.length ? times : DEFAULT_RUN_TIMES;
}

export interface IvendSettingsView {
  isEnabled: boolean;
  login: string;
  hasPassword: boolean;
  overlapMinutes: number;
  runTimes: string[];
  lastRun: {
    startedAt: string;
    finishedAt: string | null;
    status: string;
    rowsInserted: number;
    rowsMatched: number;
    errorMessage: string | null;
  } | null;
}

/** Пароль никогда не возвращается клиенту — только факт, что он задан (см. GET /api/parser/settings). */
export async function getIvendSettings(client: Client, actor: Actor): Promise<IvendSettingsView> {
  assertAdmin(actor);
  const row = await loadRow(client);
  const lastRunResult = await client.query(
    `SELECT started_at, finished_at, status, rows_inserted, rows_matched, error_message
     FROM parser_runs WHERE provider = $1 ORDER BY started_at DESC LIMIT 1`,
    [PROVIDER],
  );
  const lastRun = lastRunResult.rows[0]
    ? {
        startedAt: lastRunResult.rows[0].started_at,
        finishedAt: lastRunResult.rows[0].finished_at,
        status: lastRunResult.rows[0].status,
        rowsInserted: lastRunResult.rows[0].rows_inserted,
        rowsMatched: lastRunResult.rows[0].rows_matched,
        errorMessage: lastRunResult.rows[0].error_message,
      }
    : null;

  return {
    isEnabled: row?.is_enabled ?? false,
    login: row?.login ?? '',
    hasPassword: Boolean(row?.password),
    overlapMinutes: row?.overlap_minutes ?? 120,
    runTimes: parseRunTimes(row?.schedule_cron),
    lastRun,
  };
}

/** Отдельно от логина/пароля: смена времени не должна каждый раз дёргать реальный вход в iVend. */
export async function saveIvendRunTimes(
  client: Client,
  actor: Actor,
  runTimes: string[],
): Promise<{ ok: boolean; runTimes: string[] }> {
  assertAdmin(actor);
  if (!Array.isArray(runTimes) || runTimes.length === 0) {
    throw badRequest('RUN_TIMES_REQUIRED', 'нужно указать хотя бы одно время запуска');
  }
  const normalized = [...new Set(runTimes.map((t) => t.trim()))].sort();
  for (const t of normalized) {
    if (!RUN_TIME_RE.test(t)) {
      throw badRequest('RUN_TIME_INVALID', `неверный формат времени: «${t}», ожидается ЧЧ:ММ`);
    }
  }
  await client.query(
    `UPDATE parser_settings SET schedule_cron = $2, updated_at = now() WHERE provider = $1`,
    [PROVIDER, normalized.join(';')],
  );
  return { ok: true, runTimes: normalized };
}

/**
 * Сохраняет логин/пароль кабинета iVend и сразу проверяет их реальным входом — так владелец
 * сразу видит «логин и пароль приняты» или «логин или пароль не верны», не дожидаясь фонового
 * запуска синхронизации.
 */
export async function saveIvendSettings(
  client: Client,
  actor: Actor,
  input: { login: string; password: string; isEnabled: boolean },
): Promise<{ ok: boolean; message: string }> {
  assertAdmin(actor);
  const login = input.login.trim();
  if (!login) throw badRequest('LOGIN_REQUIRED', 'нужно указать логин (телефон) кабинета iVend');
  if (!input.password) throw badRequest('PASSWORD_REQUIRED', 'нужно указать пароль кабинета iVend');

  const check = await ivendLogin(login, input.password);
  await client.query(
    `UPDATE parser_settings SET login = $2, password = $3, is_enabled = $4, updated_at = now()
     WHERE provider = $1`,
    [PROVIDER, login, input.password, input.isEnabled],
  );
  return {
    ok: check.ok,
    message: check.ok
      ? 'Логин и пароль приняты кабинетом iVend'
      : (check.message ?? 'логин или пароль не приняты кабинетом iVend'),
  };
}

export interface IvendSyncResult {
  skipped: boolean;
  imported?: number;
  matched?: number;
  error?: string;
}

/**
 * Забирает безналичные транзакции iVend для всех наших терминалов и заводит их через тот же
 * единый импортёр, что и ручной /api/cashless/import (10_ТЗ §13/§14 — DECISION-008: парсер не
 * создаёт Service и не трогает счётчики, только сырые транзакции; дальнейшее сопоставление —
 * matchTransactions внутри importCashless).
 *
 * Сопоставление терминала: iVend отдаёт per-machine поле controller.uid («устройство
 * телеметрии») — тот же номер, что администратор вводит как serial при создании терминала у нас.
 * Отдельной таблицы соответствий не нужно, достаточно текстового совпадения.
 *
 * Каждый запуск пишется в parser_runs целиком (даже неудачный — с error_message), поэтому история
 * синхронизаций видна в уже существующем GET /api/parser/runs без отдельного экрана.
 *
 * Транзакция БД держится только вокруг двух коротких моментов — чтения настроек в начале и записи
 * результата в конце, а не вокруг всей функции целиком (см. DECISION-041). Раньше вызывающий код
 * (server.ts/routes/cashless.ts) открывал одну транзакцию на весь вызов, и вся сетевая часть —
 * вход в кабинет плюс до ~40 страниц списка аппаратов плюс до 200 страниц продаж на каждый из
 * 85+ терминалов — выполнялась с удержанным соединением из пула. У fetch в Node нет таймаута по
 * умолчанию, поэтому один зависший запрос держал это соединение и, как следствие, флаг `running`
 * в планировщике (server.ts) бесконечно — до перезапуска контейнера синхронизация переставала
 * запускаться вовсе. Теперь функция сама открывает и закрывает свои транзакции, а вся сетевая
 * часть выполняется без какой-либо открытой транзакции; каждый отдельный запрос к iVend ограничен
 * таймаутом в integrations/ivend.ts.
 */
export async function runIvendSync(actor: Actor): Promise<IvendSyncResult> {
  assertAdmin(actor);

  // Фаза 1 — короткое чтение: настройки и момент последнего успешного запуска. Отдельная
  // транзакция держит соединение лишь на время пары SELECT, а не всей сетевой работы ниже.
  const prep = await withTransaction(async (client) => {
    const settings = await loadRow(client);
    if (!settings || !settings.is_enabled || !settings.login || !settings.password) {
      return null;
    }
    // The window starts where the last successful run left off, minus the configured overlap
    // margin (covers transactions that settle a bit late), and never further back than 90 days so
    // a first run or a long-disabled period doesn't request an unbounded history.
    const lastSuccess = await client.query<{ finished_at: string }>(
      `SELECT finished_at FROM parser_runs WHERE provider = $1 AND status = 'SUCCESS' AND finished_at IS NOT NULL
       ORDER BY finished_at DESC LIMIT 1`,
      [PROVIDER],
    );
    return { settings, lastFinishedAt: lastSuccess.rows[0]?.finished_at ?? null };
  });
  if (!prep) return { skipped: true };
  const { settings, lastFinishedAt } = prep;

  // Фаза 2 — сеть, без единой открытой транзакции. login — единственный запрос до появления
  // строки RUNNING, поэтому при его сбое пишем ERROR одним автокоммитным запросом через pool.
  const auth = await ivendLogin(settings.login as string, settings.password as string);
  if (!auth.ok || !auth.token) {
    await pool.query(
      // clock_timestamp(), not now() — см. комментарий у следующего INSERT ниже.
      `INSERT INTO parser_runs (provider, started_at, finished_at, status, error_message)
       VALUES ($1, clock_timestamp(), clock_timestamp(), 'ERROR', $2)`,
      [PROVIDER, auth.message ?? 'не удалось войти в кабинет iVend'],
    );
    return { skipped: false, error: auth.message };
  }

  const now = Date.now();
  const overlapMs = settings.overlap_minutes * 60_000;
  const sinceLastRun = lastFinishedAt
    ? new Date(lastFinishedAt).getTime() - overlapMs
    : now - 30 * 86_400_000;
  const from = Math.max(sinceLastRun, now - 90 * 86_400_000);

  // Строка RUNNING появляется в той же точке последовательности, что и раньше — прямо перед
  // потенциально долгой частью (список аппаратов + продажи по каждому) — поэтому индикатор
  // «выполняется…» в админке (Admin.tsx, lastRun.status === 'RUNNING') по-прежнему отражает
  // реальность. clock_timestamp(), not now() — см. комментарий у ERROR-веток выше/ниже.
  const runInsert = await pool.query<{ id: number }>(
    `INSERT INTO parser_runs (provider, started_at, window_from, status)
     VALUES ($1, clock_timestamp(), $2::timestamptz, 'RUNNING') RETURNING id`,
    [PROVIDER, new Date(from).toISOString()],
  );
  const runId = runInsert.rows[0].id;

  try {
    const ourTerminals = await pool.query<{ serial: string }>(
      `SELECT serial FROM terminals WHERE status <> 'RETIRED'`,
    );
    const ourSerials = new Set(ourTerminals.rows.map((row) => row.serial));

    const { machines: ivendMachines, pagesFetched: machinesPages } = await fetchIvendMachines(auth.token);
    const relevant = ivendMachines.filter((m) => m.terminalUid && ourSerials.has(m.terminalUid));

    let pagesFetched = machinesPages;
    const transactions: RawTransaction[] = [];
    for (const machine of relevant) {
      const { sales, pagesFetched: salesPages } = await fetchIvendSales(auth.token, machine.machineId, from, now);
      pagesFetched += salesPages;
      for (const sale of sales) {
        if (sale.type !== 'CASHLESS') continue;
        transactions.push({
          providerTransactionId: String(sale.id),
          terminalExternalId: machine.terminalUid as string,
          occurredAt: new Date(sale.createdAtMs).toISOString(),
          amount: sale.price,
          paymentType: 'CASHLESS',
          raw: { machineId: machine.machineId, machineName: machine.name },
        });
      }
    }

    // Фаза 3 — единственная часть, которой по-прежнему нужна транзакция: импорт полученных строк
    // и отметка успеха должны закоммититься вместе, как и раньше. Отдельная от фазы 1 транзакция:
    // SAVEPOINT-трюк, нужный прежде для изоляции от объемлющей транзакции вызывающего кода, больше
    // не нужен — своей объемлющей транзакции у этой функции теперь нет вовсе, а withTransaction
    // сама откатывает себя при ошибке.
    const result = await withTransaction(async (client) => {
      const imported = await importCashless(client, actor, PROVIDER, transactions);
      await client.query(
        `UPDATE parser_runs SET finished_at = clock_timestamp(), status = 'SUCCESS',
                pages_fetched = $2, rows_received = $3, rows_inserted = $4,
                rows_duplicate = $5, rows_matched = $6
         WHERE id = $1`,
        [
          runId, pagesFetched, imported.received, imported.inserted,
          imported.duplicates, imported.machinesTouched.length,
        ],
      );
      return imported;
    });
    return { skipped: false, imported: result.inserted, matched: result.machinesTouched.length };
  } catch (error) {
    await pool.query(
      `UPDATE parser_runs SET finished_at = clock_timestamp(), status = 'ERROR', error_message = $2 WHERE id = $1`,
      [runId, (error as Error).message],
    );
    return { skipped: false, error: (error as Error).message };
  }
}
