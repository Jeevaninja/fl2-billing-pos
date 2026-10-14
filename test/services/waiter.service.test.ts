import { describe, expect, it } from 'vitest';
import { NotFoundError, PosErrorCode } from '../../src/db/errors.js';
import { useSeededDb } from '../support/db.js';
import { waiterBalance } from '../support/pos.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

describe('WaiterService', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, ...makeServices(db) };
  };

  /** A counter bill tagged to `waiterId` with `qty` Halfs on it. */
  async function waiterBill(waiterId: string, qty = 2) {
    const { fx, billing, waiters } = setup();
    const bill = await billing.createBill('NORMAL', fx.cashier);
    await waiters.tagBillToWaiter(bill.id, waiterId);
    await billing.addItemToBill(bill.id, fx.sku.half, qty);
    return bill.id;
  }

  describe('tagBillToWaiter', () => {
    it('tags an open bill and snapshots the waiter’s trust', async () => {
      const { fx, billing, waiters } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);

      const tagged = await waiters.tagBillToWaiter(bill.id, fx.waiter.untrusted);
      expect(tagged).toMatchObject({ waiterId: fx.waiter.untrusted, waiterTrustedAtBilling: false, source: 'COUNTER' });

      // Re-tagging is allowed until the first tender.
      const retagged = await waiters.tagBillToWaiter(bill.id, fx.waiter.trusted);
      expect(retagged).toMatchObject({ waiterId: fx.waiter.trusted, waiterTrustedAtBilling: true });
    });

    it('locks the tag once a tender exists (PS002) and once settled (PS001)', async () => {
      const { fx, waiters } = setup();
      const billId = await waiterBill(fx.waiter.trusted);
      await waiters.settleWaiterBill(billId, fx.waiter.trusted, 'CASH', 100_000n);
      await expectPosError(waiters.tagBillToWaiter(billId, fx.waiter.limited), PosErrorCode.ILLEGAL_TRANSITION, /already has tenders/);

      await waiters.settleWaiterBill(billId, fx.waiter.trusted, 'CASH');
      await expectPosError(waiters.tagBillToWaiter(billId, fx.waiter.limited), PosErrorCode.APPEND_ONLY, /frozen/);
    });

    it('refuses peak bills, inactive or unknown waiters, and unknown bills', async () => {
      const { db, fx, billing, peak, waiters } = setup();
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      const { bill: peakBill } = await billing.recordPeakSale(session.id, fx.sku.half, 1, fx.cashier);
      await expectPosError(waiters.tagBillToWaiter(peakBill.id, fx.waiter.trusted), PosErrorCode.ILLEGAL_TRANSITION, /counter-only/);

      const bill = await billing.createBill('NORMAL', fx.cashier);
      await db.query(`UPDATE waiters SET is_active = false WHERE id = $1`, [fx.waiter.limited]);
      await expectPosError(waiters.tagBillToWaiter(bill.id, fx.waiter.limited), PosErrorCode.ILLEGAL_TRANSITION, /inactive/);
      await expectPosError(waiters.tagBillToWaiter(bill.id, UNKNOWN_ID), PosErrorCode.ILLEGAL_TRANSITION, /not found/);
      await expect(waiters.tagBillToWaiter(UNKNOWN_ID, fx.waiter.trusted)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('settleWaiterBill — trusted waiter', () => {
    it('settles the full amount in one mode by default', async () => {
      const { fx, waiters } = setup();
      const billId = await waiterBill(fx.waiter.trusted);
      const result = await waiters.settleWaiterBill(billId, fx.waiter.trusted, 'UPI');
      expect(result.bill.status).toBe('SETTLED');
      expect(result.payment).toMatchObject({ tender: 'UPI', amountPaise: 2n * PAISE.half });
      expect(result.remainingDuePaise).toBe(0n);
    });

    it('takes a partial payment now and the rest on collect-later credit', async () => {
      const { db, fx, waiters } = setup();
      const billId = await waiterBill(fx.waiter.trusted); // 240,000

      const part = await waiters.settleWaiterBill(billId, fx.waiter.trusted, 'CASH', 150_000n);
      expect(part.bill.status).toBe('OPEN');
      expect(part.remainingDuePaise).toBe(90_000n);

      const rest = await waiters.settleWaiterBill(billId, fx.waiter.trusted, 'WAITER_CREDIT');
      expect(rest.bill.status).toBe('SETTLED');
      expect(rest.payment).toMatchObject({ tender: 'WAITER_CREDIT', amountPaise: 90_000n });
      expect(rest.remainingDuePaise).toBe(0n);
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(90_000);
    });

    it('rejects paying more than is due (PS005)', async () => {
      const { fx, waiters } = setup();
      const billId = await waiterBill(fx.waiter.trusted, 1);
      await expectPosError(
        waiters.settleWaiterBill(billId, fx.waiter.trusted, 'CASH', PAISE.half + 1n),
        PosErrorCode.TENDER_MISMATCH,
        /exceeds 120000 paise due/,
      );
    });

    it('enforces the credit limit (PS004)', async () => {
      const { fx, waiters } = setup();
      const billId = await waiterBill(fx.waiter.limited, 1); // 120,000 > 100,000 limit
      await expectPosError(waiters.settleWaiterBill(billId, fx.waiter.limited, 'WAITER_CREDIT'), PosErrorCode.CREDIT_NOT_ALLOWED, /credit limit/);
    });
  });

  describe('settleWaiterBill — untrusted waiter (bill-on-bill)', () => {
    it('blocks WAITER_CREDIT entirely (PS004), recording nothing', async () => {
      const { db, fx, waiters } = setup();
      const billId = await waiterBill(fx.waiter.untrusted);
      await expectPosError(waiters.settleWaiterBill(billId, fx.waiter.untrusted, 'WAITER_CREDIT'), PosErrorCode.CREDIT_NOT_ALLOWED, /not trusted/);
      await expectPosError(
        waiters.settleWaiterBill(billId, fx.waiter.untrusted, 'WAITER_CREDIT', 1_000n),
        PosErrorCode.CREDIT_NOT_ALLOWED,
      );
      const { rows } = await db.query(`SELECT 1 FROM bill_payments WHERE bill_id = $1`, [billId]);
      expect(rows).toEqual([]);
      expect(await waiterBalance(db, fx.waiter.untrusted)).toBe(0);
    });

    it('requires the exact amount due in one go (PS005 for a partial amount)', async () => {
      const { fx, waiters } = setup();
      const billId = await waiterBill(fx.waiter.untrusted); // 240,000
      await expectPosError(
        waiters.settleWaiterBill(billId, fx.waiter.untrusted, 'CASH', 100_000n),
        PosErrorCode.TENDER_MISMATCH,
        /bill-on-bill: bill \d+ must be settled for exactly 240000 paise/,
      );
      const settled = await waiters.settleWaiterBill(billId, fx.waiter.untrusted, 'CASH', 240_000n);
      expect(settled.bill.status).toBe('SETTLED');
    });

    it('applies the waiter’s current trust: a downgraded waiter loses credit and partial payment', async () => {
      const { db, fx, waiters } = setup();
      const billId = await waiterBill(fx.waiter.trusted);
      await db.query(`UPDATE waiters SET is_trusted = false WHERE id = $1`, [fx.waiter.trusted]);
      await expectPosError(waiters.settleWaiterBill(billId, fx.waiter.trusted, 'WAITER_CREDIT'), PosErrorCode.CREDIT_NOT_ALLOWED);
      await expectPosError(waiters.settleWaiterBill(billId, fx.waiter.trusted, 'CASH', 1n), PosErrorCode.TENDER_MISMATCH);
    });
  });

  describe('settleWaiterBill — guards', () => {
    it('only settles bills tagged to that waiter (PS002)', async () => {
      const { fx, billing, waiters } = setup();
      const billId = await waiterBill(fx.waiter.trusted);
      await expectPosError(waiters.settleWaiterBill(billId, fx.waiter.untrusted, 'CASH'), PosErrorCode.ILLEGAL_TRANSITION, /not tagged/);

      const untagged = await billing.createBill('NORMAL', fx.cashier);
      await expectPosError(waiters.settleWaiterBill(untagged.id, fx.waiter.trusted, 'CASH'), PosErrorCode.ILLEGAL_TRANSITION);
    });

    it('rejects settled bills (PS001) and bad arguments', async () => {
      const { fx, waiters } = setup();
      const billId = await waiterBill(fx.waiter.trusted);
      await waiters.settleWaiterBill(billId, fx.waiter.trusted, 'CASH');
      await expectPosError(waiters.settleWaiterBill(billId, fx.waiter.trusted, 'CASH'), PosErrorCode.APPEND_ONLY);

      await expect(waiters.settleWaiterBill(billId, fx.waiter.trusted, 'CARD' as never)).rejects.toBeInstanceOf(RangeError);
      await expect(waiters.settleWaiterBill(billId, fx.waiter.trusted, 'CASH', 0n)).rejects.toBeInstanceOf(RangeError);
      await expect(waiters.settleWaiterBill(UNKNOWN_ID, fx.waiter.trusted, 'CASH')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('recordWaiterRepayment', () => {
    it('reduces the outstanding balance and returns it as bigint', async () => {
      const { fx, waiters } = setup();
      const billId = await waiterBill(fx.waiter.trusted);
      await waiters.settleWaiterBill(billId, fx.waiter.trusted, 'WAITER_CREDIT'); // owes 240,000

      const first = await waiters.recordWaiterRepayment(fx.waiter.trusted, 100_000n, 'CASH', fx.cashier);
      expect(first.outstandingPaise).toBe(140_000n);
      expect(first.payment).toMatchObject({ tender: 'CASH', amountPaise: 100_000n, waiterId: fx.waiter.trusted, peakSessionId: null });

      const second = await waiters.recordWaiterRepayment(fx.waiter.trusted, 140_000n, 'UPI', fx.cashier);
      expect(second.outstandingPaise).toBe(0n);
    });

    it('tags repayments taken during a peak window to that session', async () => {
      const { fx, peak, waiters } = setup();
      const billId = await waiterBill(fx.waiter.trusted, 1);
      await waiters.settleWaiterBill(billId, fx.waiter.trusted, 'WAITER_CREDIT');
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      const { payment } = await waiters.recordWaiterRepayment(fx.waiter.trusted, PAISE.half, 'CASH', fx.cashier);
      expect(payment.peakSessionId).toBe(session.id);
    });

    it('rejects overpayment (PS008), bad amounts and unknown waiters', async () => {
      const { db, fx, waiters } = setup();
      await expectPosError(
        waiters.recordWaiterRepayment(fx.waiter.trusted, 1n, 'CASH', fx.cashier),
        PosErrorCode.WAITER_BALANCE,
        /cannot go negative/,
      );
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(0);

      await expect(waiters.recordWaiterRepayment(fx.waiter.trusted, 0n, 'CASH', fx.cashier)).rejects.toBeInstanceOf(RangeError);
      await expect(waiters.recordWaiterRepayment(fx.waiter.trusted, 100 as never, 'CASH', fx.cashier)).rejects.toBeInstanceOf(TypeError);
      await expect(waiters.recordWaiterRepayment(fx.waiter.trusted, 1n, 'WAITER_CREDIT' as never, fx.cashier)).rejects.toBeInstanceOf(
        RangeError,
      );
      await expect(waiters.recordWaiterRepayment(UNKNOWN_ID, 1n, 'CASH', fx.cashier)).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
