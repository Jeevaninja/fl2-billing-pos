import { describe, expect, it } from 'vitest'
import type { Department } from '../api/types'
import { departmentChip, departmentName, prettyCode } from './departments'

describe('revenue center labels', () => {
  it('names a center from the list, else from its code; colours are stable', () => {
    const list = [{ code: 'COOL_DRINKS', name: 'Cool Drinks & Soda' } as Department]
    expect(departmentName(list, 'COOL_DRINKS')).toBe('Cool Drinks & Soda')
    expect(departmentName(list, 'AC_CHARGES')).toBe('Ac Charges')
    expect(prettyCode('PAAN_SHOP_2')).toBe('Paan Shop 2')
    expect(departmentChip('LIQUOR')).toContain('amber')
    expect(departmentChip('KITCHEN')).toContain('emerald')
    const seeded = ['LIQUOR', 'KITCHEN', 'CIGARETTES', 'COOL_DRINKS', 'WATER', 'AC_CHARGES', 'ANCILLARY'].map(departmentChip)
    expect(new Set(seeded).size).toBe(seeded.length) // the seeded centers never share a colour
    expect(departmentChip('PAAN')).toBe(departmentChip('PAAN'))
  })
})
