import { AppError } from './errors.js';

/**
 * Защита входа от перебора пароля (DECISION-043).
 *
 * Ключ — логин, а не IP-адрес: Fastify здесь запущен без trustProxy, и за Traefik у всех запросов
 * один и тот же request.ip. Ключ по IP заблокировал бы вход всем сотрудникам разом после серии
 * ошибок у кого-то одного.
 *
 * Считаются только НЕУДАЧНЫЕ попытки, успешный вход сбрасывает счётчик. Обычная работа и тесты,
 * где один и тот же пользователь входит много раз подряд, лимит не задевают.
 *
 * Состояние хранится в памяти процесса и обнуляется при перезапуске контейнера. Для единственного
 * экземпляра API этого достаточно и не требует новой таблицы в базе.
 */
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60_000;
const MAX_TRACKED = 10_000;

const failures = new Map<string, { count: number; firstAt: number; nextAt: number }>();

const keyOf = (login: string): string => login.trim().toLowerCase();

export function assertLoginAllowed(login: string, now = Date.now()): void {
  const key = keyOf(login);
  const entry = failures.get(key);
  if (!entry) return;
  if (now - entry.firstAt > WINDOW_MS) {
    failures.delete(key);
    return;
  }
  const blockedUntil = entry.count >= MAX_FAILURES ? entry.firstAt + WINDOW_MS : entry.nextAt;
  if (blockedUntil > now) {
    const seconds = Math.ceil((blockedUntil - now) / 1000);
    throw new AppError(
      429,
      'TOO_MANY_LOGIN_ATTEMPTS',
      `слишком много неудачных попыток входа, повторите через ${seconds} сек`,
      { retryAfterSeconds: seconds },
    );
  }
}

export function recordLoginFailure(login: string, now = Date.now()): void {
  const key = keyOf(login);
  const entry = failures.get(key);
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    if (!entry && failures.size >= MAX_TRACKED) {
      const oldest = failures.keys().next().value;
      if (oldest !== undefined) failures.delete(oldest);
    }
    failures.set(key, { count: 1, firstAt: now, nextAt: now });
  } else {
    entry.count += 1;
    if (entry.count >= 5) entry.nextAt = now + Math.min(30, 2 ** (entry.count - 5)) * 1000;
  }
}

export function recordLoginSuccess(login: string): void {
  failures.delete(keyOf(login));
}
