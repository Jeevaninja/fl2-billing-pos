/**
 * BankDepositScreen state machine. Pure and unit-tested: the form (amount, reference), the open
 * day's deposits, the drawer's expected cash (for the over-drawer warning) and the void
 * confirmation. Amounts are parsed to whole paise; no floats.
 */
import type { BankDepositEntry, Paise } from '../api/types'
import type { Flash } from '../billing/billingReducer'
import { formatPaise, parseRupeesToPaise } from '../lib/money'

export const MAX_REFERENCE = 200

export interface BankDepositState {
  load: 'loading' | 'ready' | 'offline' | 'noDay'
  /** Who the server stamps on new deposits (the till's cashier) and the open day, if any. */
  till: { cashier: string; date: string | null } | null
  entries: BankDepositEntry[]
  /** The Day End expected drawer cash; null until known. Display only. */
  expectedCashPaise: Paise | null
  /** Deposits are refused while a peak session runs. */
  peakRunning: boolean
  amount: string
  reference: string
  submitting: boolean
  /** The deposit awaiting void confirmation. */
  confirmVoidId: string | null
  flash: Flash | null
}

export const initialBankDepositState: BankDepositState = {
  load: 'loading',
  till: null,
  entries: [],
  expectedCashPaise: null,
  peakRunning: false,
  amount: '',
  reference: '',
  submitting: false,
  confirmVoidId: null,
  flash: null,
}

export type BankDepositAction =
  | { type: 'till'; cashier: string; date: string | null; peakRunning: boolean }
  | { type: 'loaded'; entries: BankDepositEntry[]; expectedCashPaise: Paise }
  | { type: 'noDay' }
  | { type: 'failed'; message: string }
  | { type: 'amount'; text: string }
  | { type: 'reference'; text: string }
  | { type: 'submitting'; on: boolean }
  /** Recorded: clear the form. */
  | { type: 'recorded' }
  | { type: 'confirmVoid'; id: string | null }
  | { type: 'flash'; kind: Flash['kind']; text: string }

/** What still stops the form from being recorded, or null when it's ready. */
export function formError(state: BankDepositState): string | null {
  if (state.peakRunning) return 'End the peak session before a bank deposit'
  if (state.amount.trim() === '') return 'Enter the amount'
  const amount = parseRupeesToPaise(state.amount)
  if (amount === null) return 'Enter rupees, e.g. 10000 or 10,000.50'
  if (amount <= 0n) return 'Amount must be more than ₹0'
  if (state.reference.trim().length > MAX_REFERENCE) return `Reference must be at most ${MAX_REFERENCE} characters`
  return null
}

export function formPayload(state: BankDepositState): { amount: Paise; reference: string | null } | null {
  if (formError(state) !== null) return null
  const amount = parseRupeesToPaise(state.amount)
  if (amount === null) return null
  return { amount, reference: state.reference.trim() || null }
}

/**
 * A warning (not a block) when the amount is more than the drawer should hold. The drawer can
 * genuinely be over, so the deposit is still allowed.
 */
export function overDrawerWarning(state: BankDepositState): string | null {
  if (state.expectedCashPaise === null) return null
  const amount = parseRupeesToPaise(state.amount)
  if (amount === null || amount <= state.expectedCashPaise) return null
  return `More than the drawer should hold (${formatPaise(state.expectedCashPaise)}). Check the amount.`
}

/** Count and total of the day's deposits that still stand (voided ones excluded). */
export function todayTotals(entries: readonly BankDepositEntry[]): { count: number; totalPaise: Paise } {
  const live = entries.filter((e) => e.voidedAt === null)
  return { count: live.length, totalPaise: live.reduce((sum, e) => sum + e.amountPaise, 0n) }
}

function flash(state: BankDepositState, kind: Flash['kind'], text: string): Flash {
  return { kind, text, seq: (state.flash?.seq ?? 0) + 1 }
}

export function bankDepositReducer(state: BankDepositState, action: BankDepositAction): BankDepositState {
  switch (action.type) {
    case 'till':
      return { ...state, till: { cashier: action.cashier, date: action.date }, peakRunning: action.peakRunning }
    case 'loaded': {
      const stillVoidable = action.entries.some((e) => e.id === state.confirmVoidId && e.voidedAt === null)
      return {
        ...state,
        load: 'ready',
        entries: action.entries,
        expectedCashPaise: action.expectedCashPaise,
        confirmVoidId: stillVoidable ? state.confirmVoidId : null,
      }
    }
    case 'noDay':
      return { ...state, load: 'noDay', entries: [], expectedCashPaise: null, confirmVoidId: null }
    case 'failed':
      return { ...state, load: 'offline', flash: flash(state, 'error', action.message) }
    case 'amount':
      return { ...state, amount: action.text }
    case 'reference':
      return { ...state, reference: action.text }
    case 'submitting':
      return { ...state, submitting: action.on }
    case 'recorded':
      return { ...state, amount: '', reference: '', submitting: false }
    case 'confirmVoid':
      return { ...state, confirmVoidId: action.id }
    case 'flash':
      return { ...state, flash: flash(state, action.kind, action.text) }
  }
}
