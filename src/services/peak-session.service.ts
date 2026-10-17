import type { SqlDatabase } from '../db/client.js';
import { NotFoundError, withPosErrors } from '../db/errors.js';
import { assertPaise, type DbInt, type Paise, paiseParam, toPaise } from '../domain/money.js';
import type { PeakSession } from '../domain/types.js';
import { getDay, getDayFigures } from './day-end.service.js';
import { mapPeakSession, maybeOne, one, type PeakSessionRow } from './rows.js';

/** How a session's expected collection was built up: Σ collections − cash expenses = expectedPaise. */
export interface PeakBreakdown {
  /** Σ peak bill totals in the session (negative peak reversals included). */
  peakBillsPaise: Paise;
  /** CASH / UPI tenders on normal (e.g. waiter) bills taken during the session, refunds included. */
  billCashPaise: Paise;
  billUpiPaise: Paise;
  /** Waiter repayments taken during the session. */
  waiterCashPaise: Paise;
  waiterUpiPaise: Paise;
  /** Cash expenses paid from the drawer during the session (subtracted). */
  cashExpensesPaise: Paise;
  expectedPaise: Paise;
  /** Counted drawer + UPI movement: (end cash − start cash) + (end UPI − start UPI). */
  actualPaise: Paise;
  cashDeltaPaise: Paise;
  upiDeltaPaise: Paise;
  /** actual − expected. Negative = shortage. */
  variancePaise: Paise;
}

/**
 * What the till should hold when a peak starts, shown before the cashier types the readings.
 * Cash is pos_day_expected_cash (earlier peaks count with their counted cash); UPI is every UPI
 * recorded today, which the GPay day total should match.
 */
export interface PeakStartBaseline {
  businessDayId: string;
  openingFloatPaise: Paise;
  /** CASH bill tenders outside peak windows, refunds included. */
  normalCashPaise: Paise;
  /** CASH waiter repayments outside peak windows. */
  waiterCashPaise: Paise;
  /** Σ earlier ended peaks' counted cash delta. */
  peakCashPaise: Paise;
  /** Cash expenses outside peak windows (subtracted). */
  cashExpensesPaise: Paise;
  expectedCashPaise: Paise;
  /** UPI tenders on normal bills, refunds included. */
  billUpiPaise: Paise;
  /** UPI waiter repayments. */
  waiterUpiPaise: Paise;
  /** Σ earlier peaks' UPI attributed to peak sales. */
  peakUpiPaise: Paise;
  expectedUpiPaise: Paise;
}

export interface PeakReconciliation {
  session: PeakSession;
  breakdown: PeakBreakdown;
}

export class PeakSessionService {
  constructor(private readonly db: SqlDatabase) {}

  /** The expected drawer cash and UPI so far on the day, for the Start peak dialog. Read-only. */
  async getStartBaseline(businessDayId: string): Promise<PeakStartBaseline> {
    const day = await getDay(this.db, businessDayId);
    const { breakdown, sales } = await getDayFigures(this.db, day);
    return {
      businessDayId: day.id,
      openingFloatPaise: breakdown.openingFloatPaise,
      normalCashPaise: breakdown.normalCashPaise,
      waiterCashPaise: breakdown.waiterCashPaise,
      peakCashPaise: breakdown.peakCashPaise,
      cashExpensesPaise: breakdown.cashExpensesPaise,
      expectedCashPaise: breakdown.expectedCashPaise,
      billUpiPaise: sales.normal.upiPaise,
      waiterUpiPaise: sales.waiterRepayments.upiPaise,
      peakUpiPaise: sales.peak.upiPaise,
      // = breakdown.upiTotalPaise (asserted in getDayFigures).
      expectedUpiPaise: sales.total.upiPaise + sales.waiterRepayments.upiPaise,
    };
  }

  /**
   * Opens a peak window on the (open) business day with the declared drawer cash and UPI reading.
   * Only one session can run at a time (PS007).
   */
  async startPeakSession(businessDayId: string, declaredCash: Paise, declaredUpi: Paise, staffId: string): Promise<PeakSession> {
    assertPaise(declaredCash, 'declaredCash', { allowZero: true });
    assertPaise(declaredUpi, 'declaredUpi', { allowZero: true });
    return withPosErrors(async () =>
      mapPeakSession(
        await one<PeakSessionRow>(
          this.db,
          `INSERT INTO peak_sessions (business_day_id, started_by_staff_id, peak_start_cash, peak_start_upi)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [businessDayId, staffId, paiseParam(declaredCash), paiseParam(declaredUpi)],
        ),
      ),
    );
  }

  /**
   * Closes the session with the counted figures. In one transaction the database computes and
   * freezes expected + variance and moves the session's peak bills to PEAK_RECONCILED.
   */
  async endPeakSession(sessionId: string, countedCash: Paise, countedUpi: Paise, staffId: string): Promise<PeakReconciliation> {
    assertPaise(countedCash, 'countedCash', { allowZero: true });
    assertPaise(countedUpi, 'countedUpi', { allowZero: true });
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const exists = await maybeOne(tx, `SELECT 1 FROM peak_sessions WHERE id = $1`, [sessionId]);
        if (!exists) throw new NotFoundError('peak session', sessionId);

        const session = mapPeakSession(
          await one<PeakSessionRow>(tx, `SELECT * FROM pos_end_peak($1, $2, $3, $4)`, [
            sessionId,
            paiseParam(countedCash),
            paiseParam(countedUpi),
            staffId,
          ]),
        );

        const sums = await one<Record<'peak_bills' | 'bill_cash' | 'bill_upi' | 'waiter_cash' | 'waiter_upi' | 'expenses', DbInt>>(
          tx,
          `SELECT
             coalesce((SELECT sum(total_paise) FROM bills WHERE peak_session_id = $1), 0)::text AS peak_bills,
             coalesce((SELECT sum(amount_paise) FROM bill_payments WHERE peak_session_id = $1 AND tender_type = 'CASH'), 0)::text AS bill_cash,
             coalesce((SELECT sum(amount_paise) FROM bill_payments WHERE peak_session_id = $1 AND tender_type = 'UPI'), 0)::text AS bill_upi,
             coalesce((SELECT sum(amount_paise) FROM waiter_payments WHERE peak_session_id = $1 AND tender_type = 'CASH'), 0)::text AS waiter_cash,
             coalesce((SELECT sum(amount_paise) FROM waiter_payments WHERE peak_session_id = $1 AND tender_type = 'UPI'), 0)::text AS waiter_upi,
             coalesce((SELECT sum(amount_paise) FROM cash_expenses WHERE peak_session_id = $1), 0)::text AS expenses`,
          [sessionId],
        );
        const peakBillsPaise = toPaise(sums.peak_bills);
        const billCashPaise = toPaise(sums.bill_cash);
        const billUpiPaise = toPaise(sums.bill_upi);
        const waiterCashPaise = toPaise(sums.waiter_cash);
        const waiterUpiPaise = toPaise(sums.waiter_upi);
        const cashExpensesPaise = toPaise(sums.expenses);
        const cashDeltaPaise = countedCash - session.startCashPaise;
        const upiDeltaPaise = countedUpi - session.startUpiPaise;
        const expectedPaise = peakBillsPaise + billCashPaise + billUpiPaise + waiterCashPaise + waiterUpiPaise - cashExpensesPaise;
        const actualPaise = cashDeltaPaise + upiDeltaPaise;

        const breakdown: PeakBreakdown = {
          peakBillsPaise,
          billCashPaise,
          billUpiPaise,
          waiterCashPaise,
          waiterUpiPaise,
          cashExpensesPaise,
          expectedPaise,
          actualPaise,
          cashDeltaPaise,
          upiDeltaPaise,
          variancePaise: actualPaise - expectedPaise,
        };
        if (breakdown.expectedPaise !== session.expectedPaise || breakdown.variancePaise !== session.variancePaise) {
          throw new Error(
            `peak session ${session.sessionNo}: breakdown (${breakdown.expectedPaise}/${breakdown.variancePaise}) ` +
              `disagrees with the frozen figures (${session.expectedPaise}/${session.variancePaise})`,
          );
        }
        return { session, breakdown };
      }),
    );
  }
}
