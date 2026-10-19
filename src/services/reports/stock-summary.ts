/**
 * Stock Summary (Phase 24, Revision 1 R1): the Tamil Nadu FL2 register.
 *
 *   Item | Op.Stk | Purch | Total | Sale | Closing | P.Rate | SRate | Clo.Purch Val | Clo.Sales Val | Sales Total
 *
 * Op.Stk includes the opening counts of items created inside the range. Adj. (signed ADJUSTMENT
 * movements) is reported only when some row has one; Closing = Total − Sale + Adj. on every row.
 * Valuations are whole paise: Closing × P.Rate, Closing × SRate, Sale × SRate.
 */
import type { SqlClient } from '../../db/client.js';
import type { Paise } from '../../domain/money.js';
import type { DepartmentCode, ExciseGroup, SizeCode } from '../../domain/types.js';
import { type MlSummary, mlSummary } from './ml-summary.js';
import { dayBefore, type ReportHeader } from './shared.js';
import { stockLedger } from './stock-ledger.js';
import { type RateSource, ratesAsOf, valueOf } from './valuation.js';

export interface StockSummaryRow {
  skuId: string;
  skuCode: string;
  name: string;
  sizeCode: SizeCode;
  categoryName: string;
  centerCode: DepartmentCode;
  centerName: string;
  isActive: boolean;
  volumeMl: number | null;
  exciseGroup: ExciseGroup | null;
  opStk: number;
  purch: number;
  /** opStk + purch */
  total: number;
  sale: number;
  /** Signed ADJUSTMENT movements (breakage is negative). */
  adj: number;
  closing: number;
  /** Valuation rate as of the end date (D2); null = unrated. */
  pRatePaise: Paise | null;
  pRateSource: RateSource | null;
  /** Current selling price. */
  sRatePaise: Paise;
  cloPurchValPaise: Paise | null;
  cloSalesValPaise: Paise;
  salesTotalPaise: Paise;
  /** Op.Stk × the rate as of the day before the start date (the Full Report's opening valuation). */
  openingValPaise: Paise | null;
}

export interface StockSummaryTotals {
  opStk: number;
  purch: number;
  total: number;
  sale: number;
  adj: number;
  closing: number;
  /** Rated rows only. */
  cloPurchValPaise: Paise;
  cloSalesValPaise: Paise;
  salesTotalPaise: Paise;
  openingValPaise: Paise;
  /** Rows with stock but no P.Rate: left out of the purchase valuation. */
  unratedCount: number;
  unratedClosingQty: number;
}

export interface StockSummaryGroup {
  categoryName: string;
  rows: StockSummaryRow[];
  totals: StockSummaryTotals;
}

export interface StockSummary extends ReportHeader {
  groups: StockSummaryGroup[];
  totals: StockSummaryTotals;
  /** Show the Adj. column: some row has a stock adjustment in the range. */
  hasAdjustments: boolean;
  ml: MlSummary;
}

function totalsOf(rows: readonly StockSummaryRow[]): StockSummaryTotals {
  const t: StockSummaryTotals = {
    opStk: 0,
    purch: 0,
    total: 0,
    sale: 0,
    adj: 0,
    closing: 0,
    cloPurchValPaise: 0n,
    cloSalesValPaise: 0n,
    salesTotalPaise: 0n,
    openingValPaise: 0n,
    unratedCount: 0,
    unratedClosingQty: 0,
  };
  for (const r of rows) {
    t.opStk += r.opStk;
    t.purch += r.purch;
    t.total += r.total;
    t.sale += r.sale;
    t.adj += r.adj;
    t.closing += r.closing;
    t.cloSalesValPaise += r.cloSalesValPaise;
    t.salesTotalPaise += r.salesTotalPaise;
    if (r.cloPurchValPaise !== null) t.cloPurchValPaise += r.cloPurchValPaise;
    else if (r.closing !== 0) {
      t.unratedCount += 1;
      t.unratedClosingQty += r.closing;
    }
    if (r.openingValPaise !== null) t.openingValPaise += r.openingValPaise;
  }
  return t;
}

export async function stockSummary(db: SqlClient, head: ReportHeader): Promise<StockSummary> {
  const ledger = await stockLedger(db, head.range);
  const closingRates = await ratesAsOf(db, head.range.endDate);
  const openingRates = await ratesAsOf(db, dayBefore(head.range.startDate));

  const rows: StockSummaryRow[] = ledger.map((l) => {
    const opStk = l.openingQty + l.openingCountQty;
    const total = opStk + l.inwardQty;
    const closing = total - l.salesQty + l.adjustmentQty;
    if (closing !== l.closingQty) throw new Error(`stock summary ${l.skuCode}: Total − Sale + Adj. ${closing} ≠ closing ${l.closingQty}`);
    const rate = closingRates.get(l.skuId);
    // An item first priced inside the range has no earlier rate: its opening counts take the closing rate.
    const openingRate = openingRates.get(l.skuId) ?? rate;
    return {
      skuId: l.skuId,
      skuCode: l.skuCode,
      name: l.name,
      sizeCode: l.sizeCode,
      categoryName: l.categoryName,
      centerCode: l.centerCode,
      centerName: l.centerName,
      isActive: l.isActive,
      volumeMl: l.volumeMl,
      exciseGroup: l.exciseGroup,
      opStk,
      purch: l.inwardQty,
      total,
      sale: l.salesQty,
      adj: l.adjustmentQty,
      closing,
      pRatePaise: rate?.ratePaise ?? null,
      pRateSource: rate?.source ?? null,
      sRatePaise: l.pricePaise,
      cloPurchValPaise: valueOf(closing, rate),
      cloSalesValPaise: BigInt(closing) * l.pricePaise,
      salesTotalPaise: BigInt(l.salesQty) * l.pricePaise,
      openingValPaise: valueOf(opStk, openingRate),
    };
  });

  const groups: StockSummaryGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.categoryName === row.categoryName) last.rows.push(row);
    else groups.push({ categoryName: row.categoryName, rows: [row], totals: totalsOf([]) });
  }
  for (const g of groups) g.totals = totalsOf(g.rows);

  return {
    ...head,
    groups,
    totals: totalsOf(rows),
    hasAdjustments: rows.some((r) => r.adj !== 0),
    ml: mlSummary(ledger),
  };
}
