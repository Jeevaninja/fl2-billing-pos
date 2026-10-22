/**
 * Boots the local POS API.
 *
 *   DATABASE_URL     node-postgres connection string (production: the local PostgreSQL primary).
 *                    Unset → embedded PGlite persisted under FL2_PGLITE_DIR (default .data/pglite).
 *   FL2_API_PORT     default 4310. The server binds to 127.0.0.1 only.
 *   FL2_CASHIER_ID   staff id the counter's bills are attributed to (Phase 25 D1: sign-in unlocks the
 *                    terminal; it does not change who the till's bills belong to).
 *   FL2_DEV_SEED=1   seed demo data into an empty database and default to its cashier.
 *
 * Captain (waiter app) server — started once a handset is paired, at boot or later from
 * Settings → Staff & PINs (or `npm run captain:devices -- pair <id> <label>`):
 *   FL2_CAPTAIN_DEVICES  devices file (default .data/captain-devices.json)
 *   FL2_CAPTAIN_HOST     default 0.0.0.0 (all interfaces, so handsets on the Wi-Fi can reach it)
 *   FL2_CAPTAIN_PORT     default 4311
 */
import { networkInterfaces } from 'node:os';
import type { SqlDatabase } from '../src/db/client.js';
import { AuthService } from '../src/services/index.js';
import { createApiServer } from './app.js';
import { DeviceRegistry } from './captain-devices.js';
import { createCaptainServer } from './captain-server.js';
import { openDatabase } from './database.js';
import { seedDevData } from './dev-seed.js';

const HOST = '127.0.0.1';
const port = Number(process.env.FL2_API_PORT ?? 4310);
const devSeed = process.env.FL2_DEV_SEED === '1';
const captainDevicesFile = process.env.FL2_CAPTAIN_DEVICES ?? '.data/captain-devices.json';
const captainHost = process.env.FL2_CAPTAIN_HOST ?? '0.0.0.0';
const captainPort = Number(process.env.FL2_CAPTAIN_PORT ?? 4311);

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
const devices = DeviceRegistry.fromFile(captainDevicesFile);
let captainUrls: string[] = [];

/** Starts the Captain server once; later calls (each new pairing) are no-ops. */
function startCaptain(): void {
  if (servers.length > 1) return;
  const captain = createCaptainServer({ db, devices });
  servers.push(captain);
  captain.listen(captainPort, captainHost, () => {
    captainUrls = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => `http://${a!.address}:${captainPort}`);
    console.log(`[fl2-captain] listening on ${captainHost}:${captainPort} for ${devices.activeDevices().length} handset(s) · ${captainUrls.join(', ') || 'no LAN address'}`);
    console.log('[fl2-captain] plain HTTP: use a staff-only WPA2/WPA3 Wi-Fi network; device tokens travel in clear text');
  });
}

const servers = [
  createApiServer({
    db,
    cashierId,
    captain: { devicesFile: captainDevicesFile, serverUrls: () => captainUrls, onPaired: startCaptain },
  }),
];

servers[0]!.listen(port, HOST, () => {
  console.log(`[fl2-api] listening on http://${HOST}:${port} · ${label} · cashier ${cashierId}`);
});
if (!(await new AuthService(db).adminConfigured())) {
  console.warn('[fl2-api] no admin can sign in yet — stop the API and run: npm run staff -- set-admin <username>');
}

if (devices.activeDevices().length === 0) {
  console.log(`[fl2-captain] not started: no paired handsets in ${captainDevicesFile} (pair one in Settings → Staff & PINs)`);
} else {
  startCaptain();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    let open = servers.length;
    for (const server of servers) server.close(() => --open === 0 && void close().then(() => process.exit(0)));
  });
}
