/**
 * Read-only queries behind the counter billing screen. No writes, no transactions: every method
 * reads committed state, and money still crosses into the domain only through toPaise().
 */
import type { SqlClient } from '../db/client.js';
import { NotFoundError } from '../db/errors.js';
import { type DbInt, type Paise, toPaise, toPaiseOrNull } from '../domain/money.js';
import type { Bill, BillItem, BillPayment, PeakSession, SizeCode } from '../domain/types.js';
import {
  type BillItemRow,
  type BillPaymentRow,
  getBill,
  mapBillItem,
  mapBillPayment,
  mapPeakSession,
  maybeOne,
  type PeakSessionRow,
} from './rows.js';

export type StaffRole = 'CASHIER' | 'MANAGER' | 'ADMIN';

export interface StaffSummary {
  id: string;
  displayName: string;
  role: StaffRole;
}

export interface BusinessDaySummary {
  id: string;
  /** ISO date, e.g. '2026-10-14'. */
  businessDate: string;
  openedAt: Date;
}

export interface PeakSessionView extends PeakSession {
  /** What the drawer should have gained so far in this session (frozen once the session ends). */
  runningExpectedPaise: Paise;
  /**
   * Physical cash that should be in the drawer now: start cash + peak sales (no tender, so counted as
   * cash) + in-peak cash tenders and waiter cash − in-peak cash expenses. See pos_peak_expected_drawer_cash.
   */
  expectedDrawerCashPaise: Paise;
  /** Σ the session's peak bill totals so far (Phase 13: the end dialog's live split). */
  runningSalesPaise: Paise;
  /** UPI recorded inside the window on normal bills and waiter repayments (it moves the UPI reading too). */
  runningInWindowUpiPaise: Paise;
}

export type PeakSessionViewRow = PeakSessionRow &
  Record<'running_expected_paise' | 'expected_drawer_cash_paise' | 'running_sales_paise' | 'running_in_window_upi_paise', DbInt>;

/** Maps a running session from v_peak_sessions. */
export function mapPeakSessionView(row: PeakSessionViewRow): PeakSessionView {
  return {
    ...mapPeakSession(row),
    runningExpectedPaise: toPaise(row.running_expected_paise),
    expectedDrawerCashPaise: toPaise(row.expected_drawer_cash_paise),
    runningSalesPaise: toPaise(row.running_sales_paise),
    runningInWindowUpiPaise: toPaise(row.running_in_window_upi_paise),
  };
}

export interface MemberSummary {
  id: string;
  membershipNo: string;
  displayName: string;
}

export interface WaiterSummary {
  id: string;
  code: string;
  displayName: string;
  isTrusted: boolean;
  outstandingPaise: Paise;
  /** null = no limit. */
  creditLimitPaise: Paise | null;
}

export interface SkuLookup {
  id: string;
  skuCode: string;
  barcode: string | null;
  displayName: string;
  sizeCode: SizeCode;
  pricePaise: Paise;
  /** Default per-bottle cost for a GRN line; null when the catalog has none. */
  purchasePricePaise: Paise | null;
  /** Sealed bottles per supplier case. */
  caseSize: number;
  onHandQty: number;
  isActive: boolean;
}

export interface BillDetailItem extends BillItem {
  /** Bottles still sold on a positive line after cancellations and reversals; 0 for negative lines. */
  remainingQuantity: number;
}

export interface BillDetail {
  bill: Bill;
  /** Every line in line order, including negative cancellation lines. */
  items: BillDetailItem[];
  payments: BillPayment[];
  member: MemberSummary | null;
  waiter: WaiterSummary | null;
  tenderedPaise: Paise;
  duePaise: Paise;
}

export interface CounterContext {
  cashier: StaffSummary;
  /** null when no business day is open: billing is blocked until Day End opens one. */
  businessDay: BusinessDaySummary | null;
  /** The running peak session; when present the counter bills in PEAK mode. */
  peakSession: PeakSessionView | null;
  /** This cashier's newest OPEN NORMAL counter bill on the open day, for resume after a reload. */
  openBill: BillDetail | null;
  /** Every OPEN NORMAL counter bill of this cashier on the open day, oldest first: held billing tabs. */
  openBills: BillDetail[];
}

export interface WaiterDayTotals {
  /** OPEN sale bills tagged to the waiter on the day. */
  openBills: number;
  /** Σ due (total − tendered) on those open bills: what is still to be settled. */
  openDuePaise: Paise;
  /** SETTLED sale bills of the day that have not been reversed, whatever the tender (waiter credit included). */
  closedBills: number;
  settledPaise: Paise;
}

export type WaiterStats = WaiterSummary & WaiterDayTotals;

/** A waiter's account for the open day (Phase 16 Waiter Ledger). Billed − Paid = Balance in normal flows. */
export interface WaiterLedgerRow extends WaiterSummary {
  /** Σ totals of the day's sale bills tagged to the waiter, reversed bills left out. */
  billedPaise: Paise;
  /** Σ CASH / UPI tenders on those bills + Σ the day's repayments (net of voids). */
  paidPaise: Paise;
  /** What the waiter owes now: dues on their OPEN bills + credit balance. Must be ₹0 to close the day. */
  balancePaise: Paise;
  openBills: number;
  openDuePaise: Paise;
  /** When their newest open bill was created (new-order hint); null with none open. */
  newestOpenAt: Date | null;
}

export type LedgerAllocation =
  | { kind: 'BILL'; billId: string; billNo: number; amountPaise: Paise; settled: boolean; remainingDuePaise: Paise }
  | { kind: 'CREDIT'; amountPaise: Paise }
  | { kind: 'VOID'; amountPaise: Paise };

/** Money handed in at one moment: one payment, possibly spread over several bills and the credit balance. */
export interface LedgerReceipt {
  at: Date;
  tender: 'CASH' | 'UPI';
  amountPaise: Paise;
  allocations: LedgerAllocation[];
}

export interface WaiterLedger {
  waiter: WaiterLedgerRow;
  /** Credit not yet repaid (`outstanding_balance`); part of the balance. */
  creditPaise: Paise;
  /** OPEN sale bills tagged to the waiter (any source), oldest first. */
  openBills: BillDetail[];
  /** Today's money from the waiter, newest first. */
  receipts: LedgerReceipt[];
}


export interface WaiterStatsReport {
  /** The open business day; null when none is open (every waiter then reports zeros). */
  businessDayId: string | null;
  /** Active waiters by code, including those with no bills today. */
  waiters: WaiterStats[];
  /** Σ of the rows. */
  totals: WaiterDayTotals;
}

const DEFAULT_MEMBER_LIMIT = 20;
const DEFAULT_SKU_LIMIT = 20;

export interface WaiterRow {
  id: string;
  waiter_code: string;
  display_name: string;
  is_trusted: boolean;
  outstanding_balance: DbInt;
  credit_limit_paise: DbInt | null;
}

export interface SkuLookupRow {
  id: string;
  sku_code: string;
  barcode: string | null;
  display_name: string;
  size_code: SizeCode;
  price_paise: DbInt;
  purchase_price_paise: DbInt | null;
  case_size: number;
  on_hand_qty: number;
  is_active: boolean;
}

export function mapSkuLookup(row: SkuLookupRow): SkuLookup {
  return {
    id: row.id,
    skuCode: row.sku_code,
    barcode: row.barcode,
    displayName: row.display_name,
    sizeCode: row.size_code,
    pricePaise: toPaise(row.price_paise),
    purchasePricePaise: toPaiseOrNull(row.purchase_price_paise),
    caseSize: row.case_size,
    onHandQty: row.on_hand_qty,
    isActive: row.is_active,
  };
}

export const WAITER_COLUMNS = `id, waiter_code, display_name, is_trusted, outstanding_balance, credit_limit_paise`;

export function mapWaiter(r: WaiterRow): WaiterSummary {
  return {
    id: r.id,
    code: r.waiter_code,
    displayName: r.display_name,
    isTrusted: r.is_trusted,
    outstandingPaise: toPaise(r.outstanding_balance),
    creditLimitPaise: toPaiseOrNull(r.credit_limit_paise),
  };
}

type WaiterLedgerDbRow = WaiterRow & { billed: DbInt; paid: DbInt; open_bills: number; open_due: DbInt; newest_open_at: Date | null };

/**
 * Per-waiter figures for the open day. Open dues cover every OPEN bill (an open bill can't outlive its
 * day, since Day End refuses to close over one). `$1` = waiter id filter or null for all.
 */
const WAITER_LEDGER_SQL = `
  WITH day AS (SELECT id FROM business_days WHERE status = 'OPEN'),
  wb AS (
    SELECT b.waiter_id, b.total_paise,
           coalesce((SELECT sum(p.amount_paise) FROM bill_payments p
                      WHERE p.bill_id = b.id AND p.tender_type IN ('CASH', 'UPI')), 0) AS cash_upi
      FROM bills b
     WHERE b.waiter_id IS NOT NULL AND b.bill_kind = 'SALE' AND b.business_day_id = (SELECT id FROM day)
       AND NOT EXISTS (SELECT 1 FROM bills r WHERE r.reverses_bill_id = b.id)
  ),
  billed AS (SELECT waiter_id, count(*) AS n, sum(total_paise) AS billed, sum(cash_upi) AS paid FROM wb GROUP BY waiter_id),
  repaid AS (
    SELECT waiter_id, count(*) AS n, sum(amount_paise) AS repaid FROM waiter_payments
     WHERE business_day_id = (SELECT id FROM day) GROUP BY waiter_id
  ),
  open AS (
    SELECT b.waiter_id, count(*) AS n, max(b.created_at) AS newest,
           sum(b.total_paise - coalesce((SELECT sum(p.amount_paise) FROM bill_payments p WHERE p.bill_id = b.id), 0)) AS due
      FROM bills b
     WHERE b.waiter_id IS NOT NULL AND b.status = 'OPEN' AND b.bill_kind = 'SALE'
     GROUP BY b.waiter_id
  )
  SELECT ${WAITER_COLUMNS.split(', ').map((c) => `w.${c}`).join(', ')},
         coalesce(bl.billed, 0)::text                         AS billed,
         (coalesce(bl.paid, 0) + coalesce(rp.repaid, 0))::text AS paid,
         coalesce(o.n, 0)::int                                AS open_bills,
         coalesce(o.due, 0)::text                             AS open_due,
         o.newest                                             AS newest_open_at
    FROM waiters w
    LEFT JOIN billed bl ON bl.waiter_id = w.id
    LEFT JOIN repaid rp ON rp.waiter_id = w.id
    LEFT JOIN open o ON o.waiter_id = w.id
   WHERE ($1::uuid IS NULL AND (bl.n > 0 OR rp.n > 0 OR o.n > 0 OR w.outstanding_balance > 0)) OR w.id = $1::uuid
   ORDER BY (w.outstanding_balance + coalesce(o.due, 0)) DESC, w.waiter_code`;

function mapLedgerRow(r: WaiterLedgerDbRow): WaiterLedgerRow {
  const openDuePaise = toPaise(r.open_due);
  return {
    ...mapWaiter(r),
    billedPaise: toPaise(r.billed),
    paidPaise: toPaise(r.paid),
    balancePaise: toPaise(r.outstanding_balance) + openDuePaise,
    openBills: r.open_bills,
    openDuePaise,
    newestOpenAt: r.newest_open_at,
  };
}

/** Escapes LIKE metacharacters so user input matches literally (default escape character is `\`). */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class CounterQueries {
  constructor(private readonly db: SqlClient) {}

  async getCounterContext(cashierId: string): Promise<CounterContext> {
    const staff = await maybeOne<{ id: string; display_name: string; role: StaffRole }>(
      this.db,
      `SELECT id, display_name, role FROM staff WHERE id = $1`,
      [cashierId],
    );
    if (!staff) throw new NotFoundError('staff', cashierId);
    const cashier: StaffSummary = { id: staff.id, displayName: staff.display_name, role: staff.role };

    const day = await maybeOne<{ id: string; business_date: string; opened_at: Date }>(
      this.db,
      `SELECT id, business_date::text AS business_date, opened_at FROM business_days WHERE status = 'OPEN'`,
    );
    if (!day) return { cashier, businessDay: null, peakSession: null, openBill: null, openBills: [] };

    const session = await maybeOne<PeakSessionViewRow>(
      this.db,
      `SELECT * FROM v_peak_sessions WHERE business_day_id = $1 AND ended_at IS NULL`,
      [day.id],
    );
    const { rows: openRows } = await this.db.query<{ id: string }>(
      `SELECT id FROM bills
        WHERE business_day_id = $1 AND created_by_staff_id = $2
          AND status = 'OPEN' AND billing_mode = 'NORMAL' AND bill_kind = 'SALE' AND source = 'COUNTER'
        ORDER BY bill_no`,
      [day.id, cashierId],
    );
    const openBills: BillDetail[] = [];
    for (const { id } of openRows) openBills.push(await this.getBillDetail(id));

    return {
      cashier,
      businessDay: { id: day.id, businessDate: day.business_date, openedAt: day.opened_at },
      peakSession: session ? mapPeakSessionView(session) : null,
      openBill: openBills.at(-1) ?? null,
      openBills,
    };
  }

  /** Resolves scanned or typed text: an exact barcode wins, then a case-insensitive SKU code. */
  async lookupSku(code: string): Promise<SkuLookup | null> {
    const text = code.trim();
    if (text === '') return null;
    const row = await maybeOne<SkuLookupRow>(
      this.db,
      `SELECT k.id, k.sku_code, k.barcode, k.display_name, k.size_code, k.price_paise, k.purchase_price_paise, k.case_size, k.is_active,
              coalesce(s.on_hand_qty, 0) AS on_hand_qty
         FROM skus k
         LEFT JOIN sku_stock s ON s.sku_id = k.id
        WHERE k.barcode = $1 OR upper(k.sku_code) = upper($1)
        ORDER BY (k.barcode = $1) IS TRUE DESC
        LIMIT 1`,
      [text],
    );
    return row ? mapSkuLookup(row) : null;
  }

  /**
   * SKUs for a picker (Purchase screen): exact barcode, SKU code prefix, or name contains `query`.
   * An exact barcode ranks first, inactive SKUs last; then by name and size (FULL → QUARTER, 650 → 330).
   */
  async searchSkus(query: string, limit = DEFAULT_SKU_LIMIT): Promise<SkuLookup[]> {
    const text = query.trim();
    if (text === '') return [];
    const { rows } = await this.db.query<SkuLookupRow>(
      `SELECT k.id, k.sku_code, k.barcode, k.display_name, k.size_code, k.price_paise, k.purchase_price_paise, k.case_size, k.is_active,
              coalesce(s.on_hand_qty, 0) AS on_hand_qty
         FROM skus k
         JOIN products p ON p.id = k.product_id
         LEFT JOIN sku_stock s ON s.sku_id = k.id
        WHERE k.barcode = $2 OR k.sku_code ILIKE $1 || '%' OR k.display_name ILIKE '%' || $1 || '%'
        ORDER BY (k.barcode = $2) IS TRUE DESC, k.is_active DESC, lower(p.name),
                 array_position(ARRAY['FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330'], k.size_code),
                 k.sku_code
        LIMIT $3`,
      [likeLiteral(text), text, limit],
    );
    return rows.map(mapSkuLookup);
  }

  /** Active members whose number starts with, or name contains, `query`. An exact number ranks first. */
  async searchMembers(query: string, limit = DEFAULT_MEMBER_LIMIT): Promise<MemberSummary[]> {
    const text = query.trim();
    if (text === '') return [];
    const { rows } = await this.db.query<{ id: string; membership_no: string; display_name: string }>(
      `SELECT id, membership_no, display_name FROM members
        WHERE is_active AND (membership_no ILIKE $1 || '%' OR display_name ILIKE '%' || $1 || '%')
        ORDER BY upper(membership_no) = upper($2) DESC, display_name, membership_no
        LIMIT $3`,
      [likeLiteral(text), text, limit],
    );
    return rows.map((r) => ({ id: r.id, membershipNo: r.membership_no, displayName: r.display_name }));
  }

  async listWaiters(): Promise<WaiterSummary[]> {
    const { rows } = await this.db.query<WaiterRow>(
      `SELECT ${WAITER_COLUMNS} FROM waiters WHERE is_active ORDER BY waiter_code`,
    );
    return rows.map(mapWaiter);
  }

  /**
   * Per-waiter figures for the waiter sidebar: today's open bills (count, Σ due) and closed bills
   * (count, Σ total) across counter and Captain-app bills, on the open business day. Reversed bills
   * are not counted as closed.
   */
  async getWaiterStats(): Promise<WaiterStatsReport> {
    const day = await maybeOne<{ id: string }>(this.db, `SELECT id FROM business_days WHERE status = 'OPEN'`);
    const businessDayId = day?.id ?? null;
    const { rows } = await this.db.query<WaiterRow & { open_bills: number; open_due: DbInt; closed_bills: number; settled_total: DbInt }>(
      `SELECT ${WAITER_COLUMNS.split(', ').map((c) => `w.${c}`).join(', ')},
              (count(b.id) FILTER (WHERE b.status = 'OPEN'))::int                                           AS open_bills,
              coalesce(sum(b.total_paise - coalesce(t.tendered, 0)) FILTER (WHERE b.status = 'OPEN'), 0)::bigint AS open_due,
              (count(b.id) FILTER (WHERE b.status = 'SETTLED' AND r.id IS NULL))::int                         AS closed_bills,
              coalesce(sum(b.total_paise) FILTER (WHERE b.status = 'SETTLED' AND r.id IS NULL), 0)::bigint    AS settled_total
         FROM waiters w
         LEFT JOIN bills b ON b.waiter_id = w.id AND b.business_day_id = $1 AND b.bill_kind = 'SALE'
         LEFT JOIN LATERAL (SELECT sum(p.amount_paise) AS tendered FROM bill_payments p WHERE p.bill_id = b.id) t ON true
         LEFT JOIN bills r ON r.reverses_bill_id = b.id
        WHERE w.is_active
        GROUP BY w.id
        ORDER BY w.waiter_code`,
      [businessDayId],
    );
    const waiters: WaiterStats[] = rows.map((r) => ({
      ...mapWaiter(r),
      openBills: r.open_bills,
      openDuePaise: toPaise(r.open_due),
      closedBills: r.closed_bills,
      settledPaise: toPaise(r.settled_total),
    }));
    const totals: WaiterDayTotals = { openBills: 0, openDuePaise: 0n, closedBills: 0, settledPaise: 0n };
    for (const w of waiters) {
      totals.openBills += w.openBills;
      totals.openDuePaise += w.openDuePaise;
      totals.closedBills += w.closedBills;
      totals.settledPaise += w.settledPaise;
    }
    return { businessDayId, waiters, totals };
  }

  /** Waiters with a bill or a payment today, or anything owed: biggest balance first, then by code. */
  async listWaiterLedger(): Promise<WaiterLedgerRow[]> {
    const { rows } = await this.db.query<WaiterLedgerDbRow>(WAITER_LEDGER_SQL, [null]);
    return rows.map(mapLedgerRow);
  }

  /** One waiter's account: figures, open bills with their lines, and today's receipts. */
  async getWaiterLedger(waiterId: string): Promise<WaiterLedger> {
    const { rows } = await this.db.query<WaiterLedgerDbRow>(WAITER_LEDGER_SQL, [waiterId]);
    const row = rows[0];
    if (!row) throw new NotFoundError('waiter', waiterId);

    const { rows: openIds } = await this.db.query<{ id: string }>(
      `SELECT id FROM bills WHERE waiter_id = $1 AND status = 'OPEN' AND bill_kind = 'SALE' ORDER BY created_at, bill_no`,
      [waiterId],
    );
    const openBills: BillDetail[] = [];
    for (const { id } of openIds) openBills.push(await this.getBillDetail(id));

    // Rows written in one transaction share now(): one receipt = one waiter + tender + timestamp.
    const { rows: money } = await this.db.query<{
      at: Date; at_key: string; tender: 'CASH' | 'UPI'; amount: DbInt; bill_id: string | null; bill_no: number | null; remaining: DbInt | null;
    }>(
      `WITH day AS (SELECT id FROM business_days WHERE status = 'OPEN'),
       pay AS (
         SELECT p.created_at, p.id, p.tender_type, p.amount_paise, p.business_day_id, p.bill_id, b.bill_no,
                b.total_paise - sum(p.amount_paise) OVER (PARTITION BY p.bill_id ORDER BY p.created_at, p.id) AS remaining
           FROM bill_payments p
           JOIN bills b ON b.id = p.bill_id
          WHERE b.waiter_id = $1 AND b.bill_kind = 'SALE' AND NOT EXISTS (SELECT 1 FROM bills r WHERE r.reverses_bill_id = b.id)
       )
       SELECT created_at AS at, created_at::text AS at_key, tender_type AS tender, amount_paise::text AS amount,
              bill_id, bill_no, remaining::text AS remaining
         FROM pay
        WHERE business_day_id = (SELECT id FROM day) AND tender_type IN ('CASH', 'UPI')
       UNION ALL
       SELECT created_at, created_at::text, tender_type, amount_paise::text, NULL, NULL, NULL
         FROM waiter_payments
        WHERE waiter_id = $1 AND business_day_id = (SELECT id FROM day)
       ORDER BY at_key DESC, bill_no NULLS LAST`,
      [waiterId],
    );
    const receipts: LedgerReceipt[] = [];
    const byKey = new Map<string, LedgerReceipt>();
    for (const m of money) {
      const key = `${m.at_key}|${m.tender}`;
      let receipt = byKey.get(key);
      if (!receipt) {
        receipt = { at: m.at, tender: m.tender, amountPaise: 0n, allocations: [] };
        byKey.set(key, receipt);
        receipts.push(receipt);
      }
      const amountPaise = toPaise(m.amount);
      receipt.amountPaise += amountPaise;
      if (m.bill_id !== null && m.bill_no !== null) {
        const remainingDuePaise = toPaise(m.remaining ?? 0);
        receipt.allocations.push({ kind: 'BILL', billId: m.bill_id, billNo: m.bill_no, amountPaise, settled: remainingDuePaise === 0n, remainingDuePaise });
      } else {
        receipt.allocations.push({ kind: amountPaise < 0n ? 'VOID' : 'CREDIT', amountPaise });
      }
    }

    return { waiter: mapLedgerRow(row), creditPaise: toPaise(row.outstanding_balance), openBills, receipts };
  }

  /** Every OPEN sale bill placed from the Captain app, oldest first: the cashier's settle queue. */
  async listCaptainOrders(): Promise<BillDetail[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM bills
        WHERE source = 'WAITER_APP' AND status = 'OPEN' AND bill_kind = 'SALE'
        ORDER BY created_at, id`,
    );
    const orders: BillDetail[] = [];
    for (const { id } of rows) orders.push(await this.getBillDetail(id));
    return orders;
  }

  async getBillDetail(billId: string): Promise<BillDetail> {
    const bill = await getBill(this.db, billId);
    const { rows: itemRows } = await this.db.query<BillItemRow & { remaining_qty: number }>(
      `SELECT i.*,
              CASE WHEN i.qty > 0
                   THEN (i.qty + coalesce((SELECT sum(c.qty) FROM bill_items c WHERE c.reverses_item_id = i.id), 0))::int
                   ELSE 0 END AS remaining_qty
         FROM bill_items i
        WHERE i.bill_id = $1
        ORDER BY i.line_no`,
      [billId],
    );
    const { rows: paymentRows } = await this.db.query<BillPaymentRow>(
      `SELECT * FROM bill_payments WHERE bill_id = $1 ORDER BY created_at, id`,
      [billId],
    );
    const member = bill.memberId
      ? await maybeOne<{ id: string; membership_no: string; display_name: string }>(
          this.db,
          `SELECT id, membership_no, display_name FROM members WHERE id = $1`,
          [bill.memberId],
        )
      : undefined;
    const waiter = bill.waiterId
      ? await maybeOne<WaiterRow>(this.db, `SELECT ${WAITER_COLUMNS} FROM waiters WHERE id = $1`, [bill.waiterId])
      : undefined;

    const payments = paymentRows.map(mapBillPayment);
    const tenderedPaise = payments.reduce((sum, p) => sum + p.amountPaise, 0n);
    return {
      bill,
      items: itemRows.map((r) => ({ ...mapBillItem(r), remainingQuantity: r.remaining_qty })),
      payments,
      member: member ? { id: member.id, membershipNo: member.membership_no, displayName: member.display_name } : null,
      waiter: waiter ? mapWaiter(waiter) : null,
      tenderedPaise,
      duePaise: bill.totalPaise - tenderedPaise,
    };
  }
}
