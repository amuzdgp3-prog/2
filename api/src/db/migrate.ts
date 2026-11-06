import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from './pool.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const migrationFiles = async () => (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

export async function assertMigrationsApplied(): Promise<void> {
  const files = await migrationFiles();
  const result = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(result.rows.map((row) => row.name));
  const pending = files.filter((file) => !applied.has(file));
  if (pending.length) throw Error(`Run the migration command before starting API: ${pending.join(', ')}`);
}

export async function runMigrations(log: (message: string) => void = console.log): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = await migrationFiles();

  for (const file of files) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (applied.rowCount) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    log(`applied migration ${file}`);
  }
}

if (process.argv[1] && /[\\/]migrate\.(ts|js)$/.test(process.argv[1])) {
  runMigrations()
    .then(() => pool.end())
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
