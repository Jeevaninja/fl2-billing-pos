import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeviceRegistry,
  generateToken,
  hashToken,
  listDevices,
  pairDevice,
  parseDeviceFile,
  reissueToken,
  revokeDevice,
} from '../../server/captain-devices.js';

describe('Captain device registry', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fl2-devices-'));
    file = path.join(dir, 'nested', 'captain-devices.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates 256-bit URL-safe tokens and hashes them with SHA-256', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(token);
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('pairs a handset: stores only the hash, owner-only, and the token authenticates', () => {
    const { token, record } = pairDevice(file, 'handset-01', 'Captain 1', new Date('2026-10-14T10:00:00Z'));
    const stored = readFileSync(file, 'utf8');
    expect(stored).not.toContain(token);
    expect(record).toEqual({ id: 'handset-01', label: 'Captain 1', tokenSha256: hashToken(token), active: true, pairedAt: '2026-10-14T10:00:00.000Z' });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const registry = DeviceRegistry.fromFile(file);
    expect(registry.authenticate(token)).toEqual({ id: 'handset-01', label: 'Captain 1' });
    expect(registry.authenticate(`${token}x`)).toBeNull();
    expect(registry.authenticate('')).toBeNull();
  });

  it('refuses invalid or duplicate ids, including revoked ones (kept for audit)', () => {
    expect(() => pairDevice(file, 'Handset 1', 'x')).toThrow(/device id must match/);
    pairDevice(file, 'handset-01', 'Captain 1');
    revokeDevice(file, 'handset-01');
    expect(() => pairDevice(file, 'handset-01', 'again')).toThrow(/already paired/);
    expect(() => revokeDevice(file, 'handset-77')).toThrow(/no paired device/);
  });

  it('applies pairing and revocation to a running registry without a restart', () => {
    const registry = DeviceRegistry.fromFile(file);
    expect(registry.activeDevices()).toEqual([]);

    const one = pairDevice(file, 'handset-01', 'Captain 1');
    const two = pairDevice(file, 'handset-02', 'Captain 2');
    expect(registry.activeDevices().map((d) => d.id)).toEqual(['handset-01', 'handset-02']);

    revokeDevice(file, 'handset-01');
    expect(registry.authenticate(one.token)).toBeNull();
    expect(registry.authenticate(two.token)?.id).toBe('handset-02');
    expect(listDevices(file).map((d) => [d.id, d.active])).toEqual([
      ['handset-01', false],
      ['handset-02', true],
    ]);
  });

  it('re-issues a token for an active handset: the old token stops working, the id and pairing date stay', () => {
    const registry = DeviceRegistry.fromFile(file);
    const first = pairDevice(file, 'handset-01', 'Captain 1', new Date('2026-10-14T10:00:00Z'));
    const again = reissueToken(file, 'handset-01');
    expect(again.token).not.toBe(first.token);
    expect(again.record).toEqual({ ...first.record, tokenSha256: hashToken(again.token) });
    expect(readFileSync(file, 'utf8')).not.toContain(again.token);
    expect(registry.authenticate(first.token)).toBeNull();
    expect(registry.authenticate(again.token)?.id).toBe('handset-01');

    expect(() => reissueToken(file, 'handset-77')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    revokeDevice(file, 'handset-01');
    expect(() => reissueToken(file, 'handset-01')).toThrow(expect.objectContaining({ code: 'REVOKED' }));
    expect(registry.authenticate(again.token)).toBeNull();
  });

  it('treats a missing file as no devices', () => {
    expect(DeviceRegistry.fromFile(path.join(dir, 'absent.json')).activeDevices()).toEqual([]);
  });

  it.each([
    ['not an array', '{}', /JSON array/],
    ['a bad id', '[{"id":"Bad Id","label":"x","tokenSha256":"' + 'a'.repeat(64) + '","active":true}]', /id must match/],
    ['a duplicate id', JSON.stringify([1, 2].map(() => ({ id: 'h1', label: 'x', tokenSha256: 'a'.repeat(64), active: true }))), /appears twice/],
    ['a plaintext token', '[{"id":"h1","label":"x","tokenSha256":"secret","active":true}]', /64 hex/],
    ['a missing active flag', '[{"id":"h1","label":"x","tokenSha256":"' + 'a'.repeat(64) + '"}]', /active/],
  ])('rejects a devices file with %s', (_label, text, message) => {
    expect(() => parseDeviceFile(text)).toThrow(message);
    writeFileSync(path.join(dir, 'bad.json'), text);
    expect(() => DeviceRegistry.fromFile(path.join(dir, 'bad.json')).activeDevices()).toThrow(message);
  });
});
