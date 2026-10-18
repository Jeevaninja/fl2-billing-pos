/**
 * Orders screen (Phase 17): every sale bill of the open business day with a derived status, and one
 * bill in full with its settlement story. Read-only; a void (REVERSAL bill) is folded into the bill
 * it voids rather than listed on its own.
 */
import type { SqlClient } from '../db/client.js';
import { NotFoundError } from '../db/errors.js';
import { type DbInt, type Paise, toPaise } from '../domain/money.js';
import type { BillSource, SizeCode, Tender } from '../domain/types.js';
import { type BillDetail, CounterQueries } from './counter-queries.js';
import { maybeOne } from './rows.js';
import type { ReceiptTicket } from './printer.service.js';

export type OrderStatus = 'OPEN' | 'SETTLED' | 'CANCELLED' | 'VOIDED' | 'PEAK_PENDING' | 'PEAK_RECONCILED';

export interface OrderSummary {
  billId: string;
  billNo: number;
  createdAt: Date;
  settledAt: Date | null;
  status: OrderStatus;
  mode: 'NORMAL' | 'PEAK';
  source: BillSource;
  waiter: { id: string; code: string; displayName: string } | null;
  member: { membershipNo: string; displayName: string } | null;
  peakSessionId: string | null;
  peakSessionNo: number | null;
  createdByStaffId: string;
  /** Lines and bottles still on the bill after counter cancellations (a void doesn't change them). */
  lines: number;
  bottles: number;
  totalPaise: Paise;
  cashPaise: Paise;
  upiPaise: Paise;
  creditPaise: Paise;
  /** OPEN bills only: total − tendered. */
  duePaise: Paise;
  voidedAt: Date | null;
}

/** One tender on the bill; a waiter lump sum also carries the whole receipt it was part of. */
export interface OrderPayment {
  id: string;
  tender: Tender;
  amountPaise: Paise;
  at: Date;
  /** Set when this tender was one slice of a bigger waiter payment taken in one go (Waiter Ledger). */
  receiptTotalPaise: Paise | null;
}

export interface OrderDetail {
  summary: OrderSummary;
  detail: BillDetail;
  payments: OrderPayment[];
  cashier: string;
  /** How the bill was paid: by a waiter (waiter flows), at the counter, or by a peak session count. */
  settledVia: 'COUNTER' | 'WAITER' | 'PEAK' | null;
  peakSession: { sessionNo: number; endedAt: Date | null } | null;
  reversal: { billNo: number; at: Date; reason: string; refunds: Array<{ tender: Tender; amountPaise: Paise }> } | null;
}

interface OrderRow {
  id: string;
  bill_no: number;
  created_at: Date;
  settled_at: Date | null;
  status: OrderStatus;
  billing_mode: 'NORMAL' | 'PEAK';
  source: BillSource;
  waiter_id: string | null;
  waiter_code: string | null;
  waiter_name: string | null;
  membership_no: string | null;
  member_name: string | null;
  peak_session_id: string | null;
  session_no: number | null;
  created_by_staff_id: string;
  lines: number;
  bottles: number;
  total: DbInt;
  cash: DbInt;
  upi: DbInt;
  credit: DbInt;
  due: DbInt;
  voided_at: Date | null;
}

/** `$1` = the business day; `$2` = one bill id, or null for the whole day. */
const ORDERS_SQL = `
  SELECT b.id, b.bill_no, b.created_at, b.settled_at, b.billing_mode, b.source, b.created_by_staff_id, b.peak_session_id,
         CASE
           WHEN r.id IS NOT NULL THEN 'VOIDED'
           WHEN b.status = 'OPEN' THEN 'OPEN'
           WHEN b.status = 'PEAK_UNSETTLED' THEN 'PEAK_PENDING'
           WHEN b.status = 'PEAK_RECONCILED' THEN 'PEAK_RECONCILED'
           WHEN b.total_paise = 0 THEN 'CANCELLED'
           ELSE 'SETTLED'
         END AS status,
         w.waiter_code, w.display_name AS waiter_name, b.waiter_id,
         m.membership_no, m.display_name AS member_name,
         ps.session_no,
         coalesce(li.lines, 0)::int AS lines, coalesce(li.bottles, 0)::int AS bottles,
         b.total_paise::text AS total,
         coalesce(pay.cash, 0)::text AS cash, coalesce(pay.upi, 0)::text AS upi, coalesce(pay.credit, 0)::text AS credit,
         (CASE WHEN b.status = 'OPEN' THEN b.total_paise - coalesce(pay.tendered, 0) ELSE 0 END)::text AS due,
         r.created_at AS voided_at
    FROM bills b
    LEFT JOIN waiters w ON w.id = b.waiter_id
    LEFT JOIN members m ON m.id = b.member_id
    LEFT JOIN peak_sessions ps ON ps.id = b.peak_session_id
    LEFT JOIN bills r ON r.reverses_bill_id = b.id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE x.left_qty > 0) AS lines, sum(x.left_qty) AS bottles
        FROM (SELECT i.qty + coalesce((SELECT sum(c.qty) FROM bill_items c WHERE c.reverses_item_id = i.id AND c.bill_id = b.id), 0) AS left_qty
                FROM bill_items i WHERE i.bill_id = b.id AND i.qty > 0) x
    ) li ON true
    LEFT JOIN LATERAL (
      SELECT sum(p.amount_paise) FILTER (WHERE p.tender_type = 'CASH') AS cash,
             sum(p.amount_paise) FILTER (WHERE p.tender_type = 'UPI') AS upi,
             sum(p.amount_paise) FILTER (WHERE p.tender_type = 'WAITER_CREDIT') AS credit,
             sum(p.amount_paise) AS tendered
        FROM bill_payments p WHERE p.bill_id = b.id
    ) pay ON true
   WHERE b.business_day_id = $1 AND b.bill_kind = 'SALE' AND ($2::uuid IS NULL OR b.id = $2::uuid)
   ORDER BY b.created_at DESC, b.bill_no DESC`;

function mapOrder(r: OrderRow): OrderSummary {
  return {
    billId: r.id,
    billNo: r.bill_no,
    createdAt: r.created_at,
    settledAt: r.settled_at,
    status: r.status,
    mode: r.billing_mode,
    source: r.source,
    waiter: r.waiter_id && r.waiter_code && r.waiter_name ? { id: r.waiter_id, code: r.waiter_code, displayName: r.waiter_name } : null,
    member: r.membership_no && r.member_name ? { membershipNo: r.membership_no, displayName: r.member_name } : null,
    peakSessionId: r.peak_session_id,
    peakSessionNo: r.session_no,
    createdByStaffId: r.created_by_staff_id,
    lines: r.lines,
    bottles: r.bottles,
    totalPaise: toPaise(r.total),
    cashPaise: toPaise(r.cash),
    upiPaise: toPaise(r.upi),
    creditPaise: toPaise(r.credit),
    duePaise: toPaise(r.due),
    voidedAt: r.voided_at,
  };
}

export class OrdersQueries {
  private readonly counter: CounterQueries;

  constructor(private readonly db: SqlClient) {
    this.counter = new CounterQueries(db);
  }

  /** The open day's sale bills, newest first; [] when no day is open. */
  async listOrders(): Promise<OrderSummary[]> {
    const day = await maybeOne<{ id: string }>(this.db, `SELECT id FROM business_days WHERE status = 'OPEN'`);
    if (!day) return [];
    const { rows } = await this.db.query<OrderRow>(ORDERS_SQL, [day.id, null]);
    return rows.map(mapOrder);
  }

  /** One sale bill (any day) with its lines, tenders, void and peak session. */
  async getOrder(billId: string): Promise<OrderDetail> {
    const bill = await maybeOne<{ business_day_id: string; bill_kind: string }>(this.db, `SELECT business_day_id, bill_kind FROM bills WHERE id = $1`, [billId]);
    if (!bill || bill.bill_kind !== 'SALE') throw new NotFoundError('bill', billId);
    const { rows } = await this.db.query<OrderRow>(ORDERS_SQL, [bill.business_day_id, billId]);
    const row = rows[0];
    if (!row) throw new NotFoundError('bill', billId);
    const summary = mapOrder(row);
    const detail = await this.counter.getBillDetail(billId);

    // A waiter lump sum writes several rows in one transaction (same now()): sum that receipt.
    const { rows: pays } = await this.db.query<{ id: string; tender_type: Tender; amount: DbInt; created_at: Date; receipt: DbInt | null }>(
      `SELECT p.id, p.tender_type, p.amount_paise::text AS amount, p.created_at,
              CASE WHEN b.waiter_id IS NULL OR p.tender_type = 'WAITER_CREDIT' THEN NULL ELSE (
                coalesce((SELECT sum(q.amount_paise) FROM bill_payments q JOIN bills qb ON qb.id = q.bill_id
                           WHERE q.created_at = p.created_at AND q.tender_type = p.tender_type AND qb.waiter_id = b.waiter_id), 0)
                + coalesce((SELECT sum(wp.amount_paise) FROM waiter_payments wp
                             WHERE wp.created_at = p.created_at AND wp.tender_type = p.tender_type AND wp.waiter_id = b.waiter_id), 0)
              )::text END AS receipt
         FROM bill_payments p JOIN bills b ON b.id = p.bill_id
        WHERE p.bill_id = $1
        ORDER BY p.created_at, p.id`,
      [billId],
    );
    const payments: OrderPayment[] = pays.map((p) => {
      const amountPaise = toPaise(p.amount);
      const receipt = p.receipt === null ? null : toPaise(p.receipt);
      return { id: p.id, tender: p.tender_type, amountPaise, at: p.created_at, receiptTotalPaise: receipt !== null && receipt > amountPaise ? receipt : null };
    });

    const cashier = await maybeOne<{ display_name: string }>(this.db, `SELECT display_name FROM staff WHERE id = $1`, [summary.createdByStaffId]);
    const session = summary.peakSessionId
      ? await maybeOne<{ session_no: number; ended_at: Date | null }>(this.db, `SELECT session_no, ended_at FROM peak_sessions WHERE id = $1`, [summary.peakSessionId])
      : undefined;
    const reversalRow = await maybeOne<{ id: string; bill_no: number; created_at: Date; reversal_reason: string }>(
      this.db,
      `SELECT id, bill_no, created_at, reversal_reason FROM bills WHERE reverses_bill_id = $1`,
      [billId],
    );
    let reversal: OrderDetail['reversal'] = null;
    if (reversalRow) {
      const { rows: refunds } = await this.db.query<{ tender_type: Tender; amount: DbInt }>(
        `SELECT tender_type, amount_paise::text AS amount FROM bill_payments WHERE bill_id = $1 ORDER BY created_at, id`,
        [reversalRow.id],
      );
      reversal = {
        billNo: reversalRow.bill_no,
        at: reversalRow.created_at,
        reason: reversalRow.reversal_reason,
        refunds: refunds.map((f) => ({ tender: f.tender_type, amountPaise: toPaise(f.amount) })),
      };
    }

    const settledVia: OrderDetail['settledVia'] =
      summary.mode === 'PEAK' ? 'PEAK' : payments.length === 0 && summary.status !== 'SETTLED' ? null : summary.waiter ? 'WAITER' : 'COUNTER';
    return {
      summary,
      detail,
      payments,
      cashier: cashier?.display_name ?? 'Unknown',
      settledVia,
      peakSession: session ? { sessionNo: session.session_no, endedAt: session.ended_at } : null,
      reversal,
    };
  }
}

const TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

/** The customer receipt for an order (Orders reprint). Cancelled bottles are left off; a void is noted. */
export function receiptFor(order: OrderDetail, reprintedAt: Date | null): ReceiptTicket {
  const { summary, detail } = order;
  // detail.items holds this bill's own lines only: sales and counter cancellations, never a void's
  // reversal lines. So bottles sold = qty − same-bill cancellations, for a voided bill too.
  const lines = new Map<string, { displayName: string; sizeCode: SizeCode; quantity: number; unitPricePaise: Paise; amountPaise: Paise }>();
  for (const item of detail.items) {
    if (item.quantity <= 0) continue;
    const cancelled = detail.items.filter((c) => c.reversesItemId === item.id).reduce((n, c) => n - c.quantity, 0);
    const quantity = item.quantity - cancelled;
    if (quantity <= 0) continue;
    const key = `${item.skuId}:${item.unitPricePaise}`;
    const line = lines.get(key) ?? { displayName: item.displayName, sizeCode: item.sizeCode, quantity: 0, unitPricePaise: item.unitPricePaise, amountPaise: 0n };
    line.quantity += quantity;
    line.amountPaise += BigInt(quantity) * item.unitPricePaise;
    lines.set(key, line);
  }

  const servedBy = summary.mode === 'PEAK'
    ? `Peak #${summary.peakSessionNo ?? '?'} - ${order.cashier}`
    : summary.waiter
      ? `Waiter: ${summary.waiter.code} ${summary.waiter.displayName}`
      : `Counter: ${order.cashier}`;
  const note =
    summary.status === 'VOIDED' && order.reversal
      ? `VOIDED ${TIME.format(order.reversal.at)} - ${order.reversal.reason}`
      : summary.mode === 'PEAK'
        ? 'PEAK SALE - settled with the session count'
        : summary.status === 'CANCELLED'
          ? 'CANCELLED - every line returned'
          : summary.status === 'OPEN'
            ? 'NOT SETTLED'
            : null;

  return {
    billNo: summary.billNo,
    createdAt: summary.createdAt,
    servedBy,
    member: summary.member,
    lines: [...lines.values()],
    totalPaise: summary.totalPaise,
    payments: order.payments.filter((p) => p.amountPaise > 0n).map((p) => ({ tender: p.tender, amountPaise: p.amountPaise })),
    duePaise: summary.duePaise,
    note,
    reprintedAt,
  };
}
