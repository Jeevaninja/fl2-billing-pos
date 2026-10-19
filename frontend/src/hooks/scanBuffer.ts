/**
 * Keyboard-wedge scan buffer, as a pure state machine. Barcode scanners "type" the code and press
 * Enter; cashiers can type a SKU code the same way. Nothing here needs an <input> to have focus.
 *
 *   "3*" then a scan  → that scan sells 3 bottles
 *   Enter             → commit the buffer (ignored when empty, so focused buttons still work)
 *   Backspace / Esc   → edit / clear
 *   ↑ ↓ + − Delete    → row commands, only while the buffer is empty ("-" is part of SKU codes)
 *
 * Type-to-search (Phase 21): once the buffer has text, a space is kept ("chicken 65") and ↑ / ↓ move
 * the search list's highlight. While the screen shows that list (`searchOpen`) the idle reset is off,
 * so a cashier can pause; Enter commits (the screen adds an exact match, else the highlighted result)
 * and Esc clears. A scanner never pauses, and stray keys that match nothing still clear after 2 s.
 *
 * Quantity edit (normal billing): Enter on an empty buffer, with a selected row, opens the row's
 * quantity for typing — no <input> takes focus, so a scanner can never type into a field.
 *
 *   digits            → replace the shown quantity, then append (2 digits max, 1–99)
 *   + / −             → ±1        Backspace → edit        Esc → cancel
 *   ↑ ↓ Delete        → leave the edit and act on the rows as usual
 *   Enter             → setQty (the screen applies it, then opens Payment)
 *   3rd digit / other → the edit was really a scan: everything typed becomes the scan buffer
 */
export const IDLE_RESET_MS = 2_000
const MAX_LENGTH = 64
const MAX_QUANTITY = 99
const QTY_DIGITS = 2

export interface ScanState {
  text: string
  /** Quantity prefix set with "N*"; null means 1. */
  quantity: number | null
  /** Timestamp of the last key that changed the buffer. */
  lastAt: number
  /** Quantity being typed for the selected row; `fresh` = still the row's own quantity (next digit replaces it). */
  qtyEdit: { text: string; fresh: boolean } | null
}

export const EMPTY_SCAN: ScanState = { text: '', quantity: null, lastAt: 0, qtyEdit: null }

export interface ScanContext {
  /** The selected row's current quantity when it can be edited; null disables quantity edit. */
  qtyTarget: number | null
  /** The screen is showing search results for the buffer: no idle reset. */
  searchOpen?: boolean
}

const NO_QTY: ScanContext = { qtyTarget: null }

export interface ScanInput {
  key: string
  now: number
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

export type RowCommand = 'up' | 'down' | 'increment' | 'decrement'

export type ScanEffect =
  | { type: 'commit'; code: string; quantity: number }
  | { type: 'command'; command: RowCommand }
  | { type: 'setQty'; quantity: number }
  /** ↑ / ↓ with text in the buffer: move the search list's highlight. */
  | { type: 'highlight'; delta: 1 | -1 }

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

export function scanKey(prev: ScanState, input: ScanInput, ctx: ScanContext = NO_QTY): ScanResult {
  const { key, now } = input
  if (input.ctrlKey || input.metaKey || input.altKey) return { state: prev, handled: false }

  if (prev.qtyEdit) {
    if (ctx.qtyTarget !== null) return qtyKey(prev.qtyEdit, input, ctx.qtyTarget)
    prev = { ...prev, qtyEdit: null } // the row went away: drop the edit, handle the key normally
  }

  const stale = prev.lastAt !== 0 && now - prev.lastAt > IDLE_RESET_MS && !ctx.searchOpen
  const state = stale ? EMPTY_SCAN : prev
  const empty = state.text === '' && state.quantity === null

  const command = ROW_KEYS[key]
  if (command && empty) return { state, handled: true, effect: { type: 'command', command } }
  if ((key === 'ArrowUp' || key === 'ArrowDown') && state.text !== '') {
    return { state: { ...state, lastAt: now }, handled: true, effect: { type: 'highlight', delta: key === 'ArrowUp' ? -1 : 1 } }
  }

  switch (key) {
    case 'Enter': {
      const code = state.text.trim()
      if (code === '' && empty && ctx.qtyTarget !== null) {
        return { state: { ...EMPTY_SCAN, lastAt: now, qtyEdit: { text: String(ctx.qtyTarget), fresh: true } }, handled: true }
      }
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
      if (n >= 1 && n <= MAX_QUANTITY) return { state: { ...EMPTY_SCAN, quantity: n, lastAt: now }, handled: true }
      return { state, handled: true }
    }
  }

  if (key === ' ') {
    // A space only joins words of a typed name; a leading or repeated one is dropped.
    if (state.text === '') return { state: prev, handled: false }
    if (state.text.endsWith(' ') || state.text.length >= MAX_LENGTH) return { state, handled: true }
    return { state: { ...state, text: state.text + ' ', lastAt: now }, handled: true }
  }
  if (key.length !== 1) return { state: prev, handled: false }
  if (state.text.length >= MAX_LENGTH) return { state, handled: true }
  return { state: { ...state, text: state.text + key, lastAt: now }, handled: true }
}

function qtyValue(edit: { text: string }, target: number): number {
  return edit.text === '' ? target : Number(edit.text)
}

/** A key while the selected row's quantity is being typed. */
function qtyKey(edit: { text: string; fresh: boolean }, input: ScanInput, target: number): ScanResult {
  const { key, now } = input
  const at = (qtyEdit: ScanState['qtyEdit']): ScanState => ({ ...EMPTY_SCAN, lastAt: now, qtyEdit })
  const leave = at(null)
  switch (key) {
    case 'Enter': {
      const quantity = qtyValue(edit, target)
      // 0 keeps the edit open; the screen explains why.
      return { state: quantity === 0 ? at(edit) : leave, handled: true, effect: { type: 'setQty', quantity } }
    }
    case 'Escape':
      return { state: leave, handled: true }
    case 'Backspace':
      return { state: at({ text: edit.fresh ? '' : edit.text.slice(0, -1), fresh: false }), handled: true }
    case '+':
    case '-': {
      const next = Math.min(MAX_QUANTITY, Math.max(1, qtyValue(edit, target) + (key === '+' ? 1 : -1)))
      return { state: at({ text: String(next), fresh: true }), handled: true }
    }
  }
  const command = ROW_KEYS[key]
  if (command) return { state: leave, handled: true, effect: { type: 'command', command } }

  if (/^\d$/.test(key)) {
    if (edit.fresh) return { state: at({ text: key, fresh: false }), handled: true }
    if (edit.text.length < QTY_DIGITS) return { state: at({ text: edit.text + key, fresh: false }), handled: true }
  } else if (key.length !== 1 || key === ' ') {
    return { state: at(edit), handled: false }
  }
  // A 3rd digit or any other character: this was a scan, not a quantity.
  return scanKey({ ...EMPTY_SCAN, text: edit.fresh ? '' : edit.text, lastAt: now }, input)
}
