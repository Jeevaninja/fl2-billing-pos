/**
 * Day End: the pre-closure checklist, the expected-cash breakdown, locking the day, opening the
 * next one with a float, the petty-cash expense ledger and the bank deposit (cash drop) ledger. The database enforces every rule
 * (blockers, frozen expected cash and variance, the locked day); this service reads and reports.
 */
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { NotFoundError, PosError, PosErrorCode, withPosErrors } from '../db/errors.js';
import { assertPaise, type DbInt, type Paise, paiseParam, toPaise, toPaiseOrNull } from '../domain/money.js';
import type { BillSource, BillStatus, DepartmentCode } from '../domain/types.js';
import {
  mapPeakSessionView,
  mapWaiter,
  type PeakSessionView,
  type PeakSessionViewRow,
  WAITER_COLUMNS,
  type WaiterRow,
  type WaiterSummary,
} from './counter-queries.js';
import { mapPeakSession, maybeOne, one, type PeakSessionRow } from './rows.js';

export interface DaySummary {
  id: string;
  /** ISO date, e.g. '2026-10-15'. */
  businessDate: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: Date;
  openingFloatPaise: Paise;
  closedAt: Date | null;
  /** The close-time cash count; null while the day is open (and on days closed before 0005). */
  countedCashPaise: Paise | null;
  expectedCashPaise: Paise | null;
  /** counted − expected. Negative = shortage. */
  cashVariancePaise: Paise | null;
}

export interface OpenBillBlocker {
  billId: string;
  billNo: number;
  source: BillSource;
  status: BillStatus;
  waiter: WaiterSummary | null;
  duePaise: Paise;
  createdAt: Date;
}

export interface OwingWaiter extends WaiterSummary {
  isActive: boolean;
}

export interface DayEndBlockers {
  /** OPEN and PEAK_UNSETTLED bills of the day, by bill number. */
  openBills: OpenBillBlocker[];
  runningPeakSession: PeakSessionView | null;
  /** Every waiter with a balance above zero, whichever day the credit was raised on. */
  waitersOwing: OwingWaiter[];
  /** Phase 16: everything waiters owe (open waiter-bill dues + credit balances). Must be ₹0 to close. */
  waiterBalance: WaiterBalanceBlocker;
}

export interface WaiterBalanceBlocker {
  totalPaise: Paise;
  /** Σ due on OPEN bills tagged to a waiter. */
  openBillsPaise: Paise;
  /** Σ waiter credit balances (collect later, not yet repaid). */
  creditPaise: Paise;
  /** Waiters owing anything (open-bill due or credit). */
  waiters: number;
}

export interface CashBreakdown {
  openingFloatPaise: Paise;
  /** CASH bill tenders outside peak windows, refunds included. */
  normalCashPaise: Paise;
  /** Σ ended peak sessions (end cash − start cash). */
  peakCashPaise: Paise;
  /** CASH waiter repayments outside peak windows. */
  waiterCashPaise: Paise;
  /** Cash expenses outside peak windows (subtracted). */
  cashExpensesPaise: Paise;
  /** Σ tally adjustments' cash deltas (Phase 13): positive when UPI revenue was reclassified as cash. */
  tenderAdjustmentPaise: Paise;
  /** Cash taken out of the drawer to be banked (Phase 14; subtracted). Not an expense, not revenue. */
  bankDepositsPaise: Paise;
  /** Revenue-center purchases paid from the drawer (Phase 21 kitchen, Phase 22 every center; subtracted). */
  centerPurchasesPaise: Paise;
  expectedCashPaise: Paise;
  /** Information only: UPI collected the same way (bill and waiter UPI outside peaks + peak UPI deltas). */
  upiTotalPaise: Paise;
}

export interface PeakSessionCash {
  id: string;
  sessionNo: number;
  startedAt: Date;
  endedAt: Date;
  cashDeltaPaise: Paise;
  upiDeltaPaise: Paise;
  variancePaise: Paise;
  /** Σ the session's peak bill totals (in-session reversals included). */
  salesPaise: Paise;
  /** UPI recorded inside the window on normal bills and waiter repayments (it moved the UPI reading too). */
  inWindowUpiPaise: Paise;
  /** UPI attributed to peak sales: UPI delta − in-window recorded UPI. */
  peakUpiPaise: Paise;
  /** salesPaise − peakUpiPaise. Any session variance lands here, not in the cash count. */
  peakCashPaise: Paise;
}

/**
 * How the day's revenue was collected. Only ended peak sessions are included; tenders taken inside a
 * still-running session appear once it ends.
 */
export interface SalesBreakdown {
  /**
   * Every tender on normal bills (inside or outside peak windows), refunds included. cash / upi
   * include the day's tally adjustments; systemCash / systemUpi are as recorded on the bills. The
   * total is the same either way.
   */
  normal: { cashPaise: Paise; upiPaise: Paise; creditPaise: Paise; totalPaise: Paise; systemCashPaise: Paise; systemUpiPaise: Paise };
  /** Peak bills carry no tender: UPI comes from the readings, cash = sales − UPI. */
  peak: { salesPaise: Paise; cashPaise: Paise; upiPaise: Paise; sessionCount: number; runningSessionNo: number | null };
  /** Waiter credit collected today: money in, not sales. */
  waiterRepayments: { cashPaise: Paise; upiPaise: Paise };
  total: { cashPaise: Paise; upiPaise: Paise; creditPaise: Paise; salesPaise: Paise };
  /**
   * Phase 19, info only: the same sales split by the department snapshotted on each bill line, over
   * the bills the totals above count (settled normal bills, ended peak sessions). Liquor is always
   * listed; other revenue centers only when they sold something (Phase 22), in display order.
   */
  byDepartment: DepartmentSales[];
  /**
   * Tenders already counted above on bills not yet split: part-paid open bills, or bills settled
   * inside a still-running peak window. Σ byDepartment + this = total.salesPaise. ₹0 at close.
   */
  unallocatedPaise: Paise;
}

export interface DepartmentSales {
  code: DepartmentCode;
  name: string;
  salesPaise: Paise;
}

export interface DayEndSummary {
  day: DaySummary;
  blockers: DayEndBlockers;
  /** The day is open and nothing blocks the close. */
  canClose: boolean;
  breakdown: CashBreakdown;
  sales: SalesBreakdown;
  peakSessions: PeakSessionCash[];
  /** Tally adjustments of the day, newest first: originals only, each with when (if ever) it was voided. */
  tenderAdjustments: TenderAdjustmentEntry[];
}

/** A Cash ⇄ UPI reclassification of normal-bill revenue (cashDelta + upiDelta = 0). */
export interface TenderAdjustment {
  id: string;
  businessDayId: string;
  /** Positive: UPI revenue reclassified as cash. Negated on a void row. */
  cashDeltaPaise: Paise;
  upiDeltaPaise: Paise;
  /** Normal-bill cash / UPI as recorded on bills when the row was written. */
  systemCashPaise: Paise;
  systemUpiPaise: Paise;
  reason: string;
  reversesAdjustmentId: string | null;
  createdByStaffId: string;
  createdAt: Date;
}

export interface TenderAdjustmentEntry extends TenderAdjustment {
  voidedAt: Date | null;
}

/** The cash, sales and per-peak figures of a day, shared by Day End and the peak start baseline. */
export interface DayFigures {
  breakdown: CashBreakdown;
  sales: SalesBreakdown;
  peakSessions: PeakSessionCash[];
}

/** The fixed 0006 codes, still on pre-0012 expense rows (resolved through expense_categories.legacy_code). */
export const EXPENSE_CATEGORIES = ['ICE', 'STAFF_FOOD', 'TRANSPORT', 'CLEANING', 'REPAIRS', 'OTHER'] as const;
export type LegacyExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface CashExpense {
  id: string;
  businessDayId: string;
  peakSessionId: string | null;
  /** Negative on a void row. */
  amountPaise: Paise;
  reversesExpenseId: string | null;
  /**
   * The managed category (Phase 18); pre-0012 rows resolve through their legacy code. `department`
   * is the category's current P&L (Phase 19); null = Shared.
   */
  category: { id: string; name: string; department: DepartmentCode | null };
  /** Optional note; required when the category says so ("Other"). */
  description: string | null;
  createdByStaffId: string;
  createdAt: Date;
}

/** An expense as listed for the day: originals only, with when (if ever) it was voided. */
export interface ExpenseEntry extends CashExpense {
  voidedAt: Date | null;
}

/** Cash taken out of the drawer to be banked, e.g. for an RTGS vendor payment (Phase 14). */
export interface BankDeposit {
  id: string;
  businessDayId: string;
  /** Negative on a void row. */
  amountPaise: Paise;
  /** Optional, e.g. "RTGS to Sri Balaji". */
  reference: string | null;
  reversesDepositId: string | null;
  createdByStaffId: string;
  createdAt: Date;
}

/** A deposit as listed for the day: originals only, with when (if ever) it was voided. */
export interface BankDepositEntry extends BankDeposit {
  voidedAt: Date | null;
}

const MAX_DESCRIPTION = 200;
const MAX_REASON = 200;
const MAX_REFERENCE = 200;

interface DepositRow {
  id: string;
  business_day_id: string;
  amount_paise: DbInt;
  reference: string | null;
  reverses_deposit_id: string | null;
  created_by_staff_id: string;
  created_at: Date;
}

function mapDeposit(r: DepositRow): BankDeposit {
  return {
    id: r.id,
    businessDayId: r.business_day_id,
    amountPaise: toPaise(r.amount_paise),
    reference: r.reference,
    reversesDepositId: r.reverses_deposit_id,
    createdByStaffId: r.created_by_staff_id,
    createdAt: r.created_at,
  };
}

interface AdjustmentRow {
  id: string;
  business_day_id: string;
  cash_delta_paise: DbInt;
  upi_delta_paise: DbInt;
  system_cash_paise: DbInt;
  system_upi_paise: DbInt;
  reason: string;
  reverses_adjustment_id: string | null;
  created_by_staff_id: string;
  created_at: Date;
}

function mapAdjustment(r: AdjustmentRow): TenderAdjustment {
  return {
    id: r.id,
    businessDayId: r.business_day_id,
    cashDeltaPaise: toPaise(r.cash_delta_paise),
    upiDeltaPaise: toPaise(r.upi_delta_paise),
    systemCashPaise: toPaise(r.system_cash_paise),
    systemUpiPaise: toPaise(r.system_upi_paise),
    reason: r.reason,
    reversesAdjustmentId: r.reverses_adjustment_id,
    createdByStaffId: r.created_by_staff_id,
    createdAt: r.created_at,
  };
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface DayRow {
  id: string;
  business_date: string;
  status: 'OPEN' | 'CLOSED';
  opened_at: Date;
  opening_float_paise: DbInt;
  closed_at: Date | null;
  counted_cash_paise: DbInt | null;
  expected_cash_paise: DbInt | null;
  cash_variance_paise: DbInt | null;
}

const DAY_COLUMNS = `id, business_date::text AS business_date, status, opened_at, opening_float_paise, closed_at,
                     counted_cash_paise, expected_cash_paise, cash_variance_paise`;

function mapDay(r: DayRow): DaySummary {
  return {
    id: r.id,
    businessDate: r.business_date,
    status: r.status,
    openedAt: r.opened_at,
    openingFloatPaise: toPaise(r.opening_float_paise),
    closedAt: r.closed_at,
    countedCashPaise: toPaiseOrNull(r.counted_cash_paise),
    expectedCashPaise: toPaiseOrNull(r.expected_cash_paise),
    cashVariancePaise: toPaiseOrNull(r.cash_variance_paise),
  };
}

interface ExpenseRow {
  id: string;
  business_day_id: string;
  peak_session_id: string | null;
  amount_paise: DbInt;
  reverses_expense_id: string | null;
  category: LegacyExpenseCategory | null;
  category_id: string | null;
  /** Resolved: by id, else by legacy code. */
  cat_id: string;
  cat_name: string;
  cat_department: DepartmentCode | null;
  description: string | null;
  created_by_staff_id: string;
  created_at: Date;
}

/** Expense rows with their category resolved (id first, then the pre-0012 legacy code). */
const EXPENSE_SELECT = `
  SELECT e.*, coalesce(c.id, lc.id) AS cat_id, coalesce(c.name, lc.name) AS cat_name,
         CASE WHEN c.id IS NOT NULL THEN c.department ELSE lc.department END AS cat_department
    FROM cash_expenses e
    LEFT JOIN expense_categories c ON c.id = e.category_id
    LEFT JOIN expense_categories lc ON lc.legacy_code = e.category`;

async function getExpense(db: SqlClient, id: string): Promise<CashExpense> {
  return mapExpense(await one<ExpenseRow>(db, `${EXPENSE_SELECT} WHERE e.id = $1`, [id]));
}

function mapExpense(r: ExpenseRow): CashExpense {
  return {
    id: r.id,
    businessDayId: r.business_day_id,
    peakSessionId: r.peak_session_id,
    amountPaise: toPaise(r.amount_paise),
    reversesExpenseId: r.reverses_expense_id,
    category: { id: r.cat_id, name: r.cat_name, department: r.cat_department },
    description: r.description,
    createdByStaffId: r.created_by_staff_id,
    createdAt: r.created_at,
  };
}

export async function getDay(db: SqlClient, dayId: string, lock = false): Promise<DaySummary> {
  const row = await maybeOne<DayRow>(db, `SELECT ${DAY_COLUMNS} FROM business_days WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [dayId]);
  if (!row) throw new NotFoundError('business day', dayId);
  return mapDay(row);
}

export class DayEndService {
  constructor(private readonly db: SqlDatabase) {}

  /** The open day, else the most recently closed one; null before the first day is opened. */
  async getCurrentDayId(): Promise<string | null> {
    const row = await maybeOne<{ id: string }>(
      this.db,
      `SELECT id FROM business_days ORDER BY (status = 'OPEN') DESC, closed_at DESC NULLS LAST, business_date DESC LIMIT 1`,
    );
    return row?.id ?? null;
  }

  async getDayEndSummary(businessDayId: string): Promise<DayEndSummary> {
    return summarise(this.db, await getDay(this.db, businessDayId));
  }

  /**
   * Locks the day with the counted drawer cash. The day row is locked first, so a sale racing the
   * close either commits before it (and is counted) or fails with PS007. The database re-checks
   * every blocker and freezes expected cash and variance.
   */
  async closeBusinessDay(businessDayId: string, countedCash: Paise, staffId: string): Promise<DayEndSummary> {
    assertPaise(countedCash, 'countedCash', { allowZero: true });
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await getDay(tx, businessDayId, true);
        const day = mapDay(
          await one<DayRow>(
            tx,
            `UPDATE business_days SET status = 'CLOSED', closed_by_staff_id = $2, counted_cash_paise = $3
              WHERE id = $1 RETURNING ${DAY_COLUMNS}`,
            [businessDayId, staffId, paiseParam(countedCash)],
          ),
        );
        const summary = await summarise(tx, day);
        if (summary.breakdown.expectedCashPaise !== day.expectedCashPaise) {
          throw new Error(
            `day ${day.businessDate}: breakdown expects ${summary.breakdown.expectedCashPaise}, frozen figure is ${day.expectedCashPaise}`,
          );
        }
        // No open bill and no running peak can survive the close, so every rupee is split by department.
        if (summary.sales.unallocatedPaise !== 0n) {
          throw new Error(`day ${day.businessDate}: ${summary.sales.unallocatedPaise} paise of sales left unsplit at close`);
        }
        return summary;
      }),
    );
  }

  /**
   * Opens the next trading day with the drawer float. `businessDate` defaults to today in India;
   * a date that has already traded, or a day still open, is refused with PS007.
   */
  async openBusinessDay(openingFloat: Paise, staffId: string, businessDate?: string): Promise<DaySummary> {
    assertPaise(openingFloat, 'openingFloat', { allowZero: true });
    if (businessDate !== undefined && !ISO_DATE.test(businessDate)) throw new RangeError(`businessDate must be YYYY-MM-DD, got ${businessDate}`);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const open = await maybeOne<{ business_date: string }>(tx, `SELECT business_date::text AS business_date FROM business_days WHERE status = 'OPEN'`);
        if (open) throw new PosError(PosErrorCode.DAY_OR_PEAK_RULE, `business day ${open.business_date} is already open; close it first`);

        const date =
          businessDate ?? (await one<{ d: string }>(tx, `SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
        const traded = await maybeOne(tx, `SELECT 1 FROM business_days WHERE business_date = $1`, [date]);
        if (traded) throw new PosError(PosErrorCode.DAY_OR_PEAK_RULE, `business date ${date} has already traded`);

        return mapDay(
          await one<DayRow>(
            tx,
            `INSERT INTO business_days (business_date, opening_float_paise, opened_by_staff_id)
             VALUES ($1, $2, $3) RETURNING ${DAY_COLUMNS}`,
            [date, paiseParam(openingFloat), staffId],
          ),
        );
      }),
    );
  }

  /**
   * A petty-cash payment from the drawer on the open day (tagged to the running peak, if any), filed
   * under a managed category. The database refuses a disabled category, or a missing note where the
   * category requires one (PS002); an unknown category id is a NotFoundError.
   */
  async recordCashExpense(amount: Paise, description: string | null, staffId: string, categoryId: string): Promise<CashExpense> {
    assertPaise(amount, 'amount');
    const text = description?.trim() || null;
    if (text !== null && text.length > MAX_DESCRIPTION) throw new RangeError(`description must be at most ${MAX_DESCRIPTION} characters`);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const known = await maybeOne(tx, `SELECT 1 FROM expense_categories WHERE id = $1`, [categoryId]);
        if (!known) throw new NotFoundError('expense category', categoryId);
        const row = await one<{ id: string }>(
          tx,
          `INSERT INTO cash_expenses (amount_paise, category_id, description, created_by_staff_id) VALUES ($1, $2, $3, $4) RETURNING id`,
          [paiseParam(amount), categoryId, text, staffId],
        );
        return getExpense(tx, row.id);
      }),
    );
  }

  /**
   * Cash taken out of the drawer to be banked, on the open day. Refused while a peak session runs
   * (PS007): the peak's counted drawer would otherwise have to account for it.
   */
  async recordBankDeposit(amount: Paise, reference: string | null, staffId: string): Promise<BankDeposit> {
    assertPaise(amount, 'amount');
    const text = reference?.trim() || null;
    if (text !== null && text.length > MAX_REFERENCE) throw new RangeError(`reference must be at most ${MAX_REFERENCE} characters`);
    return withPosErrors(async () =>
      mapDeposit(
        await one<DepositRow>(
          this.db,
          `INSERT INTO bank_deposits (amount_paise, reference, created_by_staff_id) VALUES ($1, $2, $3) RETURNING *`,
          [paiseParam(amount), text, staffId],
        ),
      ),
    );
  }

  /** The day's bank deposits, newest first: originals only, each with the time it was voided (if it was). */
  async listBankDeposits(businessDayId: string): Promise<BankDepositEntry[]> {
    const { rows } = await this.db.query<DepositRow & { voided_at: Date | null }>(
      `SELECT k.*, v.created_at AS voided_at
         FROM bank_deposits k
         LEFT JOIN bank_deposits v ON v.reverses_deposit_id = k.id
        WHERE k.business_day_id = $1 AND k.amount_paise > 0
        ORDER BY k.created_at DESC, k.id DESC`,
      [businessDayId],
    );
    return rows.map((r) => ({ ...mapDeposit(r), voidedAt: r.voided_at }));
  }

  /**
   * Voids a deposit by appending its negating row. Refused for a second void or a void row (PS006)
   * and for a deposit from a closed day (PS007).
   */
  async voidBankDeposit(depositId: string, staffId: string): Promise<BankDeposit> {
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const original = await maybeOne<DepositRow>(tx, `SELECT * FROM bank_deposits WHERE id = $1`, [depositId]);
        if (!original) throw new NotFoundError('bank deposit', depositId);
        return mapDeposit(
          await one<DepositRow>(
            tx,
            `INSERT INTO bank_deposits (amount_paise, reverses_deposit_id, reference, created_by_staff_id)
             VALUES (-$1::bigint, $2, $3, $4) RETURNING *`,
            [paiseParam(toPaise(original.amount_paise)), depositId, original.reference, staffId],
          ),
        );
      }),
    );
  }

  /**
   * Tally tool: reclassifies `cashDelta` of the day's normal-bill revenue between Cash and UPI
   * (positive = UPI → Cash). The UPI side is always −cashDelta, so total revenue cannot change; the
   * database records the system figures and refuses to take either tender below ₹0 (PS002).
   */
  async adjustTenderSplit(businessDayId: string, cashDelta: Paise, reason: string, staffId: string): Promise<TenderAdjustment> {
    if (typeof cashDelta !== 'bigint') throw new TypeError('cashDelta must be a bigint of paise');
    if (cashDelta === 0n) throw new RangeError('cashDelta must not be zero');
    const text = reason.trim();
    if (text === '') throw new RangeError('a reason is required');
    if (text.length > MAX_REASON) throw new RangeError(`reason must be at most ${MAX_REASON} characters`);
    return withPosErrors(async () =>
      mapAdjustment(
        await one<AdjustmentRow>(
          this.db,
          `INSERT INTO tender_adjustments (business_day_id, cash_delta_paise, upi_delta_paise, system_cash_paise, system_upi_paise, reason, created_by_staff_id)
           VALUES ($1, $2, -$2::bigint, 0, 0, $3, $4) RETURNING *`,
          [businessDayId, paiseParam(cashDelta), text, staffId],
        ),
      ),
    );
  }

  /** Voids a tally adjustment by appending its negating row (once; open day only). */
  async voidTenderAdjustment(adjustmentId: string, staffId: string): Promise<TenderAdjustment> {
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const original = await maybeOne<AdjustmentRow>(tx, `SELECT * FROM tender_adjustments WHERE id = $1`, [adjustmentId]);
        if (!original) throw new NotFoundError('tender adjustment', adjustmentId);
        return mapAdjustment(
          await one<AdjustmentRow>(
            tx,
            `INSERT INTO tender_adjustments (business_day_id, cash_delta_paise, upi_delta_paise, system_cash_paise, system_upi_paise, reason, reverses_adjustment_id, created_by_staff_id)
             VALUES ($1, -$2::bigint, $2::bigint, 0, 0, $3, $4, $5) RETURNING *`,
            [original.business_day_id, paiseParam(toPaise(original.cash_delta_paise)), original.reason, adjustmentId, staffId],
          ),
        );
      }),
    );
  }

  /** The day's expenses, newest first: originals only, each with the time it was voided (if it was). */
  async listCashExpenses(businessDayId: string): Promise<ExpenseEntry[]> {
    const { rows } = await this.db.query<ExpenseRow & { voided_at: Date | null }>(
      `${EXPENSE_SELECT.replace('SELECT e.*,', 'SELECT e.*, v.created_at AS voided_at,')}
         LEFT JOIN cash_expenses v ON v.reverses_expense_id = e.id
        WHERE e.business_day_id = $1 AND e.amount_paise > 0
        ORDER BY e.created_at DESC, e.id DESC`,
      [businessDayId],
    );
    return rows.map((r) => ({ ...mapExpense(r), voidedAt: r.voided_at }));
  }

  /**
   * Voids an expense by appending its negating row (the original is never edited). Refused for a
   * second void (PS006) and for an expense from a closed day (PS007).
   */
  async voidCashExpense(expenseId: string, staffId: string): Promise<CashExpense> {
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const original = await maybeOne<ExpenseRow>(tx, `SELECT * FROM cash_expenses WHERE id = $1`, [expenseId]);
        if (!original) throw new NotFoundError('expense', expenseId);
        // The insert trigger copies the original's category (legacy code or id) onto the void.
        const row = await one<{ id: string }>(
          tx,
          `INSERT INTO cash_expenses (amount_paise, reverses_expense_id, category, category_id, description, created_by_staff_id)
           VALUES (-$1::bigint, $2, $3, $4, $5, $6) RETURNING id`,
          [paiseParam(toPaise(original.amount_paise)), expenseId, original.category, original.category_id, original.description, staffId],
        );
        return getExpense(tx, row.id);
      }),
    );
  }
}

function waiterBalanceBlocker(
  openBills: ReadonlyArray<{ status: BillStatus; waiter_id: string | null; due: DbInt }>,
  waiters: ReadonlyArray<WaiterRow>,
): WaiterBalanceBlocker {
  const owing = new Set<string>();
  let openBillsPaise = 0n;
  for (const b of openBills) {
    if (b.status !== 'OPEN' || b.waiter_id === null) continue;
    const due = toPaise(b.due);
    if (due <= 0n) continue;
    openBillsPaise += due;
    owing.add(b.waiter_id);
  }
  let creditPaise = 0n;
  for (const w of waiters) {
    const credit = toPaise(w.outstanding_balance);
    if (credit <= 0n) continue;
    creditPaise += credit;
    owing.add(w.id);
  }
  return { totalPaise: openBillsPaise + creditPaise, openBillsPaise, creditPaise, waiters: owing.size };
}

async function summarise(db: SqlClient, day: DaySummary): Promise<DayEndSummary> {
  const { rows: billRows } = await db.query<{
    id: string;
    bill_no: number;
    source: BillSource;
    status: BillStatus;
    waiter_id: string | null;
    due: DbInt;
    created_at: Date;
  }>(
    `SELECT b.id, b.bill_no, b.source, b.status, b.waiter_id, b.created_at,
            (b.total_paise - coalesce((SELECT sum(p.amount_paise) FROM bill_payments p WHERE p.bill_id = b.id), 0))::text AS due
       FROM bills b
      WHERE b.business_day_id = $1 AND b.status IN ('OPEN', 'PEAK_UNSETTLED')
      ORDER BY b.bill_no`,
    [day.id],
  );
  const { rows: waiterRows } = await db.query<WaiterRow & { is_active: boolean }>(`SELECT ${WAITER_COLUMNS}, is_active FROM waiters`);
  const waiters = new Map(waiterRows.map((w) => [w.id, w]));

  const session = await maybeOne<PeakSessionViewRow>(
    db,
    `SELECT * FROM v_peak_sessions WHERE business_day_id = $1 AND ended_at IS NULL`,
    [day.id],
  );
  const blockers: DayEndBlockers = {
    openBills: billRows.map((b) => {
      const waiter = b.waiter_id ? waiters.get(b.waiter_id) : undefined;
      return {
        billId: b.id,
        billNo: b.bill_no,
        source: b.source,
        status: b.status,
        waiter: waiter ? mapWaiter(waiter) : null,
        duePaise: toPaise(b.due),
        createdAt: b.created_at,
      };
    }),
    runningPeakSession: session ? mapPeakSessionView(session) : null,
    waitersOwing: waiterRows
      .filter((w) => toPaise(w.outstanding_balance) > 0n)
      .sort((a, b) => a.waiter_code.localeCompare(b.waiter_code))
      .map((w) => ({ ...mapWaiter(w), isActive: w.is_active })),
    waiterBalance: waiterBalanceBlocker(billRows, waiterRows),
  };
  const canClose =
    day.status === 'OPEN' &&
    blockers.openBills.length === 0 &&
    blockers.runningPeakSession === null &&
    blockers.waitersOwing.length === 0 &&
    blockers.waiterBalance.totalPaise === 0n;

  const { rows: adjustments } = await db.query<AdjustmentRow & { voided_at: Date | null }>(
    `SELECT a.*, v.created_at AS voided_at
       FROM tender_adjustments a
       LEFT JOIN tender_adjustments v ON v.reverses_adjustment_id = a.id
      WHERE a.business_day_id = $1 AND a.reverses_adjustment_id IS NULL
      ORDER BY a.created_at DESC, a.id DESC`,
    [day.id],
  );
  return {
    day,
    blockers,
    canClose,
    ...(await getDayFigures(db, day)),
    tenderAdjustments: adjustments.map((r) => ({ ...mapAdjustment(r), voidedAt: r.voided_at })),
  };
}

/**
 * Bills whose revenue the sales totals count in full: settled normal bills of the day (none of their
 * tenders inside a still-running peak window) and every bill of an ended peak session. `$1` = day.
 */
export const COUNTED_BILLS = `
  SELECT b.id FROM bills b
   WHERE b.business_day_id = $1 AND b.billing_mode = 'NORMAL' AND b.status = 'SETTLED'
     AND NOT EXISTS (SELECT 1 FROM bill_payments p JOIN peak_sessions s ON s.id = p.peak_session_id
                      WHERE p.bill_id = b.id AND s.ended_at IS NULL)
  UNION ALL
  SELECT b.id FROM bills b JOIN peak_sessions s ON s.id = b.peak_session_id
   WHERE s.business_day_id = $1 AND s.ended_at IS NOT NULL`;

/** Sales per department over COUNTED_BILLS, plus the counted tenders on every other bill. */
async function departmentSplit(db: SqlClient, dayId: string): Promise<Pick<SalesBreakdown, 'byDepartment' | 'unallocatedPaise'>> {
  const { rows } = await db.query<{ code: DepartmentCode; name: string; sales: DbInt }>(
    `WITH counted AS (${COUNTED_BILLS})
     SELECT code, name, sales::text AS sales FROM (
       SELECT d.code, d.name, d.sort_order,
              coalesce((SELECT sum(i.line_total_paise) FROM bill_items i
                         WHERE i.department = d.code AND i.bill_id IN (SELECT id FROM counted)), 0) AS sales
         FROM departments d
     ) x
      -- Liquor always; any other revenue center only when it sold something (Phase 22: the list is open-ended).
      WHERE code = 'LIQUOR' OR sales <> 0
      ORDER BY sort_order, lower(name)`,
    [dayId],
  );
  const open = await one<{ total: DbInt }>(
    db,
    `WITH counted AS (${COUNTED_BILLS})
     SELECT coalesce(sum(p.amount_paise), 0)::text AS total
       FROM bill_payments p LEFT JOIN peak_sessions s ON s.id = p.peak_session_id
      WHERE p.business_day_id = $1 AND (p.peak_session_id IS NULL OR s.ended_at IS NOT NULL)
        AND p.bill_id NOT IN (SELECT id FROM counted)`,
    [dayId],
  );
  return {
    byDepartment: rows.map((r) => ({ code: r.code, name: r.name, salesPaise: toPaise(r.sales) })),
    unallocatedPaise: toPaise(open.total),
  };
}

type SessionSumRow = PeakSessionRow & Record<'sales' | 'bill_cash' | 'bill_upi' | 'waiter_cash' | 'waiter_upi' | 'expenses', DbInt>;
type TenderSumRow = { kind: 'BILL' | 'WAITER'; tender_type: 'CASH' | 'UPI' | 'WAITER_CREDIT'; total: DbInt };

/**
 * Builds the day's cash breakdown (checked against pos_day_expected_cash), the sales breakdown and
 * the per-session peak split. Each balance identity is asserted, so a drift between the screens
 * throws instead of showing two different answers.
 */
export async function getDayFigures(db: SqlClient, day: DaySummary): Promise<DayFigures> {
  const { rows: ended } = await db.query<SessionSumRow>(
    `SELECT s.*,
       coalesce((SELECT sum(b.total_paise) FROM bills b WHERE b.peak_session_id = s.id), 0)::text AS sales,
       coalesce((SELECT sum(p.amount_paise) FROM bill_payments p WHERE p.peak_session_id = s.id AND p.tender_type = 'CASH'), 0)::text AS bill_cash,
       coalesce((SELECT sum(p.amount_paise) FROM bill_payments p WHERE p.peak_session_id = s.id AND p.tender_type = 'UPI'), 0)::text AS bill_upi,
       coalesce((SELECT sum(w.amount_paise) FROM waiter_payments w WHERE w.peak_session_id = s.id AND w.tender_type = 'CASH'), 0)::text AS waiter_cash,
       coalesce((SELECT sum(w.amount_paise) FROM waiter_payments w WHERE w.peak_session_id = s.id AND w.tender_type = 'UPI'), 0)::text AS waiter_upi,
       coalesce((SELECT sum(e.amount_paise) FROM cash_expenses e WHERE e.peak_session_id = s.id), 0)::text AS expenses
       FROM peak_sessions s
      WHERE s.business_day_id = $1 AND s.ended_at IS NOT NULL
      ORDER BY s.session_no`,
    [day.id],
  );
  const running = await maybeOne<{ session_no: number }>(
    db,
    `SELECT session_no FROM peak_sessions WHERE business_day_id = $1 AND ended_at IS NULL`,
    [day.id],
  );

  const sums = await one<Record<'normal_cash' | 'waiter_cash' | 'expenses' | 'normal_upi' | 'waiter_upi' | 'expected', DbInt>>(
    db,
    `SELECT
       coalesce((SELECT sum(amount_paise) FROM bill_payments
                  WHERE business_day_id = $1 AND tender_type = 'CASH' AND peak_session_id IS NULL), 0)::text AS normal_cash,
       coalesce((SELECT sum(amount_paise) FROM waiter_payments
                  WHERE business_day_id = $1 AND tender_type = 'CASH' AND peak_session_id IS NULL), 0)::text AS waiter_cash,
       coalesce((SELECT sum(amount_paise) FROM cash_expenses
                  WHERE business_day_id = $1 AND peak_session_id IS NULL), 0)::text AS expenses,
       coalesce((SELECT sum(amount_paise) FROM bill_payments
                  WHERE business_day_id = $1 AND tender_type = 'UPI' AND peak_session_id IS NULL), 0)::text AS normal_upi,
       coalesce((SELECT sum(amount_paise) FROM waiter_payments
                  WHERE business_day_id = $1 AND tender_type = 'UPI' AND peak_session_id IS NULL), 0)::text AS waiter_upi,
       pos_day_expected_cash($1)::text AS expected`,
    [day.id],
  );

  const adjusted = await one<{ cash: DbInt; deposits: DbInt; centers: DbInt }>(
    db,
    `SELECT coalesce((SELECT sum(cash_delta_paise) FROM tender_adjustments WHERE business_day_id = $1), 0)::text AS cash,
            coalesce((SELECT sum(amount_paise) FROM bank_deposits WHERE business_day_id = $1), 0)::text AS deposits,
            coalesce((SELECT sum(amount_paise) FROM revenue_center_purchases WHERE business_day_id = $1 AND paid_from = 'DRAWER'), 0)::text AS centers`,
    [day.id],
  );
  const tenderAdjustmentPaise = toPaise(adjusted.cash);

  // Every tender of the day outside a still-running window, by tender type.
  const { rows: tenderRows } = await db.query<TenderSumRow>(
    `SELECT 'BILL' AS kind, p.tender_type, sum(p.amount_paise)::text AS total
       FROM bill_payments p LEFT JOIN peak_sessions s ON s.id = p.peak_session_id
      WHERE p.business_day_id = $1 AND (p.peak_session_id IS NULL OR s.ended_at IS NOT NULL)
      GROUP BY p.tender_type
     UNION ALL
     SELECT 'WAITER' AS kind, w.tender_type, sum(w.amount_paise)::text AS total
       FROM waiter_payments w LEFT JOIN peak_sessions s ON s.id = w.peak_session_id
      WHERE w.business_day_id = $1 AND (w.peak_session_id IS NULL OR s.ended_at IS NOT NULL)
      GROUP BY w.tender_type`,
    [day.id],
  );
  const tender = (kind: TenderSumRow['kind'], type: TenderSumRow['tender_type']): Paise => {
    const row = tenderRows.find((r) => r.kind === kind && r.tender_type === type);
    return row ? toPaise(row.total) : 0n;
  };

  const peakSessions: PeakSessionCash[] = ended.map((row) => {
    const s = mapPeakSession(row);
    const cashDeltaPaise = (s.endCashPaise ?? 0n) - s.startCashPaise;
    const upiDeltaPaise = (s.endUpiPaise ?? 0n) - s.startUpiPaise;
    const variancePaise = s.variancePaise ?? 0n;
    const salesPaise = toPaise(row.sales);
    const inWindowUpiPaise = toPaise(row.bill_upi) + toPaise(row.waiter_upi);
    const peakUpiPaise = upiDeltaPaise - inWindowUpiPaise;
    const peakCashPaise = salesPaise - peakUpiPaise;
    // The derived cash must equal the counted cash delta less the other in-window cash, with the variance taken out.
    const fromDrawer = cashDeltaPaise - toPaise(row.bill_cash) - toPaise(row.waiter_cash) + toPaise(row.expenses) - variancePaise;
    if (peakCashPaise !== fromDrawer) {
      throw new Error(`peak session ${s.sessionNo}: derived peak cash ${peakCashPaise} disagrees with the drawer ${fromDrawer}`);
    }
    return {
      id: s.id,
      sessionNo: s.sessionNo,
      startedAt: s.startedAt,
      endedAt: s.endedAt as Date,
      cashDeltaPaise,
      upiDeltaPaise,
      variancePaise,
      salesPaise,
      inWindowUpiPaise,
      peakUpiPaise,
      peakCashPaise,
    };
  });
  const sumOf = (pick: (s: PeakSessionCash) => Paise): Paise => peakSessions.reduce((sum, s) => sum + pick(s), 0n);

  const breakdown: CashBreakdown = {
    openingFloatPaise: day.openingFloatPaise,
    normalCashPaise: toPaise(sums.normal_cash),
    peakCashPaise: sumOf((s) => s.cashDeltaPaise),
    waiterCashPaise: toPaise(sums.waiter_cash),
    cashExpensesPaise: toPaise(sums.expenses),
    tenderAdjustmentPaise,
    bankDepositsPaise: toPaise(adjusted.deposits),
    centerPurchasesPaise: toPaise(adjusted.centers),
    expectedCashPaise: 0n,
    upiTotalPaise: toPaise(sums.normal_upi) + toPaise(sums.waiter_upi) + sumOf((s) => s.upiDeltaPaise) - tenderAdjustmentPaise,
  };
  breakdown.expectedCashPaise =
    breakdown.openingFloatPaise +
    breakdown.normalCashPaise +
    breakdown.peakCashPaise +
    breakdown.waiterCashPaise -
    breakdown.cashExpensesPaise +
    breakdown.tenderAdjustmentPaise -
    breakdown.bankDepositsPaise -
    breakdown.centerPurchasesPaise;
  if (breakdown.expectedCashPaise !== toPaise(sums.expected)) {
    throw new Error(`day ${day.businessDate}: breakdown ${breakdown.expectedCashPaise} disagrees with pos_day_expected_cash ${sums.expected}`);
  }

  const systemCashPaise = tender('BILL', 'CASH');
  const systemUpiPaise = tender('BILL', 'UPI');
  const creditPaise = tender('BILL', 'WAITER_CREDIT');
  const normal = {
    cashPaise: systemCashPaise + tenderAdjustmentPaise,
    upiPaise: systemUpiPaise - tenderAdjustmentPaise,
    creditPaise,
    // Adjustments only move revenue between tenders, so the total is the recorded one.
    totalPaise: systemCashPaise + systemUpiPaise + creditPaise,
    systemCashPaise,
    systemUpiPaise,
  };
  if (normal.cashPaise + normal.upiPaise + normal.creditPaise !== normal.totalPaise) {
    throw new Error(`day ${day.businessDate}: adjusted normal tenders no longer add up to ${normal.totalPaise}`);
  }
  const peak = {
    salesPaise: sumOf((s) => s.salesPaise),
    cashPaise: sumOf((s) => s.peakCashPaise),
    upiPaise: sumOf((s) => s.peakUpiPaise),
    sessionCount: peakSessions.length,
    runningSessionNo: running?.session_no ?? null,
  };
  const split = await departmentSplit(db, day.id);
  const sales: SalesBreakdown = {
    normal,
    peak,
    waiterRepayments: { cashPaise: tender('WAITER', 'CASH'), upiPaise: tender('WAITER', 'UPI') },
    total: {
      cashPaise: normal.cashPaise + peak.cashPaise,
      upiPaise: normal.upiPaise + peak.upiPaise,
      creditPaise: normal.creditPaise,
      salesPaise: normal.totalPaise + peak.salesPaise,
    },
    ...split,
  };
  if (sales.total.upiPaise + sales.waiterRepayments.upiPaise !== breakdown.upiTotalPaise) {
    throw new Error(`day ${day.businessDate}: sales UPI ${sales.total.upiPaise} + repayments disagrees with UPI today ${breakdown.upiTotalPaise}`);
  }
  const splitTotal = split.byDepartment.reduce((sum, d) => sum + d.salesPaise, split.unallocatedPaise);
  if (splitTotal !== sales.total.salesPaise) {
    throw new Error(`day ${day.businessDate}: department split ${splitTotal} disagrees with total sales ${sales.total.salesPaise}`);
  }

  return { breakdown, sales, peakSessions };
}
