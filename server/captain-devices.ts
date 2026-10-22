/**
 * Paired Captain handsets. Each device holds a static random bearer token; the server stores only
 * its SHA-256, in a JSON file (default .data/captain-devices.json, git-ignored, mode 0600):
 *
 *   [{ "id": "handset-01", "label": "Captain 1", "tokenSha256": "<64 hex>", "active": true, "pairedAt": "…" }]
 *
 * Revoking marks a device inactive (records are kept for audit). The registry re-reads the file
 * when it changes, so pairing and revocation apply without restarting the server.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Same format the bills.captain_device_id CHECK accepts. */
export const DEVICE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface DeviceRecord {
  id: string;
  label: string;
  tokenSha256: string;
  active: boolean;
  pairedAt: string;
}

/** A pairing request the registry refuses: a malformed id, a taken id, or a missing or revoked device. */
export class DeviceRegistryError extends Error {
  constructor(
    readonly code: 'INVALID' | 'CONFLICT' | 'NOT_FOUND' | 'REVOKED',
    message: string,
  ) {
    super(message);
    this.name = 'DeviceRegistryError';
  }
}

export interface CaptainDevice {
  id: string;
  label: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 256 random bits, URL-safe: what the handset sends as `Authorization: Bearer <token>`. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Validates a devices file; throws with a precise message on any malformed entry. */
export function parseDeviceFile(text: string): DeviceRecord[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('captain devices file must be a JSON array');
  const seen = new Set<string>();
  return data.map((raw: unknown, i) => {
    const r = raw as Partial<DeviceRecord> | null;
    if (typeof r !== 'object' || r === null) throw new Error(`device[${i}] must be an object`);
    if (typeof r.id !== 'string' || !DEVICE_ID.test(r.id)) throw new Error(`device[${i}].id must match ${DEVICE_ID}`);
    if (seen.has(r.id)) throw new Error(`device id ${r.id} appears twice`);
    seen.add(r.id);
    if (typeof r.label !== 'string') throw new Error(`device ${r.id}: label must be a string`);
    if (typeof r.tokenSha256 !== 'string' || !SHA256_HEX.test(r.tokenSha256)) throw new Error(`device ${r.id}: tokenSha256 must be 64 hex`);
    if (typeof r.active !== 'boolean') throw new Error(`device ${r.id}: active must be true or false`);
    return { id: r.id, label: r.label, tokenSha256: r.tokenSha256, active: r.active, pairedAt: String(r.pairedAt ?? '') };
  });
}

export class DeviceRegistry {
  constructor(private readonly records: () => readonly DeviceRecord[]) {}

  static fromRecords(records: readonly DeviceRecord[]): DeviceRegistry {
    return new DeviceRegistry(() => records);
  }

  /** Reads `file`, re-reading whenever it changes (mtime, size or inode). A missing file means no devices. */
  static fromFile(file: string): DeviceRegistry {
    let cached: { stamp: string; records: DeviceRecord[] } | null = null;
    return new DeviceRegistry(() => {
      if (!existsSync(file)) return [];
      const { mtimeMs, size, ino } = statSync(file);
      const stamp = `${mtimeMs}:${size}:${ino}`; // atomic rename gives a new inode on every write
      if (cached?.stamp !== stamp) cached = { stamp, records: parseDeviceFile(readFileSync(file, 'utf8')) };
      return cached.records;
    });
  }

  /** The active device holding `token`, or null. Compares every hash in constant time. */
  authenticate(token: string): CaptainDevice | null {
    const presented = Buffer.from(hashToken(token), 'hex');
    let found: CaptainDevice | null = null;
    for (const r of this.records()) {
      const match = timingSafeEqual(presented, Buffer.from(r.tokenSha256, 'hex'));
      if (match && r.active) found = { id: r.id, label: r.label };
    }
    return found;
  }

  activeDevices(): CaptainDevice[] {
    return this.records()
      .filter((r) => r.active)
      .map((r) => ({ id: r.id, label: r.label }));
  }
}

// ── File maintenance (used by the captain:devices CLI) ───────────────────────

function readRecords(file: string): DeviceRecord[] {
  return existsSync(file) ? parseDeviceFile(readFileSync(file, 'utf8')) : [];
}

/** Atomic write (temp file + rename), owner-only permissions. */
function writeRecords(file: string, records: readonly DeviceRecord[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Pairs a new handset: stores the token's hash and returns the token, which is shown only once. */
export function pairDevice(file: string, id: string, label: string, now = new Date()): { token: string; record: DeviceRecord } {
  if (!DEVICE_ID.test(id)) throw new DeviceRegistryError('INVALID', `device id must match ${DEVICE_ID} (e.g. handset-01)`);
  const records = readRecords(file);
  if (records.some((r) => r.id === id)) {
    throw new DeviceRegistryError('CONFLICT', `device ${id} is already paired; pick a new id (revoked ids stay reserved for audit)`);
  }
  const token = generateToken();
  const record: DeviceRecord = { id, label, tokenSha256: hashToken(token), active: true, pairedAt: now.toISOString() };
  writeRecords(file, [...records, record]);
  return { token, record };
}

/**
 * Issues a fresh token for an active handset (lost or leaked token, or a replacement phone that
 * keeps the id). The old token stops working at once; like pairing, the new one is shown only once.
 */
export function reissueToken(file: string, id: string): { token: string; record: DeviceRecord } {
  const records = readRecords(file);
  const target = records.find((r) => r.id === id);
  if (!target) throw new DeviceRegistryError('NOT_FOUND', `no paired device ${id}`);
  if (!target.active) throw new DeviceRegistryError('REVOKED', `device ${id} is revoked; pair a new id instead`);
  const token = generateToken();
  const record = { ...target, tokenSha256: hashToken(token) };
  writeRecords(file, records.map((r) => (r.id === id ? record : r)));
  return { token, record };
}

/** Revokes a handset. Its record stays (inactive) so orders it placed remain attributable. */
export function revokeDevice(file: string, id: string): DeviceRecord {
  const records = readRecords(file);
  const target = records.find((r) => r.id === id);
  if (!target) throw new DeviceRegistryError('NOT_FOUND', `no paired device ${id}`);
  const revoked = { ...target, active: false };
  writeRecords(file, records.map((r) => (r.id === id ? revoked : r)));
  return revoked;
}

export function listDevices(file: string): DeviceRecord[] {
  return readRecords(file);
}
