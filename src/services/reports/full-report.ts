/**
 * Full Report (Phase 24 §1.9, D4): the Tally master sheet — grouped ledger totals, never a profit line.
 *
 * Cash book over the range (each line is Day End's own per-day figure, summed):
 *
 *     opening cash (first day's float)
 *   + cash sales (Day End cash tender: counter after tally adjustments + peak cash)
 *   + waiter cash repayments
 *   − cash expenses (paid outside a peak window or inside an ended one)
 *   − drawer purchases − bank deposits
 *   + peak variances (short is negative)              → each day: = expected cash, asserted
 *   ± unreconciled (stored expected − recomputed; only days closed before a formula change)
 *   ± Day End variances (counted − expected)
 *   − cash taken out between days (day d's count − day d+1's opening float)
 *   = closing cash (last closed day's count; the open day's running expected cash)
 *
 * The identity is asserted to the paisa; nothing is forced to balance.
 */
import type { SqlClient } from '../../db/client.js';
import { type DbInt, type Paise, toPaise } from '../../domain/money.js';
import { daysWithFigures } from './day-end-log.js';
import { expenseSummary } from './expenses.js';
import { type LedgerCenterSales, salesByCenter } from './ledger.js';
import { purchaseSummary } from './purchases.js';
import { type ReportHeader, sum } from './shared.js';
import { stockSummary } from './stock-summary.js';

export interface FullReport extends ReportHeader {
  cash: {
    openingBalancePaise: Paise;
    cashSalesPaise: Paise;
    waiterCashRepaidPaise: Paise;
    cashExpensesPaise: Paise;
    drawerPurchasesPaise: Paise;
    bankDepositsPaise: Paise;
    peakVariancePaise: Paise;
    unreconciledPaise: Paise;
    dayEndVariancePaise: Paise;
    betweenDaysPaise: Paise;
    closingBalancePaise: Paise;
    /** Open day only: expenses paid inside a still-running peak window (counted when it ends; not in the lines above). */
    runningPeakExpensesPaise: Paise;
  };
  sales: { byCenter: LedgerCenterSales[]; unallocatedPaise: Paise; totalPaise: Paise };
  payments: { cashPaise: Paise; upiPaise: Paise; waiterCreditPaise: Paise };
  expenses: { byCenter: Array<{ code: string; name: string; amountPaise: Paise }>; totalPaise: Paise };
  purchases: { byCenter: Array<{ code: string; name: string; grnPaise: Paise; suppliesPaise: Paise; totalPaise: Paise }>; totalPaise: Paise };
  bankDepositsPaise: Paise;
  stock: { openingValuePaise: Paise; closingValuePaise: Paise; unratedCount: number };
}

export async function fullReport(db: SqlClient, head: ReportHeader): Promise<FullReport> {
  const days = await daysWithFigures(db, head.days);

  // Expenses inside peak windows: ended ones are part of the drawer delta, a running one isn't yet.
  const { rows: peakExpenseRows } = await db.query<{ day_id: string; ended: DbInt; running: DbInt }>(
    `SELECT e.business_day_id AS day_id,
            coalesce(sum(e.amount_paise) FILTER (WHERE s.ended_at IS NOT NULL), 0)::text AS ended,
            coalesce(sum(e.amount_paise) FILTER (WHERE s.ended_at IS NULL), 0)::text AS running
       FROM cash_expenses e JOIN peak_sessions s ON s.id = e.peak_session_id
      WHERE e.business_day_id = ANY($1::uuid[])
      GROUP BY e.business_day_id`,
    [head.days.map((d) => d.id)],
  );
  const peakExpenses = new Map(peakExpenseRows.map((r) => [r.day_id, { ended: toPaise(r.ended), running: toPaise(r.running) }]));

  const cash = {
    openingBalancePaise: days[0]?.row.openingFloatPaise ?? 0n,
    cashSalesPaise: 0n,
    waiterCashRepaidPaise: 0n,
    cashExpensesPaise: 0n,
    drawerPurchasesPaise: 0n,
    bankDepositsPaise: 0n,
    peakVariancePaise: 0n,
    unreconciledPaise: 0n,
    dayEndVariancePaise: 0n,
    betweenDaysPaise: 0n,
    closingBalancePaise: 0n,
    runningPeakExpensesPaise: 0n,
  };
  days.forEach(({ day, figures, row }, i) => {
    const b = figures.breakdown;
    const inPeak = peakExpenses.get(day.id) ?? { ended: 0n, running: 0n };
    const flows = {
      cashSales: figures.sales.total.cashPaise,
      waiterCash: figures.sales.waiterRepayments.cashPaise,
      expenses: b.cashExpensesPaise + inPeak.ended,
      drawerPurchases: b.centerPurchasesPaise,
      deposits: b.bankDepositsPaise,
      peakVariance: row.peakVariancePaise,
    };
    const expected =
      row.openingFloatPaise + flows.cashSales + flows.waiterCash - flows.expenses - flows.drawerPurchases - flows.deposits + flows.peakVariance;
    if (expected !== row.recomputedExpectedPaise) {
      throw new Error(`full report ${day.businessDate}: cash book ${expected} disagrees with Day End expected cash ${row.recomputedExpectedPaise}`);
    }
    cash.cashSalesPaise += flows.cashSales;
    cash.waiterCashRepaidPaise += flows.waiterCash;
    cash.cashExpensesPaise += flows.expenses;
    cash.drawerPurchasesPaise += flows.drawerPurchases;
    cash.bankDepositsPaise += flows.deposits;
    cash.peakVariancePaise += flows.peakVariance;
    cash.runningPeakExpensesPaise += inPeak.running;
    cash.unreconciledPaise += row.expectedCashPaise - row.recomputedExpectedPaise;
    cash.dayEndVariancePaise += row.variancePaise ?? 0n;

    const closing = row.status === 'OPEN' ? row.recomputedExpectedPaise : (row.countedCashPaise ?? row.expectedCashPaise);
    const next = days[i + 1];
    if (next) cash.betweenDaysPaise += closing - next.row.openingFloatPaise;
    else cash.closingBalancePaise = closing;
  });
  const balance =
    cash.openingBalancePaise +
    cash.cashSalesPaise +
    cash.waiterCashRepaidPaise -
    cash.cashExpensesPaise -
    cash.drawerPurchasesPaise -
    cash.bankDepositsPaise +
    cash.peakVariancePaise +
    cash.unreconciledPaise +
    cash.dayEndVariancePaise -
    cash.betweenDaysPaise;
  if (balance !== cash.closingBalancePaise) {
    throw new Error(`full report ${head.range.startDate}…${head.range.endDate}: cash book ends at ${balance}, not the closing cash ${cash.closingBalancePaise}`);
  }

  const { byCenter, unallocatedPaise } = await salesByCenter(
    db,
    days.map((d) => d.figures.sales),
  );
  const salesTotal = sum(byCenter, (c) => c.salesPaise) + unallocatedPaise;
  const payments = {
    cashPaise: sum(days, (d) => d.figures.sales.total.cashPaise),
    upiPaise: sum(days, (d) => d.figures.sales.total.upiPaise),
    waiterCreditPaise: sum(days, (d) => d.figures.sales.total.creditPaise),
  };
  if (payments.cashPaise + payments.upiPaise + payments.waiterCreditPaise !== salesTotal) {
    throw new Error(`full report: cash + UPI + credit ≠ total sales ${salesTotal}`);
  }

  const expenses = await expenseSummary(db, head);
  const purchases = await purchaseSummary(db, head);
  const stock = await stockSummary(db, head);

  return {
    ...head,
    cash,
    sales: { byCenter, unallocatedPaise, totalPaise: salesTotal },
    payments,
    expenses: { byCenter: expenses.byCenter, totalPaise: expenses.totalPaise },
    purchases: {
      byCenter: purchases.centers.map((c) => ({ code: c.code, name: c.name, grnPaise: c.grnPaise, suppliesPaise: c.suppliesPaise, totalPaise: c.totalPaise })),
      totalPaise: purchases.totalPaise,
    },
    bankDepositsPaise: cash.bankDepositsPaise,
    stock: { openingValuePaise: stock.totals.openingValPaise, closingValuePaise: stock.totals.cloPurchValPaise, unratedCount: stock.totals.unratedCount },
  };
}
