import { describe, expect, it } from 'vitest'
import type { ExpenseCategory, ExpenseEntry } from '../api/types'
import {
  categoryForKey,
  expenseReducer,
  formError,
  formPayload,
  initialExpenseState,
  pickerMatches,
  quickKey,
  selectedCategory,
  todayTotals,
  type ExpenseAction,
  type ExpenseState,
} from './expenseReducer'

const run = (state: ExpenseState, ...actions: ExpenseAction[]) => actions.reduce(expenseReducer, state)

const cat = (id: string, name: string, over: Partial<ExpenseCategory> = {}): ExpenseCategory => ({
  id,
  name,
  isActive: true,
  noteRequired: false,
  department: null,
  sortOrder: 1,
  legacyCode: null,
  usedCount: 0,
  ...over,
})

/** The seeded list, in the manager's order, plus three more so the 1–9 keys run out. */
const CATS: ExpenseCategory[] = [
  cat('ice', 'Ice'),
  cat('food', 'Staff food'),
  cat('transport', 'Transport'),
  cat('clean', 'Cleaning'),
  cat('repairs', 'Repairs & Maintenance'),
  cat('bata', 'Bata / Daily Wages'),
  cat('other', 'Other', { noteRequired: true }),
  cat('soda', 'Soda'),
  cat('gas', 'Gas cylinder'),
  cat('misc', 'Misc printing'),
]

const ready = (...actions: ExpenseAction[]) => run(initialExpenseState, { type: 'categories', categories: CATS }, { type: 'loaded', entries: [] }, ...actions)

function entry(over: Partial<ExpenseEntry> = {}): ExpenseEntry {
  return {
    id: 'e-1',
    businessDayId: 'day-1',
    peakSessionId: null,
    amountPaise: 150_00n,
    reversesExpenseId: null,
    category: { id: 'ice', name: 'Ice', department: 'LIQUOR' },
    description: null,
    createdAt: '2026-10-15T08:30:00.000Z',
    voidedAt: null,
    ...over,
  }
}

describe('expense form', () => {
  it('asks for a category, then an amount above ₹0, then a note when the category requires one', () => {
    const s = ready()
    expect(formError(s)).toBe('Pick a category')
    const ice = run(s, { type: 'category', id: 'ice' })
    expect(formError(ice)).toBe('Enter the amount')
    expect(formError(run(ice, { type: 'amount', text: '12.345' }))).toMatch(/rupees/)
    expect(formError(run(ice, { type: 'amount', text: '0' }))).toBe('Amount must be more than ₹0')
    expect(formError(run(ice, { type: 'amount', text: '150' }))).toBeNull()

    const other = run(ice, { type: 'category', id: 'other' }, { type: 'amount', text: '40' })
    expect(formError(other)).toBe('Add a note for Other')
    expect(formError(run(other, { type: 'note', text: '   ' }))).toBe('Add a note for Other')
    expect(formError(run(other, { type: 'note', text: 'Tea' }))).toBeNull()
  })

  it('builds the payload in paise with the category id and a trimmed (or null) note', () => {
    const s = ready({ type: 'category', id: 'transport' }, { type: 'amount', text: '1,080.50' })
    expect(formPayload(s)).toEqual({ amount: 1080_50n, categoryId: 'transport', description: null })
    expect(formPayload(run(s, { type: 'note', text: '  Auto to supplier ' }))).toEqual({ amount: 1080_50n, categoryId: 'transport', description: 'Auto to supplier' })
    expect(formPayload(initialExpenseState)).toBeNull()
  })

  it('clears amount and note after recording but keeps the category for the next entry', () => {
    const s = ready({ type: 'category', id: 'ice' }, { type: 'amount', text: '150' }, { type: 'note', text: 'Bags' }, { type: 'submitting', on: true })
    expect(s.submitting).toBe(true)
    const done = run(s, { type: 'recorded' })
    expect(done).toMatchObject({ categoryId: 'ice', query: 'Ice', amount: '', note: '', submitting: false })
  })

  it('drops a picked category that the manager disabled meanwhile', () => {
    const s = ready({ type: 'category', id: 'soda' })
    const after = run(s, { type: 'categories', categories: CATS.filter((c) => c.id !== 'soda') })
    expect(selectedCategory(after)).toBeNull()
    expect(after.query).toBe('')
    expect(formError(after)).toBe('Pick a category')
    // A refresh that keeps it changes nothing.
    expect(run(s, { type: 'categories', categories: CATS }).categoryId).toBe('soda')
  })
})

describe('category picker', () => {
  it('filters by name as the cashier types, and Enter-highlight moves through the matches', () => {
    expect(pickerMatches(ready())).toHaveLength(CATS.length)
    let s = ready({ type: 'query', text: 'ing' })
    expect(pickerMatches(s).map((c) => c.id)).toEqual(['clean', 'misc'])
    s = run(s, { type: 'highlight', delta: 1 }, { type: 'highlight', delta: 1 })
    expect(s.highlighted).toBe(1)
    s = run(s, { type: 'highlight', delta: -1 })
    expect(s.highlighted).toBe(0)
    expect(pickerMatches(ready({ type: 'query', text: 'WAGES' })).map((c) => c.id)).toEqual(['bata'])
    expect(pickerMatches(ready({ type: 'query', text: 'zzz' }))).toEqual([])
  })

  it('shows every category again once a pick fills the field with its name', () => {
    const s = ready({ type: 'query', text: 'ice' }, { type: 'category', id: 'ice' })
    expect(s.query).toBe('Ice')
    expect(pickerMatches(s)).toHaveLength(CATS.length)
  })

  it('gives keys 1–9 to the first nine categories in the manager’s order', () => {
    const s = ready()
    expect(quickKey(s, 'ice')).toBe('1')
    expect(quickKey(s, 'other')).toBe('7')
    expect(quickKey(s, 'gas')).toBe('9')
    expect(quickKey(s, 'misc')).toBeNull()
    expect(categoryForKey(s, '6')?.name).toBe('Bata / Daily Wages')
    expect(categoryForKey(s, '0')).toBeNull()
    expect(categoryForKey(run(initialExpenseState, { type: 'categories', categories: CATS.slice(0, 2) }), '3')).toBeNull()
  })
})

describe('expense list', () => {
  it('totals only expenses that are not voided', () => {
    const entries = [entry({ id: 'a', amountPaise: 150_00n }), entry({ id: 'b', amountPaise: 40_00n, voidedAt: '2026-10-15T09:00:00.000Z' }), entry({ id: 'c', amountPaise: 60_00n })]
    expect(todayTotals(entries)).toEqual({ count: 2, totalPaise: 210_00n })
  })

  it('confirms a void by id, and forgets it once the list no longer offers it', () => {
    const s = run(initialExpenseState, { type: 'loaded', entries: [entry({ id: 'a' })] }, { type: 'confirmVoid', id: 'a' })
    expect(s.confirmVoidId).toBe('a')
    expect(run(s, { type: 'loaded', entries: [entry({ id: 'a', voidedAt: '2026-10-15T09:00:00.000Z' })] }).confirmVoidId).toBeNull()
    expect(run(s, { type: 'confirmVoid', id: null }).confirmVoidId).toBeNull()
  })

  it("remembers the till's cashier and day for the header", () => {
    expect(run(initialExpenseState, { type: 'till', cashier: 'Counter 1', date: '2026-10-15' }).till).toEqual({ cashier: 'Counter 1', date: '2026-10-15' })
  })

  it('tracks no open day and offline separately from the list', () => {
    expect(run(initialExpenseState, { type: 'noDay' }).load).toBe('noDay')
    const s = run(initialExpenseState, { type: 'loaded', entries: [entry()] }, { type: 'failed', message: 'down' })
    expect(s).toMatchObject({ load: 'offline', entries: [entry()] })
    expect(s.flash).toMatchObject({ kind: 'error', text: 'down' })
  })
})
