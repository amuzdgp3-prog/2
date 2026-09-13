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
// Потолок на число отслеживаемых логинов, чтобы поток запросов со случайными логинами не раздувал
// память: при превышении из карты вычищаются записи с истёкшим окном.
const MAX_TRACKED = 10_000;

const failures = new Map<string, { count: number; firstAt: number }>();

const keyOf = (login: string): string => login.trim().toLowerCase();

export function assertLoginAllowed(login: string, now = Date.now()): void {
  const key = keyOf(login);
  const entry = failures.get(key);
  if (!entry) return;
  if (now - entry.firstAt > WINDOW_MS) {
    failures.delete(key);
    return;
  }
  if (entry.count >= MAX_FAILURES) {
    const minutes = Math.max(1, Math.ceil((entry.firstAt + WINDOW_MS - now) / 60_000));
    throw new AppError(
      429,
      'TOO_MANY_LOGIN_ATTEMPTS',
      `слишком много неудачных попыток входа, повторите через ${minutes} мин`,
    );
  }
}

export function recordLoginFailure(login: string, now = Date.now()): void {
  if (failures.size >= MAX_TRACKED) {
    for (const [key, entry] of failures) {
      if (now - entry.firstAt > WINDOW_MS) failures.delete(key);
    }
  }
  const key = keyOf(login);
  const entry = failures.get(key);
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
  }
}

export function recordLoginSuccess(login: string): void {
  failures.delete(keyOf(login));
}
