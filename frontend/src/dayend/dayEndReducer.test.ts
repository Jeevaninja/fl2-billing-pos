import { describe, expect, it } from 'vitest'
import type { DayEndSummary, OwingWaiter } from '../api/types'
import {
  blockerCount,
  countedPaise,
  dayEndReducer,
  dayEndView,
  initialDayEndState,
  initialDayEndStateFrom,
  lockBlock,
  variancePreview,
  waiterBalanceBlock,
  type DayEndAction,
  type DayEndState,
} from './dayEndReducer'

function summary(over: { id?: string; status?: 'OPEN' | 'CLOSED'; expected?: bigint; blockers?: Partial<DayEndSummary['blockers']> } = {}): DayEndSummary {
  const blockers = {
    openBills: [],
    runningPeakSession: null,
    waitersOwing: [],
    waiterBalance: { totalPaise: 0n, openBillsPaise: 0n, creditPaise: 0n, waiters: 0 },
    ...over.blockers,
  }
  const status = over.status ?? 'OPEN'
  return {
    day: {
      id: over.id ?? 'day-1',
      businessDate: '2026-10-15',
      status,
      openedAt: '2026-10-15T05:00:00.000Z',
      openingFloatPaise: 2000_00n,
      closedAt: status === 'CLOSED' ? '2026-10-16T19:00:00.000Z' : null,
      countedCashPaise: status === 'CLOSED' ? 30500_00n : null,
      expectedCashPaise: status === 'CLOSED' ? 30550_00n : null,
      cashVariancePaise: status === 'CLOSED' ? -50_00n : null,
    },
    blockers,
    canClose: status === 'OPEN' && blockers.openBills.length === 0 && blockers.runningPeakSession === null && blockers.waitersOwing.length === 0,
    breakdown: {
      openingFloatPaise: 2000_00n,
      normalCashPaise: 0n,
      peakCashPaise: 0n,
      waiterCashPaise: 0n,
      cashExpensesPaise: 0n,
      tenderAdjustmentPaise: 0n,
      bankDepositsPaise: 0n,
      centerPurchasesPaise: 0n,
      expectedCashPaise: over.expected ?? 30550_00n,
      upiTotalPaise: 0n,
    },
    sales: {
      normal: { cashPaise: 0n, upiPaise: 0n, creditPaise: 0n, totalPaise: 0n, systemCashPaise: 0n, systemUpiPaise: 0n },
      peak: { salesPaise: 0n, cashPaise: 0n, upiPaise: 0n, sessionCount: 0, runningSessionNo: null },
      waiterRepayments: { cashPaise: 0n, upiPaise: 0n },
      total: { cashPaise: 0n, upiPaise: 0n, creditPaise: 0n, salesPaise: 0n },
      byDepartment: [],
      unallocatedPaise: 0n,
    },
    peakSessions: [],
    tenderAdjustments: [],
  }
}

const owing: OwingWaiter = { id: 'w-1', code: 'W01', displayName: 'Suresh', isTrusted: true, outstandingPaise: 1200_00n, creditLimitPaise: null, isActive: true }
const run = (state: DayEndState, ...actions: DayEndAction[]) => actions.reduce(dayEndReducer, state)

describe('dayEndReducer', () => {
  it('derives the view: loading, offline, no day yet, open, closed', () => {
    expect(dayEndView(initialDayEndState)).toBe('LOADING')
    expect(dayEndView(run(initialDayEndState, { type: 'failed', message: 'down' }))).toBe('OFFLINE')
    expect(dayEndView(run(initialDayEndState, { type: 'noDay' }))).toBe('NO_DAY')
    expect(dayEndView(run(initialDayEndState, { type: 'loaded', summary: summary() }))).toBe('OPEN')
    expect(dayEndView(run(initialDayEndState, { type: 'loaded', summary: summary({ status: 'CLOSED' }) }))).toBe('CLOSED')
  })

  it('restores a draft count after a trip to another screen, only for the same open day', () => {
    const fresh = (draft: { dayId: string; counted: string } | null, s = summary()) =>
      run(initialDayEndStateFrom(draft), { type: 'loaded', summary: s })
    expect(fresh({ dayId: 'day-1', counted: '30,500' }).counted).toBe('30,500')
    expect(fresh({ dayId: 'day-0', counted: '30,500' }).counted).toBe('')
    expect(fresh({ dayId: 'day-1', counted: '30,500' }, summary({ status: 'CLOSED' })).counted).toBe('')
    expect(fresh(null).counted).toBe('')
    // A changed expected figure (a late expense) leaves the count alone; the variance follows.
    const s1 = fresh({ dayId: 'day-1', counted: '30,500' })
    expect(variancePreview(run(s1, { type: 'loaded', summary: summary({ expected: 30450_00n }) }))).toBe(50_00n)
  })

  it('keeps the typed count across polls of the same day, and clears it for another day', () => {
    const s1 = run(initialDayEndState, { type: 'loaded', summary: summary() }, { type: 'counted', text: '30,500' })
    expect(run(s1, { type: 'loaded', summary: summary() }).counted).toBe('30,500')
    expect(run(s1, { type: 'loaded', summary: summary({ id: 'day-2' }) }).counted).toBe('')
  })

  it('previews the variance in paise as counted − expected; blank or invalid gives none', () => {
    const s = run(initialDayEndState, { type: 'loaded', summary: summary({ expected: 30550_00n }) })
    expect(countedPaise(run(s, { type: 'counted', text: '30,500.50' }))).toBe(30500_50n)
    expect(variancePreview(run(s, { type: 'counted', text: '30,500.50' }))).toBe(-49_50n)
    expect(variancePreview(run(s, { type: 'counted', text: '30600' }))).toBe(50_00n)
    expect(variancePreview(run(s, { type: 'counted', text: '' }))).toBeNull()
    expect(variancePreview(run(s, { type: 'counted', text: '12.345' }))).toBeNull()
  })

  it('blocks the lock until nothing blocks the day and a valid count is entered', () => {
    const blocked = run(initialDayEndState, { type: 'loaded', summary: summary({ blockers: { waitersOwing: [owing] } }) }, { type: 'counted', text: '100' })
    expect(blockerCount(blocked.summary!)).toBe(1)
    expect(lockBlock(blocked)).toMatch(/1 item/)

    const ready = run(initialDayEndState, { type: 'loaded', summary: summary() })
    expect(lockBlock(ready)).toMatch(/Enter the counted cash/)
    expect(lockBlock(run(ready, { type: 'counted', text: 'abc' }))).toMatch(/rupees/)
    expect(lockBlock(run(ready, { type: 'counted', text: '0' }))).toBeNull()
  })

  it('strictly blocks the lock while waiters owe anything, naming the total', () => {
    const waiterBalance = { totalPaise: 650_00n, openBillsPaise: 400_00n, creditPaise: 250_00n, waiters: 2 }
    const s = run(initialDayEndState, { type: 'loaded', summary: summary({ blockers: { waiterBalance } }) }, { type: 'counted', text: '100' })
    const sentence = 'Waiters owe ₹650.00 — All waiter balances must be settled to ₹0 before closing.'
    expect(waiterBalanceBlock(s.summary!)).toBe(sentence)
    // It wins over every other reason, even with a valid count and no other blocker listed.
    expect(lockBlock(s)).toBe(sentence)

    const settled = run(s, { type: 'loaded', summary: summary() })
    expect(waiterBalanceBlock(settled.summary!)).toBeNull()
    expect(lockBlock(settled)).toBeNull()
  })

  it('counts every open bill, a running peak and each owing waiter as blockers', () => {
    const peak = { id: 'p', sessionNo: 1, startedAt: '', startCashPaise: 0n, startUpiPaise: 0n, runningExpectedPaise: 0n, expectedDrawerCashPaise: 0n, runningSalesPaise: 0n, runningInWindowUpiPaise: 0n }
    const bill = { billId: 'b', billNo: 3, source: 'COUNTER' as const, status: 'OPEN' as const, waiter: null, duePaise: 1n, createdAt: '' }
    expect(blockerCount(summary({ blockers: { openBills: [bill, { ...bill, billId: 'c' }], runningPeakSession: peak, waitersOwing: [owing] } }))).toBe(4)
    // Peak bills clear together when the session ends: one item, however many scans.
    const peakBills = [1, 2, 3].map((n) => ({ ...bill, billId: `p${n}`, status: 'PEAK_UNSETTLED' as const }))
    expect(blockerCount(summary({ blockers: { openBills: [bill, ...peakBills], runningPeakSession: peak } }))).toBe(2)
    expect(blockerCount(summary({ blockers: { openBills: peakBills } }))).toBe(3)
  })

  it('shows the closed day after locking and closes the dialog', () => {
    const s1 = run(initialDayEndState, { type: 'loaded', summary: summary() }, { type: 'counted', text: '30500' }, { type: 'dialog', dialog: { kind: 'confirm' } })
    const s2 = run(s1, { type: 'loaded', summary: summary({ status: 'CLOSED' }) })
    expect(s2).toMatchObject({ dialog: null, counted: '' })
    expect(dayEndView(s2)).toBe('CLOSED')
  })

  it('keeps the last summary when a poll fails, but reports offline before the first load', () => {
    const s1 = run(initialDayEndState, { type: 'loaded', summary: summary() }, { type: 'failed', message: 'down' })
    expect(dayEndView(s1)).toBe('OPEN')
    expect(s1.flash).toMatchObject({ kind: 'error', text: 'down' })
  })
})
