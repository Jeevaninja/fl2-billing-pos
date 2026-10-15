/**
 * ExpenseScreen state machine. Pure and unit-tested: the form (category, amount, note), the open
 * day's list, and the void confirmation. Amounts are parsed to whole paise; no floats.
 */
import type { ExpenseCategory, ExpenseEntry, Paise } from '../api/types'
import type { Flash } from '../billing/billingReducer'
import { parseRupeesToPaise } from '../lib/money'

export const CATEGORIES: ReadonlyArray<{ id: ExpenseCategory; label: string; key: string }> = [
  { id: 'ICE', label: 'Ice', key: '1' },
  { id: 'STAFF_FOOD', label: 'Staff food', key: '2' },
  { id: 'TRANSPORT', label: 'Transport', key: '3' },
  { id: 'CLEANING', label: 'Cleaning', key: '4' },
  { id: 'REPAIRS', label: 'Repairs', key: '5' },
  { id: 'OTHER', label: 'Other', key: '6' },
]

export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label])) as Record<ExpenseCategory, string>

export interface ExpenseState {
  load: 'loading' | 'ready' | 'offline' | 'noDay'
  /** Who the server stamps on new expenses (the till's cashier) and the open day, if any. */
  till: { cashier: string; date: string | null } | null
  entries: ExpenseEntry[]
  category: ExpenseCategory | null
  amount: string
  note: string
  submitting: boolean
  /** The expense awaiting void confirmation. */
  confirmVoidId: string | null
  flash: Flash | null
}

export const initialExpenseState: ExpenseState = {
  load: 'loading',
  till: null,
  entries: [],
  category: null,
  amount: '',
  note: '',
  submitting: false,
  confirmVoidId: null,
  flash: null,
}

export type ExpenseAction =
  | { type: 'till'; cashier: string; date: string | null }
  | { type: 'loaded'; entries: ExpenseEntry[] }
  | { type: 'noDay' }
  | { type: 'failed'; message: string }
  | { type: 'category'; category: ExpenseCategory }
  | { type: 'amount'; text: string }
  | { type: 'note'; text: string }
  | { type: 'submitting'; on: boolean }
  /** Recorded: clear amount and note, keep the category for a run of similar entries. */
  | { type: 'recorded' }
  | { type: 'confirmVoid'; id: string | null }
  | { type: 'flash'; kind: Flash['kind']; text: string }

/** What still stops the form from being recorded, or null when it's ready. */
export function formError(state: ExpenseState): string | null {
  if (!state.category) return 'Pick a category'
  if (state.amount.trim() === '') return 'Enter the amount'
  const amount = parseRupeesToPaise(state.amount)
  if (amount === null) return 'Enter rupees, e.g. 150 or 1,080.50'
  if (amount <= 0n) return 'Amount must be more than ₹0'
  if (state.category === 'OTHER' && state.note.trim() === '') return 'Add a note for Other'
  return null
}

export function formPayload(state: ExpenseState): { amount: Paise; category: ExpenseCategory; description: string | null } | null {
  if (formError(state) !== null || !state.category) return null
  const amount = parseRupeesToPaise(state.amount)
  if (amount === null) return null
  return { amount, category: state.category, description: state.note.trim() || null }
}

/** Count and total of the day's expenses that still stand (voided ones excluded). */
export function todayTotals(entries: readonly ExpenseEntry[]): { count: number; totalPaise: Paise } {
  const live = entries.filter((e) => e.voidedAt === null)
  return { count: live.length, totalPaise: live.reduce((sum, e) => sum + e.amountPaise, 0n) }
}

function flash(state: ExpenseState, kind: Flash['kind'], text: string): Flash {
  return { kind, text, seq: (state.flash?.seq ?? 0) + 1 }
}

export function expenseReducer(state: ExpenseState, action: ExpenseAction): ExpenseState {
  switch (action.type) {
    case 'till':
      return { ...state, till: { cashier: action.cashier, date: action.date } }
    case 'loaded': {
      const stillVoidable = action.entries.some((e) => e.id === state.confirmVoidId && e.voidedAt === null)
      return { ...state, load: 'ready', entries: action.entries, confirmVoidId: stillVoidable ? state.confirmVoidId : null }
    }
    case 'noDay':
      return { ...state, load: 'noDay', entries: [], confirmVoidId: null }
    case 'failed':
      return { ...state, load: 'offline', flash: flash(state, 'error', action.message) }
    case 'category':
      return { ...state, category: action.category }
    case 'amount':
      return { ...state, amount: action.text }
    case 'note':
      return { ...state, note: action.text }
    case 'submitting':
      return { ...state, submitting: action.on }
    case 'recorded':
      return { ...state, amount: '', note: '', submitting: false }
    case 'confirmVoid':
      return { ...state, confirmVoidId: action.id }
    case 'flash':
      return { ...state, flash: flash(state, action.kind, action.text) }
  }
}
