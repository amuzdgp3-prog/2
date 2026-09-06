import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { unauthorized } from '../lib/errors.js';
import { verifyPassword } from '../lib/password.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { login: string; password: string } }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['login', 'password'],
          properties: { login: { type: 'string' }, password: { type: 'string' } },
        },
      },
    },
    async (request) => {
      const { login, password } = request.body;
      const result = await pool.query(
        'SELECT id, login, full_name, role, password_hash, is_active FROM staff WHERE login = $1',
        [login],
      );
      const staff = result.rows[0];
      if (!staff || !staff.is_active || !(await verifyPassword(password, staff.password_hash))) {
        throw unauthorized('неверный логин или пароль');
      }

      const token = app.jwt.sign(
        { sub: staff.id, login: staff.login, role: staff.role },
        { expiresIn: config.tokenTtl },
      );
      return {
        token,
        user: {
          id: staff.id,
          login: staff.login,
          fullName: staff.full_name,
          role: staff.role,
        },
      };
    },
  );

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (request) => {
    const result = await pool.query(
      'SELECT id, login, full_name, role FROM staff WHERE id = $1',
      [request.actor.id],
    );
    const staff = result.rows[0];
    return { id: staff.id, login: staff.login, fullName: staff.full_name, role: staff.role };
  });
}
