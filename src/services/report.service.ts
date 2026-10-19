/**
 * Reports (Phase 23): date-ranged, read-only figures for manual Tally entry and the excise registers.
 * A date is a business (trading) date (D1): a bill rung at 1:30 am belongs to the evening it was sold.
 * The open day is included and flagged `provisional` (D2). No net-profit figure is computed anywhere.
 *
 *   ledger    Sales by revenue center · liquor GRN vs center purchases · expenses by category · contra
 *   sales     every bill in the range, chronological, reversals as their own rows
 *   stock     opening · inward · sales · other · closing per stock-tracked SKU (D4)
 *   payments  Cash / UPI / Waiter credit = sales, the waiter ledger, money received (D3)
 *
 * Sales by center and every payment figure are Day End's own per-day figures (getDayFigures) summed
 * over the range, so a range always equals the sum of its Z reports.
 */
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { type DbInt, type Paise, toPaise } from '../domain/money.js';
import type { DepartmentCode, SizeCode } from '../domain/types.js';
import { getDay, getDayFigures, type SalesBreakdown } from './day-end.service.js';
import { maybeOne, one } from './rows.js';

/** At most a year (inclusive), so one request stays a few hundred Day End calls at worst. */
export const MAX_REPORT_DAYS = 366;

export interface ReportRange {
  startDate: string;
  endDate: string;
}

export interface ReportDay {
  id: string;
  businessDate: string;
  status: 'OPEN' | 'CLOSED';
}

/** Every report starts with the range and the trading days found in it. */
export interface ReportHeader {
  range: ReportRange;
  days: ReportDay[];
  /** True when a day in the range is still open: its figures change until Day End (D2). */
  provisional: boolean;
}

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

export interface StockRegisterRow {
  skuId: string;
  skuCode: string;
  name: string;
  sizeCode: SizeCode;
  categoryName: string;
  centerName: string;
  isActive: boolean;
  openingQty: number;
  /** GRN receipts. */
  inwardQty: number;
  /** Bottles out, net of restocked returns. */
  salesQty: number;
  /** New-item opening counts and adjustments. */
  otherQty: number;
  closingQty: number;
}

export interface StockRegister extends ReportHeader {
  rows: StockRegisterRow[];
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

export interface RangeAnchor {
  /** The open day, else the latest closed one, else today in India. */
  currentBusinessDate: string;
  /** null before the first day is opened. */
  firstBusinessDate: string | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function dateMs(value: unknown, name: string): number {
  const m = typeof value === 'string' ? ISO_DATE.exec(value) : null;
  if (!m) throw new RangeError(`${name} must be a date as YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new RangeError(`${name} ${value as string} is not a real date`);
  return ms;
}

/** RangeError for a malformed date, start after end, or more than MAX_REPORT_DAYS days. */
export function checkRange(range: ReportRange): ReportRange {
  const start = dateMs(range.startDate, 'startDate');
  const end = dateMs(range.endDate, 'endDate');
  if (start > end) throw new RangeError('startDate must be on or before endDate');
  if ((end - start) / DAY_MS + 1 > MAX_REPORT_DAYS) throw new RangeError(`a report covers at most ${MAX_REPORT_DAYS} days`);
  return { startDate: range.startDate, endDate: range.endDate };
}

const sum = <T>(rows: readonly T[], pick: (r: T) => Paise) => rows.reduce((total, r) => total + pick(r), 0n);
const int = (value: DbInt): number => Number(value);

/** `$1` / `$2` = the range: rows of a business day inside it. */
const IN_RANGE = `business_day_id IN (SELECT id FROM business_days WHERE business_date BETWEEN $1::date AND $2::date)`;

async function header(db: SqlClient, range: ReportRange): Promise<ReportHeader> {
  const checked = checkRange(range);
  const { rows } = await db.query<{ id: string; business_date: string; status: 'OPEN' | 'CLOSED' }>(
    `SELECT id, business_date::text AS business_date, status FROM business_days
      WHERE business_date BETWEEN $1::date AND $2::date ORDER BY business_date`,
    [checked.startDate, checked.endDate],
  );
  const days = rows.map((r) => ({ id: r.id, businessDate: r.business_date, status: r.status }));
  return { range: checked, days, provisional: days.some((d) => d.status === 'OPEN') };
}

/** Day End's figures for every day in the range, oldest first. */
async function dayFigures(db: SqlClient, days: readonly ReportDay[]): Promise<Array<{ day: ReportDay; sales: SalesBreakdown }>> {
  const out: Array<{ day: ReportDay; sales: SalesBreakdown }> = [];
  for (const day of days) out.push({ day, sales: (await getDayFigures(db, await getDay(db, day.id))).sales });
  return out;
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

interface StockRow {
  sku_id: string;
  sku_code: string;
  display_name: string;
  size_code: SizeCode;
  category_name: string;
  center_name: string;
  is_active: boolean;
  on_hand: number;
  opening: DbInt;
  inward: DbInt;
  sales: DbInt;
  other: DbInt;
  closing: DbInt;
  undated: DbInt;
}

export class ReportService {
  constructor(private readonly db: SqlDatabase) {}

  /** The anchor the date presets count from (D1). */
  async getRangeAnchor(): Promise<RangeAnchor> {
    const row = await one<{ current: string; first: string | null }>(
      this.db,
      `SELECT coalesce(
                (SELECT business_date FROM business_days ORDER BY (status = 'OPEN') DESC, business_date DESC LIMIT 1),
                (now() AT TIME ZONE 'Asia/Kolkata')::date)::text AS current,
              (SELECT min(business_date) FROM business_days)::text AS first`,
    );
    return { currentBusinessDate: row.current, firstBusinessDate: row.first };
  }

  /** Master ledger balances: grouped totals only, no profit line. */
  async getLedger(range: ReportRange): Promise<LedgerReport> {
    const head = await header(this.db, range);
    const params = [head.range.startDate, head.range.endDate];

    // Sales Accounts: Day End's split per day, summed by center.
    const figures = await dayFigures(this.db, head.days);
    const byCode = new Map<string, Paise>();
    for (const { sales } of figures) for (const d of sales.byDepartment) byCode.set(d.code, (byCode.get(d.code) ?? 0n) + d.salesPaise);
    const { rows: centers } = await this.db.query<{ code: DepartmentCode; name: string }>(`SELECT code, name FROM departments ORDER BY sort_order, lower(name)`);
    const byCenter = centers
      .map((c) => ({ code: c.code, name: c.name, salesPaise: byCode.get(c.code) ?? 0n }))
      .filter((c) => c.code === 'LIQUOR' || c.salesPaise !== 0n);
    const unallocatedPaise = sum(figures, (f) => f.sales.unallocatedPaise);

    // Purchase Accounts: GRN cost by the brand's (current) center, plus each center's supply ledger.
    const { rows: purchaseRows } = await this.db.query<{ code: DepartmentCode; name: string; grn: DbInt; supplies: DbInt; drawer: DbInt }>(
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
    const { rows: expenseRows } = await this.db.query<{ id: string; name: string; center_name: string | null; amount: DbInt; n: number }>(
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

    const deposits = await one<{ total: DbInt }>(this.db, `SELECT coalesce(sum(amount_paise), 0)::text AS total FROM bank_deposits WHERE ${IN_RANGE}`, params);

    return {
      ...head,
      sales: { byCenter, unallocatedPaise, totalPaise: sum(byCenter, (c) => c.salesPaise) + unallocatedPaise },
      purchases: { liquorGrnPaise, byCenter: purchaseCenters, totalPaise: liquorGrnPaise + sum(purchaseCenters, (c) => c.totalPaise) },
      expenses: { byCategory, totalPaise: sum(byCategory, (c) => c.amountPaise) },
      contra: { bankDepositsPaise: toPaise(deposits.total) },
    };
  }

  /** Every bill issued in the range except OPEN tabs, by business date then bill number. */
  async getSalesRegister(range: ReportRange): Promise<SalesRegister> {
    const head = await header(this.db, range);
    const params = [head.range.startDate, head.range.endDate];
    const { rows } = await this.db.query<RegisterBillRow>(
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
    const { rows: itemRows } = await this.db.query<{ bill_id: string; name: string; size_code: SizeCode; qty: number; amount: DbInt }>(
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
    const open = await one<{ n: number }>(this.db, `SELECT count(*)::int AS n FROM bills WHERE ${IN_RANGE} AND status = 'OPEN'`, params);

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

  /**
   * Opening · inward · sales · other · closing per SKU (D4). A movement is dated by its business day;
   * an opening count posted between days is dated to the next day opened after it (none yet: after
   * every range). Rows: every SKU of a stock-tracked center that is active or holds stock, plus any
   * SKU that held or moved stock in the range.
   */
  async getStockRegister(range: ReportRange): Promise<StockRegister> {
    const head = await header(this.db, range);
    const { rows } = await this.db.query<StockRow>(
      `WITH mv AS (
         SELECT m.sku_id, m.movement_type, m.qty_delta,
                coalesce(d.business_date,
                         (SELECT n.business_date FROM business_days n WHERE n.opened_at >= m.created_at ORDER BY n.opened_at LIMIT 1)) AS eff
           FROM stock_movements m LEFT JOIN business_days d ON d.id = m.business_day_id
       ), per_sku AS (
         SELECT sku_id,
                coalesce(sum(qty_delta) FILTER (WHERE eff < $1::date), 0) AS opening,
                coalesce(sum(qty_delta) FILTER (WHERE eff BETWEEN $1::date AND $2::date AND movement_type = 'PURCHASE_RECEIPT'), 0) AS inward,
                coalesce(-sum(qty_delta) FILTER (WHERE eff BETWEEN $1::date AND $2::date AND movement_type IN ('SALE', 'SALE_REVERSAL')), 0) AS sales,
                coalesce(sum(qty_delta) FILTER (WHERE eff BETWEEN $1::date AND $2::date AND movement_type IN ('OPENING', 'ADJUSTMENT')), 0) AS other,
                coalesce(sum(qty_delta) FILTER (WHERE eff <= $2::date), 0) AS closing,
                coalesce(sum(qty_delta) FILTER (WHERE eff IS NULL), 0) AS undated,
                count(*) FILTER (WHERE eff BETWEEN $1::date AND $2::date) AS moves
           FROM mv GROUP BY sku_id
       )
       SELECT k.id AS sku_id, k.sku_code, k.display_name, k.size_code, ic.name AS category_name, dp.name AS center_name,
              (k.is_active AND p.is_active) AS is_active, coalesce(st.on_hand_qty, 0)::int AS on_hand,
              coalesce(s.opening, 0)::text AS opening, coalesce(s.inward, 0)::text AS inward, coalesce(s.sales, 0)::text AS sales,
              coalesce(s.other, 0)::text AS other, coalesce(s.closing, 0)::text AS closing, coalesce(s.undated, 0)::text AS undated
         FROM skus k
         JOIN products p ON p.id = k.product_id
         JOIN departments dp ON dp.code = p.department
         JOIN item_categories ic ON ic.id = k.item_category_id
         LEFT JOIN sku_stock st ON st.sku_id = k.id
         LEFT JOIN per_sku s ON s.sku_id = k.id
        WHERE (dp.tracks_stock AND ((k.is_active AND p.is_active) OR coalesce(st.on_hand_qty, 0) <> 0))
           OR coalesce(s.moves, 0) > 0 OR coalesce(s.opening, 0) <> 0
        ORDER BY ic.sort_order, lower(ic.name), lower(p.name),
                 array_position(ARRAY['FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330', 'UNIT'], k.size_code)`,
      [head.range.startDate, head.range.endDate],
    );
    const latest = await maybeOne<{ d: string }>(this.db, `SELECT max(business_date)::text AS d FROM business_days`);
    const reachesToday = latest?.d == null || head.range.endDate >= latest.d;

    return {
      ...head,
      rows: rows.map((r) => {
        const row: StockRegisterRow = {
          skuId: r.sku_id,
          skuCode: r.sku_code,
          name: r.display_name,
          sizeCode: r.size_code,
          categoryName: r.category_name,
          centerName: r.center_name,
          isActive: r.is_active,
          openingQty: int(r.opening),
          inwardQty: int(r.inward),
          salesQty: int(r.sales),
          otherQty: int(r.other),
          closingQty: int(r.closing),
        };
        // The register must add up, and a range reaching today must end on the shelf count.
        if (row.openingQty + row.inwardQty - row.salesQty + row.otherQty !== row.closingQty) {
          throw new Error(`stock register ${row.skuCode}: opening + inward − sales + other ≠ closing ${row.closingQty}`);
        }
        if (reachesToday && row.closingQty + int(r.undated) !== int(r.on_hand)) {
          throw new Error(`stock register ${row.skuCode}: closing ${row.closingQty} disagrees with on hand ${r.on_hand}`);
        }
        return row;
      }),
    };
  }

  /** Cash / UPI / Waiter credit, the waiter ledger and money received: Day End's figures summed (D3). */
  async getPayments(range: ReportRange): Promise<PaymentsReport> {
    const head = await header(this.db, range);
    const figures = await dayFigures(this.db, head.days);
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
}
