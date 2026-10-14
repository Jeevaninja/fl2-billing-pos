import { describe, expect, it } from 'vitest';
import { PgErrorCode, PosErrorCode } from '../src/db/errors.js';
import { expectSqlError, useSeededDb } from './support/db.js';
import { PRICE } from './support/fixtures.js';
import {
  addItem,
  endPeak,
  getBill,
  one,
  openBill,
  pay,
  reverseBill,
  runningExpected,
  sell,
  startPeak,
  waiterRepay,
  waiterBalance,
} from './support/pos.js';

describe('Peak Mode reconciliation math', () => {
  const ctx = useSeededDb();

  it('reproduces the design-doc worked example: expected ₹51,100.00, variance −₹50.00', async () => {
    const { db, fx } = ctx();

    // Before peak: trusted waiter B takes a Full on collect-later credit (₹2,200.00 owed) …
    await sell(db, { waiterId: fx.waiter.trusted, lines: [[fx.sku.full, 1]], tenders: [['WAITER_CREDIT', PRICE.full]] });
    // … and a counter cash sale happens. Neither may count toward the peak window.
    await sell(db, { lines: [[fx.sku.beer650, 1]], tenders: [['CASH', PRICE.beer650]] });

    const session = await startPeak(db, 500_000, 1_250_000, fx.cashier);

    // Peak bills: Σ = ₹48,200.00
    const p1 = await sell(db, { mode: 'PEAK', lines: [[fx.sku.full, 10], [fx.sku.half, 1]] }); // 2,320,000
    const p2 = await sell(db, { mode: 'PEAK', lines: [[fx.sku.full, 10], [fx.sku.half, 1], [fx.sku.quarter, 2]] }); // 2,440,000
    const p3 = await sell(db, { mode: 'PEAK', lines: [[fx.sku.quarter, 1]] }); // 60,000
    expect([p1.total_paise, p2.total_paise, p3.total_paise]).toEqual([2_320_000, 2_440_000, 60_000]);
    expect(p1.status).toBe('PEAK_UNSETTLED');

    // One Quarter voided inside the window: −₹600.00 (a PEAK reversal, no tenders).
    const r3 = await reverseBill(db, p3.id, { reason: 'wrong brand scanned', staffId: fx.cashier });
    expect(r3).toMatchObject({ billing_mode: 'PEAK', status: 'PEAK_UNSETTLED', total_paise: -60_000 });

    // Untrusted waiter A settles a normal bill in cash during the window: ₹1,500.00.
    await sell(db, {
      waiterId: fx.waiter.untrusted,
      lines: [[fx.sku.half, 1], [fx.sku.beer330, 2]],
      tenders: [['CASH', 150_000]],
    });
    // Waiter B repays ₹2,000.00 by UPI during the window.
    await waiterRepay(db, fx.waiter.trusted, 'UPI', 200_000, fx.cashier);

    expect(await runningExpected(db, session.id)).toBe(5_110_000);

    const ended = await endPeak(db, session.id, 3_780_000, 3_075_000, fx.cashier);
    expect(ended.peak_expected_paise).toBe(5_110_000);
    // actual = (3,780,000 − 500,000) + (3,075,000 − 1,250,000) = 5,105,000
    expect(ended.peak_variance_paise).toBe(-5_000);
    expect(ended.ended_at).toBeInstanceOf(Date);

    // Every bill of the window — including the reversal — is reconciled in the same transaction.
    const { rows } = await db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM bills WHERE peak_session_id = $1 GROUP BY status`,
      [session.id],
    );
    expect(rows).toEqual([{ status: 'PEAK_RECONCILED', n: 4 }]);
    expect(await waiterBalance(db, fx.waiter.trusted)).toBe(20_000);

    // Activity after the window never rewrites the frozen reconciliation.
    await sell(db, { lines: [[fx.sku.beer650, 2]], tenders: [['CASH', 2 * PRICE.beer650]] });
    const frozen = await one<{ peak_expected_paise: number; running_expected_paise: number }>(
      db,
      `SELECT peak_expected_paise, running_expected_paise FROM v_peak_sessions WHERE id = $1`,
      [session.id],
    );
    expect(frozen).toEqual({ peak_expected_paise: 5_110_000, running_expected_paise: 5_110_000 });
  });

  it('reports zero variance when the drawer matches, and a positive variance for excess', async () => {
    const { db, fx } = ctx();

    const s1 = await startPeak(db, 100_000, 0, fx.cashier);
    await sell(db, { mode: 'PEAK', lines: [[fx.sku.half, 2]] }); // 240,000
    const exact = await endPeak(db, s1.id, 250_000, 90_000, fx.cashier); // +150,000 cash, +90,000 UPI
    expect(exact).toMatchObject({ peak_expected_paise: 240_000, peak_variance_paise: 0 });

    const s2 = await startPeak(db, 250_000, 90_000, fx.cashier);
    await sell(db, { mode: 'PEAK', lines: [[fx.sku.quarter, 1]] }); // 60,000
    const excess = await endPeak(db, s2.id, 320_000, 90_000, fx.cashier); // +70,000 cash
    expect(excess).toMatchObject({ peak_expected_paise: 60_000, peak_variance_paise: 10_000 });
  });

  it('counts cash refunds taken during the window as money leaving the drawer', async () => {
    const { db, fx } = ctx();
    const sale = await sell(db, { lines: [[fx.sku.full, 1]], tenders: [['CASH', PRICE.full]] });

    const session = await startPeak(db, 1_000_000, 0, fx.cashier);
    await sell(db, { mode: 'PEAK', lines: [[fx.sku.full, 1]] }); // +220,000
    await reverseBill(db, sale.id, { reason: 'customer returned sealed bottle' }); // −220,000 cash refund
    const ended = await endPeak(db, session.id, 1_000_000, 0, fx.cashier);
    expect(ended).toMatchObject({ peak_expected_paise: 0, peak_variance_paise: 0 });
  });

  describe('multiple peak windows per business day', () => {
    it('numbers sessions per day and reconciles each window independently', async () => {
      const { db, fx } = ctx();

      const lunch = await startPeak(db, 200_000, 0, fx.cashier);
      await sell(db, { mode: 'PEAK', lines: [[fx.sku.half, 1]] });
      const lunchEnd = await endPeak(db, lunch.id, 320_000, 0, fx.cashier);

      await sell(db, { lines: [[fx.sku.beer330, 1]], tenders: [['CASH', PRICE.beer330]] }); // between windows

      const night = await startPeak(db, 335_000, 0, fx.cashier);
      await sell(db, { mode: 'PEAK', lines: [[fx.sku.full, 2]] });
      const nightEnd = await endPeak(db, night.id, 335_000, 440_000, fx.cashier);

      expect([lunch.session_no, night.session_no]).toEqual([1, 2]);
      expect(lunchEnd).toMatchObject({ peak_expected_paise: 120_000, peak_variance_paise: 0 });
      expect(nightEnd).toMatchObject({ peak_expected_paise: 440_000, peak_variance_paise: 0 });
    });

    it('allows only one running session at a time', async () => {
      const { db, fx } = ctx();
      await startPeak(db, 0, 0, fx.cashier);
      await expectSqlError(startPeak(db, 0, 0, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /already running/);
    });
  });

  describe('peak bill rules', () => {
    it('requires a running peak session', async () => {
      const { db } = ctx();
      await expectSqlError(openBill(db, { mode: 'PEAK' }), PosErrorCode.DAY_OR_PEAK_RULE, /running peak session/);
    });

    it('bypasses the payment screen: peak bills reject tenders', async () => {
      const { db, fx } = ctx();
      await startPeak(db, 0, 0, fx.cashier);
      const bill = await sell(db, { mode: 'PEAK', lines: [[fx.sku.half, 1]] });
      await expectSqlError(pay(db, bill.id, 'CASH', PRICE.half), PosErrorCode.TENDER_MISMATCH, /take no tenders/);
    });

    it('cannot be reconciled by hand — only by ending the session', async () => {
      const { db, fx } = ctx();
      await startPeak(db, 0, 0, fx.cashier);
      const bill = await sell(db, { mode: 'PEAK', lines: [[fx.sku.half, 1]] });
      await expectSqlError(
        db.query(`UPDATE bills SET status = 'PEAK_RECONCILED' WHERE id = $1`, [bill.id]),
        PosErrorCode.ILLEGAL_TRANSITION,
      );
      await expectSqlError(
        db.query(`UPDATE bills SET status = 'SETTLED' WHERE id = $1`, [bill.id]),
        PosErrorCode.ILLEGAL_TRANSITION,
      );
    });

    it('is counter-only (no waiter-app peak bills)', async () => {
      const { db, fx } = ctx();
      await startPeak(db, 0, 0, fx.cashier);
      await expectSqlError(openBill(db, { mode: 'PEAK', waiterId: fx.waiter.trusted }), PgErrorCode.CHECK_VIOLATION);
    });

    it('accepts no new lines once reconciled', async () => {
      const { db, fx } = ctx();
      const session = await startPeak(db, 0, 0, fx.cashier);
      const bill = await sell(db, { mode: 'PEAK', lines: [[fx.sku.half, 1]] });
      await endPeak(db, session.id, PRICE.half, 0, fx.cashier);
      expect((await getBill(db, bill.id)).status).toBe('PEAK_RECONCILED');
      await expectSqlError(addItem(db, bill.id, fx.sku.half, 1), PosErrorCode.APPEND_ONLY);
    });
  });

  describe('session lifecycle guards', () => {
    it('freezes a session once ended, including its start figures', async () => {
      const { db, fx } = ctx();
      const session = await startPeak(db, 10_000, 0, fx.cashier);
      await expectSqlError(
        db.query(`UPDATE peak_sessions SET peak_start_cash = 0 WHERE id = $1`, [session.id]),
        PosErrorCode.APPEND_ONLY,
      );
      await endPeak(db, session.id, 10_000, 0, fx.cashier);
      await expectSqlError(endPeak(db, session.id, 99_999, 0, fx.cashier), PosErrorCode.APPEND_ONLY, /frozen/);
    });

    it('computes expected/variance itself, ignoring client-supplied values', async () => {
      const { db, fx } = ctx();
      const session = await startPeak(db, 0, 0, fx.cashier);
      await sell(db, { mode: 'PEAK', lines: [[fx.sku.quarter, 1]] });
      const row = await one<{ peak_expected_paise: number; peak_variance_paise: number }>(
        db,
        `UPDATE peak_sessions
            SET peak_end_cash = 60000, peak_end_upi = 0, ended_by_staff_id = $2,
                peak_expected_paise = 1, peak_variance_paise = 0
          WHERE id = $1 RETURNING *`,
        [session.id, fx.cashier],
      );
      expect(row).toMatchObject({ peak_expected_paise: 60_000, peak_variance_paise: 0 });
    });

    it('rejects a session inserted with end figures', async () => {
      const { db, fx } = ctx();
      await expectSqlError(
        db.query(
          `INSERT INTO peak_sessions (started_by_staff_id, peak_start_cash, peak_start_upi, peak_end_cash)
           VALUES ($1, 0, 0, 0)`,
          [fx.cashier],
        ),
        PosErrorCode.ILLEGAL_TRANSITION,
      );
    });

    it('blocks closing the business day while a session is running', async () => {
      const { db, fx } = ctx();
      const session = await startPeak(db, 0, 0, fx.cashier);
      const close = () =>
        db.query(`UPDATE business_days SET status = 'CLOSED', closed_by_staff_id = $2 WHERE id = $1`, [fx.dayId, fx.manager]);
      await expectSqlError(close(), PosErrorCode.DAY_OR_PEAK_RULE, /running peak session/);
      await endPeak(db, session.id, 0, 0, fx.cashier);
      await close();
      await expectSqlError(startPeak(db, 0, 0, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE);
    });
  });
});
