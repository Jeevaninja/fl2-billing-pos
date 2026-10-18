/**
 * Orders screen (Phase 17): pure helpers behind the filters, the list rows (peak bills summarised
 * per session), the settlement sentences and "Jump to bill". Figures come from the server; nothing
 * here prices a bill, it only adds up the totals of rows it already has.
 */
import type { OrderDetail, OrderStatus, OrderSummary, Paise, Tender } from '../api/types'
import { formatPaise } from '../lib/money'

export type OrdersFilter = 'ALL' | 'OPEN' | 'SETTLED' | 'PEAK' | 'VOIDED'

export const FILTERS: ReadonlyArray<{ id: OrdersFilter; label: string; key: string }> = [
  { id: 'ALL', label: 'All', key: 'A' },
  { id: 'OPEN', label: 'Open', key: 'O' },
  { id: 'SETTLED', label: 'Settled', key: 'S' },
  { id: 'PEAK', label: 'Peak', key: 'P' },
  { id: 'VOIDED', label: 'Voided', key: 'V' },
]

/** Settled covers every finished non-void bill: settled, cancelled at ₹0, and reconciled peak bills. */
function matches(order: OrderSummary, filter: OrdersFilter): boolean {
  switch (filter) {
    case 'ALL':
      return true
    case 'OPEN':
      return order.status === 'OPEN'
    case 'SETTLED':
      return order.status === 'SETTLED' || order.status === 'CANCELLED' || order.status === 'PEAK_RECONCILED'
    case 'PEAK':
      return order.mode === 'PEAK'
    case 'VOIDED':
      return order.status === 'VOIDED'
  }
}

/** Bills passing the status filter and, when set, tagged to that waiter (peak bills never are). */
export function filterOrders(orders: readonly OrderSummary[], filter: OrdersFilter, waiterId: string | null): OrderSummary[] {
  return orders.filter((o) => matches(o, filter) && (waiterId === null || o.waiter?.id === waiterId))
}

/** Bills per chip, under the current waiter filter. */
export function chipCounts(orders: readonly OrderSummary[], waiterId: string | null): Record<OrdersFilter, number> {
  const counts: Record<OrdersFilter, number> = { ALL: 0, OPEN: 0, SETTLED: 0, PEAK: 0, VOIDED: 0 }
  for (const f of FILTERS) counts[f.id] = filterOrders(orders, f.id, waiterId).length
  return counts
}

/** Waiters with a bill today, by code, for the waiter filter. */
export function waitersInOrders(orders: readonly OrderSummary[]): Array<{ id: string; code: string; displayName: string }> {
  const seen = new Map<string, { id: string; code: string; displayName: string }>()
  for (const o of orders) if (o.waiter) seen.set(o.waiter.id, o.waiter)
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code))
}

export interface PeakGroup {
  sessionId: string
  sessionNo: number
  /** Newest first, voided scans included. */
  bills: OrderSummary[]
  firstAt: string
  lastAt: string
  /** Non-voided bills only. */
  sales: number
  bottles: number
  totalPaise: Paise
  voided: number
  /** Any bill still PEAK_PENDING (the session is running). */
  running: boolean
}

export type OrderRow = { kind: 'bill'; key: string; order: OrderSummary; nested: boolean } | { kind: 'peak'; key: string; group: PeakGroup; expanded: boolean }

export const peakKey = (sessionId: string) => `peak:${sessionId}`

/**
 * List rows for a filter. All and Settled fold each peak session's bills into one summary row,
 * placed where its newest bill would be (expanded groups list their bills under it). Peak and
 * Voided list every bill on its own, so a voided scan is always findable.
 */
export function orderRows(orders: readonly OrderSummary[], filter: OrdersFilter, waiterId: string | null, expanded: ReadonlySet<string>): OrderRow[] {
  const shown = filterOrders(orders, filter, waiterId)
  if (filter !== 'ALL' && filter !== 'SETTLED') return shown.map((o) => ({ kind: 'bill', key: o.billId, order: o, nested: false }))

  const groups = new Map<string, PeakGroup>()
  for (const o of shown) {
    if (o.mode !== 'PEAK' || o.peakSessionId === null) continue
    let g = groups.get(o.peakSessionId)
    if (!g) {
      g = { sessionId: o.peakSessionId, sessionNo: o.peakSessionNo ?? 0, bills: [], firstAt: o.createdAt, lastAt: o.createdAt, sales: 0, bottles: 0, totalPaise: 0n, voided: 0, running: false }
      groups.set(o.peakSessionId, g)
    }
    g.bills.push(o)
    if (o.createdAt < g.firstAt) g.firstAt = o.createdAt
    if (o.createdAt > g.lastAt) g.lastAt = o.createdAt
    if (o.status === 'VOIDED') g.voided += 1
    else {
      g.sales += 1
      g.bottles += o.bottles
      g.totalPaise += o.totalPaise
    }
    if (o.status === 'PEAK_PENDING') g.running = true
  }

  const rows: OrderRow[] = []
  const placed = new Set<string>()
  for (const o of shown) {
    if (o.mode !== 'PEAK' || o.peakSessionId === null) {
      rows.push({ kind: 'bill', key: o.billId, order: o, nested: false })
      continue
    }
    if (placed.has(o.peakSessionId)) continue
    placed.add(o.peakSessionId)
    const group = groups.get(o.peakSessionId)
    if (!group) continue
    const key = peakKey(group.sessionId)
    const open = expanded.has(key)
    rows.push({ kind: 'peak', key, group, expanded: open })
    if (open) for (const b of group.bills) rows.push({ kind: 'bill', key: b.billId, order: b, nested: true })
  }
  return rows
}

/** The row key `delta` rows away from `key` (clamped); the first row when `key` is not shown. */
export function moveKey(rows: readonly OrderRow[], key: string | null, delta: number): string | null {
  if (rows.length === 0) return null
  const at = rows.findIndex((r) => r.key === key)
  if (at === -1) return rows[0]?.key ?? null
  return rows[Math.min(rows.length - 1, Math.max(0, at + delta))]?.key ?? null
}

/** Who the bill belongs to, for the list. */
export function whoLabel(order: OrderSummary): string {
  if (order.mode === 'PEAK') return `Peak #${order.peakSessionNo ?? '?'}`
  if (order.waiter) return `${order.waiter.code} ${order.waiter.displayName}`
  return order.source === 'WAITER_APP' ? 'Captain app' : 'Counter'
}

export const STATUS_LABEL: Record<OrderStatus, { label: string; tone: 'amber' | 'green' | 'zinc' | 'rose' | 'violet' }> = {
  OPEN: { label: 'Open', tone: 'amber' },
  SETTLED: { label: 'Settled', tone: 'green' },
  CANCELLED: { label: 'Cancelled', tone: 'zinc' },
  VOIDED: { label: 'Voided', tone: 'rose' },
  PEAK_PENDING: { label: 'Peak · pending', tone: 'violet' },
  PEAK_RECONCILED: { label: 'Peak · reconciled', tone: 'violet' },
}

const TENDER_WORD: Record<Tender, string> = { CASH: 'cash', UPI: 'UPI', WAITER_CREDIT: 'collect-later credit' }

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** One sentence per fact about how the bill was (or wasn't) paid, oldest first. */
export function settlementLines(order: OrderDetail): string[] {
  const { summary } = order
  const lines: string[] = []
  if (summary.mode === 'PEAK') {
    const n = order.peakSession?.sessionNo ?? summary.peakSessionNo ?? '?'
    lines.push(
      summary.status === 'PEAK_PENDING' || (summary.status === 'VOIDED' && !order.peakSession?.endedAt)
        ? `Peak sale — no tender; settles with Peak #${n}'s cash/UPI count when the session ends`
        : `Peak sale — reconciled with Peak #${n}'s cash/UPI count`,
    )
  }
  for (const p of order.payments) {
    if (p.amountPaise <= 0n) continue
    if (p.tender === 'WAITER_CREDIT') {
      lines.push(`${formatPaise(p.amountPaise)} on ${summary.waiter ? `${summary.waiter.code}'s` : 'the waiter’s'} collect-later credit · ${clock(p.at)}`)
    } else if (p.receiptTotalPaise !== null) {
      lines.push(`${formatPaise(p.amountPaise)} ${TENDER_WORD[p.tender]} from a ${formatPaise(p.receiptTotalPaise)} waiter payment (Waiter Ledger) · ${clock(p.at)}`)
    } else {
      lines.push(`Paid ${formatPaise(p.amountPaise)} by ${TENDER_WORD[p.tender]}${order.settledVia === 'WAITER' ? ` via ${summary.waiter?.code ?? 'the waiter'}` : ''} · ${clock(p.at)}`)
    }
  }
  if (summary.status === 'OPEN') {
    lines.push(summary.duePaise > 0n ? `Unsettled · ${formatPaise(summary.duePaise)} due` : 'Unsettled · nothing scanned yet')
  }
  if (summary.status === 'CANCELLED') lines.push('Cancelled — every bottle went back on the shelf, closed at ₹0')
  if (order.reversal) {
    const refunds = order.reversal.refunds.filter((r) => r.amountPaise < 0n)
    const refundText = refunds.length > 0 ? ` · refunded ${refunds.map((r) => `${formatPaise(-r.amountPaise)} ${TENDER_WORD[r.tender]}`).join(' + ')}` : ''
    lines.push(`Voided ${clock(order.reversal.at)} · ${order.reversal.reason}${refundText} (reversal #${order.reversal.billNo})`)
  }
  return lines
}

export type JumpTarget = { kind: 'billing'; billId: string } | { kind: 'ledger'; waiterId: string; billId: string } | { kind: 'none'; reason: string }

/**
 * Where "Jump to bill" goes for an open bill. This till's counter bills are billing tabs; Captain
 * app orders live in the Waiter Ledger; anything else can only be viewed here.
 */
export function jumpTarget(order: OrderSummary, cashierId: string | null): JumpTarget {
  if (order.status !== 'OPEN') return { kind: 'none', reason: 'Only open bills can be jumped to' }
  if (order.source === 'WAITER_APP') {
    return order.waiter ? { kind: 'ledger', waiterId: order.waiter.id, billId: order.billId } : { kind: 'none', reason: 'Captain order without a waiter' }
  }
  if (cashierId !== null && order.createdByStaffId !== cashierId) return { kind: 'none', reason: 'Held on another till' }
  return { kind: 'billing', billId: order.billId }
}

/** The bill whose number was typed, if today's list has it. */
export function findByNumber(orders: readonly OrderSummary[], digits: string): OrderSummary | null {
  const n = Number(digits)
  if (!Number.isInteger(n) || n <= 0) return null
  return orders.find((o) => o.billNo === n) ?? null
}
