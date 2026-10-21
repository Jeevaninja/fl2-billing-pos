import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach } from 'vitest';
import { type ApiConfig, createApiServer } from '../../server/app.js';
import { type DeviceRecord, DeviceRegistry, hashToken } from '../../server/captain-devices.js';
import { type CaptainServerConfig, createCaptainServer } from '../../server/captain-server.js';
import { SESSION_COOKIE, SessionStore } from '../../server/sessions.js';
import type { SqlClient } from '../../src/db/client.js';
import type { TestContext } from './db.js';
import { one } from './pos.js';

export const MISSING = '00000000-0000-0000-0000-000000000000';

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON from the wire. */
  body: any;
}

export type Call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Reply>;

/** Two paired handsets and one revoked one, with known tokens. */
export const HANDSETS = {
  one: { id: 'handset-01', token: 'token-one-0123456789abcdefghijklmnopqrstuvwxyz' },
  two: { id: 'handset-02', token: 'token-two-0123456789abcdefghijklmnopqrstuvwxyz' },
  revoked: { id: 'handset-09', token: 'token-old-0123456789abcdefghijklmnopqrstuvwxyz' },
} as const;

export const TEST_DEVICES: DeviceRecord[] = Object.values(HANDSETS).map((h) => ({
  id: h.id,
  label: h.id,
  tokenSha256: hashToken(h.token),
  active: h.id !== HANDSETS.revoked.id,
  pairedAt: '2026-10-14T00:00:00.000Z',
}));

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Listens on an ephemeral port and returns a raw node:http caller (tests control every header). */
async function serve(server: Server, defaults: Record<string, string>, closers: Array<() => Promise<void>>): Promise<Call> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;

  return (method, path, body, headers = {}) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: { ...defaults, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? JSON.parse(text) : undefined }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  };
}

function useClosers(): Array<() => Promise<void>> {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });
  return closers;
}

/** Cheap scrypt cost for PINs set through the API in tests. */
export const TEST_SCRYPT = { N: 1024, r: 8, p: 1 } as const;

/**
 * A signed-in admin for the counter API (Phase 25): an ADMIN staff row plus a session issued straight
 * from the store, so tests don't pay for scrypt on every start. Returns the cookie header.
 */
async function signedInAdmin(db: SqlClient, sessions: SessionStore): Promise<{ adminId: string; cookie: Record<string, string> }> {
  const admin = await one<{ id: string }>(db, `INSERT INTO staff (display_name, role) VALUES ('Test Admin', 'ADMIN') RETURNING id`);
  const { token } = sessions.issue({ id: admin.id, displayName: 'Test Admin', role: 'ADMIN' });
  return { adminId: admin.id, cookie: { cookie: `${SESSION_COOKIE}=${token}` } };
}

export interface ApiOptions extends Partial<Omit<ApiConfig, 'db'>> {
  /** false: no session cookie on calls (the sign-in tests). Default true. */
  signedIn?: boolean;
}

/** Counter API (loopback) against the current test's database (from useSeededDb), signed in as an admin. */
export function useApi(ctx: () => TestContext) {
  const closers = useClosers();
  return async function start({ signedIn = true, ...config }: ApiOptions = {}) {
    const { db, fx } = ctx();
    const sessions = config.sessions ?? new SessionStore();
    const { adminId, cookie } = signedIn ? await signedInAdmin(db, sessions) : { adminId: null, cookie: {} };
    const call = await serve(createApiServer({ db, cashierId: fx.cashier, scryptCost: TEST_SCRYPT, ...config, sessions }), cookie, closers);
    return { db, fx, call, sessions, adminId };
  };
}

/**
 * Captain server (device-token auth, TEST_DEVICES) plus the counter API on the same database.
 * `call` authenticates as handset-01 unless the test passes its own authorization header.
 */
export function useCaptainApi(ctx: () => TestContext) {
  const closers = useClosers();
  return async function start(config: Partial<Omit<CaptainServerConfig, 'db'>> = {}) {
    const { db, fx } = ctx();
    const devices = config.devices ?? DeviceRegistry.fromRecords(TEST_DEVICES);
    const call = await serve(createCaptainServer({ ...config, db, devices }), bearer(HANDSETS.one.token), closers);
    const sessions = new SessionStore();
    const { cookie } = await signedInAdmin(db, sessions);
    const counter = await serve(createApiServer({ db, cashierId: fx.cashier, sessions }), cookie, closers);
    return { db, fx, call, counter };
  };
}
