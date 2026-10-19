/**
 * CSV export for the Reports tabs (Phase 23 D6 → Phase 24 D7). Amounts are written as plain rupees
 * with two decimals from bigint paise ("84230.00") — no float, no grouping, no ₹ — so a spreadsheet or
 * Tally reads them as numbers. Nested reports (members, expenses, purchases) are flattened to one row
 * per entry carrying its group columns, so a spreadsheet can pivot them. Pure and unit-tested.
 */
import type {
  BankDepositLog,
  DayEndLog,
  ExpenseSummary,
  FullReport,
  MemberSales,
  MlSummary,
  OrderSummaryReport,
  PurchaseSummary,
  ReportRange,
  SalesSummary,
  StockSummary,
} from '../api/types'
import { itemsSummary, kotLabel, orderTags, paidByLabel, rungBy } from './registerView'

type Cell = string | number | bigint

/** Whole paise → "84230.00" / "-1200.50". */
export function paiseCsv(paise: bigint): string {
  const negative = paise < 0n
  const abs = negative ? -paise : paise
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`
}

/** Quotes when needed; text starting with = + @ is prefixed with ' so a spreadsheet never runs it. */
export function csvCell(value: Cell): string {
  if (typeof value === 'bigint') return paiseCsv(value)
  if (typeof value === 'number') return String(value)
  const safe = /^[=+@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(rows: ReadonlyArray<readonly Cell[]>): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

const rangeRow = (title: string, range: ReportRange, provisional: boolean): Cell[] => [
  title,
  range.startDate,
  range.endDate,
  provisional ? 'PROVISIONAL: includes a day still open' : '',
]

const orBlank = (paise: bigint | null): Cell => (paise === null ? '' : paise)

/** The ML / Unit Details block under the Sales and Stock CSVs. */
function mlRows(ml: MlSummary): Cell[][] {
  const rows: Cell[][] = [[], ['ML / Unit Details'], ['Group', 'Size (ml)', 'Sale units', 'Sale ml', 'Closing units', 'Closing ml']]
  for (const g of ml.groups) {
    for (const s of g.bySize) rows.push([g.label, s.volumeMl, s.saleUnits, s.saleMl, s.closingUnits, s.closingMl])
    rows.push([`${g.label} total`, '', g.saleUnits, g.saleMl, g.closingUnits, g.closingMl])
  }
  rows.push(['Grand total', '', ml.total.saleUnits, ml.total.saleMl, ml.total.closingUnits, ml.total.closingMl])
  if (ml.missing.length > 0) rows.push([`Left out (no volume / group): ${ml.missing.join(' ')}`])
  return rows
}

export function salesSummaryCsv(r: SalesSummary): string {
  const rows: Cell[][] = [rangeRow('Sales Summary', r.range, r.provisional), [], ['Center', 'Category', 'Code', 'Item', 'Qty', 'SRate', 'Amount']]
  for (const s of r.rows) rows.push([s.centerName, s.categoryName, s.skuCode, s.name, s.qty, s.sRatePaise ?? 'Mixed', s.amountPaise])
  rows.push([], ['Center', 'Qty', 'Amount'])
  for (const c of r.byCenter) rows.push([c.name, c.qty, c.amountPaise])
  rows.push(['Total', r.totalQty, r.totalPaise], ...mlRows(r.ml))
  return toCsv(rows)
}

export function memberSalesCsv(r: MemberSales, time: (iso: string) => string): string {
  const rows: Cell[][] = [
    rangeRow('Member-wise Sales', r.range, r.provisional),
    [],
    ['Member No', 'Name', 'Date', 'First bill', 'Last bill', 'Bills', 'Item', 'Qty', 'Amount'],
  ]
  for (const m of r.members) {
    for (const v of m.visits) {
      const visit = [m.membershipNo, m.name, v.businessDate, time(v.firstBillAt), time(v.lastBillAt), v.billNos.map((n) => `#${n}`).join(' ')]
      if (v.items.length === 0) rows.push([...visit, '(voided / nothing net)', 0, v.totalPaise])
      for (const i of v.items) rows.push([...visit, i.name, i.qty, i.amountPaise])
    }
  }
  rows.push([], ['Not tagged to a member', '', '', '', '', `${r.untagged.billCount} bills`, '', r.untagged.qty, r.untagged.totalPaise])
  rows.push(['Total', '', '', '', '', '', '', '', r.totalPaise])
  return toCsv(rows)
}

export function ordersCsv(r: OrderSummaryReport, time: (iso: string) => string): string {
  const rows: Cell[][] = [
    rangeRow('Order Summary', r.range, r.provisional),
    [],
    ['Date', 'Bill No', 'Time', 'Rung by', 'Peak session', 'KOT', 'Tags', 'Items', 'Paid by', 'Waiter', 'Cash', 'UPI', 'Waiter credit', 'Total'],
  ]
  for (const b of r.rows) {
    rows.push([
      b.businessDate,
      b.billNo,
      time(b.createdAt),
      rungBy(b),
      b.peakSessionNo === null ? '' : `#${b.peakSessionNo}`,
      b.kots.map((k) => kotLabel(b.billNo, k)).join(' '),
      orderTags(b).join(' '),
      itemsSummary(b.items),
      paidByLabel(b),
      b.waiterName ?? '',
      b.cashPaise,
      b.upiPaise,
      b.creditPaise,
      b.totalPaise,
    ])
  }
  const pad = (n: number) => Array<Cell>(n).fill('')
  rows.push([], ['Bills', r.totals.billCount, ...pad(10), 'Sales', r.totals.salesPaise])
  rows.push(['Voids', r.totals.reversalCount, ...pad(10), 'Voided', r.totals.reversalsPaise])
  rows.push(['Cancelled items', r.totals.cancelledQty, ...pad(10), 'Net', r.totals.netPaise])
  return toCsv(rows)
}

export function stockSummaryCsv(r: StockSummary): string {
  const head: Cell[] = ['Category', 'Code', 'Item Name', 'Op.Stk', 'Purch', 'Total', 'Sale']
  if (r.hasAdjustments) head.push('Adj.')
  head.push('Closing', 'P.Rate', 'SRate', 'Clo.Purch Val', 'Clo.Sales Val', 'Sales Total')
  const rows: Cell[][] = [rangeRow('Stock Summary', r.range, r.provisional), [], head]
  const line = (category: string, code: string, name: string, t: { opStk: number; purch: number; total: number; sale: number; adj: number; closing: number }) => {
    const cells: Cell[] = [category, code, name, t.opStk, t.purch, t.total, t.sale]
    if (r.hasAdjustments) cells.push(t.adj)
    cells.push(t.closing)
    return cells
  }
  for (const g of r.groups) {
    for (const s of g.rows) rows.push([...line(g.categoryName, s.skuCode, s.name, s), orBlank(s.pRatePaise), s.sRatePaise, orBlank(s.cloPurchValPaise), s.cloSalesValPaise, s.salesTotalPaise])
    rows.push([...line(g.categoryName, '', `${g.categoryName} total`, g.totals), '', '', g.totals.cloPurchValPaise, g.totals.cloSalesValPaise, g.totals.salesTotalPaise])
  }
  rows.push([...line('', '', 'Grand total', r.totals), '', '', r.totals.cloPurchValPaise, r.totals.cloSalesValPaise, r.totals.salesTotalPaise])
  if (r.totals.unratedCount > 0) rows.push([`${r.totals.unratedCount} item(s) without a purchase rate are left out of Clo.Purch Val (${r.totals.unratedClosingQty} bottles)`])
  rows.push(...mlRows(r.ml))
  return toCsv(rows)
}

export function expensesCsv(r: ExpenseSummary, time: (iso: string) => string): string {
  const rows: Cell[][] = [rangeRow('Expenses Summary', r.range, r.provisional), [], ['Center', 'Category', 'Date', 'Time', 'Description', 'By', 'Status', 'Amount']]
  for (const g of r.byCategory) {
    for (const e of g.entries) {
      rows.push([g.centerName ?? 'Shared', g.name, e.businessDate, time(e.at), e.description, e.byName, e.isVoid ? 'VOID' : e.voided ? 'VOIDED' : '', e.amountPaise])
    }
  }
  rows.push([], ['Category', 'Center', 'Entries', 'Amount'])
  for (const g of r.byCategory) rows.push([g.name, g.centerName ?? 'Shared', g.count, g.amountPaise])
  rows.push([], ['Center', 'Amount'])
  for (const c of r.byCenter) rows.push([c.name, c.amountPaise])
  rows.push(['Total expenses', r.totalPaise])
  return toCsv(rows)
}

export function purchasesCsv(r: PurchaseSummary): string {
  const rows: Cell[][] = [
    rangeRow('Purchase Summary', r.range, r.provisional),
    [],
    ['Center', 'Kind', 'Date', 'Invoice / vendor', 'Paid from', 'Item', 'Qty', 'Unit cost', 'Amount', 'Status'],
  ]
  for (const c of r.centers) {
    for (const g of c.grn) {
      for (const l of g.lines) rows.push([c.name, 'GRN', g.businessDate, `${g.invoiceNo}${g.vendorName ? ` · ${g.vendorName}` : ''}`, '', l.name, l.qty, l.unitCostPaise, l.amountPaise, ''])
    }
    for (const s of c.supplies) {
      const status = s.isVoid ? 'VOID' : s.voided ? 'VOIDED' : ''
      if (s.lines.length === 0) rows.push([c.name, 'Supplies', s.businessDate, s.vendorName ?? '', s.paidFrom, '', '', '', s.amountPaise, status])
      for (const l of s.lines) rows.push([c.name, 'Supplies', s.businessDate, s.vendorName ?? '', s.paidFrom, l.description, l.quantity ?? '', '', l.amountPaise, status])
    }
  }
  rows.push([], ['Center', 'GRN', 'Supplies', 'of which from drawer', 'Total'])
  for (const c of r.centers) rows.push([c.name, c.grnPaise, c.suppliesPaise, c.suppliesDrawerPaise, c.totalPaise])
  rows.push(['Total purchases', '', '', '', r.totalPaise])
  return toCsv(rows)
}

export function bankDepositsCsv(r: BankDepositLog, time: (iso: string) => string): string {
  const rows: Cell[][] = [rangeRow('Bank Deposits', r.range, r.provisional), [], ['Date', 'Time', 'Reference', 'Depositor', 'Status', 'Amount']]
  for (const d of r.rows) rows.push([d.businessDate, time(d.at), d.reference ?? '', d.depositorName, d.isVoid ? 'VOID' : d.voided ? 'VOIDED' : '', d.amountPaise])
  rows.push(['Total deposited (net of voids)', '', '', '', '', r.totalPaise])
  return toCsv(rows)
}

export function dayEndCsv(r: DayEndLog, time: (iso: string) => string): string {
  const rows: Cell[][] = [
    rangeRow('Day End & Variance', r.range, r.provisional),
    [],
    ['Date', 'Status', 'Opening float', 'Expected cash', 'Actual cash', 'Variance', 'Peak variance', 'Cash sales', 'Total UPI', 'Waiter credit', 'Total sales', 'Closed at', 'Closed by', 'Role'],
  ]
  for (const d of r.rows) {
    rows.push([
      d.businessDate,
      d.status,
      d.openingFloatPaise,
      d.expectedCashPaise,
      orBlank(d.countedCashPaise),
      orBlank(d.variancePaise),
      d.peakVariancePaise,
      d.cashSalesPaise,
      d.upiPaise,
      d.waiterCreditPaise,
      d.totalSalesPaise,
      d.closedAt ? time(d.closedAt) : '',
      d.closedByName ?? '',
      d.closedByRole ?? '',
    ])
  }
  const t = r.totals
  rows.push(['Total', '', '', t.expectedCashPaise, t.countedCashPaise, t.variancePaise, t.peakVariancePaise, '', t.upiPaise, '', t.totalSalesPaise])
  return toCsv(rows)
}

export function fullReportCsv(r: FullReport): string {
  const c = r.cash
  const rows: Cell[][] = [
    rangeRow('Full Report', r.range, r.provisional),
    [],
    ['Cash book', 'Amount'],
    ['Opening cash balance', c.openingBalancePaise],
    ['Add: cash sales', c.cashSalesPaise],
    ['Add: waiter cash repayments', c.waiterCashRepaidPaise],
    ['Less: cash expenses', -c.cashExpensesPaise],
    ['Less: purchases paid from the drawer', -c.drawerPurchasesPaise],
    ['Less: bank deposits', -c.bankDepositsPaise],
    ['Peak session variance', c.peakVariancePaise],
  ]
  if (c.unreconciledPaise !== 0n) rows.push(['Unreconciled (stored Day End)', c.unreconciledPaise])
  rows.push(['Day End variance (short / over)', c.dayEndVariancePaise], c.betweenDaysPaise < 0n ? ['Add: cash added between days', -c.betweenDaysPaise] : ['Less: cash taken out between days', -c.betweenDaysPaise], ['Closing cash balance', c.closingBalancePaise])
  rows.push([], ['Sales by department', 'Amount'])
  for (const s of r.sales.byCenter) rows.push([s.name, s.salesPaise])
  if (r.sales.unallocatedPaise !== 0n) rows.push(['Not yet split (open day)', r.sales.unallocatedPaise])
  rows.push(['Total sales', r.sales.totalPaise], [], ['Sales by tender', 'Amount'], ['Cash', r.payments.cashPaise], ['UPI', r.payments.upiPaise], ['Waiter credit', r.payments.waiterCreditPaise])
  rows.push([], ['Expenses by department', 'Amount'])
  for (const e of r.expenses.byCenter) rows.push([e.name, e.amountPaise])
  rows.push(['Total expenses', r.expenses.totalPaise], [], ['Purchases by department', 'GRN', 'Supplies', 'Total'])
  for (const p of r.purchases.byCenter) rows.push([p.name, p.grnPaise, p.suppliesPaise, p.totalPaise])
  rows.push(['Total purchases', '', '', r.purchases.totalPaise], [], ['Bank deposits', r.bankDepositsPaise], [])
  rows.push(['Stock valuation (at purchase rate)', 'Amount'], ['Opening stock', r.stock.openingValuePaise], ['Closing stock', r.stock.closingValuePaise])
  if (r.stock.unratedCount > 0) rows.push([`${r.stock.unratedCount} item(s) without a purchase rate are not valued`])
  return toCsv(rows)
}
