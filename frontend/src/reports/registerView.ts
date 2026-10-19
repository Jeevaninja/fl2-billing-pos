/**
 * Reports screen view helpers (Phase 23 → Phase 24): the eight-tab model, order-register labels,
 * search and paging, sales and stock grouping, and ML formatting. Pure and unit-tested.
 */
import type { OrderSummaryRow, SalesRegisterItem, SalesRegisterRow, SalesSummaryRow, StockSummaryRow, StockSummaryTotals } from '../api/types'

export type ReportTab = 'sales' | 'orders' | 'stock' | 'expenses' | 'purchases' | 'bank' | 'dayEnd' | 'full'

/** D5: the eight Phase 24 modules, keys 1–8 in this order. */
export const REPORT_TABS: ReadonlyArray<{ id: ReportTab; label: string; title: string }> = [
  { id: 'sales', label: 'Sales', title: 'Sales Summary' },
  { id: 'orders', label: 'Orders', title: 'Order Summary' },
  { id: 'stock', label: 'Stock', title: 'Stock Summary' },
  { id: 'expenses', label: 'Expenses', title: 'Expenses Summary' },
  { id: 'purchases', label: 'Purchases', title: 'Purchase Summary' },
  { id: 'bank', label: 'Bank deposits', title: 'Bank Deposits' },
  { id: 'dayEnd', label: 'Day End', title: 'Day End & Variance' },
  { id: 'full', label: 'Full report', title: 'Full Report' },
]

export function stepReportTab(current: ReportTab, delta: number): ReportTab {
  const at = Math.max(0, REPORT_TABS.findIndex((t) => t.id === current))
  return REPORT_TABS[(at + delta + REPORT_TABS.length) % REPORT_TABS.length]!.id
}

export function isReportTab(value: unknown): value is ReportTab {
  return REPORT_TABS.some((t) => t.id === value)
}

/** "2× House Rum — Quarter, 1× Chicken 65"; reversal lines keep their minus sign. */
export function itemsSummary(items: readonly SalesRegisterItem[]): string {
  return items.length === 0 ? '— (empty bill)' : items.map((i) => `${i.qty < 0 ? '−' : ''}${Math.abs(i.qty)}× ${i.name}`).join(', ')
}

/** How the bill was paid: "Peak", "Cash + UPI", "Waiter credit", or "—" for an empty bill. */
export function paidByLabel(row: Pick<SalesRegisterRow, 'mode' | 'cashPaise' | 'upiPaise' | 'creditPaise'>): string {
  if (row.mode === 'PEAK' && row.cashPaise === 0n && row.upiPaise === 0n && row.creditPaise === 0n) return 'Peak'
  const parts = [
    row.cashPaise !== 0n ? 'Cash' : null,
    row.upiPaise !== 0n ? 'UPI' : null,
    row.creditPaise !== 0n ? 'Waiter credit' : null,
  ].filter((p): p is string => p !== null)
  return parts.length === 0 ? '—' : parts.join(' + ')
}

/** "KITCHEN #12", then "KITCHEN #12/2" for the bill's second ticket at that station. */
export function kotLabel(billNo: number, kot: OrderSummaryRow['kots'][number]): string {
  return `${kot.station} #${billNo}${kot.ticketNo > 1 ? `/${kot.ticketNo}` : ''}`
}

/** VOID / CANCEL tags for the Order Summary. */
export function orderTags(row: OrderSummaryRow): string[] {
  const tags: string[] = []
  if (row.kind === 'REVERSAL') tags.push(`VOID of #${row.reverses?.billNo ?? '?'}`)
  if (row.voidedBy) tags.push(`VOIDED by #${row.voidedBy.billNo}`)
  if (row.cancelledQty > 0) tags.push(`CANCEL ${row.cancelledQty}`)
  return tags
}

/** Who rang the bill: the cashier, or the waiter for a Captain order. */
export function rungBy(row: OrderSummaryRow): string {
  if (row.source === 'WAITER_APP') return row.waiterName ? `Captain · ${row.waiterName}` : 'Captain'
  return row.cashierName ?? '—'
}

/** A number matches the bill number exactly; any text matches an item, waiter or cashier. */
export function filterOrders<T extends SalesRegisterRow & { cashierName?: string | null }>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...rows]
  if (/^#?\d+$/.test(q)) {
    const no = Number(q.replace('#', ''))
    return rows.filter((r) => r.billNo === no)
  }
  return rows.filter(
    (r) =>
      r.items.some((i) => i.name.toLowerCase().includes(q)) ||
      (r.waiterName ?? '').toLowerCase().includes(q) ||
      (r.cashierName ?? '').toLowerCase().includes(q),
  )
}

export const PAGE_SIZE = 200

export function pageCount(total: number, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size))
}

export function pageOf<T>(rows: readonly T[], page: number, size = PAGE_SIZE): T[] {
  const last = pageCount(rows.length, size) - 1
  const at = Math.min(Math.max(0, page), last)
  return rows.slice(at * size, at * size + size)
}

// ── Sales Summary ──

export interface SalesCenterGroup {
  code: string
  name: string
  qty: number
  amountPaise: bigint
  categories: Array<{ categoryName: string; rows: SalesSummaryRow[]; qty: number; amountPaise: bigint }>
}

/** Server order kept: center → item category → item; a query matches the item name or code. */
export function groupSalesSummary(rows: readonly SalesSummaryRow[], query = ''): SalesCenterGroup[] {
  const q = query.trim().toLowerCase()
  const centers: SalesCenterGroup[] = []
  for (const r of rows) {
    if (q !== '' && !r.name.toLowerCase().includes(q) && !r.skuCode.toLowerCase().includes(q)) continue
    let center = centers.find((c) => c.code === r.centerCode)
    if (!center) {
      center = { code: r.centerCode, name: r.centerName, qty: 0, amountPaise: 0n, categories: [] }
      centers.push(center)
    }
    let category = center.categories.find((c) => c.categoryName === r.categoryName)
    if (!category) {
      category = { categoryName: r.categoryName, rows: [], qty: 0, amountPaise: 0n }
      center.categories.push(category)
    }
    category.rows.push(r)
    category.qty += r.qty
    category.amountPaise += r.amountPaise
    center.qty += r.qty
    center.amountPaise += r.amountPaise
  }
  return centers
}

// ── Stock Summary ──

/** Nothing held and nothing moved in the range. */
export function isIdleStock(r: StockSummaryRow): boolean {
  return r.opStk === 0 && r.purch === 0 && r.sale === 0 && r.adj === 0 && r.closing === 0
}

/** Totals over the given rows (the same rules as the server: unrated rows stay out of Clo.Purch Val). */
export function stockTotals(rows: readonly StockSummaryRow[]): StockSummaryTotals {
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
  }
  for (const r of rows) {
    t.opStk += r.opStk
    t.purch += r.purch
    t.total += r.total
    t.sale += r.sale
    t.adj += r.adj
    t.closing += r.closing
    t.cloSalesValPaise += r.cloSalesValPaise
    t.salesTotalPaise += r.salesTotalPaise
    if (r.cloPurchValPaise !== null) t.cloPurchValPaise += r.cloPurchValPaise
    else if (r.closing !== 0) {
      t.unratedCount += 1
      t.unratedClosingQty += r.closing
    }
    if (r.openingValPaise !== null) t.openingValPaise += r.openingValPaise
  }
  return t
}

export interface StockViewGroup {
  categoryName: string
  rows: StockSummaryRow[]
  totals: StockSummaryTotals
}

/** Category groups after the "hide idle" toggle and a name / code search; totals follow what is shown. */
export function filterStockGroups(
  groups: ReadonlyArray<{ categoryName: string; rows: StockSummaryRow[] }>,
  { hideIdle, query = '' }: { hideIdle: boolean; query?: string },
): StockViewGroup[] {
  const q = query.trim().toLowerCase()
  const out: StockViewGroup[] = []
  for (const g of groups) {
    const rows = g.rows.filter(
      (r) => !(hideIdle && isIdleStock(r)) && (q === '' || r.name.toLowerCase().includes(q) || r.skuCode.toLowerCase().includes(q)),
    )
    if (rows.length > 0) out.push({ categoryName: g.categoryName, rows, totals: stockTotals(rows) })
  }
  return out
}

// ── ML ──

const GROUPING = new Intl.NumberFormat('en-IN')

/** 49500 → "49,500" (integer ml, Indian grouping). */
export function formatMl(ml: number): string {
  return GROUPING.format(ml)
}

/** 49500 → "49.500 L", from integer ml (no float division). */
export function formatLitres(ml: number): string {
  const negative = ml < 0
  const abs = Math.abs(ml)
  const rest = abs % 1000
  return `${negative ? '−' : ''}${GROUPING.format((abs - rest) / 1000)}.${String(rest).padStart(3, '0')} L`
}
