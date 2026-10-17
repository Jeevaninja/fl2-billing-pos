import type { SqlClient, SqlDatabase } from '../db/client.js';
import { NotFoundError, PosError, PosErrorCode, withPosErrors } from '../db/errors.js';
import { assertPaise, assertQuantity, type Paise, paiseParam } from '../domain/money.js';
import type { Bill, BillingMode, BillItem, BillPayment, CounterTender, SizeCode, Tender } from '../domain/types.js';
import {
  type BillItemRow,
  type BillPaymentRow,
  type BillRow,
  getBill,
  INSERT_PAYMENT_SQL,
  mapBill,
  mapBillItem,
  mapBillPayment,
  maybeOne,
  one,
  tenderedPaise,
} from './rows.js';

export interface CounterPayment {
  mode: CounterTender;
  amount: Paise;
}

export interface BillLine {
  bill: Bill;
  item: BillItem;
}

export interface SettledBill {
  bill: Bill;
  payments: BillPayment[];
}

export interface ReverseBillOptions {
  /** Return the reversed bottles to stock (sealed bottle handed back). Default true. */
  restock?: boolean;
  /**
   * Refund tender for a collect-later portion the waiter has already repaid (the account cannot
   * go negative, so that money goes back to the waiter instead). Default CASH.
   */
  creditRefundTender?: CounterTender;
  /** Refund tender for a reconciled peak bill, which has no individual tenders to mirror. Default CASH. */
  peakRefundTender?: CounterTender;
}

export interface PeakUndoResult {
  reversal: Bill;
  /** The scan that was voided. */
  undone: { billId: string; billNo: number; sessionNo: number; displayName: string; sizeCode: SizeCode; quantity: number; totalPaise: Paise };
}

export interface ReversalResult {
  reversal: Bill;
  /** Negative tenders recorded on the reversal (empty for an in-session peak reversal). */
  refunds: BillPayment[];
}

const COUNTER_TENDERS: ReadonlySet<string> = new Set<CounterTender>(['CASH', 'UPI']);

export class BillingService {
  constructor(private readonly db: SqlDatabase) {}

  /** Opens a counter bill. NORMAL bills start OPEN; PEAK bills join the running peak session. */
  async createBill(mode: BillingMode, cashierId: string, memberId?: string): Promise<Bill> {
    return withPosErrors(async () =>
      mapBill(
        await one<BillRow>(
          this.db,
          `INSERT INTO bills (billing_mode, status, source, created_by_staff_id, member_id)
           VALUES ($1, $2, 'COUNTER', $3, $4) RETURNING *`,
          [mode, mode === 'PEAK' ? 'PEAK_UNSETTLED' : 'OPEN', cashierId, memberId ?? null],
        ),
      ),
    );
  }

  /** Adds whole bottles to an open bill after checking stock. The database re-checks under lock. */
  async addItemToBill(billId: string, skuId: string, quantity: number): Promise<BillLine> {
    assertQuantity(quantity);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const bill = await getBill(tx, billId);
        const item = await insertSaleLine(tx, bill, skuId, quantity);
        return { bill: await getBill(tx, billId), item };
      }),
    );
  }

  /** Records CASH/UPI tenders that exactly cover the bill and freezes it, atomically. */
  async settleNormalBill(billId: string, payments: readonly CounterPayment[]): Promise<SettledBill> {
    payments.forEach((p, i) => {
      if (!COUNTER_TENDERS.has(p.mode)) throw new RangeError(`payments[${i}].mode must be CASH or UPI, got ${String(p.mode)}`);
      assertPaise(p.amount, `payments[${i}].amount`);
    });
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const bill = await getBill(tx, billId, { forUpdate: true });
        if (bill.mode !== 'NORMAL') {
          throw new PosError(PosErrorCode.TENDER_MISMATCH, `bill ${bill.billNo} is a peak bill; peak bills take no tenders`);
        }
        if (bill.status !== 'OPEN') {
          throw new PosError(PosErrorCode.APPEND_ONLY, `bill ${bill.billNo} is ${bill.status} and frozen`);
        }
        const due = bill.totalPaise - (await tenderedPaise(tx, billId));
        const offered = payments.reduce((sum, p) => sum + p.amount, 0n);
        if (offered !== due) {
          throw new PosError(
            PosErrorCode.TENDER_MISMATCH,
            `bill ${bill.billNo} cannot settle: payments total ${offered} paise, amount due ${due} paise`,
          );
        }
        const recorded: BillPayment[] = [];
        for (const p of payments) {
          recorded.push(await insertPayment(tx, billId, p.mode, p.amount, null, bill.createdByStaffId));
        }
        return { bill: await settle(tx, billId, bill.createdByStaffId), payments: recorded };
      }),
    );
  }

  /**
   * Closes an open NORMAL bill whose total is exactly ₹0 (no lines, or every line cancelled) by
   * settling it with no tenders. Any amount on the bill is rejected with PS005: use a settle method.
   */
  async closeEmptyBill(billId: string): Promise<Bill> {
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const bill = await getBill(tx, billId, { forUpdate: true });
        if (bill.mode !== 'NORMAL') {
          throw new PosError(
            PosErrorCode.ILLEGAL_TRANSITION,
            `bill ${bill.billNo} is a peak bill; peak bills close when their session ends`,
          );
        }
        if (bill.status !== 'OPEN') {
          throw new PosError(PosErrorCode.APPEND_ONLY, `bill ${bill.billNo} is ${bill.status} and frozen`);
        }
        if (bill.totalPaise !== 0n) {
          throw new PosError(
            PosErrorCode.TENDER_MISMATCH,
            `bill ${bill.billNo} is not empty: total ${bill.totalPaise} paise must be settled with tenders`,
          );
        }
        return settle(tx, billId, bill.createdByStaffId);
      }),
    );
  }

  /** Attaches, swaps or clears (`null`) the member on an open NORMAL bill. Membership stays optional. */
  async setBillMember(billId: string, memberId: string | null): Promise<Bill> {
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        assertEditableNormalBill(await getBill(tx, billId, { forUpdate: true }), 'attach a member');
        if (memberId !== null) {
          const member = await maybeOne<{ membership_no: string; is_active: boolean }>(
            tx,
            `SELECT membership_no, is_active FROM members WHERE id = $1`,
            [memberId],
          );
          if (!member) throw new NotFoundError('member', memberId);
          if (!member.is_active) {
            throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `member ${member.membership_no} is inactive`);
          }
        }
        return mapBill(await one<BillRow>(tx, `UPDATE bills SET member_id = $2 WHERE id = $1 RETURNING *`, [billId, memberId]));
      }),
    );
  }

  /**
   * Cancels bottles from a line of an open NORMAL bill by appending a negative line (the original
   * line is never edited). Allowed only before the bill's first tender. `restock: false` keeps an
   * opened bottle out of stock. Peak bills are corrected with reverseBill instead.
   */
  async cancelBillItem(billId: string, itemId: string, quantity: number, options: { restock?: boolean } = {}): Promise<BillLine> {
    assertQuantity(quantity);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const bill = await getBill(tx, billId, { forUpdate: true });
        assertEditableNormalBill(bill, 'cancel lines', 'use reverseBill');
        if ((await tenderedPaise(tx, billId)) !== 0n) {
          throw new PosError(
            PosErrorCode.ILLEGAL_TRANSITION,
            `bill ${bill.billNo} already has a tender recorded; lines can no longer be cancelled`,
          );
        }
        if (!(await maybeOne(tx, `SELECT 1 FROM bill_items WHERE id = $1`, [itemId]))) throw new NotFoundError('bill item', itemId);
        const item = mapBillItem(
          await one<BillItemRow>(
            tx,
            `INSERT INTO bill_items (bill_id, reverses_item_id, qty, restock, waiter_id, created_by_staff_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [billId, itemId, -quantity, options.restock ?? true, bill.waiterId, bill.createdByStaffId],
          ),
        );
        return { bill: await getBill(tx, billId), item };
      }),
    );
  }

  /** One scan during peak: a PEAK_UNSETTLED bill with one line, attached to the running session. No payment screen. */
  async recordPeakSale(sessionId: string, skuId: string, quantity: number, cashierId: string): Promise<BillLine> {
    assertQuantity(quantity);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await assertStockAvailable(tx, skuId, quantity);
        const bill = mapBill(
          await one<BillRow>(
            tx,
            `INSERT INTO bills (billing_mode, status, source, peak_session_id, created_by_staff_id)
             VALUES ('PEAK', 'PEAK_UNSETTLED', 'COUNTER', $1, $2) RETURNING *`,
            [sessionId, cashierId],
          ),
        );
        const item = await insertSaleLine(tx, bill, skuId, quantity);
        return { bill: await getBill(tx, bill.id), item };
      }),
    );
  }

  /**
   * Voids a bill with a linked REVERSAL bill: every remaining line negated (restoring stock) and,
   * outside a running peak, every tender refunded. The original bill is never modified.
   */
  async reverseBill(billId: string, reason: string, staffId: string, options: ReverseBillOptions = {}): Promise<ReversalResult> {
    if (reason.trim() === '') throw new RangeError('a reversal reason is required');
    return withPosErrors(() => this.db.transaction((tx) => reverseInTx(tx, billId, reason, staffId, options)));
  }

  /**
   * Peak instant undo: reverses this cashier's newest peak scan in the running session that has not
   * been reversed yet (repeated calls walk back). The session row is locked first, so two fast undos
   * never pick the same bill and an undo racing the session's end is refused.
   */
  async undoLastPeakSale(cashierId: string): Promise<PeakUndoResult> {
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const session = await maybeOne<{ id: string; session_no: number }>(
          tx,
          `SELECT s.id, s.session_no FROM peak_sessions s
             JOIN business_days d ON d.id = s.business_day_id AND d.status = 'OPEN'
            WHERE s.ended_at IS NULL
            FOR UPDATE OF s`,
        );
        if (!session) throw new PosError(PosErrorCode.DAY_OR_PEAK_RULE, 'no peak session is running');

        const last = await maybeOne<{ id: string }>(
          tx,
          `SELECT b.id FROM bills b
            WHERE b.peak_session_id = $1 AND b.bill_kind = 'SALE' AND b.status = 'PEAK_UNSETTLED' AND b.created_by_staff_id = $2
              AND NOT EXISTS (SELECT 1 FROM bills r WHERE r.reverses_bill_id = b.id)
            ORDER BY b.bill_no DESC
            LIMIT 1`,
          [session.id, cashierId],
        );
        if (!last) throw new NotFoundError('peak scan to undo', `peak #${session.session_no}`);

        const original = await getBill(tx, last.id);
        const line = await one<BillItemRow>(tx, `SELECT * FROM bill_items WHERE bill_id = $1 AND qty > 0 ORDER BY line_no LIMIT 1`, [last.id]);
        const { reversal } = await reverseInTx(tx, last.id, 'Undo scan', cashierId, {});
        const item = mapBillItem(line);
        return {
          reversal,
          undone: {
            billId: original.id,
            billNo: original.billNo,
            sessionNo: session.session_no,
            displayName: item.displayName,
            sizeCode: item.sizeCode,
            quantity: item.quantity,
            totalPaise: original.totalPaise,
          },
        };
      }),
    );
  }
}

/** The body of reverseBill, inside the caller's transaction. */
async function reverseInTx(
  tx: SqlClient,
  billId: string,
  reason: string,
  staffId: string,
  options: ReverseBillOptions,
): Promise<ReversalResult> {
  const restock = options.restock ?? true;
  const original = await getBill(tx, billId, { forUpdate: true });
  const mode: BillingMode = original.status === 'PEAK_UNSETTLED' ? 'PEAK' : 'NORMAL';

  const reversal = mapBill(
    await one<BillRow>(
      tx,
      `INSERT INTO bills (bill_kind, billing_mode, status, source, reverses_bill_id, reversal_reason, created_by_staff_id)
       VALUES ('REVERSAL', $1, $2, 'COUNTER', $3, $4, $5) RETURNING *`,
      [mode, mode === 'PEAK' ? 'PEAK_UNSETTLED' : 'OPEN', billId, reason, staffId],
    ),
  );

  const { rows: lines } = await tx.query<{ id: string; remaining: number }>(
    `SELECT o.id,
            (o.qty + coalesce((SELECT sum(c.qty) FROM bill_items c WHERE c.reverses_item_id = o.id), 0))::int AS remaining
       FROM bill_items o
      WHERE o.bill_id = $1 AND o.qty > 0
      ORDER BY o.line_no`,
    [billId],
  );
  for (const line of lines) {
    if (line.remaining === 0) continue;
    await tx.query(
      `INSERT INTO bill_items (bill_id, reverses_item_id, qty, restock, created_by_staff_id) VALUES ($1, $2, $3, $4, $5)`,
      [reversal.id, line.id, -line.remaining, restock, staffId],
    );
  }

  if (mode === 'PEAK') return { reversal: await getBill(tx, reversal.id), refunds: [] };

  const refunds: BillPayment[] = [];
  if (original.mode === 'PEAK') {
    if (original.totalPaise > 0n) {
      refunds.push(await insertPayment(tx, reversal.id, options.peakRefundTender ?? 'CASH', -original.totalPaise, null, staffId));
    }
  } else {
    refunds.push(...(await refundTenders(tx, original, reversal.id, staffId, options.creditRefundTender ?? 'CASH')));
  }
  return { reversal: await settle(tx, reversal.id, staffId), refunds };
}

// ── Shared steps (run inside the caller's transaction) ───────────────────────

/** Open-bill edits apply only to OPEN NORMAL sale bills; frozen bills get PS001, peak or reversal bills PS002. */
function assertEditableNormalBill(bill: Bill, action: string, peakHint = 'peak bills are counter-only'): void {
  if (bill.mode !== 'NORMAL') {
    throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `cannot ${action} on peak bill ${bill.billNo}: ${peakHint}`);
  }
  if (bill.status !== 'OPEN') {
    throw new PosError(PosErrorCode.APPEND_ONLY, `bill ${bill.billNo} is ${bill.status} and frozen`);
  }
  if (bill.kind !== 'SALE') {
    throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `cannot ${action} on reversal bill ${bill.billNo}`);
  }
}

/** Pre-flight stock check for a friendly error before any write; the trigger re-checks under lock. */
async function assertStockAvailable(tx: SqlClient, skuId: string, quantity: number): Promise<void> {
  const stock = await maybeOne<{ sku_code: string; on_hand_qty: number }>(
    tx,
    `SELECT k.sku_code, s.on_hand_qty FROM skus k JOIN sku_stock s ON s.sku_id = k.id WHERE k.id = $1`,
    [skuId],
  );
  if (!stock) throw new NotFoundError('sku', skuId);
  if (stock.on_hand_qty < quantity) {
    throw new PosError(
      PosErrorCode.INSUFFICIENT_STOCK,
      `insufficient stock for ${stock.sku_code}: ${stock.on_hand_qty} bottle(s) on hand, ${quantity} requested`,
    );
  }
}

export async function insertSaleLine(tx: SqlClient, bill: Bill, skuId: string, quantity: number): Promise<BillItem> {
  await assertStockAvailable(tx, skuId, quantity);
  return mapBillItem(
    await one<BillItemRow>(
      tx,
      `INSERT INTO bill_items (bill_id, sku_id, qty, waiter_id, created_by_staff_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [bill.id, skuId, quantity, bill.waiterId, bill.createdByStaffId],
    ),
  );
}

export async function insertPayment(
  tx: SqlClient,
  billId: string,
  tender: Tender,
  amount: Paise,
  reversesPaymentId: string | null,
  staffId: string | null,
): Promise<BillPayment> {
  return mapBillPayment(
    await one<BillPaymentRow>(tx, INSERT_PAYMENT_SQL, [billId, tender, paiseParam(amount), reversesPaymentId, staffId]),
  );
}

export async function settle(tx: SqlClient, billId: string, staffId: string | null): Promise<Bill> {
  return mapBill(
    await one<BillRow>(tx, `UPDATE bills SET status = 'SETTLED', settled_by_staff_id = $2 WHERE id = $1 RETURNING *`, [
      billId,
      staffId,
    ]),
  );
}

/**
 * Mirrors each original tender with an exact negative. A collect-later tender goes back onto the
 * waiter account only while the waiter still owes at least that much; otherwise it is refunded
 * to the waiter in `creditRefundTender`.
 */
async function refundTenders(
  tx: SqlClient,
  original: Bill,
  reversalId: string,
  staffId: string,
  creditRefundTender: CounterTender,
): Promise<BillPayment[]> {
  const { rows } = await tx.query<BillPaymentRow>(
    `SELECT * FROM bill_payments WHERE bill_id = $1 ORDER BY created_at, id`,
    [original.id],
  );
  const payments = rows.map(mapBillPayment);

  let reversibleCredit = 0n;
  if (original.waiterId && payments.some((p) => p.tender === 'WAITER_CREDIT')) {
    const waiter = await one<{ outstanding_balance: string }>(
      tx,
      `SELECT outstanding_balance::text FROM waiters WHERE id = $1 FOR UPDATE`,
      [original.waiterId],
    );
    reversibleCredit = BigInt(waiter.outstanding_balance);
  }

  const refunds: BillPayment[] = [];
  for (const p of payments) {
    let tender: Tender = p.tender;
    if (tender === 'WAITER_CREDIT') {
      if (reversibleCredit >= p.amountPaise) reversibleCredit -= p.amountPaise;
      else tender = creditRefundTender;
    }
    refunds.push(await insertPayment(tx, reversalId, tender, -p.amountPaise, p.id, staffId));
  }
  return refunds;
}
