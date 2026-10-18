/**
 * JSON wire format. Money crosses the wire as decimal strings of whole paise ("102050"), never as
 * JSON numbers, so neither side can route it through a float. Dates go out as ISO strings.
 */

/** The request is malformed (bad JSON, missing or mistyped field). Reported as HTTP 400. */
export class BadRequestError extends Error {
  override readonly name = 'BadRequestError';
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

export type Body = Record<string, unknown>;

export function parseBody(text: string): Body {
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequestError('request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError('request body must be a JSON object');
  }
  return parsed as Body;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAISE = /^\d{1,18}$/;

export function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestError(`${name} must be a UUID`);
  return value;
}

export function optId(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : id(value, name);
}

export function str(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new BadRequestError(`${name} must be a string`);
  return value;
}

export function int(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new BadRequestError(`${name} must be a whole number`);
  return value;
}

export function optBool(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new BadRequestError(`${name} must be true or false`);
  return value;
}

/** Whole paise as a decimal string, e.g. "102050" for ₹1,020.50. JSON numbers are refused. */
export function paise(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !PAISE.test(value)) {
    throw new BadRequestError(`${name} must be a string of whole paise, e.g. "102050"`);
  }
  return BigInt(value);
}

const SIGNED_PAISE = /^-?\d{1,18}$/;

/** Signed whole paise as a decimal string, e.g. "-50000" (a movement that can go either way). */
export function signedPaise(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !SIGNED_PAISE.test(value)) {
    throw new BadRequestError(`${name} must be a string of whole paise, e.g. "50000" or "-50000"`);
  }
  return BigInt(value);
}

export function optPaise(value: unknown, name: string): bigint | undefined {
  return value === undefined ? undefined : paise(value, name);
}

export function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new BadRequestError(`${name} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

export function optOneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T | undefined {
  return value === undefined ? undefined : oneOf(value, name, allowed);
}
