/**
 * Phase 25 PIN pad (plan D5): pure state for the Day Open PIN dialog. The server is the judge of the
 * PIN; this only tracks the digits typed, who is authorising, and the feedback from the last attempt.
 */
import type { StaffSummary } from '../api/types'

export const PIN_MIN = 4
export const PIN_MAX = 6

export type PinFeedback =
  | { kind: 'none' }
  | { kind: 'wrong'; message: string; attemptsLeft: number | null }
  /** Locked until `until` (epoch ms, from the server's Retry-After). */
  | { kind: 'locked'; message: string; until: number }
  | { kind: 'error'; message: string }

export interface PinPadState {
  holders: StaffSummary[] | null
  picked: StaffSummary | null
  digits: string
  busy: boolean
  feedback: PinFeedback
  /** Bumped on a wrong PIN so the dots can replay their shake. */
  shake: number
}

export const initialPinPad: PinPadState = { holders: null, picked: null, digits: '', busy: false, feedback: { kind: 'none' }, shake: 0 }

export type PinPadAction =
  | { type: 'holders'; holders: StaffSummary[] }
  | { type: 'pick'; staff: StaffSummary }
  | { type: 'unpick' }
  | { type: 'digit'; digit: string }
  | { type: 'backspace' }
  | { type: 'clear' }
  | { type: 'submit' }
  | { type: 'failed'; feedback: Exclude<PinFeedback, { kind: 'none' }> }
  | { type: 'unlocked' }

export function pinPadReducer(state: PinPadState, action: PinPadAction): PinPadState {
  switch (action.type) {
    case 'holders':
      // One PIN holder: skip the picker.
      return { ...state, holders: action.holders, picked: action.holders.length === 1 ? action.holders[0]! : state.picked }
    case 'pick':
      return { ...state, picked: action.staff, digits: '', feedback: { kind: 'none' } }
    case 'unpick':
      return state.busy || (state.holders?.length ?? 0) <= 1 ? state : { ...state, picked: null, digits: '', feedback: { kind: 'none' } }
    case 'digit':
      if (state.busy || isLocked(state) || !/^\d$/.test(action.digit) || state.digits.length >= PIN_MAX) return state
      return { ...state, digits: state.digits + action.digit, feedback: state.feedback.kind === 'wrong' ? state.feedback : { kind: 'none' } }
    case 'backspace':
      return state.busy ? state : { ...state, digits: state.digits.slice(0, -1) }
    case 'clear':
      return state.busy ? state : { ...state, digits: '' }
    case 'submit':
      return canSubmit(state) ? { ...state, busy: true } : state
    case 'failed':
      return { ...state, busy: false, digits: '', feedback: action.feedback, shake: action.feedback.kind === 'wrong' ? state.shake + 1 : state.shake }
    case 'unlocked':
      return state.feedback.kind === 'locked' ? { ...state, feedback: { kind: 'none' } } : state
  }
}

export function isLocked(state: PinPadState): boolean {
  return state.feedback.kind === 'locked'
}

export function canSubmit(state: PinPadState): boolean {
  return state.picked !== null && !state.busy && !isLocked(state) && state.digits.length >= PIN_MIN && state.digits.length <= PIN_MAX
}

/** "4:59" for a lockout countdown; "0:00" once it has passed. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** What a failed authorisation means for the pad, from the API error's code and details. */
export function feedbackFor(error: { code: string; message: string; attemptsLeft?: number | undefined; retryAfterSeconds?: number | undefined }, now: number): Exclude<PinFeedback, { kind: 'none' }> {
  if (error.code === 'INVALID_PIN') return { kind: 'wrong', message: error.message, attemptsLeft: error.attemptsLeft ?? null }
  if (error.code === 'LOCKED') return { kind: 'locked', message: error.message, until: now + (error.retryAfterSeconds ?? 300) * 1000 }
  return { kind: 'error', message: error.message }
}

export const ROLE_LABEL: Readonly<Record<StaffSummary['role'], string>> = { CASHIER: 'Cashier', MANAGER: 'Manager', ADMIN: 'Admin' }

/** "RK" from "Ravi Kumar", "C1" from "Counter 1". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length === 1 ? words[0]!.slice(0, 2) : words.slice(0, 2).map((w) => w[0]!).join('')
  return letters.toUpperCase()
}
