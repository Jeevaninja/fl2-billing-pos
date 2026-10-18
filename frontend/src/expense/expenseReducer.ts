/**
 * ExpenseScreen state machine. Pure and unit-tested: the form (category, amount, note), the open
 * day's list, and the void confirmation. Amounts are parsed to whole paise; no floats. Categories
 * are the manager's list from Settings (Phase 18), in their order.
 */
import type { ExpenseCategory, ExpenseEntry, Paise } from '../api/types'
import type { Flash } from '../billing/billingReducer'
import { parseRupeesToPaise } from '../lib/money'

/** Quick-pick keys for the first nine categories in the manager's order. */
export const QUICK_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

export interface ExpenseState {
  load: 'loading' | 'ready' | 'offline' | 'noDay'
  /** Who the server stamps on new expenses (the till's cashier) and the open day, if any. */
  till: { cashier: string; date: string | null } | null
  entries: ExpenseEntry[]
  /** Active categories, in the manager's picker order (null until loaded). */
  categories: ExpenseCategory[] | null
  categoryId: string | null
  /** Type-to-search text in the category field. */
  query: string
  /** Index into `pickerMatches` that Enter picks. */
  highlighted: number
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
  categories: null,
  categoryId: null,
  query: '',
  highlighted: 0,
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
  /** A fresh list; a picked category that was disabled meanwhile is dropped. */
  | { type: 'categories'; categories: ExpenseCategory[] }
  | { type: 'category'; id: string }
  | { type: 'query'; text: string }
  | { type: 'highlight'; delta: 1 | -1 }
  | { type: 'amount'; text: string }
  | { type: 'note'; text: string }
  | { type: 'submitting'; on: boolean }
  /** Recorded: clear amount and note, keep the category for a run of similar entries. */
  | { type: 'recorded' }
  | { type: 'confirmVoid'; id: string | null }
  | { type: 'flash'; kind: Flash['kind']; text: string }

export function selectedCategory(state: ExpenseState): ExpenseCategory | null {
  return state.categories?.find((c) => c.id === state.categoryId) ?? null
}

/**
 * The categories the picker shows: all of them while the search is blank (or still reads the picked
 * name), otherwise those whose name contains the typed text, case-insensitive.
 */
export function pickerMatches(state: ExpenseState): ExpenseCategory[] {
  const all = state.categories ?? []
  const q = state.query.trim().toLowerCase()
  if (q === '' || q === selectedCategory(state)?.name.toLowerCase()) return all
  return all.filter((c) => c.name.toLowerCase().includes(q))
}

/** The quick-pick key ('1'–'9') of a category: its place among the first nine, in the manager's order. */
export function quickKey(state: ExpenseState, id: string): string | null {
  const at = (state.categories ?? []).findIndex((c) => c.id === id)
  return at >= 0 && at < QUICK_KEYS.length ? (QUICK_KEYS[at] ?? null) : null
}

/** The category a quick key picks, if any. */
export function categoryForKey(state: ExpenseState, key: string): ExpenseCategory | null {
  const at = QUICK_KEYS.indexOf(key as (typeof QUICK_KEYS)[number])
  return at === -1 ? null : ((state.categories ?? [])[at] ?? null)
}

/** What still stops the form from being recorded, or null when it's ready. */
export function formError(state: ExpenseState): string | null {
  const category = selectedCategory(state)
  if (!category) return 'Pick a category'
  if (state.amount.trim() === '') return 'Enter the amount'
  const amount = parseRupeesToPaise(state.amount)
  if (amount === null) return 'Enter rupees, e.g. 150 or 1,080.50'
  if (amount <= 0n) return 'Amount must be more than ₹0'
  if (category.noteRequired && state.note.trim() === '') return `Add a note for ${category.name}`
  return null
}

export function formPayload(state: ExpenseState): { amount: Paise; categoryId: string; description: string | null } | null {
  const category = selectedCategory(state)
  if (formError(state) !== null || !category) return null
  const amount = parseRupeesToPaise(state.amount)
  if (amount === null) return null
  return { amount, categoryId: category.id, description: state.note.trim() || null }
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
    case 'categories': {
      const kept = action.categories.find((c) => c.id === state.categoryId)
      return { ...state, categories: action.categories, categoryId: kept ? kept.id : null, query: kept ? kept.name : state.categoryId ? '' : state.query, highlighted: 0 }
    }
    case 'category': {
      const picked = state.categories?.find((c) => c.id === action.id)
      return picked ? { ...state, categoryId: picked.id, query: picked.name, highlighted: 0 } : state
    }
    case 'query':
      return { ...state, query: action.text, highlighted: 0 }
    case 'highlight': {
      const n = pickerMatches(state).length
      return n === 0 ? state : { ...state, highlighted: Math.min(n - 1, Math.max(0, state.highlighted + action.delta)) }
    }
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
