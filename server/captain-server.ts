/**
 * Wi-Fi-facing Captain API. Serves ONLY the /api/captain/* routes, and every request — including
 * unknown paths — must carry `Authorization: Bearer <token>` of an active paired handset
 * (captain-devices.ts). Counter routes are not reachable here.
 *
 * Transport is plain HTTP: run it on a staff-only, WPA2/WPA3-protected network. TLS is a follow-up.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { SqlDatabase } from '../src/db/client.js';
import { CaptainService, type KotPrinter, PrinterService } from '../src/services/index.js';
import { captainRoutes } from './captain-api.js';
import type { DeviceRegistry } from './captain-devices.js';
import { createJsonHandler, HttpError, type RequestContext } from './routing.js';

export interface CaptainServerConfig {
  db: SqlDatabase;
  devices: DeviceRegistry;
  /** KOT printer; defaults to the console stub. */
  printer?: KotPrinter;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]{1,256})$/;
const CHALLENGE = { 'www-authenticate': 'Bearer realm="fl2-captain"' };

function admitDevice(devices: DeviceRegistry, req: IncomingMessage): RequestContext {
  const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
  // One message for missing, malformed, unknown and revoked tokens: nothing to probe.
  const device = token ? devices.authenticate(token) : null;
  if (!device) throw new HttpError(401, 'UNAUTHORIZED', 'a valid paired-device token is required', CHALLENGE);
  return { deviceId: device.id };
}

export function createCaptainServer({ db, devices, printer = new PrinterService() }: CaptainServerConfig): Server {
  const routes = captainRoutes(new CaptainService(db, printer));
  return createServer(createJsonHandler(routes, (req) => admitDevice(devices, req)));
}
