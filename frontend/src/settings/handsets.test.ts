import { describe, expect, it } from 'vitest'
import type { Handset } from '../api/types'
import { handsetFormError, nextHandsetId, pairedOn, sortHandsets } from './handsets'

const handset = (id: string, active = true): Handset => ({ id, label: id, active, pairedAt: '2026-10-22T06:00:00.000Z' })

describe('Captain handset form rules', () => {
  it('suggests the next numbered id, counting revoked and skipping custom ids', () => {
    expect(nextHandsetId([])).toBe('handset-01')
    expect(nextHandsetId([handset('handset-01'), handset('handset-04', false), handset('bar-phone')])).toBe('handset-05')
    expect(nextHandsetId([handset('handset-99')])).toBe('handset-100')
  })

  it('checks the id format, taken ids (revoked too) and the name', () => {
    const list = [handset('handset-01'), handset('handset-02', false)]
    expect(handsetFormError('handset-03', 'Captain 3', list)).toBeNull()
    expect(handsetFormError('Handset 3', 'Captain 3', list)).toMatch(/lowercase/)
    expect(handsetFormError('', 'Captain 3', list)).toMatch(/lowercase/)
    expect(handsetFormError('handset-01', 'x', list)).toBe('handset-01 is already used; pick another ID')
    expect(handsetFormError('handset-02', 'x', list)).toBe('handset-02 is already used by a revoked handset; pick another ID')
    expect(handsetFormError('handset-03', '   ', list)).toMatch(/Enter a name/)
    expect(handsetFormError('handset-03', 'x'.repeat(41), list)).toMatch(/under 40/)
  })

  it('lists active handsets first, then by id', () => {
    const sorted = sortHandsets([handset('handset-03', false), handset('handset-02'), handset('handset-01', false), handset('handset-04')])
    expect(sorted.map((h) => h.id)).toEqual(['handset-02', 'handset-04', 'handset-01', 'handset-03'])
  })

  it('formats the pairing date and passes through anything unparseable', () => {
    expect(pairedOn('2026-10-22T06:00:00.000Z')).toMatch(/22 Oct 2026/)
    expect(pairedOn('garbage')).toBe('garbage')
  })
})
