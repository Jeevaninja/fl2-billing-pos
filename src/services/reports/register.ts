/**
 * The bill-wise registers: the Phase 23 sales register and the Phase 24 Order Summary (the same rows
 * plus cashier, peak session, KOT numbers and CANCEL tags). Every bill issued in the range except
 * OPEN tabs (not sales yet), by business date then bill number; reversals are their own rows.
 */
import type { SqlClient } from '../../db/client.js';
import { type DbInt, type Paise, toPaise } from '../../domain/money.js';
import type { KotStation, SizeCode } from '../../domain/types.js';
import { one } from '../rows.js';
import { IN_RANGE, int, type ReportHeader, sum } from './shared.js';

export interface SalesRegisterItem {
  name: string;
  sizeCode: SizeCode;
  /** Net of counter cancellations; negative on a reversal. */
  qty: number;
  lineTotalPaise: Paise;
}

export interface SalesRegisterRow {
  billId: string;
  businessDate: string;
  billNo: number;
  createdAt: Date;
  settledAt: Date | null;
  kind: 'SALE' | 'REVERSAL';
  /** REVERSAL rows: the bill it voids. */
  reverses: { billNo: number; businessDate: string } | null;
  /** SALE rows: the reversal that voided it, if any. */
  voidedBy: { billNo: number; businessDate: string } | null;
  mode: 'NORMAL' | 'PEAK';
  status: 'SETTLED' | 'PEAK_UNSETTLED' | 'PEAK_RECONCILED';
  cashPaise: Paise;
  upiPaise: Paise;
  creditPaise: Paise;
  waiterName: string | null;
  items: SalesRegisterItem[];
  /** Negative on a reversal. */
  totalPaise: Paise;
}

export interface SalesRegister extends ReportHeader {
  rows: SalesRegisterRow[];
  totals: { billCount: number; reversalCount: number; salesPaise: Paise; reversalsPaise: Paise; netPaise: Paise };
  /** OPEN tabs in the range: not sales yet, so not listed. */
  openBillCount: number;
}

interface RegisterBillRow {
  id: string;
  business_date: string;
  bill_no: number;
  created_at: Date;
  settled_at: Date | null;
  bill_kind: 'SALE' | 'REVERSAL';
  billing_mode: 'NORMAL' | 'PEAK';
  status: SalesRegisterRow['status'];
  total: DbInt;
  cash: DbInt;
  upi: DbInt;
  credit: DbInt;
  waiter_name: string | null;
  rev_no: number | null;
  rev_date: string | null;
  void_no: number | null;
  void_date: string | null;
}

/** Every bill issued in the range except OPEN tabs, by business date then bill number. */
export async function salesRegister(db: SqlClient, head: ReportHeader): Promise<SalesRegister> {
  const params = [head.range.startDate, head.range.endDate];
  const { rows } = await db.query<RegisterBillRow>(
    `SELECT b.id, d.business_date::text AS business_date, b.bill_no, b.created_at, b.settled_at, b.bill_kind, b.billing_mode, b.status,
            b.total_paise::text AS total,
            coalesce(pay.cash, 0)::text AS cash, coalesce(pay.upi, 0)::text AS upi, coalesce(pay.credit, 0)::text AS credit,
            w.display_name AS waiter_name,
            o.bill_no AS rev_no, od.business_date::text AS rev_date,
            v.bill_no AS void_no, vd.business_date::text AS void_date
       FROM bills b
       JOIN business_days d ON d.id = b.business_day_id
       LEFT JOIN waiters w ON w.id = b.waiter_id
       LEFT JOIN bills o ON o.id = b.reverses_bill_id
       LEFT JOIN business_days od ON od.id = o.business_day_id
       LEFT JOIN bills v ON v.reverses_bill_id = b.id
       LEFT JOIN business_days vd ON vd.id = v.business_day_id
       LEFT JOIN LATERAL (
         SELECT sum(p.amount_paise) FILTER (WHERE p.tender_type = 'CASH') AS cash,
                sum(p.amount_paise) FILTER (WHERE p.tender_type = 'UPI') AS upi,
                sum(p.amount_paise) FILTER (WHERE p.tender_type = 'WAITER_CREDIT') AS credit
           FROM bill_payments p WHERE p.bill_id = b.id
       ) pay ON true
      WHERE d.business_date BETWEEN $1::date AND $2::date AND b.status <> 'OPEN'
      ORDER BY d.business_date, b.bill_no`,
    params,
  );
  const { rows: itemRows } = await db.query<{ bill_id: string; name: string; size_code: SizeCode; qty: number; amount: DbInt }>(
    `SELECT i.bill_id, max(i.display_name_snapshot) AS name, max(i.size_code_snapshot) AS size_code,
            sum(i.qty)::int AS qty, sum(i.line_total_paise)::text AS amount
       FROM bill_items i
       JOIN bills b ON b.id = i.bill_id
      WHERE b.${IN_RANGE} AND b.status <> 'OPEN'
      GROUP BY i.bill_id, i.sku_id
     HAVING sum(i.qty) <> 0
      ORDER BY i.bill_id, min(i.line_no)`,
    params,
  );
  const items = new Map<string, SalesRegisterItem[]>();
  for (const r of itemRows) {
    const list = items.get(r.bill_id) ?? [];
    list.push({ name: r.name, sizeCode: r.size_code, qty: int(r.qty), lineTotalPaise: toPaise(r.amount) });
    items.set(r.bill_id, list);
  }
  const open = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM bills WHERE ${IN_RANGE} AND status = 'OPEN'`, params);

  const out: SalesRegisterRow[] = rows.map((r) => ({
    billId: r.id,
    businessDate: r.business_date,
    billNo: r.bill_no,
    createdAt: r.created_at,
    settledAt: r.settled_at,
    kind: r.bill_kind,
    reverses: r.rev_no !== null && r.rev_date !== null ? { billNo: r.rev_no, businessDate: r.rev_date } : null,
    voidedBy: r.void_no !== null && r.void_date !== null ? { billNo: r.void_no, businessDate: r.void_date } : null,
    mode: r.billing_mode,
    status: r.status,
    cashPaise: toPaise(r.cash),
    upiPaise: toPaise(r.upi),
    creditPaise: toPaise(r.credit),
    waiterName: r.waiter_name,
    items: items.get(r.id) ?? [],
    totalPaise: toPaise(r.total),
  }));
  const salesRows = out.filter((r) => r.kind === 'SALE');
  const reversalRows = out.filter((r) => r.kind === 'REVERSAL');
  const salesPaise = sum(salesRows, (r) => r.totalPaise);
  const reversalsPaise = sum(reversalRows, (r) => r.totalPaise);
  return {
    ...head,
    rows: out,
    totals: { billCount: salesRows.length, reversalCount: reversalRows.length, salesPaise, reversalsPaise, netPaise: salesPaise + reversalsPaise },
    openBillCount: int(open.n),
  };
}

export interface OrderKot {
  station: KotStation;
  /** 1 = the bill's first ticket at that station; later ones print as #bill/2, #bill/3 … */
  ticketNo: number;
}

export interface OrderSummaryRow extends SalesRegisterRow {
  /** The staff member who opened the bill at the counter; null for a Captain (waiter app) bill. */
  cashierName: string | null;
  source: 'COUNTER' | 'WAITER_APP';
  settledByName: string | null;
  /** Peak bills: the session number within the day. */
  peakSessionNo: number | null;
  kots: OrderKot[];
  /** SALE rows: bottles / items cancelled off the bill before it was settled. */
  cancelledQty: number;
}

export interface OrderSummaryReport extends ReportHeader {
  rows: OrderSummaryRow[];
  totals: SalesRegister['totals'] & { cancelledQty: number };
  openBillCount: number;
}

/** The sales register plus who rang each bill, its peak session, its KOT tickets and cancellations. */
export async function orderSummary(db: SqlClient, head: ReportHeader): Promise<OrderSummaryReport> {
  const register = await salesRegister(db, head);
  const params = [head.range.startDate, head.range.endDate];
  const { rows: extras } = await db.query<{
    id: string;
    source: 'COUNTER' | 'WAITER_APP';
    cashier: string | null;
    settled_by: string | null;
    session_no: number | null;
    cancelled: DbInt;
  }>(
    `SELECT b.id, b.source, c.display_name AS cashier, s.display_name AS settled_by, ps.session_no,
            coalesce((SELECT -sum(i.qty) FROM bill_items i WHERE i.bill_id = b.id AND i.qty < 0 AND b.bill_kind = 'SALE'), 0)::text AS cancelled
       FROM bills b
       LEFT JOIN staff c ON c.id = b.created_by_staff_id
       LEFT JOIN staff s ON s.id = b.settled_by_staff_id
       LEFT JOIN peak_sessions ps ON ps.id = b.peak_session_id
      WHERE b.${IN_RANGE} AND b.status <> 'OPEN'`,
    params,
  );
  const { rows: kotRows } = await db.query<{ bill_id: string; station: KotStation; ticket_no: number }>(
    `SELECT t.bill_id, t.station, t.ticket_no
       FROM kot_tickets t JOIN bills b ON b.id = t.bill_id
      WHERE b.${IN_RANGE} AND b.status <> 'OPEN'
      ORDER BY t.printed_at, t.station, t.ticket_no`,
    params,
  );
  const extra = new Map(extras.map((e) => [e.id, e]));
  const kots = new Map<string, OrderKot[]>();
  for (const k of kotRows) {
    const list = kots.get(k.bill_id) ?? [];
    list.push({ station: k.station, ticketNo: int(k.ticket_no) });
    kots.set(k.bill_id, list);
  }
  const rows: OrderSummaryRow[] = register.rows.map((r) => {
    const e = extra.get(r.billId);
    if (!e) throw new Error(`order summary: bill ${r.businessDate} #${r.billNo} missing from the snapshot`);
    return {
      ...r,
      cashierName: e.cashier,
      source: e.source,
      settledByName: e.settled_by,
      peakSessionNo: e.session_no === null ? null : int(e.session_no),
      kots: kots.get(r.billId) ?? [],
      cancelledQty: int(e.cancelled),
    };
  });
  return {
    ...head,
    rows,
    totals: { ...register.totals, cancelledQty: rows.reduce((n, r) => n + r.cancelledQty, 0) },
    openBillCount: register.openBillCount,
  };
}
