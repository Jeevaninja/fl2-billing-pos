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
}

const DEFAULT_MEMBER_LIMIT = 20;

interface WaiterRow {
  id: string;
  waiter_code: string;
  display_name: string;
  is_trusted: boolean;
  outstanding_balance: DbInt;
  credit_limit_paise: DbInt | null;
}

interface SkuLookupRow {
  id: string;
  sku_code: string;
  barcode: string | null;
  display_name: string;
  size_code: SizeCode;
  price_paise: DbInt;
  on_hand_qty: number;
  is_active: boolean;
}

const WAITER_COLUMNS = `id, waiter_code, display_name, is_trusted, outstanding_balance, credit_limit_paise`;

function mapWaiter(r: WaiterRow): WaiterSummary {
  return {
    id: r.id,
    code: r.waiter_code,
    displayName: r.display_name,
    isTrusted: r.is_trusted,
    outstandingPaise: toPaise(r.outstanding_balance),
    creditLimitPaise: toPaiseOrNull(r.credit_limit_paise),
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
    if (!day) return { cashier, businessDay: null, peakSession: null, openBill: null };

    const session = await maybeOne<PeakSessionRow & { running_expected_paise: DbInt }>(
      this.db,
      `SELECT * FROM v_peak_sessions WHERE business_day_id = $1 AND ended_at IS NULL`,
      [day.id],
    );
    const openBill = await maybeOne<{ id: string }>(
      this.db,
      `SELECT id FROM bills
        WHERE business_day_id = $1 AND created_by_staff_id = $2
          AND status = 'OPEN' AND billing_mode = 'NORMAL' AND bill_kind = 'SALE' AND source = 'COUNTER'
        ORDER BY bill_no DESC
        LIMIT 1`,
      [day.id, cashierId],
    );

    return {
      cashier,
      businessDay: { id: day.id, businessDate: day.business_date, openedAt: day.opened_at },
      peakSession: session
        ? { ...mapPeakSession(session), runningExpectedPaise: toPaise(session.running_expected_paise) }
        : null,
      openBill: openBill ? await this.getBillDetail(openBill.id) : null,
    };
  }

  /** Resolves scanned or typed text: an exact barcode wins, then a case-insensitive SKU code. */
  async lookupSku(code: string): Promise<SkuLookup | null> {
    const text = code.trim();
    if (text === '') return null;
    const row = await maybeOne<SkuLookupRow>(
      this.db,
      `SELECT k.id, k.sku_code, k.barcode, k.display_name, k.size_code, k.price_paise, k.is_active,
              coalesce(s.on_hand_qty, 0) AS on_hand_qty
         FROM skus k
         LEFT JOIN sku_stock s ON s.sku_id = k.id
        WHERE k.barcode = $1 OR upper(k.sku_code) = upper($1)
        ORDER BY (k.barcode = $1) IS TRUE DESC
        LIMIT 1`,
      [text],
    );
    if (!row) return null;
    return {
      id: row.id,
      skuCode: row.sku_code,
      barcode: row.barcode,
      displayName: row.display_name,
      sizeCode: row.size_code,
      pricePaise: toPaise(row.price_paise),
      onHandQty: row.on_hand_qty,
      isActive: row.is_active,
    };
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
