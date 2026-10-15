/**
 * Boots the local POS API.
 *
 *   DATABASE_URL     node-postgres connection string (production: the local PostgreSQL primary).
 *                    Unset → embedded PGlite persisted under FL2_PGLITE_DIR (default .data/pglite).
 *   FL2_API_PORT     default 4310. The server binds to 127.0.0.1 only.
 *   FL2_CASHIER_ID   staff id the counter acts as (until staff login exists).
 *   FL2_DEV_SEED=1   seed demo data into an empty database and default to its cashier.
 *
 * Captain (waiter app) server — started only when at least one handset is paired
 * (`npm run captain:devices -- pair <id> <label>`):
 *   FL2_CAPTAIN_DEVICES  devices file (default .data/captain-devices.json)
 *   FL2_CAPTAIN_HOST     default 0.0.0.0 (all interfaces, so handsets on the Wi-Fi can reach it)
 *   FL2_CAPTAIN_PORT     default 4311
 */
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { SqlDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { pgClient, pgDatabase } from '../src/db/pg.js';
import { createApiServer } from './app.js';
import { DeviceRegistry } from './captain-devices.js';
import { createCaptainServer } from './captain-server.js';
import { seedDevData } from './dev-seed.js';

const HOST = '127.0.0.1';
const port = Number(process.env.FL2_API_PORT ?? 4310);
const devSeed = process.env.FL2_DEV_SEED === '1';
const captainDevicesFile = process.env.FL2_CAPTAIN_DEVICES ?? '.data/captain-devices.json';
const captainHost = process.env.FL2_CAPTAIN_HOST ?? '0.0.0.0';
const captainPort = Number(process.env.FL2_CAPTAIN_PORT ?? 4311);

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
const servers = [createApiServer({ db, cashierId })];

servers[0]!.listen(port, HOST, () => {
  console.log(`[fl2-api] listening on http://${HOST}:${port} · ${label} · cashier ${cashierId}`);
});

const devices = DeviceRegistry.fromFile(captainDevicesFile);
const paired = devices.activeDevices();
if (paired.length === 0) {
  console.log(`[fl2-captain] not started: no paired handsets in ${captainDevicesFile} (npm run captain:devices -- pair handset-01 "Captain 1")`);
} else {
  const captain = createCaptainServer({ db, devices });
  servers.push(captain);
  captain.listen(captainPort, captainHost, () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => `http://${a!.address}:${captainPort}`);
    console.log(`[fl2-captain] listening on ${captainHost}:${captainPort} for ${paired.length} handset(s) · ${lan.join(', ') || 'no LAN address'}`);
    console.log('[fl2-captain] plain HTTP: use a staff-only WPA2/WPA3 Wi-Fi network; device tokens travel in clear text');
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    let open = servers.length;
    for (const server of servers) server.close(() => --open === 0 && void close().then(() => process.exit(0)));
  });
}
