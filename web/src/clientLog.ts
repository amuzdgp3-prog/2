import { getToken } from './api';

/**
 * Журнал событий клиента (DECISION-087).
 *
 * Закрытие вкладки системой (нехватка памяти, выгрузка в фоне) обработчиком не поймать. Поэтому
 * важные операции отмечаются «начата» в localStorage и снимаются при завершении. Операция, которая
 * осталась открытой к следующему запуску, — это и есть вылет посреди неё. Просто закрытое
 * приложение без открытой операции событием не считается, иначе журнал утонул бы в ложных обрывах.
 *
 * Логирование не должно ничего ломать: каждый вход обёрнут в try/catch, отправка идёт отдельным
 * fetch — 401 здесь не стирает токен и не выкидывает техника на экран входа, как в api.ts.
 */

type Detail = Record<string, unknown>;

interface QueuedEvent {
  at: string;
  kind: string;
  screen: string;
  detail: Detail;
}

interface OpenOperation {
  op: string;
  startedAt: string;
  screen: string;
  detail: Detail;
  hiddenAt?: string;
}

const QUEUE_KEY = 'apixspb.clientEvents';
const OPS_KEY = 'apixspb.openOperations';
const MAX_QUEUED = 200;
// keepalive-запрос ограничен 64 КБ на тело, а деталь события — до 2 КБ.
const BATCH = 20;

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Переполненное или запрещённое хранилище — журнал просто не пишется.
  }
};

/** Сеть и устройство на момент события: ради этого журнал и заводился. */
function environment(): Detail {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; saveData?: boolean; type?: string };
    deviceMemory?: number;
  };
  return {
    online: nav.onLine,
    net: nav.connection?.effectiveType,
    netType: nav.connection?.type,
    downlink: nav.connection?.downlink,
    saveData: nav.connection?.saveData,
    memoryGb: nav.deviceMemory,
  };
}

export function logEvent(kind: string, detail: Detail = {}): void {
  try {
    const queue = read<QueuedEvent[]>(QUEUE_KEY, []);
    queue.push({ at: new Date().toISOString(), kind, screen: location.pathname, detail: { ...environment(), ...detail } });
    write(QUEUE_KEY, queue.slice(-MAX_QUEUED));
    scheduleFlush();
  } catch {
    // см. комментарий модуля
  }
}

/** Отмечает начало операции; вернувшийся id передаётся в endOperation. */
export function beginOperation(op: string, detail: Detail = {}): string {
  const id = `${op}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const ops = read<Record<string, OpenOperation>>(OPS_KEY, {});
    ops[id] = { op, startedAt: new Date().toISOString(), screen: location.pathname, detail: { ...environment(), ...detail } };
    write(OPS_KEY, ops);
  } catch {
    // см. комментарий модуля
  }
  return id;
}

/** Снимает операцию. Неудача (`error`) сама попадает в журнал, успех — нет. */
export function endOperation(id: string, error?: unknown): void {
  try {
    const ops = read<Record<string, OpenOperation>>(OPS_KEY, {});
    const operation = ops[id];
    delete ops[id];
    write(OPS_KEY, ops);
    if (operation && error !== undefined) {
      logEvent('operation_failed', {
        op: operation.op,
        startedAt: operation.startedAt,
        ...operation.detail,
        ...describeError(error),
      });
    }
  } catch {
    // см. комментарий модуля
  }
}

function describeError(error: unknown): Detail {
  if (error instanceof Error) {
    return { error: error.name, message: error.message.slice(0, 300), stack: error.stack?.slice(0, 800) };
  }
  return { error: String(error).slice(0, 300) };
}

/** Вызывается один раз при запуске, до отрисовки приложения. */
export function initClientLog(): void {
  try {
    const leftover = read<Record<string, OpenOperation>>(OPS_KEY, {});
    write(OPS_KEY, {});
    for (const operation of Object.values(leftover)) {
      // hiddenAt — вкладку успели увести в фон до обрыва (выход в галерею, сворачивание): тогда
      // скорее всего выгрузила система, без него — закрытие прямо на экране.
      logEvent('operation_aborted', { op: operation.op, startedAt: operation.startedAt, hiddenAt: operation.hiddenAt, openedOn: operation.screen, ...operation.detail });
    }

    window.addEventListener('error', (event) => {
      logEvent('error', { message: String(event.message).slice(0, 300), source: event.filename, line: event.lineno, col: event.colno, stack: (event.error as Error | undefined)?.stack?.slice(0, 800) });
    });
    window.addEventListener('unhandledrejection', (event) => {
      logEvent('unhandled_rejection', describeError(event.reason));
    });
    window.addEventListener('auth:expired', () => logEvent('auth_expired'));
    window.addEventListener('online', () => void flushClientEvents());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        markOpenOperationsHidden();
        void flushClientEvents();
      }
    });
  } catch {
    // см. комментарий модуля
  }
}

function markOpenOperationsHidden(): void {
  const ops = read<Record<string, OpenOperation>>(OPS_KEY, {});
  const now = new Date().toISOString();
  let changed = false;
  for (const operation of Object.values(ops)) {
    if (!operation.hiddenAt) {
      operation.hiddenAt = now;
      changed = true;
    }
  }
  if (changed) write(OPS_KEY, ops);
}

let flushTimer: number | undefined;
function scheduleFlush(): void {
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => void flushClientEvents(), 2000);
}

let flushing = false;

/** Отправляет накопленное. Без входа или без связи события ждут следующего раза. */
export async function flushClientEvents(): Promise<void> {
  if (flushing) return;
  const token = getToken();
  if (!token || !navigator.onLine) return;
  flushing = true;
  try {
    for (;;) {
      const queue = read<QueuedEvent[]>(QUEUE_KEY, []);
      if (queue.length === 0) return;
      const batch = queue.slice(0, BATCH);
      const response = await fetch('/api/client-events', {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ appVersion: __APP_VERSION__, events: batch }),
      });
      // 400 — пачку сервер не примет никогда, держать её незачем; прочие отказы — повторим позже.
      if (!response.ok && response.status !== 400) return;
      write(QUEUE_KEY, read<QueuedEvent[]>(QUEUE_KEY, []).slice(batch.length));
    }
  } catch {
    // Нет связи — события остаются в очереди.
  } finally {
    flushing = false;
  }
}
