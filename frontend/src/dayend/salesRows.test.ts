import { describe, expect, it } from 'vitest'
import type { SalesBreakdown } from '../api/types'
import { salesCard } from './salesRows'

const sales = (over: Partial<SalesBreakdown['peak']> = {}): SalesBreakdown => ({
  normal: { cashPaise: 9800_00n, upiPaise: 5700_00n, creditPaise: 1500_00n, totalPaise: 17000_00n },
  peak: { salesPaise: 11400_00n, cashPaise: 7300_00n, upiPaise: 4100_00n, sessionCount: 2, runningSessionNo: null, ...over },
  waiterRepayments: { cashPaise: 1000_00n, upiPaise: 500_00n },
  total: { cashPaise: 17100_00n, upiPaise: 9800_00n, creditPaise: 1500_00n, salesPaise: 28400_00n },
})

describe('salesCard', () => {
  it('lays out normal, peak and total rows, with repayments kept apart from sales', () => {
    const card = salesCard(sales())
    expect(card.rows).toEqual([
      { key: 'normal', label: 'Normal bills', cash: 9800_00n, upi: 5700_00n, credit: 1500_00n, total: 17000_00n },
      { key: 'peak', label: 'Peak sales (2 sessions)', cash: 7300_00n, upi: 4100_00n, credit: null, total: 11400_00n },
      { key: 'total', label: 'Total sales', cash: 17100_00n, upi: 9800_00n, credit: 1500_00n, total: 28400_00n },
    ])
    expect(card.repayments).toEqual({ cash: 1000_00n, upi: 500_00n })
    expect(card.warnings).toEqual([])
    for (const row of card.rows) expect(row.cash + row.upi + (row.credit ?? 0n)).toBe(row.total)
  })

  it('names the session count, a running session and a negative derived peak cash', () => {
    expect(salesCard(sales({ sessionCount: 1 })).rows[1].label).toBe('Peak sales (1 session)')
    expect(salesCard(sales({ sessionCount: 0 })).rows[1].label).toBe('Peak sales')
    expect(salesCard(sales({ runningSessionNo: 3, cashPaise: -150_00n })).warnings).toEqual([
      'Peak #3 is still running — its sales appear once it ends.',
      'Peak UPI readings exceed peak sales — check the UPI readings.',
    ])
  })
})
