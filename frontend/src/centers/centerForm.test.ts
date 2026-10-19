import { describe, expect, it } from 'vitest'
import type { Department } from '../api/types'
import { centerFormError, centerFormFor, centerPatch, NEW_CENTER } from './centerForm'

const dept = (code: string, name: string, over: Partial<Department> = {}): Department => ({
  code,
  name,
  kotStation: 'BAR',
  tracksStock: true,
  isActive: true,
  sortOrder: 1,
  itemCount: 0,
  onHandQty: 0,
  ...over,
})

const LIST = [dept('LIQUOR', 'Liquor', { itemCount: 60, onHandQty: 900 }), dept('CIGARETTES', 'Cigarettes', { itemCount: 2, onHandQty: 40 }), dept('PAAN', 'Paan', { isActive: false })]

describe('center form', () => {
  it('needs a unique name of at most 30 characters', () => {
    expect(centerFormError({ ...NEW_CENTER, name: ' ' }, LIST)).toBe('Enter a name')
    expect(centerFormError({ ...NEW_CENTER, name: 'x'.repeat(31) }, LIST)).toBe('At most 30 characters')
    expect(centerFormError({ ...NEW_CENTER, name: 'cigarettes' }, LIST)).toBe('“Cigarettes” already exists')
    expect(centerFormError({ ...NEW_CENTER, name: 'PAAN' }, LIST)).toBe('“Paan” already exists (disabled — enable it instead)')
    expect(centerFormError({ ...NEW_CENTER, name: 'Water Bottles' }, LIST)).toBeNull()
  })

  it('locks Liquor, and refuses disabling with items or dropping stock tracking with stock', () => {
    expect(centerFormError({ ...centerFormFor(LIST[0]!), kotStation: 'NONE' }, LIST)).toMatch(/Liquor stays/)
    expect(centerFormError({ ...centerFormFor(LIST[0]!), name: 'Liquor (FL2)' }, LIST)).toBeNull()
    expect(centerFormError({ ...centerFormFor(LIST[1]!), isActive: false }, LIST)).toMatch(/2 active items/)
    expect(centerFormError({ ...centerFormFor(LIST[1]!), tracksStock: false }, LIST)).toMatch(/40 on hand/)
  })

  it('patches only what changed', () => {
    const cigs = LIST[1]!
    expect(centerPatch(cigs, centerFormFor(cigs))).toEqual({})
    expect(centerPatch(cigs, { ...centerFormFor(cigs), name: ' Smokes  ', kotStation: 'NONE' })).toEqual({ name: 'Smokes', kotStation: 'NONE' })
  })
})
