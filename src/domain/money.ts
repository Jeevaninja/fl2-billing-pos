/** Whole paise (₹1 = 100n). The only money type in the domain — never a float. */
export type Paise = bigint;

/** A database integer as delivered by any driver: PGlite (number | bigint), node-postgres (string). */
export type DbInt = number | bigint | string;

/** Converts a database integer to paise, refusing anything that could have lost precision. */
export function toPaise(value: DbInt): Paise {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`paise value ${value} is not a safe integer`);
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new RangeError(`paise value "${value}" is not an integer`);
  return BigInt(value);
}

export function toPaiseOrNull(value: DbInt | null): Paise | null {
  return value === null ? null : toPaise(value);
}

/** Serialises paise as a query parameter (decimal string: exact for every driver). */
export function paiseParam(value: Paise): string {
  return value.toString();
}

/** Validates a caller-supplied amount: must be a bigint, > 0 (or ≥ 0 with `allowZero`). */
export function assertPaise(value: Paise, name: string, opts: { allowZero?: boolean } = {}): void {
  if (typeof value !== 'bigint') throw new TypeError(`${name} must be a bigint amount in paise`);
  if (opts.allowZero ? value < 0n : value <= 0n) {
    throw new RangeError(`${name} must be ${opts.allowZero ? 'zero or more' : 'greater than zero'} paise, got ${value}`);
  }
}

/** Validates a whole-bottle quantity. */
export function assertQuantity(value: number, name = 'quantity'): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a whole number of bottles greater than zero, got ${value}`);
  }
}
