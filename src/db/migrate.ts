import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlClient } from './client.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Applies pending `migrations/NNNN_name.sql` files in order, each in its own transaction.
 * Returns the versions applied by this call.
 */
export async function runMigrations(db: SqlClient, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const { rows } = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const ran: string[] = [];
  for (const file of files) {
    const version = file.slice(0, -'.sql'.length);
    if (applied.has(version)) continue;

    const sql = await readFile(path.join(dir, file), 'utf8');
    await db.exec('BEGIN');
    try {
      await db.exec(sql);
      await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
    }
    ran.push(version);
  }
  return ran;
}
