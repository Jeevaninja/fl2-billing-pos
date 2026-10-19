import { describe, expect, it } from 'vitest'
import { addDays, formatBusinessDate, presetRange, rangeDays, rangeError, rangeLabel } from './dateRange'

describe('report date presets (from the business date)', () => {
  it('counts every preset from the anchor', () => {
    const a = '2026-10-19'
    expect(presetRange('today', a)).toEqual({ startDate: a, endDate: a })
    expect(presetRange('yesterday', a)).toEqual({ startDate: '2026-10-18', endDate: '2026-10-18' })
    expect(presetRange('last7', a)).toEqual({ startDate: '2026-10-13', endDate: a })
    expect(presetRange('thisMonth', a)).toEqual({ startDate: '2026-10-01', endDate: a })
    expect(presetRange('lastMonth', a)).toEqual({ startDate: '2026-09-01', endDate: '2026-09-30' })
  })

  it('crosses month, year and leap-year ends', () => {
    expect(presetRange('yesterday', '2026-03-01')).toEqual({ startDate: '2026-02-28', endDate: '2026-02-28' })
    expect(presetRange('lastMonth', '2028-03-10')).toEqual({ startDate: '2028-02-01', endDate: '2028-02-29' })
    expect(presetRange('lastMonth', '2027-01-05')).toEqual({ startDate: '2026-12-01', endDate: '2026-12-31' })
    expect(presetRange('last7', '2027-01-03')).toEqual({ startDate: '2026-12-28', endDate: '2027-01-03' })
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('validates a custom range like the server', () => {
    expect(rangeError({ startDate: '', endDate: '2026-10-19' })).toBe('Pick a start date')
    expect(rangeError({ startDate: '2026-02-30', endDate: '2026-10-19' })).toBe('Pick a start date')
    expect(rangeError({ startDate: '2026-10-20', endDate: '2026-10-19' })).toMatch(/after/)
    expect(rangeError({ startDate: '2025-10-18', endDate: '2026-10-19' })).toMatch(/366/)
    expect(rangeError({ startDate: '2025-10-19', endDate: '2026-10-19' })).toBeNull()
    expect(rangeDays({ startDate: '2025-10-19', endDate: '2026-10-19' })).toBe(366)
    expect(rangeDays({ startDate: '2026-10-19', endDate: '2026-10-19' })).toBe(1)
  })

  it('labels dates for the header', () => {
    expect(formatBusinessDate('2026-10-04')).toBe('4 Oct 2026')
    expect(rangeLabel({ startDate: '2026-10-01', endDate: '2026-10-19' })).toBe('1 Oct 2026 – 19 Oct 2026')
    expect(rangeLabel({ startDate: '2026-10-19', endDate: '2026-10-19' })).toBe('19 Oct 2026')
  })
})
