import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, SessionStore } from '../../server/sessions.js';
import { AuthService } from '../../src/services/index.js';
import { TEST_SCRYPT, useApi } from '../support/api.js';
import { useSeededDb } from '../support/db.js';

const PASSWORD = 'correct horse battery';

/** `fl2_session=…` from a Set-Cookie header, ready for a Cookie header. */
function cookieFrom(setCookie: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const pair = raw?.split(';')[0];
  if (!pair) throw new Error('no Set-Cookie on the response');
  return { cookie: pair };
}

describe('counter API sign-in (Phase 25)', () => {
  const ctx = useSeededDb();
  const start = useApi(ctx);
  const withAdmin = async () => {
    const api = await start({ signedIn: false });
    await new AuthService(api.db, TEST_SCRYPT).setAdminPassword('owner', PASSWORD);
    return api;
  };

  it('blocks every counter route without a session, but answers health and the session probe', async () => {
    const { call } = await start({ signedIn: false });
    expect(await call('GET', '/api/health')).toMatchObject({ status: 200 });
    expect(await call('GET', '/api/auth/session')).toMatchObject({ status: 200, body: { authenticated: false, adminConfigured: false } });
    for (const [method, path] of [
      ['GET', '/api/context'],
      ['GET', '/api/catalog'],
      ['POST', '/api/bills'],
      ['GET', '/api/staff/pin-holders'],
      ['GET', '/api/reports/full?startDate=2026-10-14&endDate=2026-10-14'],
    ] as const) {
      expect(await call(method, path, method === 'POST' ? {} : undefined)).toMatchObject({ status: 401, body: { error: { code: 'UNAUTHENTICATED' } } });
    }
    expect(await call('GET', '/api/context', undefined, { cookie: `${SESSION_COOKIE}=forged-token` })).toMatchObject({ status: 401 });
  });

  it('signs in with an HttpOnly, SameSite=Strict cookie, then signs out', async () => {
    const { call } = await withAdmin();
    expect((await call('GET', '/api/auth/session')).body).toEqual({ authenticated: false, adminConfigured: true });

    const login = await call('POST', '/api/auth/login', { username: 'Owner', password: PASSWORD });
    expect(login).toMatchObject({ status: 200, body: { authenticated: true, staff: { displayName: 'Super Admin', role: 'ADMIN' } } });
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=57600$`));
    const cookie = cookieFrom(login.headers['set-cookie']);

    expect(await call('GET', '/api/context', undefined, cookie)).toMatchObject({ status: 200 });
    expect((await call('GET', '/api/auth/session', undefined, cookie)).body).toMatchObject({ authenticated: true, staff: { role: 'ADMIN' }, adminConfigured: true });

    const logout = await call('POST', '/api/auth/logout', {}, cookie);
    expect(String(logout.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect(await call('GET', '/api/context', undefined, cookie)).toMatchObject({ status: 401 });
  });

  it('refuses a wrong password with one message, then locks with Retry-After', async () => {
    const { call } = await withAdmin();
    const unknown = await call('POST', '/api/auth/login', { username: 'nobody', password: PASSWORD });
    const wrong = await call('POST', '/api/auth/login', { username: 'owner', password: 'not the password' });
    expect(unknown).toMatchObject({ status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'Wrong username or password' } } });
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.headers['set-cookie']).toBeUndefined();
    for (let i = 0; i < 4; i++) await call('POST', '/api/auth/login', { username: 'owner', password: `wrong ${i} password` });
    const locked = await call('POST', '/api/auth/login', { username: 'owner', password: PASSWORD });
    expect(locked).toMatchObject({ status: 429, body: { error: { code: 'LOCKED', retryAfterSeconds: 300 } } });
    expect(locked.headers['retry-after']).toBe('300');
  });

  it('expires a session after its lifetime', async () => {
    let now = Date.parse('2026-10-20T08:00:00Z');
    const sessions = new SessionStore(() => now);
    const { call } = await start({ sessions });
    expect(await call('GET', '/api/context')).toMatchObject({ status: 200 });
    now += 16 * 60 * 60 * 1000;
    expect(await call('GET', '/api/context')).toMatchObject({ status: 401 });
  });

  it('manages staff and PINs; PIN holders list names and roles only', async () => {
    const { call, fx, adminId } = await start();
    const created = await call('POST', '/api/staff', { displayName: 'Ravi', role: 'CASHIER', pin: '4321' });
    expect(created).toMatchObject({ status: 201, body: { displayName: 'Ravi', role: 'CASHIER', hasPin: true, isActive: true } });
    expect(await call('POST', '/api/staff', { displayName: 'Boss', role: 'ADMIN' })).toMatchObject({ status: 400 });
    expect(await call('POST', '/api/staff', { displayName: 'ravi', role: 'MANAGER' })).toMatchObject({ status: 409, body: { error: { code: 'PS012' } } });
    expect(await call('PUT', `/api/staff/${fx.manager}/pin`, { pin: '12' })).toMatchObject({ status: 400 });
    expect(await call('PUT', `/api/staff/${fx.manager}/pin`, { pin: 2468 })).toMatchObject({ status: 400 });

    const holders = await call('GET', '/api/staff/pin-holders');
    expect(holders.body).toEqual([{ id: created.body.id, displayName: 'Ravi', role: 'CASHIER' }]);

    expect(await call('PATCH', `/api/staff/${created.body.id}`, { role: 'MANAGER' })).toMatchObject({ status: 200, body: { role: 'MANAGER' } });
    expect(await call('PATCH', `/api/staff/${adminId}`, { isActive: false })).toMatchObject({ status: 409, body: { error: { code: 'PS002' } } });
    expect(await call('PUT', `/api/staff/${created.body.id}/pin`, { pin: null })).toMatchObject({ status: 200, body: { hasPin: false } });
    const list = (await call('GET', '/api/staff')).body as Array<Record<string, unknown>>;
    expect(list.map((s) => s.displayName)).toEqual(['Counter 1', 'Manager', 'Test Admin', 'Ravi']);
    expect(JSON.stringify(list)).not.toMatch(/scrypt|pin_hash|password_hash/);
  });

  it('only an admin session may manage staff', async () => {
    const sessions = new SessionStore();
    const { call, fx } = await start({ sessions, signedIn: false });
    const { token } = sessions.issue({ id: fx.cashier, displayName: 'Counter 1', role: 'CASHIER' });
    const cookie = { cookie: `${SESSION_COOKIE}=${token}` };
    expect(await call('GET', '/api/staff', undefined, cookie)).toMatchObject({ status: 403 });
    expect(await call('PUT', `/api/staff/${fx.cashier}/pin`, { pin: '1234' }, cookie)).toMatchObject({ status: 403 });
  });

  it('deactivating someone signs them out', async () => {
    const sessions = new SessionStore();
    const { call, db } = await start({ sessions });
    const auth = new AuthService(db, TEST_SCRYPT);
    await auth.setAdminPassword('owner', PASSWORD);
    const deputy = await auth.setAdminPassword('deputy', PASSWORD, 'Deputy');
    const { token } = sessions.issue(deputy);
    const cookie = { cookie: `${SESSION_COOKIE}=${token}` };
    expect(await call('GET', '/api/context', undefined, cookie)).toMatchObject({ status: 200 });
    expect(await call('PATCH', `/api/staff/${deputy.id}`, { isActive: false })).toMatchObject({ status: 200, body: { isActive: false } });
    expect(await call('GET', '/api/context', undefined, cookie)).toMatchObject({ status: 401 });
  });
});
