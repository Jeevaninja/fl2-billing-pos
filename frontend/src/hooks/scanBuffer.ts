/**
 * Keyboard-wedge scan buffer, as a pure state machine. Barcode scanners "type" the code and press
 * Enter; cashiers can type a SKU code the same way. Nothing here needs an <input> to have focus.
 *
 *   "3*" then a scan  → that scan sells 3 bottles
 *   Enter             → commit the buffer (ignored when empty, so focused buttons still work)
 *   Backspace / Esc   → edit / clear
 *   ↑ ↓ + − Delete    → row commands, only while the buffer is empty ("-" is part of SKU codes)
 */
export const IDLE_RESET_MS = 2_000
const MAX_LENGTH = 64
const MAX_QUANTITY = 99

export interface ScanState {
  text: string
  /** Quantity prefix set with "N*"; null means 1. */
  quantity: number | null
  /** Timestamp of the last key that changed the buffer. */
  lastAt: number
}

export const EMPTY_SCAN: ScanState = { text: '', quantity: null, lastAt: 0 }

export interface ScanInput {
  key: string
  now: number
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

export type RowCommand = 'up' | 'down' | 'increment' | 'decrement'

export type ScanEffect = { type: 'commit'; code: string; quantity: number } | { type: 'command'; command: RowCommand }

export interface ScanResult {
  state: ScanState
  /** True when the key was consumed (the caller should preventDefault). */
  handled: boolean
  effect?: ScanEffect
}

const ROW_KEYS: Record<string, RowCommand> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  '+': 'increment',
  '-': 'decrement',
  Delete: 'decrement',
}

export function scanKey(prev: ScanState, input: ScanInput): ScanResult {
  const { key, now } = input
  if (input.ctrlKey || input.metaKey || input.altKey) return { state: prev, handled: false }

  const stale = prev.lastAt !== 0 && now - prev.lastAt > IDLE_RESET_MS
  const state = stale ? EMPTY_SCAN : prev
  const empty = state.text === '' && state.quantity === null

  const command = ROW_KEYS[key]
  if (command && empty) return { state, handled: true, effect: { type: 'command', command } }

  switch (key) {
    case 'Enter': {
      const code = state.text.trim()
      if (code === '') return { state, handled: !empty }
      return { state: { ...EMPTY_SCAN, lastAt: now }, handled: true, effect: { type: 'commit', code, quantity: state.quantity ?? 1 } }
    }
    case 'Escape':
      return empty ? { state, handled: false } : { state: { ...EMPTY_SCAN, lastAt: now }, handled: true }
    case 'Backspace':
      if (state.text !== '') return { state: { ...state, text: state.text.slice(0, -1), lastAt: now }, handled: true }
      if (state.quantity !== null) return { state: { ...state, quantity: null, lastAt: now }, handled: true }
      return { state, handled: false }
    case '*': {
      const n = /^\d{1,2}$/.test(state.text) ? Number(state.text) : 0
      if (n >= 1 && n <= MAX_QUANTITY) return { state: { text: '', quantity: n, lastAt: now }, handled: true }
      return { state, handled: true }
    }
  }

  if (key.length !== 1 || key === ' ') return { state: prev, handled: false }
  if (state.text.length >= MAX_LENGTH) return { state, handled: true }
  return { state: { ...state, text: state.text + key, lastAt: now }, handled: true }
}
