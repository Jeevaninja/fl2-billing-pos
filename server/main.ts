/**
 * Boots the local POS API.
 *
 *   DATABASE_URL     node-postgres connection string (production: the local PostgreSQL primary).
 *                    Unset → embedded PGlite persisted under FL2_PGLITE_DIR (default .data/pglite).
 *   FL2_API_PORT     default 4310. The server binds to 127.0.0.1 only.
 *   FL2_CASHIER_ID   staff id the counter acts as (until staff login exists).
 *   FL2_DEV_SEED=1   seed demo data into an empty database and default to its cashier.
 */
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { SqlDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { pgClient, pgDatabase } from '../src/db/pg.js';
import { createApiServer } from './app.js';
import { seedDevData } from './dev-seed.js';

const HOST = '127.0.0.1';
const port = Number(process.env.FL2_API_PORT ?? 4310);
const devSeed = process.env.FL2_DEV_SEED === '1';

async function openDatabase(): Promise<{ db: SqlDatabase; label: string; close: () => Promise<void> }> {
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

async function resolveCashier(db: SqlDatabase): Promise<string> {
  const seeded = devSeed ? await seedDevData(db) : null;
  const configured = process.env.FL2_CASHIER_ID ?? seeded?.cashierId;
  if (configured) return configured;
  if (devSeed) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM staff WHERE role = 'CASHIER' AND is_active ORDER BY created_at LIMIT 1`,
    );
    if (rows[0]) return rows[0].id;
  }
  throw new Error('FL2_CASHIER_ID is not set (or run with FL2_DEV_SEED=1 for demo data)');
}

const { db, label, close } = await openDatabase();
const cashierId = await resolveCashier(db);
const server = createApiServer({ db, cashierId });

server.listen(port, HOST, () => {
  console.log(`[fl2-api] listening on http://${HOST}:${port} · ${label} · cashier ${cashierId}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => void close().then(() => process.exit(0)));
  });
}
