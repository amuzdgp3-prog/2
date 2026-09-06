import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

process.env.DATABASE_URL ??= 'postgres://postgres:test@127.0.0.1:55432/apixspb_test';
process.env.JWT_SECRET ??= 'test-secret';
process.env.LOG_LEVEL ??= 'error';
process.env.PHOTO_DIR ??= '/tmp/apixspb-test-photos';

const { pool } = await import('../src/db/pool.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { buildServer } = await import('../src/server.js');
const { hashPassword } = await import('../src/lib/password.js');

export { pool };

export interface TestContext {
  app: FastifyInstance;
  adminToken: string;
  technicianToken: string;
  bossToken: string;
  technicianId: number;
}

/** Rebuilds the schema from the real migrations, so tests run against production DDL. */
export async function resetDatabase(): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(() => undefined);
}

export async function createStaff(
  login: string,
  role: 'ADMIN' | 'TECHNICIAN' | 'BOSS',
): Promise<number> {
  const passwordHash = await hashPassword('secret');
  const result = await pool.query(
    `INSERT INTO staff (login, full_name, role, password_hash)
     VALUES ($1, $1, $2::staff_role, $3) RETURNING id`,
    [login, role, passwordHash],
  );
  return result.rows[0].id;
}

export async function bootstrap(): Promise<TestContext> {
  await resetDatabase();
  await createStaff('admin', 'ADMIN');
  const technicianId = await createStaff('tech', 'TECHNICIAN');
  await createStaff('boss', 'BOSS');

  const app = await buildServer();
  await app.ready();

  const login = async (user: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: user, password: 'secret' },
    });
    return response.json().token;
  };

  return {
    app,
    adminToken: await login('admin'),
    technicianToken: await login('tech'),
    bossToken: await login('boss'),
    technicianId,
  };
}

export const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Registers a counter photo the way the upload endpoint would, so Service tests can exercise the
 * mandatory-photo rule without pushing multipart bodies through every case.
 */
export async function preparePhoto(localId: string): Promise<string> {
  const objectKey = `services/${localId}.jpg`;
  await pool.query(
    `INSERT INTO photo_objects (object_key, local_id, byte_size, content_type)
     VALUES ($1, $2, 1024, 'image/jpeg')
     ON CONFLICT (object_key) DO NOTHING`,
    [objectKey, localId],
  );
  return objectKey;
}

export interface ServiceOptions {
  gameCounter: number;
  prizeCounter: number;
  testGames?: number;
  occurredAt: string;
  toys?: Array<{ toyId: number; quantity: number }>;
}

export async function postService(
  context: TestContext,
  token: string,
  machineNumber: string,
  options: ServiceOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const localId = randomUUID();
  const photoObjectKey = await preparePhoto(localId);
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/services',
    headers: authHeader(token),
    payload: { localId, machineNumber, photoObjectKey, ...options },
  });
  return { status: response.statusCode, body: response.json() };
}

export async function createToy(
  context: TestContext,
  name: string,
  unitCost: number | string,
): Promise<number> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/toys',
    headers: authHeader(context.adminToken),
    payload: { name, unitCost },
  });
  return response.json().id;
}

/** Creates an ACTIVE location and installs a machine on it. */
export async function installTestMachine(
  context: TestContext,
  input: {
    machineNumber: string;
    pricePerGame: number | string;
    counterDivisor?: number | string | null;
    initialGameCounter?: number;
    initialPrizeCounter?: number;
    timezone?: string;
    locationId?: number;
    startedAt?: string;
    initialToys?: Array<{ toyId: number; quantity: number }>;
  },
): Promise<{ locationId: number; placementId: number }> {
  let locationId = input.locationId;
  if (!locationId) {
    const location = await context.app.inject({
      method: 'POST',
      url: '/api/locations',
      headers: authHeader(context.adminToken),
      payload: {
        name: `Точка ${input.machineNumber}`,
        timezone: input.timezone ?? 'Europe/Moscow',
      },
    });
    locationId = location.json().id;
  }

  const installed = await context.app.inject({
    method: 'POST',
    url: '/api/machines/install',
    headers: authHeader(context.adminToken),
    payload: {
      machineNumber: input.machineNumber,
      pricePerGame: input.pricePerGame,
      counterDivisor: input.counterDivisor ?? 1,
      locationId,
      startedAt: input.startedAt ?? '2026-01-01T08:00:00Z',
      initialGameCounter: input.initialGameCounter ?? 0,
      initialPrizeCounter: input.initialPrizeCounter ?? 0,
      initialToys: input.initialToys ?? [],
    },
  });

  if (installed.statusCode !== 200) {
    throw new Error(`install failed: ${installed.body}`);
  }

  return { locationId: locationId as number, placementId: installed.json().placementId };
}
