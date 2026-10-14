import { describe, expect, it } from 'vitest';
import { NotFoundError, PosErrorCode } from '../../src/db/errors.js';
import { useSeededDb } from '../support/db.js';
import { OPENING_QTY } from '../support/fixtures.js';
import { cancelItem, one, onHand, waiterBalance } from '../support/pos.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

describe('BillingService', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, ...makeServices(db) };
  };

  describe('createBill', () => {
    it('opens a NORMAL counter bill with bigint totals and an optional member', async () => {
      const { db, fx, billing } = setup();
      const member = await one<{ id: string }>(
        db,
        `INSERT INTO members (membership_no, display_name) VALUES ('M-001', 'A Member') RETURNING id`,
      );

      const bill = await billing.createBill('NORMAL', fx.cashier, member.id);
      expect(bill).toMatchObject({
        mode: 'NORMAL',
        status: 'OPEN',
        kind: 'SALE',
        source: 'COUNTER',
        totalPaise: 0n,
        memberId: member.id,
        createdByStaffId: fx.cashier,
        businessDayId: fx.dayId,
      });
      expect(typeof bill.totalPaise).toBe('bigint');

      const walkIn = await billing.createBill('NORMAL', fx.cashier);
      expect(walkIn.memberId).toBeNull();
      expect(walkIn.billNo).toBe(bill.billNo + 1);
    });

    it('opens a PEAK bill only while a peak session is running', async () => {
      const { fx, billing, peak } = setup();
      await expectPosError(billing.createBill('PEAK', fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /running peak session/);

      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      const bill = await billing.createBill('PEAK', fx.cashier);
      expect(bill).toMatchObject({ mode: 'PEAK', status: 'PEAK_UNSETTLED', peakSessionId: session.id });
    });
  });

  describe('addItemToBill', () => {
    it('adds whole bottles, returning the line and the new bill total', async () => {
      const { db, fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);

      const { item, bill: updated } = await billing.addItemToBill(bill.id, fx.sku.full, 2);
      expect(item).toMatchObject({
        quantity: 2,
        unitPricePaise: PAISE.full,
        lineTotalPaise: 2n * PAISE.full,
        sizeCode: 'FULL',
        skuCode: 'HRUM-F',
      });
      expect(updated.totalPaise).toBe(2n * PAISE.full);

      const { bill: afterBeer } = await billing.addItemToBill(bill.id, fx.sku.beer330, 3);
      expect(afterBeer.totalPaise).toBe(2n * PAISE.full + 3n * PAISE.beer330);
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY - 2);
    });

    it('checks stock before writing anything', async () => {
      const { db, fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);

      await expectPosError(
        billing.addItemToBill(bill.id, fx.sku.half, OPENING_QTY + 1),
        PosErrorCode.INSUFFICIENT_STOCK,
        new RegExp(`${OPENING_QTY} bottle\\(s\\) on hand, ${OPENING_QTY + 1} requested`),
      );
      const { rows } = await db.query(`SELECT 1 FROM bill_items WHERE bill_id = $1`, [bill.id]);
      expect(rows).toEqual([]);
      expect(await onHand(db, fx.sku.half)).toBe(OPENING_QTY);

      // Exactly the remaining stock is fine; then the SKU is sold out.
      await billing.addItemToBill(bill.id, fx.sku.half, OPENING_QTY);
      await expectPosError(billing.addItemToBill(bill.id, fx.sku.half, 1), PosErrorCode.INSUFFICIENT_STOCK);
    });

    it('rejects non-whole or non-positive quantities, and unknown bills / SKUs', async () => {
      const { fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      for (const qty of [0, -1, 1.5, Number.NaN]) {
        await expect(billing.addItemToBill(bill.id, fx.sku.full, qty)).rejects.toBeInstanceOf(RangeError);
      }
      await expect(billing.addItemToBill(bill.id, '00000000-0000-7000-8000-000000000000', 1)).rejects.toBeInstanceOf(NotFoundError);
      await expect(billing.addItemToBill('00000000-0000-7000-8000-000000000000', fx.sku.full, 1)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rejects items on a settled bill (PS001)', async () => {
      const { fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.quarter, 1);
      await billing.settleNormalBill(bill.id, [{ mode: 'CASH', amount: PAISE.quarter }]);
      await expectPosError(billing.addItemToBill(bill.id, fx.sku.quarter, 1), PosErrorCode.APPEND_ONLY, /SETTLED/);
    });
  });

  describe('settleNormalBill', () => {
    it('commits split CASH + UPI tenders and freezes the bill', async () => {
      const { fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.half, 2); // 240,000

      const { bill: settled, payments } = await billing.settleNormalBill(bill.id, [
        { mode: 'CASH', amount: 100_000n },
        { mode: 'UPI', amount: 140_000n },
      ]);
      expect(settled).toMatchObject({ status: 'SETTLED', totalPaise: 240_000n, settledByStaffId: fx.cashier });
      expect(settled.settledAt).toBeInstanceOf(Date);
      expect(payments.map((p) => [p.tender, p.amountPaise])).toEqual([
        ['CASH', 100_000n],
        ['UPI', 140_000n],
      ]);

      await expectPosError(billing.settleNormalBill(bill.id, [{ mode: 'CASH', amount: 1n }]), PosErrorCode.APPEND_ONLY, /frozen/);
    });

    it('rejects under- and over-payment atomically (PS005), recording nothing', async () => {
      const { db, fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.half, 1); // 120,000

      await expectPosError(
        billing.settleNormalBill(bill.id, [{ mode: 'CASH', amount: 119_999n }]),
        PosErrorCode.TENDER_MISMATCH,
        /payments total 119999 paise, amount due 120000 paise/,
      );
      await expectPosError(
        billing.settleNormalBill(bill.id, [
          { mode: 'CASH', amount: 100_000n },
          { mode: 'UPI', amount: 20_001n },
        ]),
        PosErrorCode.TENDER_MISMATCH,
      );
      const { rows } = await db.query(`SELECT 1 FROM bill_payments WHERE bill_id = $1`, [bill.id]);
      expect(rows).toEqual([]);
      expect((await billing.settleNormalBill(bill.id, [{ mode: 'UPI', amount: 120_000n }])).bill.status).toBe('SETTLED');
    });

    it('accepts bigint paise only, and only CASH / UPI', async () => {
      const { fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.half, 1);

      const asAny = (payments: unknown) => billing.settleNormalBill(bill.id, payments as never);
      await expect(asAny([{ mode: 'CASH', amount: 120_000 }])).rejects.toBeInstanceOf(TypeError);
      await expect(asAny([{ mode: 'CASH', amount: 0n }])).rejects.toBeInstanceOf(RangeError);
      await expect(asAny([{ mode: 'CASH', amount: -1n }])).rejects.toBeInstanceOf(RangeError);
      await expect(asAny([{ mode: 'WAITER_CREDIT', amount: 120_000n }])).rejects.toBeInstanceOf(RangeError);
    });

    it('rejects tenders on a peak bill (PS005)', async () => {
      const { fx, billing, peak } = setup();
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      const { bill } = await billing.recordPeakSale(session.id, fx.sku.half, 1, fx.cashier);
      await expectPosError(
        billing.settleNormalBill(bill.id, [{ mode: 'CASH', amount: PAISE.half }]),
        PosErrorCode.TENDER_MISMATCH,
        /peak bills take no tenders/,
      );
    });
  });

  describe('closeEmptyBill', () => {
    it('settles a bill whose lines were all cancelled, with no tenders, restoring stock', async () => {
      const { db, fx, billing, waiters } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await waiters.tagBillToWaiter(bill.id, fx.waiter.untrusted);
      const { item } = await billing.addItemToBill(bill.id, fx.sku.full, 2);
      await cancelItem(db, bill.id, item.id, 2);

      const closed = await billing.closeEmptyBill(bill.id);
      expect(closed).toMatchObject({ status: 'SETTLED', totalPaise: 0n, settledByStaffId: fx.cashier });
      expect(closed.settledAt).toBeInstanceOf(Date);
      const { rows } = await db.query(`SELECT 1 FROM bill_payments WHERE bill_id = $1`, [bill.id]);
      expect(rows).toEqual([]);
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY);

      // Frozen like any settled bill.
      await expectPosError(billing.addItemToBill(bill.id, fx.sku.full, 1), PosErrorCode.APPEND_ONLY);
      await expectPosError(billing.closeEmptyBill(bill.id), PosErrorCode.APPEND_ONLY, /frozen/);
    });

    it('settles a bill that never had any lines', async () => {
      const { fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      expect((await billing.closeEmptyBill(bill.id)).status).toBe('SETTLED');
    });

    it('refuses a bill with anything on it (PS005), leaving it open', async () => {
      const { db, fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const { item } = await billing.addItemToBill(bill.id, fx.sku.half, 2);
      await cancelItem(db, bill.id, item.id, 1); // one Half still on the bill

      await expectPosError(billing.closeEmptyBill(bill.id), PosErrorCode.TENDER_MISMATCH, /total 120000 paise/);
      const { bill: still } = await billing.addItemToBill(bill.id, fx.sku.quarter, 1);
      expect(still.status).toBe('OPEN');
    });

    it('refuses peak bills (PS002) and unknown bills', async () => {
      const { fx, billing, peak } = setup();
      await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      const peakBill = await billing.createBill('PEAK', fx.cashier);
      await expectPosError(billing.closeEmptyBill(peakBill.id), PosErrorCode.ILLEGAL_TRANSITION, /session ends/);
      await expect(billing.closeEmptyBill('00000000-0000-7000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('recordPeakSale', () => {
    it('appends an unsettled one-line bill to the running session, with no payment step', async () => {
      const { db, fx, billing, peak } = setup();
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);

      const { bill, item } = await billing.recordPeakSale(session.id, fx.sku.beer650, 4, fx.cashier);
      expect(bill).toMatchObject({
        mode: 'PEAK',
        status: 'PEAK_UNSETTLED',
        peakSessionId: session.id,
        totalPaise: 4n * PAISE.beer650,
        createdByStaffId: fx.cashier,
      });
      expect(item).toMatchObject({ quantity: 4, lineTotalPaise: 4n * PAISE.beer650 });
      expect(await onHand(db, fx.sku.beer650)).toBe(OPENING_QTY - 4);
      const { rows } = await db.query(`SELECT 1 FROM bill_payments WHERE bill_id = $1`, [bill.id]);
      expect(rows).toEqual([]);
    });

    it('rejects a session that is not the running one (PS007)', async () => {
      const { fx, billing, peak } = setup();
      const first = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      await peak.endPeakSession(first.id, 0n, 0n, fx.cashier);
      await expectPosError(billing.recordPeakSale(first.id, fx.sku.half, 1, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE);

      await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      await expectPosError(
        billing.recordPeakSale(first.id, fx.sku.half, 1, fx.cashier),
        PosErrorCode.DAY_OR_PEAK_RULE,
        /running peak session/,
      );
    });

    it('checks stock before creating the bill (PS003), leaving no empty bill behind', async () => {
      const { db, fx, billing, peak } = setup();
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      await expectPosError(
        billing.recordPeakSale(session.id, fx.sku.full, OPENING_QTY + 1, fx.cashier),
        PosErrorCode.INSUFFICIENT_STOCK,
      );
      const { rows } = await db.query(`SELECT 1 FROM bills WHERE peak_session_id = $1`, [session.id]);
      expect(rows).toEqual([]);
    });
  });

  describe('reverseBill', () => {
    it('creates a linked, settled reversal with negated lines and refunds, restoring stock', async () => {
      const { db, fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.half, 2);
      const { bill: original } = await billing.settleNormalBill(bill.id, [{ mode: 'CASH', amount: 240_000n }]);

      const { reversal, refunds } = await billing.reverseBill(original.id, 'wrong brand', fx.manager);
      expect(reversal).toMatchObject({
        kind: 'REVERSAL',
        mode: 'NORMAL',
        status: 'SETTLED',
        reversesBillId: original.id,
        reversalReason: 'wrong brand',
        totalPaise: -240_000n,
        createdByStaffId: fx.manager,
      });
      expect(refunds.map((r) => [r.tender, r.amountPaise])).toEqual([['CASH', -240_000n]]);
      expect(refunds[0]?.reversesPaymentId).not.toBeNull();
      expect(await onHand(db, fx.sku.half)).toBe(OPENING_QTY);

      const unchanged = await one<{ status: string; total_paise: number }>(db, `SELECT status, total_paise FROM bills WHERE id = $1`, [
        original.id,
      ]);
      expect(unchanged).toEqual({ status: 'SETTLED', total_paise: 240_000 });
    });

    it('can leave stock out when the bottle was not returned sealed', async () => {
      const { db, fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.full, 1);
      await billing.settleNormalBill(bill.id, [{ mode: 'UPI', amount: PAISE.full }]);
      await billing.reverseBill(bill.id, 'opened at table, refused', fx.manager, { restock: false });
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY - 1);
    });

    it('maps rule violations to PS006: double void, voiding a reversal, voiding an open bill', async () => {
      const { fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.quarter, 1);
      await billing.settleNormalBill(bill.id, [{ mode: 'CASH', amount: PAISE.quarter }]);
      const { reversal } = await billing.reverseBill(bill.id, 'duplicate', fx.manager);

      const twice = await expectPosError(billing.reverseBill(bill.id, 'again', fx.manager), PosErrorCode.REVERSAL_RULE);
      expect(twice.constraint).toBe('bills_reverses_unique');
      await expectPosError(billing.reverseBill(reversal.id, 'undo', fx.manager), PosErrorCode.REVERSAL_RULE, /cannot itself be reversed/);

      const open = await billing.createBill('NORMAL', fx.cashier);
      await expectPosError(billing.reverseBill(open.id, 'nope', fx.manager), PosErrorCode.REVERSAL_RULE, /line cancellations/);
      await expect(billing.reverseBill(open.id, '  ', fx.manager)).rejects.toBeInstanceOf(RangeError);
    });

    it('reverses an unsettled peak bill inside the session without tenders', async () => {
      const { fx, billing, peak } = setup();
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      const { bill } = await billing.recordPeakSale(session.id, fx.sku.quarter, 1, fx.cashier);

      const { reversal, refunds } = await billing.reverseBill(bill.id, 'scanned twice', fx.cashier);
      expect(reversal).toMatchObject({ mode: 'PEAK', status: 'PEAK_UNSETTLED', peakSessionId: session.id, totalPaise: -PAISE.quarter });
      expect(refunds).toEqual([]);

      const { session: ended } = await peak.endPeakSession(session.id, 0n, 0n, fx.cashier);
      expect(ended).toMatchObject({ expectedPaise: 0n, variancePaise: 0n });
    });

    it('refunds a reconciled peak bill as a cash outflow', async () => {
      const { fx, billing, peak } = setup();
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      const { bill } = await billing.recordPeakSale(session.id, fx.sku.full, 1, fx.cashier);
      await peak.endPeakSession(session.id, PAISE.full, 0n, fx.cashier);

      const { reversal, refunds } = await billing.reverseBill(bill.id, 'customer returned sealed', fx.manager, { peakRefundTender: 'UPI' });
      expect(reversal).toMatchObject({ mode: 'NORMAL', status: 'SETTLED', totalPaise: -PAISE.full });
      expect(refunds.map((r) => [r.tender, r.amountPaise, r.reversesPaymentId])).toEqual([['UPI', -PAISE.full, null]]);
    });

    it('reverses unpaid waiter credit off the account, and refunds already-repaid credit in cash', async () => {
      const { db, fx, billing, waiters } = setup();

      const sale = async () => {
        const bill = await billing.createBill('NORMAL', fx.cashier);
        await waiters.tagBillToWaiter(bill.id, fx.waiter.trusted);
        await billing.addItemToBill(bill.id, fx.sku.half, 2); // 240,000
        await waiters.settleWaiterBill(bill.id, fx.waiter.trusted, 'CASH', 150_000n);
        await waiters.settleWaiterBill(bill.id, fx.waiter.trusted, 'WAITER_CREDIT'); // 90,000
        return bill.id;
      };

      // Still owed → the credit comes back off the waiter account.
      const unpaid = await sale();
      const first = await billing.reverseBill(unpaid, 'table cancelled', fx.manager);
      expect(first.refunds.map((r) => [r.tender, r.amountPaise])).toEqual([
        ['CASH', -150_000n],
        ['WAITER_CREDIT', -90_000n],
      ]);
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(0);

      // Already repaid → the account can't go negative, so the waiter gets that money back in cash.
      const repaid = await sale();
      await waiters.recordWaiterRepayment(fx.waiter.trusted, 90_000n, 'UPI', fx.cashier);
      const second = await billing.reverseBill(repaid, 'table cancelled', fx.manager);
      expect(second.refunds.map((r) => [r.tender, r.amountPaise])).toEqual([
        ['CASH', -150_000n],
        ['CASH', -90_000n],
      ]);
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(0);
    });
  });
});
