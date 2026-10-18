import { describe, expect, it } from 'vitest'
import type { SalesBreakdown } from '../api/types'
import { describeShift, EMPTY_TALLY, tallyResult } from './tallyForm'

const normal: SalesBreakdown['normal'] = {
  cashPaise: 9800_00n,
  upiPaise: 5700_00n,
  creditPaise: 1500_00n,
  totalPaise: 17000_00n,
  systemCashPaise: 9800_00n,
  systemUpiPaise: 5700_00n,
}

describe('tallyResult', () => {
  it('moves UPI → Cash as a positive cash delta, the total locked', () => {
    const r = tallyResult(normal, { direction: 'UPI_TO_CASH', amount: '500', reason: ' keyed as UPI ' })
    expect(r).toEqual({ ok: true, cashDeltaPaise: 500_00n, reason: 'keyed as UPI', after: { cashPaise: 10300_00n, upiPaise: 5200_00n, totalPaise: 17000_00n } })
  })

  it('moves Cash → UPI as a negative cash delta', () => {
    const r = tallyResult(normal, { direction: 'CASH_TO_UPI', amount: '1,000.50', reason: 'GPay' })
    expect(r).toMatchObject({ ok: true, cashDeltaPaise: -1000_50n, after: { cashPaise: 8799_50n, upiPaise: 6700_50n } })
  })

  it('never changes cash + UPI', () => {
    for (const [direction, amount] of [['UPI_TO_CASH', '5700'], ['CASH_TO_UPI', '9800'], ['UPI_TO_CASH', '0.01']] as const) {
      const r = tallyResult(normal, { direction, amount, reason: 'x' })
      if (!r.ok) throw new Error(r.error)
      expect(r.after.cashPaise + r.after.upiPaise).toBe(normal.cashPaise + normal.upiPaise)
    }
  })

  it('refuses a blank, invalid, zero or too-large amount, and a missing reason', () => {
    expect(tallyResult(normal, EMPTY_TALLY)).toEqual({ ok: false, error: 'Enter the amount to move' })
    expect(tallyResult(normal, { ...EMPTY_TALLY, amount: '1.234' })).toMatchObject({ ok: false, error: expect.stringMatching(/rupees/) })
    expect(tallyResult(normal, { ...EMPTY_TALLY, amount: '0' })).toMatchObject({ ok: false, error: expect.stringMatching(/more than/) })
    expect(tallyResult(normal, { direction: 'UPI_TO_CASH', amount: '5700.01', reason: 'x' })).toEqual({ ok: false, error: 'Only ₹5,700.00 of normal UPI to move' })
    expect(tallyResult(normal, { direction: 'CASH_TO_UPI', amount: '9800.01', reason: 'x' })).toEqual({ ok: false, error: 'Only ₹9,800.00 of normal cash to move' })
    expect(tallyResult(normal, { direction: 'UPI_TO_CASH', amount: '5', reason: '  ' })).toMatchObject({ ok: false, error: expect.stringMatching(/reason/) })
    expect(tallyResult(normal, { direction: 'UPI_TO_CASH', amount: '5', reason: 'x'.repeat(201) })).toMatchObject({ ok: false })
  })
})

describe('describeShift', () => {
  it('words the direction from the sign', () => {
    expect(describeShift(500_00n)).toBe('UPI → Cash ₹500.00')
    expect(describeShift(-250_50n)).toBe('Cash → UPI ₹250.50')
  })
})
