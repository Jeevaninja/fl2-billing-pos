/**
 * Password and PIN hashing (Phase 25, D2): Node's built-in scrypt, a random 16-byte salt per secret,
 * and a constant-time compare. The stored form carries its own cost parameters,
 * `scrypt$N$r$p$<salt b64>$<hash b64>`, so the cost can be raised later without breaking old hashes.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

/** ~32 MiB and ~100 ms per check on the till: slow enough to make guessing expensive. */
export const DEFAULT_COST: ScryptCost = { N: 2 ** 15, r: 8, p: 1 };

const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** Upper bounds on parameters read back from a stored hash. */
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;
const STORED = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

function scrypt(secret: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(secret.normalize('NFKC'), salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** 128 · N · r bytes plus headroom; Node's default cap (32 MiB) is too tight for N = 2^15. */
const maxmem = ({ N, r }: ScryptCost) => 128 * N * r * 2;

export async function hashSecret(secret: string, cost: ScryptCost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(secret, salt, KEY_BYTES, { ...cost, maxmem: maxmem(cost) });
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** True when `secret` matches `stored`. A malformed or out-of-bounds hash never matches. */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const m = STORED.exec(stored);
  if (!m) return false;
  const cost = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  const isPowerOfTwo = (cost.N & (cost.N - 1)) === 0;
  if (cost.N < 2 || cost.N > MAX_N || !isPowerOfTwo || cost.r < 1 || cost.r > MAX_R || cost.p < 1 || cost.p > MAX_P) return false;
  const salt = Buffer.from(m[4]!, 'base64');
  const expected = Buffer.from(m[5]!, 'base64');
  if (expected.length !== KEY_BYTES) return false;
  const actual = await scrypt(secret, salt, KEY_BYTES, { ...cost, maxmem: maxmem(cost) });
  return timingSafeEqual(actual, expected);
}

/** A hash of nothing in particular, verified against when a username is unknown, so timing reveals nothing. */
let decoy: Promise<string> | undefined;
export function decoyHash(): Promise<string> {
  decoy ??= hashSecret(randomBytes(16).toString('hex'));
  return decoy;
}
