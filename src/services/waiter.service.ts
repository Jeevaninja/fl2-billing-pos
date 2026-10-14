import type { SqlDatabase } from '../db/client.js';
import { NotFoundError, PosError, PosErrorCode, withPosErrors } from '../db/errors.js';
import { assertPaise, type DbInt, type Paise, paiseParam, toPaise } from '../domain/money.js';
import type { Bill, BillPayment, CounterTender, Tender, WaiterPayment } from '../domain/types.js';
import { insertPayment, settle } from './billing.service.js';
import { type BillRow, getBill, mapBill, mapWaiterPayment, maybeOne, one, tenderedPaise, type WaiterPaymentRow } from './rows.js';

export interface WaiterSettlement {
  bill: Bill;
  payment: BillPayment;
  /** Still owed on the bill after this payment; 0n once the bill is SETTLED. */
  remainingDuePaise: Paise;
}

export interface WaiterRepayment {
  payment: WaiterPayment;
  /** The waiter's outstanding balance after the repayment. */
  outstandingPaise: Paise;
}

const WAITER_TENDERS: ReadonlySet<string> = new Set<Tender>(['CASH', 'UPI', 'WAITER_CREDIT']);

export class WaiterService {
  constructor(private readonly db: SqlDatabase) {}

  /** Tags (or re-tags) an open NORMAL bill to a waiter. Allowed only until the bill's first tender. */
  async tagBillToWaiter(billId: string, waiterId: string): Promise<Bill> {
    return withPosErrors(async () => {
      const row = await maybeOne<BillRow>(this.db, `UPDATE bills SET waiter_id = $2 WHERE id = $1 RETURNING *`, [billId, waiterId]);
      if (!row) throw new NotFoundError('bill', billId);
      return mapBill(row);
    });
  }

  /**
   * Takes payment from a waiter for a bill tagged to them.
   *
   * - `amount` defaults to the full amount still due; the bill settles once nothing is due.
   * - Trusted waiters may pay part now (bill stays OPEN) and put any part on WAITER_CREDIT.
   * - Untrusted waiters are bill-on-bill: WAITER_CREDIT is blocked (PS004) and a payment must
   *   cover the exact amount due (PS005).
   */
  async settleWaiterBill(billId: string, waiterId: string, paymentMode: Tender, amount?: Paise): Promise<WaiterSettlement> {
    if (!WAITER_TENDERS.has(paymentMode)) throw new RangeError(`paymentMode must be CASH, UPI or WAITER_CREDIT, got ${String(paymentMode)}`);
    if (amount !== undefined) assertPaise(amount, 'amount');

    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const bill = await getBill(tx, billId, { forUpdate: true });
        if (bill.waiterId !== waiterId) {
          throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `bill ${bill.billNo} is not tagged to waiter ${waiterId}`);
        }
        if (bill.status !== 'OPEN') {
          throw new PosError(PosErrorCode.APPEND_ONLY, `bill ${bill.billNo} is ${bill.status} and frozen`);
        }

        const waiter = await maybeOne<{ waiter_code: string; is_trusted: boolean }>(
          tx,
          `SELECT waiter_code, is_trusted FROM waiters WHERE id = $1`,
          [waiterId],
        );
        if (!waiter) throw new NotFoundError('waiter', waiterId);

        if (paymentMode === 'WAITER_CREDIT' && !waiter.is_trusted) {
          throw new PosError(
            PosErrorCode.CREDIT_NOT_ALLOWED,
            `waiter ${waiter.waiter_code} is not trusted: bill-on-bill settlement only, no collect-later credit`,
          );
        }

        const due = bill.totalPaise - (await tenderedPaise(tx, billId));
        if (due <= 0n) {
          throw new PosError(PosErrorCode.TENDER_MISMATCH, `bill ${bill.billNo} has nothing due`);
        }
        const paying = amount ?? due;
        if (paying > due) {
          throw new PosError(
            PosErrorCode.TENDER_MISMATCH,
            `payment of ${paying} paise exceeds ${due} paise due on bill ${bill.billNo}`,
          );
        }
        if (paying < due && !waiter.is_trusted) {
          throw new PosError(
            PosErrorCode.TENDER_MISMATCH,
            `waiter ${waiter.waiter_code} is bill-on-bill: bill ${bill.billNo} must be settled for exactly ${due} paise`,
          );
        }

        const payment = await insertPayment(tx, billId, paymentMode, paying, null, null);
        const remainingDuePaise = due - paying;
        const updated = remainingDuePaise === 0n ? await settle(tx, billId, null) : await getBill(tx, billId);
        return { bill: updated, payment, remainingDuePaise };
      }),
    );
  }

  /** Cash/UPI handed in against the waiter's running account. Overpayment is rejected (PS008). */
  async recordWaiterRepayment(waiterId: string, amount: Paise, mode: CounterTender, staffId: string): Promise<WaiterRepayment> {
    assertPaise(amount, 'amount');
    if (mode !== 'CASH' && mode !== 'UPI') throw new RangeError(`mode must be CASH or UPI, got ${String(mode)}`);

    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const exists = await maybeOne(tx, `SELECT 1 FROM waiters WHERE id = $1`, [waiterId]);
        if (!exists) throw new NotFoundError('waiter', waiterId);

        const payment = mapWaiterPayment(
          await one<WaiterPaymentRow>(
            tx,
            `INSERT INTO waiter_payments (waiter_id, tender_type, amount_paise, received_by_staff_id)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [waiterId, mode, paiseParam(amount), staffId],
          ),
        );
        const ledger = await one<{ balance_after_paise: DbInt }>(
          tx,
          `SELECT balance_after_paise::text FROM waiter_ledger_entries WHERE waiter_payment_id = $1`,
          [payment.id],
        );
        return { payment, outstandingPaise: toPaise(ledger.balance_after_paise) };
      }),
    );
  }
}
