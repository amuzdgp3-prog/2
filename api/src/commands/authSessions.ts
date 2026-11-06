import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';

export const DEVICE_SESSION_SECONDS = 180 * 86_400;
export const ACCESS_TOKEN_TTL = '15m';

type Role = 'ADMIN' | 'TECHNICIAN' | 'BOSS';
export interface SessionStaff {
  id: number;
  login: string;
  full_name: string;
  role: Role;
}

function cookieHash(cookie: string | undefined): string | null {
  return cookie && /^[A-Za-z0-9_-]{43}$/.test(cookie)
    ? createHash('sha256').update(cookie).digest('hex')
    : null;
}

export async function createDeviceSession(staffId: number, deviceLabel: string, previousCookie?: string) {
  const id = randomUUID();
  const cookie = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + DEVICE_SESSION_SECONDS * 1000);
  await pool.query(
    `WITH revoke_previous AS (
       UPDATE auth_sessions SET revoked_at = now() WHERE refresh_hash = $6 AND revoked_at IS NULL
     )
     INSERT INTO auth_sessions (id, staff_id, refresh_hash, device_label, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, staffId, cookieHash(cookie), deviceLabel.slice(0, 180), expiresAt, cookieHash(previousCookie)],
  );
  return { id, cookie };
}

export async function refreshDeviceSession(cookie?: string) {
  const hash = cookieHash(cookie);
  if (!hash) return null;
  const result = await pool.query<SessionStaff & { session_id: string }>(
    `UPDATE auth_sessions a SET last_used_at = now()
     FROM staff s
     WHERE a.refresh_hash = $1 AND s.id = a.staff_id AND s.is_active
       AND a.revoked_at IS NULL AND a.expires_at > now()
     RETURNING a.id AS session_id, s.id, s.login, s.full_name, s.role`,
    [hash],
  );
  return result.rows[0] ?? null;
}

export async function revokeDeviceCookie(cookie?: string) {
  const hash = cookieHash(cookie);
  if (hash) await pool.query(
    'UPDATE auth_sessions SET revoked_at = now() WHERE refresh_hash = $1 AND revoked_at IS NULL', [hash],
  );
}
