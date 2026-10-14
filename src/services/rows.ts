/**
 * Raw row shapes, row → domain mappers and small query helpers shared by the services.
 * Every money column passes through toPaise(), so the domain only ever sees bigint paise.
 */
import type { SqlClient } from '../db/client.js';
import { NotFoundError } from '../db/errors.js';
import { type DbInt, toPaise, toPaiseOrNull } from '../domain/money.js';
import type {
  Bill,
  BillingMode,
  BillItem,
  BillKind,
  BillPayment,
  BillSource,
  BillStatus,
  CounterTender,
  PeakSession,
  SizeCode,
  Tender,
  WaiterPayment,
} from '../domain/types.js';

export interface BillRow {
  id: string;
  business_day_id: string;
  bill_no: number;
  bill_kind: BillKind;
  billing_mode: BillingMode;
  status: BillStatus;
  source: BillSource;
  peak_session_id: string | null;
  waiter_id: string | null;
  waiter_trusted_at_billing: boolean | null;
  member_id: string | null;
  total_paise: DbInt;
  reverses_bill_id: string | null;
  replaces_bill_id: string | null;
  reversal_reason: string | null;
  created_by_staff_id: string | null;
  created_at: Date;
  settled_at: Date | null;
  settled_by_staff_id: string | null;
  peak_reconciled_at: Date | null;
}

export interface BillItemRow {
  id: string;
  bill_id: string;
  line_no: number;
  sku_id: string;
  sku_code_snapshot: string;
  display_name_snapshot: string;
  size_code_snapshot: SizeCode;
  qty: number;
  unit_price_paise: DbInt;
  line_total_paise: DbInt;
  reverses_item_id: string | null;
  restock: boolean;
}

export interface BillPaymentRow {
  id: string;
  bill_id: string;
  business_day_id: string;
  peak_session_id: string | null;
  tender_type: Tender;
  amount_paise: DbInt;
  reverses_payment_id: string | null;
  created_at: Date;
}

export interface PeakSessionRow {
  id: string;
  business_day_id: string;
  session_no: number;
  started_at: Date;
  started_by_staff_id: string;
  peak_start_cash: DbInt;
  peak_start_upi: DbInt;
  ended_at: Date | null;
  ended_by_staff_id: string | null;
  peak_end_cash: DbInt | null;
  peak_end_upi: DbInt | null;
  peak_expected_paise: DbInt | null;
  peak_variance_paise: DbInt | null;
}

export interface WaiterPaymentRow {
  id: string;
  waiter_id: string;
  business_day_id: string;
  peak_session_id: string | null;
  tender_type: CounterTender;
  amount_paise: DbInt;
  reverses_waiter_payment_id: string | null;
  created_at: Date;
}

export function mapBill(r: BillRow): Bill {
  return {
    id: r.id,
    businessDayId: r.business_day_id,
    billNo: r.bill_no,
    kind: r.bill_kind,
    mode: r.billing_mode,
    status: r.status,
    source: r.source,
    peakSessionId: r.peak_session_id,
    waiterId: r.waiter_id,
    waiterTrustedAtBilling: r.waiter_trusted_at_billing,
    memberId: r.member_id,
    totalPaise: toPaise(r.total_paise),
    reversesBillId: r.reverses_bill_id,
    replacesBillId: r.replaces_bill_id,
    reversalReason: r.reversal_reason,
    createdByStaffId: r.created_by_staff_id,
    createdAt: r.created_at,
    settledAt: r.settled_at,
    settledByStaffId: r.settled_by_staff_id,
    peakReconciledAt: r.peak_reconciled_at,
  };
}

export function mapBillItem(r: BillItemRow): BillItem {
  return {
    id: r.id,
    billId: r.bill_id,
    lineNo: r.line_no,
    skuId: r.sku_id,
    skuCode: r.sku_code_snapshot,
    displayName: r.display_name_snapshot,
    sizeCode: r.size_code_snapshot,
    quantity: r.qty,
    unitPricePaise: toPaise(r.unit_price_paise),
    lineTotalPaise: toPaise(r.line_total_paise),
    reversesItemId: r.reverses_item_id,
    restock: r.restock,
  };
}

export function mapBillPayment(r: BillPaymentRow): BillPayment {
  return {
    id: r.id,
    billId: r.bill_id,
    businessDayId: r.business_day_id,
    peakSessionId: r.peak_session_id,
    tender: r.tender_type,
    amountPaise: toPaise(r.amount_paise),
    reversesPaymentId: r.reverses_payment_id,
    createdAt: r.created_at,
  };
}

export function mapPeakSession(r: PeakSessionRow): PeakSession {
  return {
    id: r.id,
    businessDayId: r.business_day_id,
    sessionNo: r.session_no,
    startedAt: r.started_at,
    startedByStaffId: r.started_by_staff_id,
    startCashPaise: toPaise(r.peak_start_cash),
    startUpiPaise: toPaise(r.peak_start_upi),
    endedAt: r.ended_at,
    endedByStaffId: r.ended_by_staff_id,
    endCashPaise: toPaiseOrNull(r.peak_end_cash),
    endUpiPaise: toPaiseOrNull(r.peak_end_upi),
    expectedPaise: toPaiseOrNull(r.peak_expected_paise),
    variancePaise: toPaiseOrNull(r.peak_variance_paise),
  };
}

export function mapWaiterPayment(r: WaiterPaymentRow): WaiterPayment {
  return {
    id: r.id,
    waiterId: r.waiter_id,
    businessDayId: r.business_day_id,
    peakSessionId: r.peak_session_id,
    tender: r.tender_type,
    amountPaise: toPaise(r.amount_paise),
    reversesWaiterPaymentId: r.reverses_waiter_payment_id,
    createdAt: r.created_at,
  };
}

// ── Query helpers ────────────────────────────────────────────────────────────

export async function maybeOne<T>(db: SqlClient, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await db.query<T>(sql, params);
  return rows[0];
}

export async function one<T>(db: SqlClient, sql: string, params: unknown[] = []): Promise<T> {
  const row = await maybeOne<T>(db, sql, params);
  if (row === undefined) throw new Error(`expected a row from: ${sql.trim().split('\n')[0]}`);
  return row;
}

export async function getBill(db: SqlClient, billId: string, opts: { forUpdate?: boolean } = {}): Promise<Bill> {
  const row = await maybeOne<BillRow>(db, `SELECT * FROM bills WHERE id = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`, [billId]);
  if (!row) throw new NotFoundError('bill', billId);
  return mapBill(row);
}

/** Σ tenders already recorded against a bill. */
export async function tenderedPaise(db: SqlClient, billId: string): Promise<bigint> {
  const row = await one<{ tendered: DbInt }>(
    db,
    `SELECT coalesce(sum(amount_paise), 0)::text AS tendered FROM bill_payments WHERE bill_id = $1`,
    [billId],
  );
  return toPaise(row.tendered);
}

export const INSERT_PAYMENT_SQL = `
  INSERT INTO bill_payments (bill_id, tender_type, amount_paise, reverses_payment_id, received_by_staff_id)
  VALUES ($1, $2, $3, $4, $5) RETURNING *`;
