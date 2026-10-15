/**
 * DayEndScreen state machine. Pure and unit-tested. The server computes every figure (expected
 * cash, the frozen variance); the screen only previews counted − expected while the cashier types.
 */
import type { DayEndSummary, Paise } from '../api/types'
import type { Flash } from '../billing/billingReducer'
import { parseRupeesToPaise } from '../lib/money'

export type DayEndDialog = { kind: 'confirm' } | { kind: 'repay'; waiterId: string } | { kind: 'endPeak' }
export type DayEndView = 'LOADING' | 'OFFLINE' | 'NO_DAY' | 'OPEN' | 'CLOSED'

export interface DayEndState {
  load: 'loading' | 'ready' | 'offline' | 'none'
  offlineMessage: string | null
  /** The open day, or the last closed one. */
  summary: DayEndSummary | null
  /** Counted drawer cash as typed (rupees). */
  counted: string
  dialog: DayEndDialog | null
  flash: Flash | null
}

export const initialDayEndState: DayEndState = {
  load: 'loading',
  offlineMessage: null,
  summary: null,
  counted: '',
  dialog: null,
  flash: null,
}

export type DayEndAction =
  | { type: 'loaded'; summary: DayEndSummary }
  /** No business day has ever been opened. */
  | { type: 'noDay' }
  | { type: 'failed'; message: string }
  | { type: 'counted'; text: string }
  | { type: 'dialog'; dialog: DayEndDialog | null }
  | { type: 'flash'; kind: Flash['kind']; text: string }

export function dayEndView(state: DayEndState): DayEndView {
  if (state.summary) return state.summary.day.status === 'OPEN' ? 'OPEN' : 'CLOSED'
  if (state.load === 'offline') return 'OFFLINE'
  if (state.load === 'none') return 'NO_DAY'
  return 'LOADING'
}

/** Open bills that need the cashier one by one; peak bills clear together when the session ends. */
export function openCounterBills(summary: DayEndSummary) {
  const { openBills, runningPeakSession } = summary.blockers
  return runningPeakSession ? openBills.filter((b) => b.status === 'OPEN') : openBills
}

/** Checklist items to clear: each open bill, a running peak session (with its bills), each owing waiter. */
export function blockerCount(summary: DayEndSummary): number {
  const { runningPeakSession, waitersOwing } = summary.blockers
  return openCounterBills(summary).length + (runningPeakSession ? 1 : 0) + waitersOwing.length
}

/** The typed count in paise; null when blank or not a valid rupee amount. */
export function countedPaise(state: DayEndState): Paise | null {
  return state.counted.trim() === '' ? null : parseRupeesToPaise(state.counted)
}

/** counted − expected, for display only (the server freezes its own figure on lock). */
export function variancePreview(state: DayEndState): Paise | null {
  const counted = countedPaise(state)
  return counted === null || !state.summary ? null : counted - state.summary.breakdown.expectedCashPaise
}

/** Why "Confirm & Lock Day" is disabled, or null when it can go ahead. */
export function lockBlock(state: DayEndState): string | null {
  const summary = state.summary
  if (!summary || summary.day.status !== 'OPEN') return 'No open business day'
  const blockers = blockerCount(summary)
  if (blockers > 0 || !summary.canClose) return `Clear ${blockers} item${blockers === 1 ? '' : 's'} in the checklist first`
  if (state.counted.trim() === '') return 'Enter the counted cash'
  if (countedPaise(state) === null) return 'Enter rupees, e.g. 30500 or 30,500.50'
  return null
}

export function dayEndReducer(state: DayEndState, action: DayEndAction): DayEndState {
  switch (action.type) {
    case 'loaded': {
      const sameOpenDay = state.summary?.day.id === action.summary.day.id && action.summary.day.status === 'OPEN'
      return {
        ...state,
        load: 'ready',
        offlineMessage: null,
        summary: action.summary,
        counted: sameOpenDay ? state.counted : '',
        dialog: sameOpenDay ? state.dialog : null,
      }
    }
    case 'noDay':
      return { ...state, load: 'none', offlineMessage: null, summary: null, counted: '', dialog: null }
    case 'failed':
      return {
        ...state,
        load: state.summary ? state.load : 'offline',
        offlineMessage: action.message,
        flash: { kind: 'error', text: action.message, seq: (state.flash?.seq ?? 0) + 1 },
      }
    case 'counted':
      return { ...state, counted: action.text }
    case 'dialog':
      return { ...state, dialog: action.dialog }
    case 'flash':
      return { ...state, flash: { kind: action.kind, text: action.text, seq: (state.flash?.seq ?? 0) + 1 } }
  }
}
