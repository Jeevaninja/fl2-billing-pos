import { describe, expect, it } from 'vitest';
import { isPosError, PosError, PosErrorCode, toPosError, withPosErrors } from '../../src/db/errors.js';
import { assertPaise, assertQuantity, paiseParam, toPaise } from '../../src/domain/money.js';

function dbError(code: string, message: string, constraint?: string): Error {
  return Object.assign(new Error(message), { code, constraint });
}

describe('toPosError', () => {
  it('maps every PS001–PS009 SQLSTATE raised by the schema onto PosError', () => {
    for (const code of Object.values(PosErrorCode)) {
      const raw = dbError(code, `rule ${code}`);
      const mapped = toPosError(raw);
      expect(mapped).toBeInstanceOf(PosError);
      expect(mapped).toMatchObject({ code, message: `rule ${code}`, cause: raw });
    }
  });

  it('maps business-rule constraints to their PS code and keeps the constraint name', () => {
    const cases: Array<[string, string, PosErrorCode]> = [
      ['23505', 'bills_reverses_unique', PosErrorCode.REVERSAL_RULE],
      ['23505', 'peak_sessions_one_active_per_day', PosErrorCode.DAY_OR_PEAK_RULE],
      ['23514', 'sku_stock_non_negative', PosErrorCode.INSUFFICIENT_STOCK],
      ['23514', 'waiters_outstanding_non_negative', PosErrorCode.WAITER_BALANCE],
      ['23514', 'bills_peak_counter_only', PosErrorCode.ILLEGAL_TRANSITION],
    ];
    for (const [sqlState, constraint, code] of cases) {
      expect(toPosError(dbError(sqlState, 'violation', constraint))).toMatchObject({ code, constraint });
    }
  });

  it('passes through errors that are not business rules', () => {
    const fk = dbError('23503', 'fk violation', 'bills_member_id_fkey');
    const plain = new Error('network down');
    expect(toPosError(fk)).toBe(fk);
    expect(toPosError(plain)).toBe(plain);
    expect(toPosError('not an error')).toBe('not an error');
  });

  it('withPosErrors rethrows mapped errors and leaves PosErrors untouched', async () => {
    await expect(withPosErrors(() => Promise.reject(dbError('PS003', 'no stock')))).rejects.toSatisfy((e: unknown) =>
      isPosError(e, PosErrorCode.INSUFFICIENT_STOCK),
    );
    const own = new PosError(PosErrorCode.TENDER_MISMATCH, 'mine');
    await expect(withPosErrors(() => Promise.reject(own))).rejects.toBe(own);
    expect(await withPosErrors(async () => 42)).toBe(42);
  });
});

describe('money', () => {
  it('converts every driver representation to exact bigint paise', () => {
    expect(toPaise(120_000)).toBe(120_000n);
    expect(toPaise(-60_000)).toBe(-60_000n);
    expect(toPaise('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(toPaise(9_007_199_254_740_993n)).toBe(9_007_199_254_740_993n);
  });

  it('refuses values that could have lost precision or are not integers', () => {
    expect(() => toPaise(2 ** 53)).toThrow(RangeError);
    expect(() => toPaise(10.5)).toThrow(RangeError);
    expect(() => toPaise('10.50')).toThrow(RangeError);
    expect(() => toPaise('1e5')).toThrow(RangeError);
  });

  it('serialises paise as exact decimal strings', () => {
    expect(paiseParam(9_007_199_254_740_993n)).toBe('9007199254740993');
    expect(paiseParam(-5_000n)).toBe('-5000');
  });

  it('validates caller amounts and quantities', () => {
    expect(() => assertPaise(1n, 'x')).not.toThrow();
    expect(() => assertPaise(0n, 'x')).toThrow(RangeError);
    expect(() => assertPaise(0n, 'x', { allowZero: true })).not.toThrow();
    expect(() => assertPaise(-1n, 'x', { allowZero: true })).toThrow(RangeError);
    expect(() => assertPaise(100 as never, 'x')).toThrow(TypeError);
    expect(() => assertQuantity(1)).not.toThrow();
    expect(() => assertQuantity(0)).toThrow(RangeError);
    expect(() => assertQuantity(2.5)).toThrow(RangeError);
  });
});
