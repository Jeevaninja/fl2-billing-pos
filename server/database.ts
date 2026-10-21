/**
 * Opens the POS database for the API (main.ts) and the staff CLI, and applies pending migrations.
 *
 *   DATABASE_URL     node-postgres connection string (production: the local PostgreSQL primary).
 *                    Unset → embedded PGlite persisted under FL2_PGLITE_DIR (default .data/pglite).
 */
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { SqlDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { pgClient, pgDatabase } from '../src/db/pg.js';

export async function openDatabase(): Promise<{ db: SqlDatabase; label: string; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new pg.Pool({ connectionString: url });
    // Migrations issue their own BEGIN/COMMIT, so they need one dedicated connection.
    const conn = await pool.connect();
    try {
      await runMigrations(pgClient(conn));
    } finally {
      conn.release();
    }
    return { db: pgDatabase(pool), label: 'PostgreSQL', close: () => pool.end() };
  }
  const dir = process.env.FL2_PGLITE_DIR ?? '.data/pglite';
  mkdirSync(dir, { recursive: true }); // PGlite creates only the last path segment
  const lite = new PGlite(dir);
  await runMigrations(lite);
  return { db: lite, label: `PGlite (${dir})`, close: () => lite.close() };
}
