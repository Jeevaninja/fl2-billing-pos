import { describe, expect, it } from 'vitest'
import { describeVariance, parseReadings } from './peakMath'

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
