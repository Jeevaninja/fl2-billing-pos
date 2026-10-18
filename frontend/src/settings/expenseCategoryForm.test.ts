import { describe, expect, it } from 'vitest'
import type { ExpenseCategory } from '../api/types'
import { categoryFormError, categoryPatch, cleanName, formFor, NEW_CATEGORY, quickKeyFor, visibleCategories } from './expenseCategoryForm'

const cat = (id: string, name: string, sortOrder: number, over: Partial<ExpenseCategory> = {}): ExpenseCategory => ({
  id,
  name,
  isActive: true,
  noteRequired: false,
  sortOrder,
  legacyCode: null,
  usedCount: 0,
  ...over,
})

const LIST = [cat('ice', 'Ice', 1), cat('other', 'Other', 3, { noteRequired: true }), cat('soda', 'Soda', 2, { isActive: false }), cat('bata', 'Bata / Daily Wages', 4)]

describe('categoryFormError', () => {
  it('needs a tidy, unique name of at most 40 characters', () => {
    expect(categoryFormError({ ...NEW_CATEGORY, name: '   ' }, LIST)).toBe('Enter a name')
    expect(categoryFormError({ ...NEW_CATEGORY, name: 'x'.repeat(41) }, LIST)).toBe('At most 40 characters')
    expect(categoryFormError({ ...NEW_CATEGORY, name: '  ICE ' }, LIST)).toBe('“Ice” already exists')
    expect(categoryFormError({ ...NEW_CATEGORY, name: 'soda' }, LIST)).toBe('“Soda” already exists (disabled — enable it instead)')
    expect(categoryFormError({ ...NEW_CATEGORY, name: 'Gas  cylinder' }, LIST)).toBeNull()
    // Renaming a category to its own name (any case) is fine.
    expect(categoryFormError({ ...formFor(LIST[0]!), name: 'ICE' }, LIST)).toBeNull()
    expect(cleanName('  Gas   cylinder ')).toBe('Gas cylinder')
  })

  it('refuses to disable the last active category', () => {
    const onlyIce = [cat('ice', 'Ice', 1), cat('soda', 'Soda', 2, { isActive: false })]
    expect(categoryFormError({ ...formFor(onlyIce[0]!), isActive: false }, onlyIce)).toMatch(/last active category/)
    expect(categoryFormError({ ...formFor(LIST[0]!), isActive: false }, LIST)).toBeNull()
  })
})

describe('categoryPatch', () => {
  it('sends only what changed, with the tidied name', () => {
    const ice = LIST[0]!
    expect(categoryPatch(ice, formFor(ice))).toEqual({})
    expect(categoryPatch(ice, { ...formFor(ice), name: '  Ice  blocks ' })).toEqual({ name: 'Ice blocks' })
    expect(categoryPatch(ice, { ...formFor(ice), noteRequired: true, isActive: false })).toEqual({ noteRequired: true, isActive: false })
  })
})

describe('visibleCategories and quick keys', () => {
  it('lists active ones in picker order, then disabled ones when asked; keys follow the active order', () => {
    expect(visibleCategories(LIST, false).map((c) => c.id)).toEqual(['ice', 'other', 'bata'])
    expect(visibleCategories(LIST, true).map((c) => c.id)).toEqual(['ice', 'other', 'bata', 'soda'])
    expect(quickKeyFor(LIST, 'ice')).toBe('1')
    expect(quickKeyFor(LIST, 'other')).toBe('2') // the disabled Soda in between takes no key
    expect(quickKeyFor(LIST, 'soda')).toBeNull()
  })
})
