/**
 * Reports screen view helpers (Phase 23): the tab model, sales-register labels, search and paging,
 * and the stock register grouped by item category. Pure and unit-tested.
 */
import type { SalesRegisterItem, SalesRegisterRow, StockRegisterRow } from '../api/types'

export type ReportTab = 'ledger' | 'sales' | 'stock' | 'payments'

export const REPORT_TABS: ReadonlyArray<{ id: ReportTab; label: string }> = [
  { id: 'ledger', label: 'Ledger balances' },
  { id: 'sales', label: 'Sales register' },
  { id: 'stock', label: 'Stock register' },
  { id: 'payments', label: 'Payments' },
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

/** A number matches the bill number exactly; any text matches an item name or the waiter. */
export function filterSales(rows: readonly SalesRegisterRow[], query: string): SalesRegisterRow[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...rows]
  if (/^#?\d+$/.test(q)) {
    const no = Number(q.replace('#', ''))
    return rows.filter((r) => r.billNo === no)
  }
  return rows.filter((r) => r.items.some((i) => i.name.toLowerCase().includes(q)) || (r.waiterName ?? '').toLowerCase().includes(q))
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

export interface StockTotals {
  openingQty: number
  inwardQty: number
  salesQty: number
  otherQty: number
  closingQty: number
}

export interface StockGroup {
  categoryName: string
  rows: StockRegisterRow[]
  totals: StockTotals
}

const ZERO: StockTotals = { openingQty: 0, inwardQty: 0, salesQty: 0, otherQty: 0, closingQty: 0 }

/** Nothing held and nothing moved in the range. */
export function isIdle(r: StockRegisterRow): boolean {
  return r.openingQty === 0 && r.inwardQty === 0 && r.salesQty === 0 && r.otherQty === 0 && r.closingQty === 0
}

function addTotals(t: StockTotals, r: StockTotals): StockTotals {
  return {
    openingQty: t.openingQty + r.openingQty,
    inwardQty: t.inwardQty + r.inwardQty,
    salesQty: t.salesQty + r.salesQty,
    otherQty: t.otherQty + r.otherQty,
    closingQty: t.closingQty + r.closingQty,
  }
}

/**
 * Rows grouped by item category, keeping the server's report order; a text query matches the item
 * name or code. With `hideIdle`, items with no stock and no movement are left out (and so are empty
 * categories).
 */
export function groupStock(rows: readonly StockRegisterRow[], { hideIdle, query = '' }: { hideIdle: boolean; query?: string }): StockGroup[] {
  const q = query.trim().toLowerCase()
  const groups: StockGroup[] = []
  for (const r of rows) {
    if (hideIdle && isIdle(r)) continue
    if (q !== '' && !r.name.toLowerCase().includes(q) && !r.skuCode.toLowerCase().includes(q)) continue
    let group = groups.find((g) => g.categoryName === r.categoryName)
    if (!group) {
      group = { categoryName: r.categoryName, rows: [], totals: ZERO }
      groups.push(group)
    }
    group.rows.push(r)
    group.totals = addTotals(group.totals, r)
  }
  return groups
}

export function grandTotals(groups: readonly StockGroup[]): StockTotals {
  return groups.reduce((t, g) => addTotals(t, g.totals), ZERO)
}
