import { expect } from 'vitest';
import type { SqlDatabase } from '../../src/db/client.js';
import { PosError, type PosErrorCode } from '../../src/db/errors.js';
import { BillingService, PeakSessionService, WaiterService } from '../../src/services/index.js';
import { PRICE, type SkuKey } from './fixtures.js';

export function makeServices(db: SqlDatabase) {
  return {
    billing: new BillingService(db),
    peak: new PeakSessionService(db),
    waiters: new WaiterService(db),
  };
}

/** Fixture prices as bigint paise. */
export const PAISE = Object.fromEntries(Object.entries(PRICE).map(([k, v]) => [k, BigInt(v)])) as Record<SkuKey, bigint>;

/** Asserts a rejection with a PosError carrying `code` (and optionally a message pattern). */
export async function expectPosError(promise: Promise<unknown>, code: PosErrorCode, message?: RegExp): Promise<PosError> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected PosError ${code}, but the call succeeded`).toBeInstanceOf(PosError);
  const posError = err as PosError;
  expect(posError.code).toBe(code);
  if (message) expect(posError.message).toMatch(message);
  return posError;
}
