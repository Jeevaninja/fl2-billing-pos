import { describe, expect, it } from 'vitest';
import { NotFoundError, PosErrorCode } from '../../src/db/errors.js';
import { useSeededDb } from '../support/db.js';
import { OPENING_QTY } from '../support/fixtures.js';
import { one, onHand } from '../support/pos.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

describe('BillingService open-bill edits', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, ...makeServices(db) };
  };
  const addMember = async (db: ReturnType<typeof ctx>['db'], no: string, active = true) =>
    (
      await one<{ id: string }>(
        db,
        `INSERT INTO members (membership_no, display_name, is_active) VALUES ($1, $2, $3) RETURNING id`,
        [no, `Member ${no}`, active],
      )
    ).id;

  describe('setBillMember', () => {
    it('attaches, swaps and clears the member on an open bill, keeping lines and total', async () => {
      const { db, fx, billing } = setup();
      const a = await addMember(db, 'M-001');
      const b = await addMember(db, 'M-002');
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.half, 1);

      expect(await billing.setBillMember(bill.id, a)).toMatchObject({ memberId: a, totalPaise: PAISE.half, status: 'OPEN' });
      expect((await billing.setBillMember(bill.id, b)).memberId).toBe(b);
      expect((await billing.setBillMember(bill.id, null)).memberId).toBeNull();
    });

    it('rejects a missing member (NotFoundError) and an inactive member (PS002)', async () => {
      const { db, fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await expect(billing.setBillMember(bill.id, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
      const inactive = await addMember(db, 'M-OLD', false);
      await expectPosError(billing.setBillMember(bill.id, inactive), PosErrorCode.ILLEGAL_TRANSITION, /inactive/);
    });

    it('rejects a missing bill, a settled bill (PS001) and a peak bill (PS002)', async () => {
      const { db, fx, billing, peak } = setup();
      const member = await addMember(db, 'M-001');
      await expect(billing.setBillMember('00000000-0000-0000-0000-000000000000', member)).rejects.toBeInstanceOf(NotFoundError);

      const settled = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(settled.id, fx.sku.quarter, 1);
      await billing.settleNormalBill(settled.id, [{ mode: 'CASH', amount: PAISE.quarter }]);
      await expectPosError(billing.setBillMember(settled.id, member), PosErrorCode.APPEND_ONLY, /frozen/);

      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      const { bill: peakBill } = await billing.recordPeakSale(session.id, fx.sku.beer330, 1, fx.cashier);
      await expectPosError(billing.setBillMember(peakBill.id, member), PosErrorCode.ILLEGAL_TRANSITION, /peak/);
    });
  });

  describe('cancelBillItem', () => {
    it('appends a negative line, lowers the total and restocks by default', async () => {
      const { db, fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const { item } = await billing.addItemToBill(bill.id, fx.sku.full, 3);
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY - 3);

      const { item: cancel, bill: updated } = await billing.cancelBillItem(bill.id, item.id, 1);
      expect(cancel).toMatchObject({
        quantity: -1,
        reversesItemId: item.id,
        skuId: fx.sku.full,
        unitPricePaise: PAISE.full,
        lineTotalPaise: -PAISE.full,
        restock: true,
        lineNo: 2,
      });
      expect(updated.totalPaise).toBe(2n * PAISE.full);
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY - 2);

      // The original line is untouched (append-only).
      const original = await one<{ qty: number }>(db, `SELECT qty FROM bill_items WHERE id = $1`, [item.id]);
      expect(original.qty).toBe(3);
    });

    it('can leave an opened bottle out of stock with restock: false', async () => {
      const { db, fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const { item } = await billing.addItemToBill(bill.id, fx.sku.beer650, 2);
      const { item: cancel } = await billing.cancelBillItem(bill.id, item.id, 1, { restock: false });
      expect(cancel.restock).toBe(false);
      expect(await onHand(db, fx.sku.beer650)).toBe(OPENING_QTY - 2);
    });

    it('cancelling every bottle leaves a ₹0 bill that closeEmptyBill can close', async () => {
      const { fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const { item } = await billing.addItemToBill(bill.id, fx.sku.quarter, 2);
      await billing.cancelBillItem(bill.id, item.id, 1);
      const { bill: empty } = await billing.cancelBillItem(bill.id, item.id, 1);
      expect(empty.totalPaise).toBe(0n);
      expect((await billing.closeEmptyBill(bill.id)).status).toBe('SETTLED');
    });

    it('refuses to cancel more bottles than remain on the line (PS006)', async () => {
      const { fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const { item } = await billing.addItemToBill(bill.id, fx.sku.half, 2);
      await billing.cancelBillItem(bill.id, item.id, 1);
      await expectPosError(billing.cancelBillItem(bill.id, item.id, 2), PosErrorCode.REVERSAL_RULE, /only 1 remain/);
    });

    it('refuses a cancellation line or a line from another bill (PS006)', async () => {
      const { fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const other = await billing.createBill('NORMAL', fx.cashier);
      const { item } = await billing.addItemToBill(bill.id, fx.sku.half, 2);
      const { item: otherItem } = await billing.addItemToBill(other.id, fx.sku.half, 1);
      const { item: cancel } = await billing.cancelBillItem(bill.id, item.id, 1);

      await expectPosError(billing.cancelBillItem(bill.id, cancel.id, 1), PosErrorCode.REVERSAL_RULE, /only positive lines/);
      await expectPosError(billing.cancelBillItem(bill.id, otherItem.id, 1), PosErrorCode.REVERSAL_RULE, /same bill/);
    });

    it('validates arguments and missing rows', async () => {
      const { fx, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const { item } = await billing.addItemToBill(bill.id, fx.sku.half, 1);
      await expect(billing.cancelBillItem(bill.id, item.id, 0)).rejects.toBeInstanceOf(RangeError);
      await expect(billing.cancelBillItem(bill.id, item.id, 1.5)).rejects.toBeInstanceOf(RangeError);
      await expect(billing.cancelBillItem(bill.id, '00000000-0000-0000-0000-000000000000', 1)).rejects.toBeInstanceOf(NotFoundError);
      await expect(billing.cancelBillItem('00000000-0000-0000-0000-000000000000', item.id, 1)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('is closed once a tender is recorded (trusted-waiter partial payment)', async () => {
      const { fx, billing, waiters } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const { item } = await billing.addItemToBill(bill.id, fx.sku.full, 1);
      await waiters.tagBillToWaiter(bill.id, fx.waiter.trusted);
      await waiters.settleWaiterBill(bill.id, fx.waiter.trusted, 'CASH', 100_00n);

      await expectPosError(billing.cancelBillItem(bill.id, item.id, 1), PosErrorCode.ILLEGAL_TRANSITION, /tender/);
    });

    it('is closed on settled bills (PS001) and peak bills (PS002, use reverseBill)', async () => {
      const { fx, billing, peak } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const { item } = await billing.addItemToBill(bill.id, fx.sku.quarter, 1);
      await billing.settleNormalBill(bill.id, [{ mode: 'UPI', amount: PAISE.quarter }]);
      await expectPosError(billing.cancelBillItem(bill.id, item.id, 1), PosErrorCode.APPEND_ONLY, /frozen/);

      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      const sale = await billing.recordPeakSale(session.id, fx.sku.beer330, 1, fx.cashier);
      await expectPosError(billing.cancelBillItem(sale.bill.id, sale.item.id, 1), PosErrorCode.ILLEGAL_TRANSITION, /reverseBill/);
    });
  });
});
