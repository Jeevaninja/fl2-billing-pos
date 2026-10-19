/**
 * Phase 23 ledger balances and payment bifurcation. Sales by center and every payment figure are Day
 * End's own per-day figures (getDayFigures) summed over the range, so a range always equals the sum of
 * its Z reports. Grouped totals only: no net-profit line anywhere.
 */
import type { SqlClient } from '../../db/client.js';
import { type DbInt, type Paise, toPaise } from '../../domain/money.js';
import type { DepartmentCode } from '../../domain/types.js';
import { type DayFigures, getDay, getDayFigures, type SalesBreakdown } from '../day-end.service.js';
import { one } from '../rows.js';
import { IN_RANGE, int, type ReportDay, type ReportHeader, sum } from './shared.js';

export interface LedgerCenterSales {
  code: DepartmentCode;
  name: string;
  salesPaise: Paise;
}

export interface LedgerCenterPurchases {
  code: DepartmentCode;
  name: string;
  /** GRN lines for items whose brand is in the center (qty × unit cost). */
  grnPaise: Paise;
  /** The center's own supply ledger, voids netted out … */
  suppliesPaise: Paise;
  /** … of which paid from the drawer. */
  suppliesDrawerPaise: Paise;
  totalPaise: Paise;
}

export interface LedgerExpense {
  categoryId: string;
  name: string;
  /** null = Shared overheads. */
  centerName: string | null;
  amountPaise: Paise;
  /** Expenses still standing (originals not voided). */
  count: number;
}

export interface LedgerReport extends ReportHeader {
  sales: {
    byCenter: LedgerCenterSales[];
    /** Open day only: tenders Day End can't split by center yet (part-paid tabs). */
    unallocatedPaise: Paise;
    /** Σ byCenter + unallocated = the payments report's total sales. */
    totalPaise: Paise;
  };
  purchases: {
    /** GRN lines for LIQUOR brands. */
    liquorGrnPaise: Paise;
    byCenter: LedgerCenterPurchases[];
    totalPaise: Paise;
  };
  expenses: { byCategory: LedgerExpense[]; totalPaise: Paise };
  /** D5: cash taken to the bank — a contra entry, never an expense. */
  contra: { bankDepositsPaise: Paise };
}

export interface PaymentsDay {
  businessDate: string;
  status: 'OPEN' | 'CLOSED';
  cashPaise: Paise;
  upiPaise: Paise;
  waiterCreditPaise: Paise;
  totalSalesPaise: Paise;
  repaidCashPaise: Paise;
  repaidUpiPaise: Paise;
}

export interface PaymentsReport extends ReportHeader {
  /** How each rupee of sales was paid: cash + upi + waiterCredit = totalSales. */
  revenue: { cashPaise: Paise; upiPaise: Paise; waiterCreditPaise: Paise; totalSalesPaise: Paise };
  split: {
    /** Counter and Captain tenders, after tally adjustments. */
    normal: { cashPaise: Paise; upiPaise: Paise };
    /** From the peak readings; any variance sits in cash. */
    peak: { cashPaise: Paise; upiPaise: Paise; sessionCount: number };
  };
  waiterLedger: { creditGivenPaise: Paise; repaidCashPaise: Paise; repaidUpiPaise: Paise; outstandingChangePaise: Paise };
  /** Money actually taken in: sales cash / UPI plus waiter repayments. */
  received: { cashPaise: Paise; upiPaise: Paise };
  byDay: PaymentsDay[];
}

/** Day End's figures for every day in the range, oldest first. */
export async function dayFigures(db: SqlClient, days: readonly ReportDay[]): Promise<Array<{ day: ReportDay; sales: SalesBreakdown; figures: DayFigures }>> {
  const out: Array<{ day: ReportDay; sales: SalesBreakdown; figures: DayFigures }> = [];
  for (const day of days) {
    const figures = await getDayFigures(db, await getDay(db, day.id));
    out.push({ day, sales: figures.sales, figures });
  }
  return out;
}

/** Day End's per-day split by center, summed: Liquor always, any other center that sold something. */
export async function salesByCenter(db: SqlClient, days: readonly SalesBreakdown[]): Promise<{ byCenter: LedgerCenterSales[]; unallocatedPaise: Paise }> {
  const byCode = new Map<string, Paise>();
  for (const sales of days) for (const d of sales.byDepartment) byCode.set(d.code, (byCode.get(d.code) ?? 0n) + d.salesPaise);
  const { rows: centers } = await db.query<{ code: DepartmentCode; name: string }>(`SELECT code, name FROM departments ORDER BY sort_order, lower(name)`);
  const byCenter = centers
    .map((c) => ({ code: c.code, name: c.name, salesPaise: byCode.get(c.code) ?? 0n }))
    .filter((c) => c.code === 'LIQUOR' || c.salesPaise !== 0n);
  return { byCenter, unallocatedPaise: sum(days, (s) => s.unallocatedPaise) };
}

/** Master ledger balances: grouped totals only, no profit line. */
export async function ledger(db: SqlClient, head: ReportHeader): Promise<LedgerReport> {
  const params = [head.range.startDate, head.range.endDate];

  // Sales Accounts: Day End's split per day, summed by center.
  const { byCenter, unallocatedPaise } = await salesByCenter(db, (await dayFigures(db, head.days)).map((f) => f.sales));

  // Purchase Accounts: GRN cost by the brand's (current) center, plus each center's supply ledger.
  const { rows: purchaseRows } = await db.query<{ code: DepartmentCode; name: string; grn: DbInt; supplies: DbInt; drawer: DbInt }>(
    `WITH grn AS (
       SELECT p.department AS code, sum(rl.qty::bigint * rl.unit_cost_paise) AS amount
         FROM stock_receipt_lines rl
         JOIN stock_receipts r ON r.id = rl.receipt_id
         JOIN skus k ON k.id = rl.sku_id
         JOIN products p ON p.id = k.product_id
        WHERE r.${IN_RANGE}
        GROUP BY p.department
     ), supplies AS (
       SELECT department AS code, sum(amount_paise) AS amount, sum(amount_paise) FILTER (WHERE paid_from = 'DRAWER') AS drawer
         FROM revenue_center_purchases WHERE ${IN_RANGE}
        GROUP BY department
     )
     SELECT d.code, d.name, coalesce(g.amount, 0)::text AS grn, coalesce(s.amount, 0)::text AS supplies, coalesce(s.drawer, 0)::text AS drawer
       FROM departments d
       LEFT JOIN grn g ON g.code = d.code
       LEFT JOIN supplies s ON s.code = d.code
      WHERE coalesce(g.amount, 0) <> 0 OR coalesce(s.amount, 0) <> 0 OR d.code = 'LIQUOR'
      ORDER BY d.sort_order, lower(d.name)`,
    params,
  );
  const liquorGrnPaise = toPaise(purchaseRows.find((r) => r.code === 'LIQUOR')?.grn ?? 0);
  const purchaseCenters = purchaseRows
    .filter((r) => r.code !== 'LIQUOR')
    .map((r) => {
      const grnPaise = toPaise(r.grn);
      const suppliesPaise = toPaise(r.supplies);
      return { code: r.code, name: r.name, grnPaise, suppliesPaise, suppliesDrawerPaise: toPaise(r.drawer), totalPaise: grnPaise + suppliesPaise };
    });

  // Expense Accounts: by the managed category (pre-0012 rows resolve through legacy_code).
  const { rows: expenseRows } = await db.query<{ id: string; name: string; center_name: string | null; amount: DbInt; n: number }>(
    `SELECT c.id, c.name, d.name AS center_name, sum(e.amount_paise)::text AS amount,
            (count(*) FILTER (WHERE e.reverses_expense_id IS NULL
                                AND NOT EXISTS (SELECT 1 FROM cash_expenses v WHERE v.reverses_expense_id = e.id)))::int AS n
       FROM cash_expenses e
       JOIN expense_categories c ON c.id = e.category_id OR (e.category_id IS NULL AND c.legacy_code = e.category)
       LEFT JOIN departments d ON d.code = c.department
      WHERE e.${IN_RANGE}
      GROUP BY c.id, c.name, c.sort_order, d.name
     HAVING sum(e.amount_paise) <> 0
      ORDER BY c.sort_order, lower(c.name)`,
    params,
  );
  const byCategory = expenseRows.map((r) => ({ categoryId: r.id, name: r.name, centerName: r.center_name, amountPaise: toPaise(r.amount), count: int(r.n) }));

  const deposits = await one<{ total: DbInt }>(db, `SELECT coalesce(sum(amount_paise), 0)::text AS total FROM bank_deposits WHERE ${IN_RANGE}`, params);

  return {
    ...head,
    sales: { byCenter, unallocatedPaise, totalPaise: sum(byCenter, (c) => c.salesPaise) + unallocatedPaise },
    purchases: { liquorGrnPaise, byCenter: purchaseCenters, totalPaise: liquorGrnPaise + sum(purchaseCenters, (c) => c.totalPaise) },
    expenses: { byCategory, totalPaise: sum(byCategory, (c) => c.amountPaise) },
    contra: { bankDepositsPaise: toPaise(deposits.total) },
  };
}

/** Cash / UPI / Waiter credit, the waiter ledger and money received: Day End's figures summed (D3). */
export async function payments(db: SqlClient, head: ReportHeader): Promise<PaymentsReport> {
  const figures = await dayFigures(db, head.days);
  const total = (pick: (s: SalesBreakdown) => Paise) => sum(figures, (f) => pick(f.sales));
  const revenue = {
    cashPaise: total((s) => s.total.cashPaise),
    upiPaise: total((s) => s.total.upiPaise),
    waiterCreditPaise: total((s) => s.total.creditPaise),
    totalSalesPaise: total((s) => s.total.salesPaise),
  };
  if (revenue.cashPaise + revenue.upiPaise + revenue.waiterCreditPaise !== revenue.totalSalesPaise) {
    throw new Error(`payments ${head.range.startDate}…${head.range.endDate}: cash + UPI + credit ≠ total sales ${revenue.totalSalesPaise}`);
  }
  const repaidCashPaise = total((s) => s.waiterRepayments.cashPaise);
  const repaidUpiPaise = total((s) => s.waiterRepayments.upiPaise);
  return {
    ...head,
    revenue,
    split: {
      normal: { cashPaise: total((s) => s.normal.cashPaise), upiPaise: total((s) => s.normal.upiPaise) },
      peak: { cashPaise: total((s) => s.peak.cashPaise), upiPaise: total((s) => s.peak.upiPaise), sessionCount: figures.reduce((n, f) => n + f.sales.peak.sessionCount, 0) },
    },
    waiterLedger: {
      creditGivenPaise: revenue.waiterCreditPaise,
      repaidCashPaise,
      repaidUpiPaise,
      outstandingChangePaise: revenue.waiterCreditPaise - repaidCashPaise - repaidUpiPaise,
    },
    received: { cashPaise: revenue.cashPaise + repaidCashPaise, upiPaise: revenue.upiPaise + repaidUpiPaise },
    byDay: figures.map(({ day, sales }) => ({
      businessDate: day.businessDate,
      status: day.status,
      cashPaise: sales.total.cashPaise,
      upiPaise: sales.total.upiPaise,
      waiterCreditPaise: sales.total.creditPaise,
      totalSalesPaise: sales.total.salesPaise,
      repaidCashPaise: sales.waiterRepayments.cashPaise,
      repaidUpiPaise: sales.waiterRepayments.upiPaise,
    })),
  };
}
