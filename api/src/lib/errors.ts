export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'требуется авторизация') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'нет доступа') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'не найдено') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
