import { describe, expect, it } from 'vitest'
import type { ItemCategory } from '../api/types'
import { itemCategoryFormError, itemCategoryFormFor, itemCategoryPatch, NEW_ITEM_CATEGORY, visibleItemCategories } from './itemCategoryForm'

const cat = (id: string, name: string, sortOrder: number, over: Partial<ItemCategory> = {}): ItemCategory => ({
  id,
  name,
  sortOrder,
  isActive: true,
  defaultSizeCode: null,
  defaultDepartment: 'LIQUOR',
  systemKey: null,
  itemCount: 0,
  onHandQty: 0,
  ...over,
})

const LIST = [cat('full', 'FULL', 1, { itemCount: 4, defaultSizeCode: 'FULL' }), cat('cig', 'CIGARETTES', 3, { isActive: false }), cat('qtr', 'QUARTER', 2)]

describe('itemCategoryFormError', () => {
  it('needs a unique name of at most 30 characters, and no active items when disabling', () => {
    expect(itemCategoryFormError({ ...NEW_ITEM_CATEGORY, name: '  ' }, LIST)).toBe('Enter a name')
    expect(itemCategoryFormError({ ...NEW_ITEM_CATEGORY, name: 'x'.repeat(31) }, LIST)).toBe('At most 30 characters')
    expect(itemCategoryFormError({ ...NEW_ITEM_CATEGORY, name: ' full ' }, LIST)).toBe('“FULL” already exists')
    expect(itemCategoryFormError({ ...NEW_ITEM_CATEGORY, name: 'cigarettes' }, LIST)).toBe('“CIGARETTES” already exists (disabled — enable it instead)')
    expect(itemCategoryFormError({ ...itemCategoryFormFor(LIST[0]!), isActive: false }, LIST)).toBe('FULL still has 4 active items — move or deactivate them first')
    expect(itemCategoryFormError({ ...itemCategoryFormFor(LIST[2]!), isActive: false }, LIST)).toBeNull()
    expect(itemCategoryFormError({ ...NEW_ITEM_CATEGORY, name: 'Beer' }, LIST)).toBeNull()
  })
})

describe('itemCategoryPatch and order', () => {
  it('sends only what changed (null clears the default size); lists active in report order, then disabled', () => {
    const full = LIST[0]!
    expect(itemCategoryPatch(full, itemCategoryFormFor(full))).toEqual({})
    expect(itemCategoryPatch(full, { ...itemCategoryFormFor(full), name: ' FULL  750 ', defaultSizeCode: null, defaultDepartment: 'ANCILLARY' })).toEqual({
      name: 'FULL 750',
      defaultSizeCode: null,
      defaultDepartment: 'ANCILLARY',
    })
    expect(visibleItemCategories(LIST, false).map((c) => c.id)).toEqual(['full', 'qtr'])
    expect(visibleItemCategories(LIST, true).map((c) => c.id)).toEqual(['full', 'qtr', 'cig'])
  })
})
