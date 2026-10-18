import type { SqlClient, SqlDatabase } from '../db/client.js';
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

/** Mode A: several whole bills paid off at once. */
export interface WaiterBillsSettlement {
  bills: Bill[];
  /** Σ amounts paid (each bill's exact due). */
  totalPaise: Paise;
  /** What the waiter still owes afterwards: open-bill dues + credit balance. */
  balancePaise: Paise;
}

/** Where one slice of a lump sum went. */
export type ReceiptAllocation =
  | { kind: 'BILL'; billId: string; billNo: number; amountPaise: Paise; settled: boolean; remainingDuePaise: Paise }
  | { kind: 'CREDIT'; amountPaise: Paise };

/** Mode B: money handed in without naming bills, spread oldest open bill first, then onto the credit balance. */
export interface WaiterReceipt {
  tender: CounterTender;
  amountPaise: Paise;
  allocations: ReceiptAllocation[];
  balancePaise: Paise;
}

interface OpenDue {
  id: string;
  bill_no: number;
  due: DbInt;
}

const WAITER_TENDERS: ReadonlySet<string> = new Set<Tender>(['CASH', 'UPI', 'WAITER_CREDIT']);

/** Locks the waiter row (serialising every money movement for them) and returns it. */
async function lockWaiter(tx: SqlClient, waiterId: string): Promise<{ waiter_code: string; is_trusted: boolean; outstanding_balance: DbInt }> {
  const waiter = await maybeOne<{ waiter_code: string; is_trusted: boolean; outstanding_balance: DbInt }>(
    tx,
    `SELECT waiter_code, is_trusted, outstanding_balance::text FROM waiters WHERE id = $1 FOR UPDATE`,
    [waiterId],
  );
  if (!waiter) throw new NotFoundError('waiter', waiterId);
  return waiter;
}

/** The waiter's OPEN sale bills with what is still due, oldest first. */
async function openDues(tx: SqlClient, waiterId: string): Promise<OpenDue[]> {
  const { rows } = await tx.query<OpenDue>(
    `SELECT b.id, b.bill_no,
            (b.total_paise - coalesce((SELECT sum(p.amount_paise) FROM bill_payments p WHERE p.bill_id = b.id), 0))::text AS due
       FROM bills b
      WHERE b.waiter_id = $1 AND b.status = 'OPEN' AND b.bill_kind = 'SALE'
      ORDER BY b.created_at, b.bill_no`,
    [waiterId],
  );
  return rows;
}

/** Open-bill dues + credit balance: everything the waiter owes the house. */
async function waiterBalance(tx: SqlClient, waiterId: string): Promise<Paise> {
  const row = await one<{ balance: DbInt }>(
    tx,
    `SELECT (w.outstanding_balance + coalesce((
              SELECT sum(b.total_paise - coalesce((SELECT sum(p.amount_paise) FROM bill_payments p WHERE p.bill_id = b.id), 0))
                FROM bills b WHERE b.waiter_id = w.id AND b.status = 'OPEN' AND b.bill_kind = 'SALE'), 0))::text AS balance
       FROM waiters w WHERE w.id = $1`,
    [waiterId],
  );
  return toPaise(row.balance);
}

async function requireOpenDay(tx: SqlClient): Promise<void> {
  const day = await maybeOne(tx, `SELECT 1 FROM business_days WHERE status = 'OPEN'`);
  if (!day) throw new PosError(PosErrorCode.DAY_OR_PEAK_RULE, 'no business day is open');
}

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

  /**
   * Mode A: pays off the chosen bills, each for exactly what is still due, with one tender. All or
   * nothing: a bill that is not this waiter's (PS002) or no longer open (PS001) rolls every bill back.
   * WAITER_CREDIT (collect later) is for trusted waiters only (PS004); whole bills suit untrusted waiters.
   */
  async settleWaiterBills(waiterId: string, billIds: readonly string[], tender: Tender, staffId: string): Promise<WaiterBillsSettlement> {
    if (!WAITER_TENDERS.has(tender)) throw new RangeError(`tender must be CASH, UPI or WAITER_CREDIT, got ${String(tender)}`);
    if (billIds.length === 0) throw new RangeError('choose at least one bill');
    if (new Set(billIds).size !== billIds.length) throw new RangeError('a bill is listed twice');

    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await requireOpenDay(tx);
        const waiter = await lockWaiter(tx, waiterId);
        if (tender === 'WAITER_CREDIT' && !waiter.is_trusted) {
          throw new PosError(
            PosErrorCode.CREDIT_NOT_ALLOWED,
            `waiter ${waiter.waiter_code} is not trusted: bill-on-bill settlement only, no collect-later credit`,
          );
        }

        const bills: Bill[] = [];
        let totalPaise = 0n;
        for (const billId of billIds) {
          const bill = await getBill(tx, billId, { forUpdate: true });
          if (bill.waiterId !== waiterId) {
            throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `bill ${bill.billNo} is not tagged to waiter ${waiter.waiter_code}`);
          }
          if (bill.status !== 'OPEN') {
            throw new PosError(PosErrorCode.APPEND_ONLY, `bill ${bill.billNo} is ${bill.status} and frozen`);
          }
          const due = bill.totalPaise - (await tenderedPaise(tx, billId));
          if (due > 0n) await insertPayment(tx, billId, tender, due, null, staffId);
          bills.push(await settle(tx, billId, staffId));
          totalPaise += due;
        }
        bills.sort((a, b) => a.billNo - b.billNo);
        return { bills, totalPaise, balancePaise: await waiterBalance(tx, waiterId) };
      }),
    );
  }

  /**
   * Mode B (trusted waiters only, PS004): a lump sum handed in without naming bills. It pays the
   * oldest open bill first, settling each one it covers and part-paying the next; anything left
   * repays the credit balance. More than the waiter owes is refused (PS008), so the house never owes
   * change. The money still lands on bills as CASH / UPI tenders, so sales and drawer figures stay right.
   */
  async receiveWaiterPayment(waiterId: string, amount: Paise, tender: CounterTender, staffId: string): Promise<WaiterReceipt> {
    assertPaise(amount, 'amount');
    if (tender !== 'CASH' && tender !== 'UPI') throw new RangeError(`tender must be CASH or UPI, got ${String(tender)}`);

    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await requireOpenDay(tx);
        const waiter = await lockWaiter(tx, waiterId);
        if (!waiter.is_trusted) {
          throw new PosError(
            PosErrorCode.CREDIT_NOT_ALLOWED,
            `waiter ${waiter.waiter_code} is not trusted: bill-on-bill only — settle whole bills instead of a lump sum`,
          );
        }
        const dues = await openDues(tx, waiterId);
        const credit = toPaise(waiter.outstanding_balance);
        const owed = dues.reduce((sum, d) => sum + toPaise(d.due), 0n) + credit;
        if (amount > owed) {
          throw new PosError(PosErrorCode.WAITER_BALANCE, `waiter ${waiter.waiter_code} owes only ${owed} paise; received ${amount} paise`);
        }

        const allocations: ReceiptAllocation[] = [];
        let left = amount;
        for (const d of dues) {
          if (left === 0n) break;
          const due = toPaise(d.due);
          if (due <= 0n) continue;
          const paying = left < due ? left : due;
          await insertPayment(tx, d.id, tender, paying, null, staffId);
          const settled = paying === due;
          if (settled) await settle(tx, d.id, staffId);
          allocations.push({ kind: 'BILL', billId: d.id, billNo: d.bill_no, amountPaise: paying, settled, remainingDuePaise: due - paying });
          left -= paying;
        }
        if (left > 0n) {
          await tx.query(
            `INSERT INTO waiter_payments (waiter_id, tender_type, amount_paise, received_by_staff_id) VALUES ($1, $2, $3, $4)`,
            [waiterId, tender, paiseParam(left), staffId],
          );
          allocations.push({ kind: 'CREDIT', amountPaise: left });
        }
        return { tender, amountPaise: amount, allocations, balancePaise: owed - amount };
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
