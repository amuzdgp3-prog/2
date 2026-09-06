import { hashPassword } from '../lib/password.js';
import { pool } from './pool.js';

/**
 * Bootstraps the first administrator so a fresh deployment is usable. It runs on every start but
 * only ever inserts when the staff table is empty, so it can never overwrite real accounts.
 */
export async function seedAdmin(log: (message: string) => void = console.log): Promise<void> {
  const login = process.env.ADMIN_LOGIN;
  const password = process.env.ADMIN_PASSWORD;
  if (!login || !password) return;

  const existing = await pool.query('SELECT 1 FROM staff LIMIT 1');
  if (existing.rowCount) return;

  const passwordHash = await hashPassword(password);
  await pool.query(
    `INSERT INTO staff (login, full_name, role, password_hash)
     VALUES ($1, $2, 'ADMIN', $3)`,
    [login, 'Администратор', passwordHash],
  );
  log(`seeded initial admin account "${login}"`);
}
