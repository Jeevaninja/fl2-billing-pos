import { describe, expect, it } from 'vitest'
import type { OrderDetail, OrderSummary } from '../api/types'
import { detail } from '../billing/testData'
import { chipCounts, filterOrders, findByNumber, jumpTarget, moveKey, orderRows, peakKey, settlementLines, waitersInOrders, whoLabel } from './ordersView'

const W1 = { id: 'w-1', code: 'W01', displayName: 'Suresh' }
const W2 = { id: 'w-2', code: 'W02', displayName: 'Manoj' }

/** Bill #n created at minute n (so a higher n is newer). */
function order(n: number, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    billId: `b${n}`,
    billNo: n,
    createdAt: `2026-10-18T18:${String(n).padStart(2, '0')}:00.000Z`,
    settledAt: null,
    status: 'SETTLED',
    mode: 'NORMAL',
    source: 'COUNTER',
    waiter: null,
    member: null,
    peakSessionId: null,
    peakSessionNo: null,
    createdByStaffId: 'staff-1',
    lines: 1,
    bottles: 1,
    totalPaise: 10000n,
    cashPaise: 10000n,
    upiPaise: 0n,
    creditPaise: 0n,
    duePaise: 0n,
    voidedAt: null,
    ...over,
  }
}

const peak = (n: number, session: 1 | 2, over: Partial<OrderSummary> = {}) =>
  order(n, { mode: 'PEAK', peakSessionId: `s${session}`, peakSessionNo: session, status: session === 1 ? 'PEAK_RECONCILED' : 'PEAK_PENDING', cashPaise: 0n, totalPaise: 25000n, bottles: 2, ...over })

// Newest first, as the server sends them.
const DAY: OrderSummary[] = [
  peak(20, 2),
  order(19, { status: 'OPEN', waiter: W1, duePaise: 5000n, cashPaise: 5000n }),
  order(18, { status: 'VOIDED', voidedAt: '2026-10-18T18:25:00.000Z' }),
  order(17, { status: 'CANCELLED', totalPaise: 0n, cashPaise: 0n, lines: 0, bottles: 0 }),
  order(16, { waiter: W2, source: 'WAITER_APP' }),
  order(15, { status: 'OPEN' }),
  peak(14, 1, { status: 'VOIDED' }),
  peak(13, 1),
  peak(12, 1),
  order(11, { waiter: W1 }),
]

const ids = (list: Array<{ billId: string }>) => list.map((o) => o.billId)

describe('filterOrders', () => {
  it('sorts bills into open, settled (incl. cancelled and reconciled peak), peak and voided', () => {
    expect(ids(filterOrders(DAY, 'ALL', null))).toHaveLength(10)
    expect(ids(filterOrders(DAY, 'OPEN', null))).toEqual(['b19', 'b15'])
    expect(ids(filterOrders(DAY, 'SETTLED', null))).toEqual(['b17', 'b16', 'b13', 'b12', 'b11'])
    expect(ids(filterOrders(DAY, 'PEAK', null))).toEqual(['b20', 'b14', 'b13', 'b12'])
    expect(ids(filterOrders(DAY, 'VOIDED', null))).toEqual(['b18', 'b14'])
  })

  it('narrows to one waiter (peak bills never carry one)', () => {
    expect(ids(filterOrders(DAY, 'ALL', 'w-1'))).toEqual(['b19', 'b11'])
    expect(ids(filterOrders(DAY, 'OPEN', 'w-1'))).toEqual(['b19'])
    expect(filterOrders(DAY, 'PEAK', 'w-1')).toEqual([])
    expect(chipCounts(DAY, null)).toEqual({ ALL: 10, OPEN: 2, SETTLED: 5, PEAK: 4, VOIDED: 2 })
    expect(chipCounts(DAY, 'w-2')).toEqual({ ALL: 1, OPEN: 0, SETTLED: 1, PEAK: 0, VOIDED: 0 })
    expect(waitersInOrders(DAY).map((w) => w.code)).toEqual(['W01', 'W02'])
  })
})

describe('orderRows', () => {
  it('folds each peak session into one row where its newest bill sits, with totals that skip voided scans', () => {
    const rows = orderRows(DAY, 'ALL', null, new Set())
    expect(rows.map((r) => r.key)).toEqual([peakKey('s2'), 'b19', 'b18', 'b17', 'b16', 'b15', peakKey('s1'), 'b11'])
    const s1 = rows.find((r) => r.key === peakKey('s1'))
    expect(s1).toMatchObject({ kind: 'peak', group: { sessionNo: 1, sales: 2, voided: 1, bottles: 4, totalPaise: 50000n, running: false } })
    expect(rows[0]).toMatchObject({ kind: 'peak', group: { running: true, sales: 1 } })
  })

  it('lists an expanded session’s bills under it, nested', () => {
    const rows = orderRows(DAY, 'ALL', null, new Set([peakKey('s1')]))
    const at = rows.findIndex((r) => r.key === peakKey('s1'))
    expect(rows.slice(at, at + 4).map((r) => r.key)).toEqual([peakKey('s1'), 'b14', 'b13', 'b12'])
    expect(rows[at + 1]).toMatchObject({ kind: 'bill', nested: true })
  })

  it('in Settled, a session row holds only its reconciled bills; Peak and Voided list every bill', () => {
    const settled = orderRows(DAY, 'SETTLED', null, new Set())
    expect(settled.map((r) => r.key)).toEqual(['b17', 'b16', peakKey('s1'), 'b11'])
    expect(settled[2]).toMatchObject({ group: { sales: 2, voided: 0 } })
    expect(orderRows(DAY, 'PEAK', null, new Set()).every((r) => r.kind === 'bill')).toBe(true)
    expect(orderRows(DAY, 'VOIDED', null, new Set()).map((r) => r.key)).toEqual(['b18', 'b14'])
  })

  it('moves the selection by rows, clamped, starting at the top', () => {
    const rows = orderRows(DAY, 'OPEN', null, new Set())
    expect(moveKey(rows, null, 1)).toBe('b19')
    expect(moveKey(rows, 'b19', 1)).toBe('b15')
    expect(moveKey(rows, 'b15', 1)).toBe('b15')
    expect(moveKey(rows, 'b19', -1)).toBe('b19')
    expect(moveKey([], 'b19', 1)).toBeNull()
  })
})

describe('labels, jump and search', () => {
  it('names who the bill belongs to', () => {
    expect(whoLabel(DAY[0]!)).toBe('Peak #2')
    expect(whoLabel(DAY[1]!)).toBe('W01 Suresh')
    expect(whoLabel(DAY[5]!)).toBe('Counter')
    expect(whoLabel(order(1, { source: 'WAITER_APP' }))).toBe('Captain app')
  })

  it('jumps this till’s open counter bills to Billing and Captain orders to the Waiter Ledger', () => {
    expect(jumpTarget(order(1, { status: 'OPEN' }), 'staff-1')).toEqual({ kind: 'billing', billId: 'b1' })
    expect(jumpTarget(order(1, { status: 'OPEN', waiter: W1 }), 'staff-1')).toEqual({ kind: 'billing', billId: 'b1' })
    expect(jumpTarget(order(2, { status: 'OPEN', source: 'WAITER_APP', waiter: W2 }), 'staff-1')).toEqual({ kind: 'ledger', waiterId: 'w-2', billId: 'b2' })
    expect(jumpTarget(order(3, { status: 'OPEN', createdByStaffId: 'staff-9' }), 'staff-1')).toEqual({ kind: 'none', reason: 'Held on another till' })
    expect(jumpTarget(order(4), 'staff-1').kind).toBe('none')
  })

  it('finds a bill by its typed number', () => {
    expect(findByNumber(DAY, '16')?.billId).toBe('b16')
    expect(findByNumber(DAY, '99')).toBeNull()
    expect(findByNumber(DAY, '')).toBeNull()
  })
})

describe('settlementLines', () => {
  const base = (summary: OrderSummary, over: Partial<OrderDetail> = {}): OrderDetail => ({
    summary,
    detail: detail(),
    payments: [],
    cashier: 'Counter 1',
    settledVia: 'COUNTER',
    peakSession: null,
    reversal: null,
    ...over,
  })
  const pay = (tender: 'CASH' | 'UPI' | 'WAITER_CREDIT', amountPaise: bigint, receiptTotalPaise: bigint | null = null) => ({
    id: `p-${tender}-${amountPaise}`,
    tender,
    amountPaise,
    at: '2026-10-18T15:11:00.000Z',
    receiptTotalPaise,
  })

  it('words counter, waiter, lump-sum and credit tenders', () => {
    expect(settlementLines(base(order(1), { payments: [pay('UPI', 120000n)] }))).toEqual([expect.stringMatching(/^Paid ₹1,200\.00 by UPI · \d\d:\d\d$/)])
    const waiterBill = order(2, { waiter: W1 })
    expect(settlementLines(base(waiterBill, { settledVia: 'WAITER', payments: [pay('CASH', 50000n)] }))[0]).toMatch(/^Paid ₹500\.00 by cash via W01 · /)
    expect(settlementLines(base(waiterBill, { settledVia: 'WAITER', payments: [pay('CASH', 60000n, 200000n)] }))[0]).toMatch(
      /^₹600\.00 cash from a ₹2,000\.00 waiter payment \(Waiter Ledger\) · /,
    )
    expect(settlementLines(base(waiterBill, { settledVia: 'WAITER', payments: [pay('WAITER_CREDIT', 65000n)] }))[0]).toMatch(/^₹650\.00 on W01's collect-later credit · /)
  })

  it('words open, cancelled, peak and voided bills', () => {
    expect(settlementLines(base(order(3, { status: 'OPEN', duePaise: 31000n }), { settledVia: null }))).toEqual(['Unsettled · ₹310.00 due'])
    expect(settlementLines(base(order(4, { status: 'CANCELLED' })))).toEqual(['Cancelled — every bottle went back on the shelf, closed at ₹0'])
    expect(settlementLines(base(peak(5, 2), { settledVia: 'PEAK', peakSession: { sessionNo: 2, endedAt: null } }))[0]).toMatch(/settles with Peak #2/)
    expect(settlementLines(base(peak(6, 1), { settledVia: 'PEAK', peakSession: { sessionNo: 1, endedAt: '2026-10-18T16:00:00.000Z' } }))).toEqual([
      "Peak sale — reconciled with Peak #1's cash/UPI count",
    ])
    const voided = settlementLines(
      base(order(7, { status: 'VOIDED' }), {
        payments: [pay('CASH', 22000n)],
        reversal: { billNo: 8, at: '2026-10-18T15:35:00.000Z', reason: 'wrong bottle', refunds: [{ tender: 'CASH', amountPaise: -22000n }] },
      }),
    )
    expect(voided).toHaveLength(2)
    expect(voided[1]).toMatch(/^Voided \d\d:\d\d · wrong bottle · refunded ₹220\.00 cash \(reversal #8\)$/)
  })
})
