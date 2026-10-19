/**
 * Day End & Variance (Phase 24 §1.8): one row per trading day — the Z-read history. A closed day shows
 * the figures frozen at close (expected, counted, variance); the open day shows its running expected
 * cash and no count. Sales and UPI are Day End's own figures, so each row equals that day's Z report.
 */
import type { SqlClient } from '../../db/client.js';
import { type DbInt, type Paise, toPaise, toPaiseOrNull } from '../../domain/money.js';
import type { DayFigures } from '../day-end.service.js';
import { dayFigures } from './ledger.js';
import { type ReportDay, type ReportHeader, sum } from './shared.js';

export interface DayEndLogRow {
  businessDate: string;
  status: 'OPEN' | 'CLOSED';
  openingFloatPaise: Paise;
  /** Frozen at close; the running figure on the open day. */
  expectedCashPaise: Paise;
  /** The running expected cash recomputed now (equals the stored one unless a later migration changed the formula). */
  recomputedExpectedPaise: Paise;
  countedCashPaise: Paise | null;
  /** counted − expected: negative = short, positive = over. */
  variancePaise: Paise | null;
  /** Σ that day's peak-session variances (already inside expected cash). */
  peakVariancePaise: Paise;
  cashSalesPaise: Paise;
  /** UPI received that day: sales UPI plus waiter UPI repayments. */
  upiPaise: Paise;
  waiterCreditPaise: Paise;
  totalSalesPaise: Paise;
  closedAt: Date | null;
  closedByName: string | null;
  closedByRole: string | null;
}

export interface DayEndLog extends ReportHeader {
  rows: DayEndLogRow[];
  totals: {
    expectedCashPaise: Paise;
    countedCashPaise: Paise;
    variancePaise: Paise;
    peakVariancePaise: Paise;
    upiPaise: Paise;
    totalSalesPaise: Paise;
  };
}

export interface DayWithFigures {
  day: ReportDay;
  figures: DayFigures;
  row: DayEndLogRow;
}

/** Day End figures plus the stored close-time columns, per day, oldest first. */
export async function daysWithFigures(db: SqlClient, days: readonly ReportDay[]): Promise<DayWithFigures[]> {
  if (days.length === 0) return [];
  const { rows: stored } = await db.query<{
    id: string;
    opening_float: DbInt;
    counted: DbInt | null;
    expected: DbInt | null;
    variance: DbInt | null;
    closed_at: Date | null;
    closed_by: string | null;
    closed_role: string | null;
  }>(
    `SELECT d.id, d.opening_float_paise::text AS opening_float, d.counted_cash_paise::text AS counted,
            d.expected_cash_paise::text AS expected, d.cash_variance_paise::text AS variance,
            d.closed_at, s.display_name AS closed_by, s.role AS closed_role
       FROM business_days d LEFT JOIN staff s ON s.id = d.closed_by_staff_id
      WHERE d.id = ANY($1::uuid[])`,
    [days.map((d) => d.id)],
  );
  const byId = new Map(stored.map((s) => [s.id, s]));
  return (await dayFigures(db, days)).map(({ day, figures }) => {
    const s = byId.get(day.id);
    if (!s) throw new Error(`day end log: day ${day.businessDate} missing`);
    const recomputed = figures.breakdown.expectedCashPaise;
    const closed = day.status === 'CLOSED';
    const row: DayEndLogRow = {
      businessDate: day.businessDate,
      status: day.status,
      openingFloatPaise: toPaise(s.opening_float),
      expectedCashPaise: closed && s.expected !== null ? toPaise(s.expected) : recomputed,
      recomputedExpectedPaise: recomputed,
      countedCashPaise: closed ? toPaiseOrNull(s.counted) : null,
      variancePaise: closed ? toPaiseOrNull(s.variance) : null,
      peakVariancePaise: figures.peakSessions.reduce((t, p) => t + p.variancePaise, 0n),
      cashSalesPaise: figures.sales.total.cashPaise,
      upiPaise: figures.breakdown.upiTotalPaise,
      waiterCreditPaise: figures.sales.total.creditPaise,
      totalSalesPaise: figures.sales.total.salesPaise,
      closedAt: s.closed_at,
      closedByName: s.closed_by,
      closedByRole: s.closed_role,
    };
    return { day, figures, row };
  });
}

export async function dayEndLog(db: SqlClient, head: ReportHeader): Promise<DayEndLog> {
  const rows = (await daysWithFigures(db, head.days)).map((d) => d.row);
  return {
    ...head,
    rows,
    totals: {
      expectedCashPaise: sum(rows, (r) => r.expectedCashPaise),
      countedCashPaise: sum(rows, (r) => r.countedCashPaise ?? 0n),
      variancePaise: sum(rows, (r) => r.variancePaise ?? 0n),
      peakVariancePaise: sum(rows, (r) => r.peakVariancePaise),
      upiPaise: sum(rows, (r) => r.upiPaise),
      totalSalesPaise: sum(rows, (r) => r.totalSalesPaise),
    },
  };
}
