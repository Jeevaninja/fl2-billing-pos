/**
 * Thin SQL wrappers used by the tests. All business rules live in the database
 * (migrations/0002_core_rules.sql); these helpers only issue the statements a client would.
 */
import type { SqlClient } from '../../src/db/client.js';

export type Tender = 'CASH' | 'UPI' | 'WAITER_CREDIT';
export type BillingMode = 'NORMAL' | 'PEAK';
export type BillStatus = 'OPEN' | 'SETTLED' | 'PEAK_UNSETTLED' | 'PEAK_RECONCILED';

export interface BillRow {
  id: string;
  bill_no: number;
  bill_kind: 'SALE' | 'REVERSAL';
  billing_mode: BillingMode;
  status: BillStatus;
  source: 'COUNTER' | 'WAITER_APP';
  peak_session_id: string | null;
  waiter_id: string | null;
  waiter_trusted_at_billing: boolean | null;
  total_paise: number;
  reverses_bill_id: string | null;
  replaces_bill_id: string | null;
}

export interface BillItemRow {
  id: string;
  bill_id: string;
  line_no: number;
  sku_id: string;
  qty: number;
  unit_price_paise: number;
  line_total_paise: number;
  reverses_item_id: string | null;
  restock: boolean;
}

export interface PaymentRow {
  id: string;
  bill_id: string;
  tender_type: Tender;
  amount_paise: number;
  peak_session_id: string | null;
  reverses_payment_id: string | null;
}

export interface PeakSessionRow {
  id: string;
  session_no: number;
  peak_start_cash: number;
  peak_start_upi: number;
  peak_end_cash: number | null;
  peak_end_upi: number | null;
  peak_expected_paise: number | null;
  peak_variance_paise: number | null;
  ended_at: Date | null;
}

export async function one<T>(db: SqlClient, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<T>(sql, params);
  const row = rows[0];
  if (row === undefined) throw new Error(`expected one row from: ${sql}`);
  return row;
}

export async function inTransaction<T>(db: SqlClient, fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN');
  try {
    const result = await fn();
    await db.exec('COMMIT');
    return result;
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

// ── Bills ────────────────────────────────────────────────────────────────────

export interface OpenBillOptions {
  mode?: BillingMode;
  source?: 'COUNTER' | 'WAITER_APP';
  waiterId?: string | null;
  staffId?: string | null;
  memberId?: string | null;
  replacesBillId?: string | null;
}

export function openBill(db: SqlClient, opts: OpenBillOptions = {}): Promise<BillRow> {
  const mode = opts.mode ?? 'NORMAL';
  return one<BillRow>(
    db,
    `INSERT INTO bills (billing_mode, status, source, waiter_id, created_by_staff_id, member_id, replaces_bill_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      mode,
      mode === 'PEAK' ? 'PEAK_UNSETTLED' : 'OPEN',
      opts.source ?? (opts.waiterId ? 'WAITER_APP' : 'COUNTER'),
      opts.waiterId ?? null,
      opts.staffId ?? null,
      opts.memberId ?? null,
      opts.replacesBillId ?? null,
    ],
  );
}

export function addItem(db: SqlClient, billId: string, skuId: string, qty: number): Promise<BillItemRow> {
  return one<BillItemRow>(db, `INSERT INTO bill_items (bill_id, sku_id, qty) VALUES ($1, $2, $3) RETURNING *`, [
    billId,
    skuId,
    qty,
  ]);
}

/** Cancels `qty` bottles of a line on a still-open bill (appends a negative line). */
export function cancelItem(db: SqlClient, billId: string, itemId: string, qty: number, restock = true): Promise<BillItemRow> {
  return one<BillItemRow>(
    db,
    `INSERT INTO bill_items (bill_id, reverses_item_id, qty, restock) VALUES ($1, $2, $3, $4) RETURNING *`,
    [billId, itemId, -qty, restock],
  );
}

export function pay(
  db: SqlClient,
  billId: string,
  tender: Tender,
  amountPaise: number,
  opts: { reversesPaymentId?: string; staffId?: string } = {},
): Promise<PaymentRow> {
  return one<PaymentRow>(
    db,
    `INSERT INTO bill_payments (bill_id, tender_type, amount_paise, reverses_payment_id, received_by_staff_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [billId, tender, amountPaise, opts.reversesPaymentId ?? null, opts.staffId ?? null],
  );
}

export function settle(db: SqlClient, billId: string, staffId: string | null = null): Promise<BillRow> {
  return one<BillRow>(
    db,
    `UPDATE bills SET status = 'SETTLED', settled_by_staff_id = $2 WHERE id = $1 RETURNING *`,
    [billId, staffId],
  );
}

export function getBill(db: SqlClient, billId: string): Promise<BillRow> {
  return one<BillRow>(db, `SELECT * FROM bills WHERE id = $1`, [billId]);
}

export interface SellOptions extends OpenBillOptions {
  lines: ReadonlyArray<readonly [skuId: string, qty: number]>;
  /** NORMAL bills: tenders to record; the bill is settled when given. */
  tenders?: ReadonlyArray<readonly [Tender, number]>;
}

/** One bill, its lines and (for NORMAL mode) its tenders + settlement, in a single transaction. */
export function sell(db: SqlClient, opts: SellOptions): Promise<BillRow> {
  return inTransaction(db, async () => {
    const bill = await openBill(db, opts);
    for (const [skuId, qty] of opts.lines) await addItem(db, bill.id, skuId, qty);
    if (opts.tenders) {
      for (const [tender, amount] of opts.tenders) await pay(db, bill.id, tender, amount);
      return settle(db, bill.id, opts.staffId ?? null);
    }
    return getBill(db, bill.id);
  });
}

export interface ReverseOptions {
  reason: string;
  staffId?: string;
  restock?: boolean;
  /** Override the refund tender for specific original payments (e.g. refund waiter credit as CASH). */
  refundAs?: Readonly<Record<string, Tender>>;
  /** Refund tender for a reconciled peak bill (it has no original tenders to mirror). */
  peakRefundTender?: 'CASH' | 'UPI';
}

/**
 * Full reversal: a new REVERSAL bill that negates every remaining line of the original and,
 * in NORMAL mode, refunds every original tender. The original bill is never modified.
 */
export function reverseBill(db: SqlClient, originalId: string, opts: ReverseOptions): Promise<BillRow> {
  return inTransaction(db, async () => {
    const original = await getBill(db, originalId);
    const mode: BillingMode = original.status === 'PEAK_UNSETTLED' ? 'PEAK' : 'NORMAL';

    const reversal = await one<BillRow>(
      db,
      `INSERT INTO bills (bill_kind, billing_mode, status, source, reverses_bill_id, reversal_reason, created_by_staff_id)
       VALUES ('REVERSAL', $1, $2, 'COUNTER', $3, $4, $5) RETURNING *`,
      [mode, mode === 'PEAK' ? 'PEAK_UNSETTLED' : 'OPEN', originalId, opts.reason, opts.staffId ?? null],
    );

    const { rows: lines } = await db.query<{ id: string; remaining: number }>(
      `SELECT o.id, (o.qty + coalesce((SELECT sum(c.qty) FROM bill_items c WHERE c.reverses_item_id = o.id), 0))::int AS remaining
         FROM bill_items o
        WHERE o.bill_id = $1 AND o.qty > 0
        ORDER BY o.line_no`,
      [originalId],
    );
    for (const line of lines) {
      if (line.remaining === 0) continue;
      await db.query(`INSERT INTO bill_items (bill_id, reverses_item_id, qty, restock) VALUES ($1, $2, $3, $4)`, [
        reversal.id,
        line.id,
        -line.remaining,
        opts.restock ?? true,
      ]);
    }

    if (mode === 'PEAK') return getBill(db, reversal.id);

    if (original.billing_mode === 'PEAK') {
      if (original.total_paise > 0) await pay(db, reversal.id, opts.peakRefundTender ?? 'CASH', -original.total_paise);
    } else {
      const { rows: payments } = await db.query<PaymentRow>(
        `SELECT * FROM bill_payments WHERE bill_id = $1 ORDER BY created_at, id`,
        [originalId],
      );
      for (const p of payments) {
        await pay(db, reversal.id, opts.refundAs?.[p.id] ?? p.tender_type, -p.amount_paise, { reversesPaymentId: p.id });
      }
    }
    return settle(db, reversal.id, opts.staffId ?? null);
  });
}

// ── Peak sessions ────────────────────────────────────────────────────────────

export function startPeak(db: SqlClient, startCash: number, startUpi: number, staffId: string): Promise<PeakSessionRow> {
  return one<PeakSessionRow>(db, `SELECT * FROM pos_start_peak($1, $2, $3)`, [startCash, startUpi, staffId]);
}

export function endPeak(
  db: SqlClient,
  sessionId: string,
  endCash: number,
  endUpi: number,
  staffId: string,
): Promise<PeakSessionRow> {
  return one<PeakSessionRow>(db, `SELECT * FROM pos_end_peak($1, $2, $3, $4)`, [sessionId, endCash, endUpi, staffId]);
}

export async function runningExpected(db: SqlClient, sessionId: string): Promise<number> {
  return (
    await one<{ running_expected_paise: number }>(db, `SELECT running_expected_paise FROM v_peak_sessions WHERE id = $1`, [
      sessionId,
    ])
  ).running_expected_paise;
}

// ── Waiters & stock ──────────────────────────────────────────────────────────

export function waiterRepay(
  db: SqlClient,
  waiterId: string,
  tender: 'CASH' | 'UPI',
  amountPaise: number,
  staffId: string,
  reversesWaiterPaymentId: string | null = null,
): Promise<{ id: string; amount_paise: number; peak_session_id: string | null }> {
  return one(
    db,
    `INSERT INTO waiter_payments (waiter_id, tender_type, amount_paise, received_by_staff_id, reverses_waiter_payment_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [waiterId, tender, amountPaise, staffId, reversesWaiterPaymentId],
  );
}

export async function waiterBalance(db: SqlClient, waiterId: string): Promise<number> {
  return (await one<{ outstanding_balance: number }>(db, `SELECT outstanding_balance FROM waiters WHERE id = $1`, [waiterId]))
    .outstanding_balance;
}

export async function onHand(db: SqlClient, skuId: string): Promise<number> {
  return (await one<{ on_hand_qty: number }>(db, `SELECT on_hand_qty FROM sku_stock WHERE sku_id = $1`, [skuId])).on_hand_qty;
}
