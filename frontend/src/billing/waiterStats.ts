/** Pure helpers behind the waiter sidebar. */
import type { WaiterStats } from '../api/types'

/** Waiters whose code or name contains `query` (case-insensitive); all of them for a blank query. */
export function filterWaiters(rows: readonly WaiterStats[], query: string): WaiterStats[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...rows]
  return rows.filter((w) => w.code.toLowerCase().includes(q) || w.displayName.toLowerCase().includes(q))
}

/**
 * A heads-up for the row, or null: an untrusted waiter with an open bill can't place a new Captain
 * order (bill-on-bill), and a trusted one near their credit limit is worth a look. Counter tagging is
 * never refused here.
 */
export function waiterNote(w: WaiterStats): string | null {
  if (!w.isTrusted && w.openBills > 0) return `Bill-on-bill: ${w.openBills} unpaid`
  if (w.isTrusted && w.creditLimitPaise !== null && w.outstandingPaise >= w.creditLimitPaise) return 'Credit limit reached'
  return null
}

/** Σ of the rows (the server sends the same totals for every waiter; this one sums whatever is shown). */
export function sumStats(rows: readonly WaiterStats[]): { openBills: number; openDuePaise: bigint; closedBills: number; settledPaise: bigint } {
  const sum = { openBills: 0, openDuePaise: 0n, closedBills: 0, settledPaise: 0n }
  for (const w of rows) {
    sum.openBills += w.openBills
    sum.openDuePaise += w.openDuePaise
    sum.closedBills += w.closedBills
    sum.settledPaise += w.settledPaise
  }
  return sum
}
