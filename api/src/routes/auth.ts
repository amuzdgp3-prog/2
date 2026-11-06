import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { assertLoginAllowed, recordLoginFailure, recordLoginSuccess } from '../lib/loginThrottle.js';
import { verifyPassword } from '../lib/password.js';
import { ACCESS_TOKEN_TTL, DEVICE_SESSION_SECONDS, createDeviceSession, refreshDeviceSession, revokeDeviceCookie, type SessionStaff } from '../commands/authSessions.js';

const DEVICE_COOKIE = 'apixspb_device';
const cookieOptions = { path: '/api/auth', secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax' as const };

function assertSessionOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;
  const local = process.env.NODE_ENV !== 'production' && origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== config.publicOrigin && !local)) {
    throw forbidden('запрос авторизации должен быть отправлен из приложения');
  }
}

const publicUser = (staff: SessionStaff) => ({
  id: staff.id, login: staff.login, fullName: staff.full_name, role: staff.role,
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const signAccess = (staff: SessionStaff, sid: string) => app.jwt.sign(
    { sub: staff.id, login: staff.login, role: staff.role, sid },
    { expiresIn: ACCESS_TOKEN_TTL },
  );
  app.post<{ Body: { login: string; password: string; deviceSession?: boolean } }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['login', 'password'],
          properties: {
            login: { type: 'string', minLength: 1, maxLength: 320 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
            deviceSession: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      assertSessionOrigin(request);
      const { login, password } = request.body;
      assertLoginAllowed(login);
      const result = await pool.query(
        'SELECT id, login, full_name, role, password_hash, is_active FROM staff WHERE login = $1',
        [login],
      );
      const staff = result.rows[0];
      if (!staff || !staff.is_active || !(await verifyPassword(password, staff.password_hash))) {
        recordLoginFailure(login);
        throw unauthorized('неверный логин или пароль');
      }
      recordLoginSuccess(login);

      reply.header('Cache-Control', 'no-store');
      if (request.body.deviceSession) {
        const device = await createDeviceSession(staff.id, request.headers['user-agent'] ?? '', request.cookies[DEVICE_COOKIE]);
        reply.setCookie(DEVICE_COOKIE, device.cookie, { ...cookieOptions, maxAge: DEVICE_SESSION_SECONDS });
        return { token: signAccess(staff, device.id), user: publicUser(staff), deviceSession: true };
      }
      const token = app.jwt.sign(
        { sub: staff.id, login: staff.login, role: staff.role, ...(!config.acceptLegacySessions ? { purpose: 'automation' } : {}) },
        { expiresIn: config.acceptLegacySessions ? config.tokenTtl : ACCESS_TOKEN_TTL },
      );
      return { token, user: publicUser(staff) };
    },
  );

  app.post('/api/auth/refresh', async (request, reply) => {
    assertSessionOrigin(request);
    reply.header('Cache-Control', 'no-store');
    const staff = await refreshDeviceSession(request.cookies[DEVICE_COOKIE]);
    if (!staff) throw unauthorized('сессия истекла, войдите заново');
    return { token: signAccess(staff, staff.session_id), userId: staff.id };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    assertSessionOrigin(request);
    await revokeDeviceCookie(request.cookies[DEVICE_COOKIE]);
    return reply.clearCookie(DEVICE_COOKIE, cookieOptions).code(204).send();
  });

  app.get('/api/auth/sessions', { preHandler: app.authenticate }, async (request, reply) => {
    const { sid } = request.user as { sid?: string };
    reply.header('Cache-Control', 'no-store');
    const result = await pool.query(
      `SELECT id, device_label AS "deviceLabel", created_at AS "createdAt",
              last_used_at AS "lastUsedAt", expires_at AS "expiresAt", COALESCE(id = $2, false) AS current
       FROM auth_sessions
       WHERE staff_id = $1 AND expires_at > now() AND revoked_at IS NULL
       ORDER BY last_used_at DESC`,
      [request.actor.id, sid ?? null],
    );
    return result.rows;
  });

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', {
    preHandler: app.authenticate,
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND staff_id = $2 AND revoked_at IS NULL',
      [request.params.id, request.actor.id]);
    if ((request.user as { sid?: string }).sid === request.params.id) reply.clearCookie(DEVICE_COOKIE, cookieOptions);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const result = await pool.query(
      'SELECT id, login, full_name, role FROM staff WHERE id = $1',
      [request.actor.id],
    );
    const staff = result.rows[0];
    return publicUser(staff);
  });
}
