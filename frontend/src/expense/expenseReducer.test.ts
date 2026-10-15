import { describe, expect, it } from 'vitest'
import type { ExpenseEntry } from '../api/types'
import {
  expenseReducer,
  formError,
  formPayload,
  initialExpenseState,
  todayTotals,
  type ExpenseAction,
  type ExpenseState,
} from './expenseReducer'

const run = (state: ExpenseState, ...actions: ExpenseAction[]) => actions.reduce(expenseReducer, state)

function entry(over: Partial<ExpenseEntry> = {}): ExpenseEntry {
  return {
    id: 'e-1',
    businessDayId: 'day-1',
    peakSessionId: null,
    amountPaise: 150_00n,
    reversesExpenseId: null,
    category: 'ICE',
    description: null,
    createdAt: '2026-10-15T08:30:00.000Z',
    voidedAt: null,
    ...over,
  }
}

describe('expense form', () => {
  it('asks for a category, then an amount above ₹0, then a note for Other', () => {
    const s = run(initialExpenseState, { type: 'loaded', entries: [] })
    expect(formError(s)).toBe('Pick a category')
    const ice = run(s, { type: 'category', category: 'ICE' })
    expect(formError(ice)).toBe('Enter the amount')
    expect(formError(run(ice, { type: 'amount', text: '12.345' }))).toMatch(/rupees/)
    expect(formError(run(ice, { type: 'amount', text: '0' }))).toBe('Amount must be more than ₹0')
    expect(formError(run(ice, { type: 'amount', text: '150' }))).toBeNull()

    const other = run(ice, { type: 'category', category: 'OTHER' }, { type: 'amount', text: '40' })
    expect(formError(other)).toBe('Add a note for Other')
    expect(formError(run(other, { type: 'note', text: '   ' }))).toBe('Add a note for Other')
    expect(formError(run(other, { type: 'note', text: 'Tea' }))).toBeNull()
  })

  it('builds the payload in paise with a trimmed (or null) note', () => {
    const s = run(initialExpenseState, { type: 'category', category: 'TRANSPORT' }, { type: 'amount', text: '1,080.50' })
    expect(formPayload(s)).toEqual({ amount: 1080_50n, category: 'TRANSPORT', description: null })
    expect(formPayload(run(s, { type: 'note', text: '  Auto to supplier ' }))).toEqual({
      amount: 1080_50n,
      category: 'TRANSPORT',
      description: 'Auto to supplier',
    })
    expect(formPayload(initialExpenseState)).toBeNull()
  })

  it('clears amount and note after recording but keeps the category for the next entry', () => {
    const s = run(
      initialExpenseState,
      { type: 'category', category: 'ICE' },
      { type: 'amount', text: '150' },
      { type: 'note', text: 'Bags' },
      { type: 'submitting', on: true },
    )
    expect(s.submitting).toBe(true)
    const done = run(s, { type: 'recorded' })
    expect(done).toMatchObject({ category: 'ICE', amount: '', note: '', submitting: false })
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
