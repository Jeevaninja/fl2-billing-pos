import { describe, expect, it } from 'vitest';
import { NotFoundError, PosErrorCode } from '../../src/db/errors.js';
import { useSeededDb } from '../support/db.js';
import { one } from '../support/pos.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

describe('PeakSessionService', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, ...makeServices(db) };
  };

  it('reconciles the design-doc worked example end to end: expected ₹51,100.00, variance −₹50.00', async () => {
    const { db, fx, billing, peak, waiters } = setup();

    // Before peak: waiter B (trusted) runs up ₹2,200.00 on collect-later; a counter cash sale.
    const credit = await billing.createBill('NORMAL', fx.cashier);
    await waiters.tagBillToWaiter(credit.id, fx.waiter.trusted);
    await billing.addItemToBill(credit.id, fx.sku.full, 1);
    await waiters.settleWaiterBill(credit.id, fx.waiter.trusted, 'WAITER_CREDIT');
    const pre = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(pre.id, fx.sku.beer650, 1);
    await billing.settleNormalBill(pre.id, [{ mode: 'CASH', amount: PAISE.beer650 }]);

    const session = await peak.startPeakSession(fx.dayId, 500_000n, 1_250_000n, fx.cashier);
    expect(session).toMatchObject({ sessionNo: 1, startCashPaise: 500_000n, startUpiPaise: 1_250_000n, endedAt: null });

    // Peak scans: Σ ₹48,200.00.
    await billing.recordPeakSale(session.id, fx.sku.full, 10, fx.cashier);
    await billing.recordPeakSale(session.id, fx.sku.half, 1, fx.cashier);
    await billing.recordPeakSale(session.id, fx.sku.full, 10, fx.cashier);
    await billing.recordPeakSale(session.id, fx.sku.half, 1, fx.cashier);
    await billing.recordPeakSale(session.id, fx.sku.quarter, 2, fx.cashier);
    const { bill: voided } = await billing.recordPeakSale(session.id, fx.sku.quarter, 1, fx.cashier);
    // One Quarter voided in-session: −₹600.00.
    await billing.reverseBill(voided.id, 'wrong brand scanned', fx.cashier);

    // Untrusted waiter A settles ₹1,500.00 cash in the window.
    const waiterBill = await billing.createBill('NORMAL', fx.cashier);
    await waiters.tagBillToWaiter(waiterBill.id, fx.waiter.untrusted);
    await billing.addItemToBill(waiterBill.id, fx.sku.half, 1);
    await billing.addItemToBill(waiterBill.id, fx.sku.beer330, 2);
    await waiters.settleWaiterBill(waiterBill.id, fx.waiter.untrusted, 'CASH');
    // Waiter B repays ₹2,000.00 by UPI in the window.
    await waiters.recordWaiterRepayment(fx.waiter.trusted, 200_000n, 'UPI', fx.cashier);

    const { session: ended, breakdown } = await peak.endPeakSession(session.id, 3_780_000n, 3_075_000n, fx.cashier);

    expect(ended).toMatchObject({
      endCashPaise: 3_780_000n,
      endUpiPaise: 3_075_000n,
      expectedPaise: 5_110_000n,
      variancePaise: -5_000n,
      endedByStaffId: fx.cashier,
    });
    expect(ended.endedAt).toBeInstanceOf(Date);
    expect(breakdown).toEqual({
      peakBillsPaise: 4_760_000n, // 4,820,000 − 60,000
      billCashPaise: 150_000n,
      billUpiPaise: 0n,
      waiterCashPaise: 0n,
      waiterUpiPaise: 200_000n,
      expectedPaise: 5_110_000n,
      actualPaise: 5_105_000n,
      cashDeltaPaise: 3_280_000n,
      upiDeltaPaise: 1_825_000n,
      variancePaise: -5_000n,
    });

    const open = await one<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM bills WHERE peak_session_id = $1 AND status <> 'PEAK_RECONCILED'`,
      [session.id],
    );
    expect(open.n).toBe(0);
  });

  it('allows only one running session; a second window starts after the first ends', async () => {
    const { fx, billing, peak } = setup();
    const first = await peak.startPeakSession(fx.dayId, 100_000n, 0n, fx.cashier);
    await expectPosError(peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /already running/);

    await billing.recordPeakSale(first.id, fx.sku.half, 1, fx.cashier);
    const lunch = await peak.endPeakSession(first.id, 220_000n, 0n, fx.cashier);
    expect(lunch.session).toMatchObject({ expectedPaise: PAISE.half, variancePaise: 0n });

    const second = await peak.startPeakSession(fx.dayId, 220_000n, 0n, fx.cashier);
    expect(second.sessionNo).toBe(2);
    await billing.recordPeakSale(second.id, fx.sku.full, 1, fx.cashier);
    const night = await peak.endPeakSession(second.id, 220_000n, PAISE.full - 1_000n, fx.cashier);
    expect(night.session).toMatchObject({ expectedPaise: PAISE.full, variancePaise: -1_000n });
    expect(night.breakdown.upiDeltaPaise).toBe(PAISE.full - 1_000n);
  });

  it('reports an excess as a positive variance', async () => {
    const { fx, billing, peak } = setup();
    const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    await billing.recordPeakSale(session.id, fx.sku.quarter, 1, fx.cashier);
    const { session: ended } = await peak.endPeakSession(session.id, PAISE.quarter + 500n, 0n, fx.cashier);
    expect(ended.variancePaise).toBe(500n);
  });

  it('closes atomically and only once (PS001 on a second close)', async () => {
    const { fx, peak } = setup();
    const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    await peak.endPeakSession(session.id, 0n, 0n, fx.cashier);
    await expectPosError(peak.endPeakSession(session.id, 10n, 0n, fx.cashier), PosErrorCode.APPEND_ONLY, /frozen/);
  });

  it('only starts on the open business day (PS007)', async () => {
    const { db, fx, peak } = setup();
    await db.query(`UPDATE business_days SET status = 'CLOSED', closed_by_staff_id = $2 WHERE id = $1`, [fx.dayId, fx.manager]);
    await expectPosError(peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /open business day/);
  });

  it('validates amounts: bigint, zero allowed, never negative', async () => {
    const { fx, peak } = setup();
    await expect(peak.startPeakSession(fx.dayId, -1n, 0n, fx.cashier)).rejects.toBeInstanceOf(RangeError);
    await expect(peak.startPeakSession(fx.dayId, 1000 as never, 0n, fx.cashier)).rejects.toBeInstanceOf(TypeError);

    const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    await expect(peak.endPeakSession(session.id, 0n, -5n, fx.cashier)).rejects.toBeInstanceOf(RangeError);
    await expect(peak.endPeakSession('00000000-0000-7000-8000-000000000000', 0n, 0n, fx.cashier)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
