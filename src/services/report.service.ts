/**
 * Reports (Phase 23 / Phase 24): date-ranged, read-only figures for manual Tally entry and the FL2
 * statutory registers. A date is a business (trading) date; the open day is included and flagged
 * `provisional`. No net- or gross-profit figure is computed anywhere: grouped ledger totals only.
 *
 * Every report runs in one READ ONLY, REPEATABLE READ snapshot (Phase 24 D6). The modules live in
 * ./reports/; this class is the façade the HTTP routes call.
 *
 *   Phase 23   ledger · sales register · stock register · payments
 *   Phase 24   1 sales summary (+ member-wise) · 2 order summary · 3 stock summary (TN FL2 columns, ML
 *              summary) · 4 expenses · 5 purchases · 6 bank deposits · 7 day end & variance · 8 full report
 */
import type { SqlDatabase } from '../db/client.js';
import { one } from './rows.js';
import { bankDepositLog, type BankDepositLog } from './reports/bank-deposits.js';
import { dayEndLog, type DayEndLog } from './reports/day-end-log.js';
import { expenseSummary, type ExpenseSummary, SHARED } from './reports/expenses.js';
import { type FullReport, fullReport } from './reports/full-report.js';
import { ledger, type LedgerReport, payments, type PaymentsReport } from './reports/ledger.js';
import { memberSales, type MemberSales } from './reports/member-sales.js';
import { purchaseSummary, type PurchaseSummary } from './reports/purchases.js';
import { orderSummary, type OrderSummaryReport, salesRegister, type SalesRegister } from './reports/register.js';
import { salesSummary, type SalesSummary } from './reports/sales-summary.js';
import { header, type ReportHeader, type ReportRange, snapshot } from './reports/shared.js';
import { stockRegister, type StockRegister } from './reports/stock-register.js';
import { stockSummary, type StockSummary } from './reports/stock-summary.js';
import type { SqlClient } from '../db/client.js';

export { checkRange, MAX_REPORT_DAYS } from './reports/shared.js';
export type { ReportDay, ReportHeader, ReportRange } from './reports/shared.js';
export type { LedgerCenterPurchases, LedgerCenterSales, LedgerExpense, LedgerReport, PaymentsDay, PaymentsReport } from './reports/ledger.js';
export type { OrderKot, OrderSummaryReport, OrderSummaryRow, SalesRegister, SalesRegisterItem, SalesRegisterRow } from './reports/register.js';
export type { StockRegister, StockRegisterRow } from './reports/stock-register.js';
export type { StockSummary, StockSummaryGroup, StockSummaryRow, StockSummaryTotals } from './reports/stock-summary.js';
export type { MlFigures, MlGroup, MlSizeLine, MlSummary } from './reports/ml-summary.js';
export type { SalesSummary, SalesSummaryCenter, SalesSummaryRow } from './reports/sales-summary.js';
export type { MemberSales, MemberSalesRow, MemberVisit, MemberVisitItem } from './reports/member-sales.js';
export type { ExpenseCategoryGroup, ExpenseCenterTotal, ExpenseReportEntry, ExpenseSummary } from './reports/expenses.js';
export type { PurchaseCenter, PurchaseGrn, PurchaseGrnLine, PurchaseSummary, PurchaseSupply, PurchaseSupplyLine } from './reports/purchases.js';
export type { BankDepositLog, BankDepositRow } from './reports/bank-deposits.js';
export type { DayEndLog, DayEndLogRow } from './reports/day-end-log.js';
export type { FullReport } from './reports/full-report.js';
export type { RateSource } from './reports/valuation.js';
export { SHARED as SHARED_CENTER } from './reports/expenses.js';

export interface RangeAnchor {
  /** The open day, else the latest closed one, else today in India. */
  currentBusinessDate: string;
  /** null before the first day is opened. */
  firstBusinessDate: string | null;
}

const CENTER_CODE = /^[A-Z][A-Z0-9_]{1,29}$/;

/** A center filter: a revenue center code (or SHARED for expenses), else RangeError → 400. */
function checkCenter(center: string | undefined, allowShared: boolean): string | undefined {
  if (center === undefined || center === '') return undefined;
  if (!CENTER_CODE.test(center) || (center === SHARED && !allowShared)) throw new RangeError(`center ${center} is not a revenue center code`);
  return center;
}

export class ReportService {
  constructor(private readonly db: SqlDatabase) {}

  /** Checks the range, reads its trading days and runs `fn` — all inside one read-only snapshot. */
  private run<T>(range: ReportRange, fn: (tx: SqlClient, head: ReportHeader) => Promise<T>): Promise<T> {
    return snapshot(this.db, async (tx) => fn(tx, await header(tx, range)));
  }

  /** The anchor the date presets count from. */
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

  // ── Phase 23 ──

  getLedger(range: ReportRange): Promise<LedgerReport> {
    return this.run(range, ledger);
  }

  getSalesRegister(range: ReportRange): Promise<SalesRegister> {
    return this.run(range, salesRegister);
  }

  getStockRegister(range: ReportRange): Promise<StockRegister> {
    return this.run(range, stockRegister);
  }

  getPayments(range: ReportRange): Promise<PaymentsReport> {
    return this.run(range, payments);
  }

  // ── Phase 24 ──

  /** 1 · Sales aggregated per SKU, by center, with the ML / unit summary. */
  getSalesSummary(range: ReportRange): Promise<SalesSummary> {
    return this.run(range, salesSummary);
  }

  /** 1b · Member-wise sales: tagged bills only, untagged on their own line. */
  getMemberSales(range: ReportRange): Promise<MemberSales> {
    return this.run(range, memberSales);
  }

  /** 2 · Every bill with cashier, peak session, KOTs and VOID / CANCEL tags. */
  getOrderSummary(range: ReportRange): Promise<OrderSummaryReport> {
    return this.run(range, orderSummary);
  }

  /** 3 · The TN FL2 stock register with valuations and the ML / unit summary. */
  getStockSummary(range: ReportRange): Promise<StockSummary> {
    return this.run(range, stockSummary);
  }

  /** 4 · Petty-cash payouts by category; `center` = a center code or SHARED. */
  async getExpenseSummary(range: ReportRange, center?: string): Promise<ExpenseSummary> {
    const filter = checkCenter(center, true);
    return this.run(range, (tx, head) => expenseSummary(tx, head, filter));
  }

  /** 5 · GRN and center purchases, separated by revenue center. */
  async getPurchaseSummary(range: ReportRange, center?: string): Promise<PurchaseSummary> {
    const filter = checkCenter(center, false);
    return this.run(range, (tx, head) => purchaseSummary(tx, head, filter));
  }

  /** 6 · The contra log: cash from the till to the bank. */
  getBankDeposits(range: ReportRange): Promise<BankDepositLog> {
    return this.run(range, bankDepositLog);
  }

  /** 7 · Z-read history: expected, counted, variance, UPI and who closed each day. */
  getDayEndLog(range: ReportRange): Promise<DayEndLog> {
    return this.run(range, dayEndLog);
  }

  /** 8 · The master sheet: cash book, sales / expenses / purchases by center, deposits, stock valuation. */
  getFullReport(range: ReportRange): Promise<FullReport> {
    return this.run(range, fullReport);
  }
}
