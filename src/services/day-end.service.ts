/**
 * Day End: the pre-closure checklist, the expected-cash breakdown, locking the day, opening the
 * next one with a float, and the petty-cash expense ledger. The database enforces every rule
 * (blockers, frozen expected cash and variance, the locked day); this service reads and reports.
 */
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { NotFoundError, PosError, PosErrorCode, withPosErrors } from '../db/errors.js';
import { assertPaise, type DbInt, type Paise, paiseParam, toPaise, toPaiseOrNull } from '../domain/money.js';
import type { BillSource, BillStatus } from '../domain/types.js';
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
  /** Every tender on normal bills (inside or outside peak windows), refunds included. */
  normal: { cashPaise: Paise; upiPaise: Paise; creditPaise: Paise; totalPaise: Paise };
  /** Peak bills carry no tender: UPI comes from the readings, cash = sales − UPI. */
  peak: { salesPaise: Paise; cashPaise: Paise; upiPaise: Paise; sessionCount: number; runningSessionNo: number | null };
  /** Waiter credit collected today: money in, not sales. */
  waiterRepayments: { cashPaise: Paise; upiPaise: Paise };
  total: { cashPaise: Paise; upiPaise: Paise; creditPaise: Paise; salesPaise: Paise };
}

export interface DayEndSummary {
  day: DaySummary;
  blockers: DayEndBlockers;
  /** The day is open and nothing blocks the close. */
  canClose: boolean;
  breakdown: CashBreakdown;
  sales: SalesBreakdown;
  peakSessions: PeakSessionCash[];
}

/** The cash, sales and per-peak figures of a day, shared by Day End and the peak start baseline. */
export interface DayFigures {
  breakdown: CashBreakdown;
  sales: SalesBreakdown;
  peakSessions: PeakSessionCash[];
}

export const EXPENSE_CATEGORIES = ['ICE', 'STAFF_FOOD', 'TRANSPORT', 'CLEANING', 'REPAIRS', 'OTHER'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface CashExpense {
  id: string;
  businessDayId: string;
  peakSessionId: string | null;
  /** Negative on a void row. */
  amountPaise: Paise;
  reversesExpenseId: string | null;
  category: ExpenseCategory;
  /** Optional note; required for OTHER. */
  description: string | null;
  createdByStaffId: string;
  createdAt: Date;
}

/** An expense as listed for the day: originals only, with when (if ever) it was voided. */
export interface ExpenseEntry extends CashExpense {
  voidedAt: Date | null;
}

const MAX_DESCRIPTION = 200;
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
  category: ExpenseCategory;
  description: string | null;
  created_by_staff_id: string;
  created_at: Date;
}

function mapExpense(r: ExpenseRow): CashExpense {
  return {
    id: r.id,
    businessDayId: r.business_day_id,
    peakSessionId: r.peak_session_id,
    amountPaise: toPaise(r.amount_paise),
    reversesExpenseId: r.reverses_expense_id,
    category: r.category,
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
   * A petty-cash payment from the drawer on the open day (tagged to the running peak, if any).
   * The note is optional, except for OTHER, where it is the only description.
   */
  async recordCashExpense(
    amount: Paise,
    description: string | null,
    staffId: string,
    category: ExpenseCategory = 'OTHER',
  ): Promise<CashExpense> {
    assertPaise(amount, 'amount');
    if (!EXPENSE_CATEGORIES.includes(category)) throw new RangeError(`category must be one of ${EXPENSE_CATEGORIES.join(', ')}`);
    const text = description?.trim() || null;
    if (text !== null && text.length > MAX_DESCRIPTION) throw new RangeError(`description must be at most ${MAX_DESCRIPTION} characters`);
    if (text === null && category === 'OTHER') throw new RangeError('an OTHER expense needs a description');
    return withPosErrors(async () =>
      mapExpense(
        await one<ExpenseRow>(
          this.db,
          `INSERT INTO cash_expenses (amount_paise, category, description, created_by_staff_id) VALUES ($1, $2, $3, $4) RETURNING *`,
          [paiseParam(amount), category, text, staffId],
        ),
      ),
    );
  }

  /** The day's expenses, newest first: originals only, each with the time it was voided (if it was). */
  async listCashExpenses(businessDayId: string): Promise<ExpenseEntry[]> {
    const { rows } = await this.db.query<ExpenseRow & { voided_at: Date | null }>(
      `SELECT e.*, v.created_at AS voided_at
         FROM cash_expenses e
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
        return mapExpense(
          await one<ExpenseRow>(
            tx,
            `INSERT INTO cash_expenses (amount_paise, reverses_expense_id, category, description, created_by_staff_id)
             VALUES (-$1::bigint, $2, $3, $4, $5) RETURNING *`,
            [paiseParam(toPaise(original.amount_paise)), expenseId, original.category, original.description, staffId],
          ),
        );
      }),
    );
  }
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
  };
  const canClose =
    day.status === 'OPEN' && blockers.openBills.length === 0 && blockers.runningPeakSession === null && blockers.waitersOwing.length === 0;

  return { day, blockers, canClose, ...(await getDayFigures(db, day)) };
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
    expectedCashPaise: 0n,
    upiTotalPaise: toPaise(sums.normal_upi) + toPaise(sums.waiter_upi) + sumOf((s) => s.upiDeltaPaise),
  };
  breakdown.expectedCashPaise =
    breakdown.openingFloatPaise + breakdown.normalCashPaise + breakdown.peakCashPaise + breakdown.waiterCashPaise - breakdown.cashExpensesPaise;
  if (breakdown.expectedCashPaise !== toPaise(sums.expected)) {
    throw new Error(`day ${day.businessDate}: breakdown ${breakdown.expectedCashPaise} disagrees with pos_day_expected_cash ${sums.expected}`);
  }

  const normal = { cashPaise: tender('BILL', 'CASH'), upiPaise: tender('BILL', 'UPI'), creditPaise: tender('BILL', 'WAITER_CREDIT'), totalPaise: 0n };
  normal.totalPaise = normal.cashPaise + normal.upiPaise + normal.creditPaise;
  const peak = {
    salesPaise: sumOf((s) => s.salesPaise),
    cashPaise: sumOf((s) => s.peakCashPaise),
    upiPaise: sumOf((s) => s.peakUpiPaise),
    sessionCount: peakSessions.length,
    runningSessionNo: running?.session_no ?? null,
  };
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
  };
  if (sales.total.upiPaise + sales.waiterRepayments.upiPaise !== breakdown.upiTotalPaise) {
    throw new Error(`day ${day.businessDate}: sales UPI ${sales.total.upiPaise} + repayments disagrees with UPI today ${breakdown.upiTotalPaise}`);
  }

  return { breakdown, sales, peakSessions };
}
