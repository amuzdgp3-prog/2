import pg from 'pg';
import { config } from '../config.js';

// Money and game counts are exact NUMERIC values; keep them as strings instead of letting
// node-postgres coerce them into lossy JS floats.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => value);
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
// A business DATE is a calendar date, not an instant: keeping it as "YYYY-MM-DD" stops it from
// being reinterpreted in the process timezone and shifting by a day on the way out.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export type Client = pg.PoolClient;

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

/**
 * One business operation = one PostgreSQL transaction (10_ТЗ §18).
 * Mutation, recalculation and audit all live inside this boundary; any failure rolls back.
 */
export async function withTransaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
