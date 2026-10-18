import { describe, expect, it } from 'vitest'
import type { WaiterStats } from '../api/types'
import { filterWaiters, sumStats, waiterNote } from './waiterStats'
import { waiter } from './testData'

const stats = (over: Partial<WaiterStats> = {}): WaiterStats => ({
  ...waiter(),
  openBills: 0,
  openDuePaise: 0n,
  closedBills: 0,
  settledPaise: 0n,
  ...over,
})

describe('filterWaiters', () => {
  const rows = [stats({ id: 'a', code: 'W01', displayName: 'Suresh' }), stats({ id: 'b', code: 'W12', displayName: 'Ramesh' })]

  it('matches code or name, case-insensitive; blank shows everyone', () => {
    expect(filterWaiters(rows, '  ').map((w) => w.id)).toEqual(['a', 'b'])
    expect(filterWaiters(rows, 'w1').map((w) => w.id)).toEqual(['b'])
    expect(filterWaiters(rows, 'ESH').map((w) => w.id)).toEqual(['a', 'b'])
    expect(filterWaiters(rows, 'sur').map((w) => w.id)).toEqual(['a'])
    expect(filterWaiters(rows, 'zz')).toEqual([])
  })
})

describe('waiterNote', () => {
  it('flags an untrusted waiter with unpaid bills, and a trusted one at the credit limit', () => {
    expect(waiterNote(stats({ isTrusted: false, openBills: 2 }))).toBe('Bill-on-bill: 2 unpaid')
    expect(waiterNote(stats({ isTrusted: false }))).toBeNull()
    expect(waiterNote(stats({ creditLimitPaise: 1000_00n, outstandingPaise: 1000_00n }))).toBe('Credit limit reached')
    expect(waiterNote(stats({ creditLimitPaise: 1000_00n, outstandingPaise: 999_99n }))).toBeNull()
    expect(waiterNote(stats({ outstandingPaise: 5000_00n }))).toBeNull()
  })
})

describe('sumStats', () => {
  it('adds up every column in whole paise', () => {
    const rows = [
      stats({ openBills: 2, openDuePaise: 1240_50n, closedBills: 5, settledPaise: 8800_00n }),
      stats({ openBills: 0, openDuePaise: 0n, closedBills: 1, settledPaise: 220_00n }),
      stats({ openBills: 1, openDuePaise: 1n, closedBills: 0, settledPaise: 0n }),
    ]
    expect(sumStats(rows)).toEqual({ openBills: 3, openDuePaise: 1240_51n, closedBills: 6, settledPaise: 9020_00n })
    expect(sumStats([])).toEqual({ openBills: 0, openDuePaise: 0n, closedBills: 0, settledPaise: 0n })
  })
})
