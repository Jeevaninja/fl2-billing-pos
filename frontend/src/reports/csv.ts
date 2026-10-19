/**
 * CSV export for the Reports tabs (Phase 23, D6). Amounts are written as plain rupees with two
 * decimals from bigint paise ("84230.00") — no float, no grouping, no ₹ — so a spreadsheet or Tally
 * reads them as numbers. Pure and unit-tested.
 */
import type { LedgerReport, PaymentsReport, ReportRange, SalesRegister, StockRegister } from '../api/types'
import { itemsSummary, paidByLabel } from './registerView'

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

const rangeRow = (range: ReportRange, provisional: boolean): Cell[] => [
  'Business dates',
  range.startDate,
  range.endDate,
  provisional ? 'PROVISIONAL: includes a day still open' : '',
]

/** Ledger balances: one section per account group, a total under each. Bigints are amounts. */
export function ledgerCsv(r: LedgerReport): string {
  const rows: Cell[][] = [rangeRow(r.range, r.provisional), [], ['Sales Accounts', 'Amount']]
  for (const c of r.sales.byCenter) rows.push([`${c.name} Sales`, c.salesPaise])
  if (r.sales.unallocatedPaise !== 0n) rows.push(['Not yet split (open day)', r.sales.unallocatedPaise])
  rows.push(['Total sales', r.sales.totalPaise], [], ['Purchase Accounts', 'Stock (GRN)', 'Supplies', 'Total'])
  rows.push(['Liquor purchases', r.purchases.liquorGrnPaise, 0n, r.purchases.liquorGrnPaise])
  for (const c of r.purchases.byCenter) rows.push([`${c.name} purchases`, c.grnPaise, c.suppliesPaise, c.totalPaise])
  rows.push(['Total purchases', '', '', r.purchases.totalPaise], [], ['Expense Accounts', 'Center', 'Entries', 'Amount'])
  for (const e of r.expenses.byCategory) rows.push([e.name, e.centerName ?? 'Shared', e.count, e.amountPaise])
  rows.push(['Total expenses', '', '', r.expenses.totalPaise], [], ['Contra', 'Amount'], ['Cash deposited to bank', r.contra.bankDepositsPaise])
  return toCsv(rows)
}

export function salesCsv(r: SalesRegister, time: (iso: string) => string): string {
  const rows: Cell[][] = [rangeRow(r.range, r.provisional), [], ['Date', 'Bill No', 'Time', 'Type', 'Items', 'Paid by', 'Waiter', 'Cash', 'UPI', 'Waiter credit', 'Total']]
  for (const b of r.rows) {
    const type = b.kind === 'REVERSAL' ? `VOID of #${b.reverses?.billNo ?? '?'}${b.reverses && b.reverses.businessDate !== b.businessDate ? ` (${b.reverses.businessDate})` : ''}` : b.mode === 'PEAK' ? 'Peak sale' : 'Sale'
    rows.push([b.businessDate, b.billNo, time(b.createdAt), type, itemsSummary(b.items), paidByLabel(b), b.waiterName ?? '', b.cashPaise, b.upiPaise, b.creditPaise, b.totalPaise])
  }
  rows.push([], ['Bills', r.totals.billCount, '', '', '', '', '', '', '', 'Sales', r.totals.salesPaise])
  rows.push(['Voids', r.totals.reversalCount, '', '', '', '', '', '', '', 'Voided', r.totals.reversalsPaise])
  rows.push(['', '', '', '', '', '', '', '', '', 'Net', r.totals.netPaise])
  return toCsv(rows)
}

export function stockCsv(r: StockRegister): string {
  const rows: Cell[][] = [rangeRow(r.range, r.provisional), [], ['Category', 'Code', 'Item', 'Center', 'Opening', 'Inward (GRN)', 'Sales', 'Other', 'Closing']]
  for (const s of r.rows) rows.push([s.categoryName, s.skuCode, s.name, s.centerName, s.openingQty, s.inwardQty, s.salesQty, s.otherQty, s.closingQty])
  return toCsv(rows)
}

export function paymentsCsv(r: PaymentsReport): string {
  const rows: Cell[][] = [
    rangeRow(r.range, r.provisional),
    [],
    ['Revenue by tender', 'Amount'],
    ['Cash', r.revenue.cashPaise],
    ['UPI', r.revenue.upiPaise],
    ['Waiter credit (collect later)', r.revenue.waiterCreditPaise],
    ['Total sales', r.revenue.totalSalesPaise],
    [],
    ['Split', 'Cash', 'UPI'],
    ['Counter and Captain bills', r.split.normal.cashPaise, r.split.normal.upiPaise],
    [`Peak sessions (${r.split.peak.sessionCount})`, r.split.peak.cashPaise, r.split.peak.upiPaise],
    [],
    ['Waiter ledger', 'Amount'],
    ['Credit given', r.waiterLedger.creditGivenPaise],
    ['Repaid in cash', r.waiterLedger.repaidCashPaise],
    ['Repaid in UPI', r.waiterLedger.repaidUpiPaise],
    ['Change in outstanding', r.waiterLedger.outstandingChangePaise],
    [],
    ['Received', 'Amount'],
    ['Cash received', r.received.cashPaise],
    ['UPI received', r.received.upiPaise],
    [],
    ['Date', 'Status', 'Cash', 'UPI', 'Waiter credit', 'Total sales', 'Repaid cash', 'Repaid UPI'],
  ]
  for (const d of r.byDay) rows.push([d.businessDate, d.status, d.cashPaise, d.upiPaise, d.waiterCreditPaise, d.totalSalesPaise, d.repaidCashPaise, d.repaidUpiPaise])
  return toCsv(rows)
}
