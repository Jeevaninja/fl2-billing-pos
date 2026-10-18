import { describe, expect, it } from 'vitest'
import type { PeakStartBaseline } from '../api/types'
import { compareReading, describeBaseline, describeVariance, parseReadings, peakSplit } from './peakMath'

describe('parseReadings', () => {
  it('needs both drawer readings as rupees; ₹0 is a valid reading', () => {
    expect(parseReadings('1,500', '0')).toEqual({ ok: true, cash: 1500_00n, upi: 0n })
    expect(parseReadings('1500.50', '200.5')).toEqual({ ok: true, cash: 1500_50n, upi: 200_50n })
    expect(parseReadings('', '0')).toEqual({ ok: false, error: 'Enter the cash in the drawer' })
    expect(parseReadings('100', '')).toEqual({ ok: false, error: 'Enter the UPI reading (0 if none)' })
    expect(parseReadings('1.234', '0')).toMatchObject({ ok: false, error: expect.stringMatching(/rupees/) })
    expect(parseReadings('10', 'abc')).toMatchObject({ ok: false, error: expect.stringMatching(/rupees/) })
  })
})

describe('describeVariance', () => {
  it('words a variance as short, over or exact', () => {
    expect(describeVariance(-50_00n)).toEqual({ kind: 'short', label: '₹50.00 short' })
    expect(describeVariance(20_00n)).toEqual({ kind: 'over', label: '₹20.00 over' })
    expect(describeVariance(0n)).toEqual({ kind: 'exact', label: 'Exact — no variance' })
  })
})

describe('compareReading', () => {
  it('compares a typed reading with the expected figure', () => {
    expect(compareReading('12,400', 12450_00n)).toEqual({ kind: 'short', label: '₹50.00 short of expected' })
    expect(compareReading('12500.5', 12450_00n)).toEqual({ kind: 'over', label: '₹50.50 over expected' })
    expect(compareReading('6200', 6200_00n)).toEqual({ kind: 'match', label: 'matches expected' })
    expect(compareReading('0', 0n)).toEqual({ kind: 'match', label: 'matches expected' })
  })

  it('says nothing while the field is empty or unparsable, or the expected figure is unknown', () => {
    expect(compareReading('', 100n)).toEqual({ kind: 'none' })
    expect(compareReading('  ', 100n)).toEqual({ kind: 'none' })
    expect(compareReading('12.345', 100n)).toEqual({ kind: 'none' })
    expect(compareReading('100', null)).toEqual({ kind: 'none' })
  })
})

describe('describeBaseline', () => {
  const base: PeakStartBaseline = {
    businessDayId: 'day-1',
    openingFloatPaise: 2000_00n,
    normalCashPaise: 9800_00n,
    waiterCashPaise: 1000_00n,
    peakCashPaise: 0n,
    cashExpensesPaise: 350_00n,
    tenderAdjustmentPaise: 0n,
    bankDepositsPaise: 0n,
    expectedCashPaise: 12450_00n,
    billUpiPaise: 5700_00n,
    waiterUpiPaise: 500_00n,
    peakUpiPaise: 0n,
    expectedUpiPaise: 6200_00n,
  }

  it('lists the non-zero terms of each figure, the float always first', () => {
    expect(describeBaseline(base)).toEqual({
      cash: 'float ₹2,000.00 + cash sales ₹9,800.00 + waiter cash ₹1,000.00 − expenses ₹350.00',
      upi: 'bills ₹5,700.00 + waiter ₹500.00',
    })
  })

  it('handles an untouched day and refunds that leave a term negative', () => {
    const quiet = { ...base, openingFloatPaise: 0n, normalCashPaise: 0n, waiterCashPaise: 0n, cashExpensesPaise: 0n, billUpiPaise: 0n, waiterUpiPaise: 0n }
    expect(describeBaseline(quiet)).toEqual({ cash: 'float ₹0.00', upi: 'no UPI recorded today yet' })
    expect(describeBaseline({ ...quiet, billUpiPaise: -200_00n, peakUpiPaise: 900_00n }).upi).toBe('bills −₹200.00 + earlier peaks ₹900.00')
  })

  it('subtracts bank deposits and carries tally adjustments in the cash terms', () => {
    expect(describeBaseline({ ...base, tenderAdjustmentPaise: -500_00n, bankDepositsPaise: 10000_00n }).cash).toBe(
      'float ₹2,000.00 + cash sales ₹9,800.00 + waiter cash ₹1,000.00 − expenses ₹350.00 − tally ₹500.00 − bank deposits ₹10,000.00',
    )
  })
})

describe('peakSplit', () => {
  // Started with ₹2,000 cash / ₹1,300 UPI; ₹11,400 of peak sales; ₹150 UPI taken on a normal bill
  // inside the window; expected collection ₹11,550.
  const session = {
    startCashPaise: 2000_00n,
    startUpiPaise: 1300_00n,
    runningExpectedPaise: 11550_00n,
    runningSalesPaise: 11400_00n,
    runningInWindowUpiPaise: 150_00n,
  }

  it('shows only the sales until the UPI reading is typed', () => {
    expect(peakSplit(session, '9300', '')).toEqual({ salesPaise: 11400_00n, upiPaise: null, cashPaise: null, variancePaise: null })
    expect(peakSplit(session, '', 'abc')).toMatchObject({ upiPaise: null })
  })

  it('derives UPI from the reading less the in-window UPI, and cash as sales − UPI', () => {
    const split = peakSplit(session, '', '5550')
    expect(split).toEqual({ salesPaise: 11400_00n, upiPaise: 4100_00n, cashPaise: 7300_00n, variancePaise: null })
    expect((split.cashPaise ?? 0n) + (split.upiPaise ?? 0n)).toBe(split.salesPaise)
  })

  it('previews the variance once both readings are typed', () => {
    expect(peakSplit(session, '9300', '5550').variancePaise).toBe(0n)
    expect(peakSplit(session, '9250', '5550').variancePaise).toBe(-50_00n)
    expect(peakSplit(session, '9300', '5,560.50').variancePaise).toBe(10_50n)
  })

  it('balances for any UPI reading, even one above the sales (negative cash)', () => {
    for (const upi of ['1300', '1450', '3000', '20000']) {
      const s = peakSplit(session, '0', upi)
      expect((s.cashPaise ?? 0n) + (s.upiPaise ?? 0n)).toBe(11400_00n)
    }
    expect(peakSplit(session, '0', '20000').cashPaise).toBeLessThan(0n)
  })
})
