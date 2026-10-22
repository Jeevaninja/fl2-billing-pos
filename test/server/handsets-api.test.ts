import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptainPairing } from '../../server/app.js';
import { DeviceRegistry } from '../../server/captain-devices.js';
import { SESSION_COOKIE, SessionStore } from '../../server/sessions.js';
import { useApi } from '../support/api.js';
import { useSeededDb } from '../support/db.js';

describe('counter API: Captain handset pairing (Staff & PINs)', () => {
  const ctx = useSeededDb();
  const start = useApi(ctx);
  let dir: string;
  let captain: CaptainPairing & { paired: number };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fl2-handsets-'));
    captain = {
      devicesFile: path.join(dir, 'captain-devices.json'),
      serverUrls: () => ['http://192.168.1.20:4311'],
      onPaired: () => void captain.paired++,
      paired: 0,
    };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('pairs a handset, shows its token once, and lists handsets without token hashes', async () => {
    const { call } = await start({ captain });
    expect((await call('GET', '/api/handsets')).body).toEqual({ handsets: [], serverUrls: ['http://192.168.1.20:4311'] });

    const paired = await call('POST', '/api/handsets', { id: 'handset-01', label: '  Captain 1 ' });
    expect(paired).toMatchObject({
      status: 201,
      body: { handset: { id: 'handset-01', label: 'Captain 1', active: true }, serverUrls: ['http://192.168.1.20:4311'] },
    });
    const { token } = paired.body as { token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(captain.paired).toBe(1);
    expect(readFileSync(captain.devicesFile, 'utf8')).not.toContain(token);
    expect(DeviceRegistry.fromFile(captain.devicesFile).authenticate(token)?.id).toBe('handset-01');

    const list = await call('GET', '/api/handsets');
    expect(list.body.handsets).toEqual([{ id: 'handset-01', label: 'Captain 1', active: true, pairedAt: expect.any(String) }]);
    expect(JSON.stringify(list.body)).not.toMatch(/tokenSha256|token"/);
  });

  it('re-issues and revokes; refuses bad ids, taken ids and revoked handsets', async () => {
    const { call } = await start({ captain });
    const registry = DeviceRegistry.fromFile(captain.devicesFile);
    const { token: first } = (await call('POST', '/api/handsets', { id: 'handset-01', label: 'Captain 1' })).body as { token: string };

    const again = await call('POST', '/api/handsets/handset-01/token', {});
    expect(again).toMatchObject({ status: 200, body: { handset: { id: 'handset-01', active: true } } });
    expect(registry.authenticate(first)).toBeNull();
    expect(registry.authenticate(again.body.token)?.id).toBe('handset-01');

    expect(await call('POST', '/api/handsets/handset-01/revoke', {})).toMatchObject({ status: 200, body: { id: 'handset-01', active: false } });
    expect(registry.authenticate(again.body.token)).toBeNull();

    expect(await call('POST', '/api/handsets', { id: 'Handset 2', label: 'x' })).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    expect(await call('POST', '/api/handsets', { id: 'handset-02', label: '   ' })).toMatchObject({ status: 400 });
    expect(await call('POST', '/api/handsets', { id: 'handset-02', label: 'x'.repeat(41) })).toMatchObject({ status: 400 });
    expect(await call('POST', '/api/handsets', { id: 'handset-01', label: 'again' })).toMatchObject({ status: 409, body: { error: { code: 'CONFLICT' } } });
    expect(await call('POST', '/api/handsets/handset-01/token', {})).toMatchObject({ status: 409, body: { error: { code: 'REVOKED' } } });
    expect(await call('POST', '/api/handsets/handset-77/revoke', {})).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
    expect(captain.paired).toBe(1);
  });

  it('is admin-only, and answers 503 when pairing is not configured', async () => {
    const sessions = new SessionStore();
    const { call, fx } = await start({ captain, sessions, signedIn: false });
    const { token } = sessions.issue({ id: fx.manager, displayName: 'Manager', role: 'MANAGER' });
    const cookie = { cookie: `${SESSION_COOKIE}=${token}` };
    expect(await call('GET', '/api/handsets', undefined, cookie)).toMatchObject({ status: 403 });
    expect(await call('POST', '/api/handsets', { id: 'handset-01', label: 'x' }, cookie)).toMatchObject({ status: 403 });

    const bare = await start();
    expect(await bare.call('GET', '/api/handsets')).toMatchObject({ status: 503, body: { error: { code: 'CAPTAIN_NOT_CONFIGURED' } } });
  });
});
