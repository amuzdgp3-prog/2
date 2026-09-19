export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class OfflineError extends Error {
  constructor() {
    super('нет связи с сервером');
  }
}

// Без таймаута fetch на плохой сети висит минутами: браузер сам сдаётся очень поздно. Считаем
// сервер недоступным, если он не ответил вовремя; отправка фото получает больше времени.
const REQUEST_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 60_000;

const TOKEN_KEY = 'apixspb.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string | null) => {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
};

/**
 * navigator.onLine only says the device is attached to a network, not that the server can be
 * reached, so reachability is reported from the outcome of real requests instead.
 */
const announce = (event: 'api:reachable' | 'api:unreachable') =>
  window.dispatchEvent(new CustomEvent(event));

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // A 401 on the login endpoint itself means "wrong login or password", not "your session
  // expired" — there was no session to expire yet. Treating it as expiry showed a scary,
  // misleading message instead of the server's actual reason, and could clear a token that
  // belonged to a session that was otherwise still perfectly valid.
  const isLoginAttempt = path === '/api/auth/login';
  // A stale or foreign token from a previous session must never ride along with a fresh login
  // attempt (e.g. switching accounts on one device, DECISION-017) — some auth middlewares would
  // inspect it before the credentials even get checked, turning a bad old token into a confusing
  // failure on what should be an unrelated new login.
  const token = isLoginAttempt ? null : getToken();
  let response: Response;

  try {
    response = await fetch(path, {
      signal: AbortSignal.timeout(init.body instanceof FormData ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
      ...init,
      headers: {
        // A Content-Type: application/json header with a truly empty body (a body-less DELETE,
        // e.g. api.delete(path) with no second argument) makes Fastify's JSON parser reject the
        // request outright with FST_ERR_CTP_EMPTY_JSON_BODY before it ever reaches the route —
        // so the header is only sent when there's an actual JSON body to describe.
        ...(init.body !== undefined && !(init.body instanceof FormData)
          ? { 'content-type': 'application/json' }
          : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    announce('api:reachable');
  } catch {
    announce('api:unreachable');
    throw new OfflineError();
  }

  if (response.status === 401 && !isLoginAttempt) {
    setToken(null);
    // The token is gone but React state doesn't know yet; without this the app can be stuck
    // showing screens as if logged in while every request silently fails with 401.
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new ApiError(401, 'UNAUTHORIZED', 'сессия истекла, войдите заново');
  }

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const payload = body as { error?: string; message?: string; details?: unknown };
    throw new ApiError(
      response.status,
      payload?.error ?? 'ERROR',
      payload?.message ?? (isLoginAttempt ? 'неверный логин или пароль' : 'ошибка запроса'),
      payload?.details,
    );
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', ...(body ? { body: JSON.stringify(body) } : {}) }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
};
