/**
 * PurchaseScreen (GRN) state machine. Pure and unit-tested: the invoice header, the SKU picker,
 * line entry, the staging list (add / merge / refuse / remove), totals and the submit states.
 * Quantities are whole bottles and costs whole paise; no floats.
 */
import type { Paise, ReceiptLinePayload, SkuLookup, StockReceipt } from '../api/types'
import type { Flash } from '../billing/billingReducer'
import { formatPaise, parseRupeesToPaise } from '../lib/money'

/** Per-line cap, mirrored from the server (MAX_RECEIPT_QTY): catches a mistyped quantity. */
export const MAX_LINE_QTY = 100_000

export interface StagedLine {
  sku: SkuLookup
  quantity: number
  unitCostPaise: Paise
}

export interface PurchaseState {
  load: 'loading' | 'ready' | 'offline' | 'noDay'
  /** The till's cashier (stamped by the server as the receiver) and the open day, if any. */
  till: { cashier: string; date: string | null } | null
  /** The open day's posted receipts, newest first. */
  receipts: StockReceipt[]
  invoiceNo: string
  vendorName: string
  /** Set when the server refused the invoice as a duplicate (PS011); cleared on edit. */
  invoiceError: boolean
  /** SKU field text: a search, a scanned barcode, or the picked SKU's name. */
  query: string
  results: SkuLookup[]
  highlighted: number
  picked: SkuLookup | null
  qty: string
  cost: string
  lines: StagedLine[]
  selectedLine: number | null
  confirming: boolean
  submitting: boolean
  flash: Flash | null
}

export const initialPurchaseState: PurchaseState = {
  load: 'loading',
  till: null,
  receipts: [],
  invoiceNo: '',
  vendorName: '',
  invoiceError: false,
  query: '',
  results: [],
  highlighted: 0,
  picked: null,
  qty: '',
  cost: '',
  lines: [],
  selectedLine: null,
  confirming: false,
  submitting: false,
  flash: null,
}

export type PurchaseAction =
  | { type: 'till'; cashier: string; date: string | null }
  | { type: 'loaded'; receipts: StockReceipt[] }
  | { type: 'noDay' }
  | { type: 'failed'; message: string }
  | { type: 'invoiceNo'; text: string }
  | { type: 'vendorName'; text: string }
  | { type: 'query'; text: string }
  /** Search results for `query`; dropped when the field has moved on. */
  | { type: 'results'; query: string; results: SkuLookup[] }
  | { type: 'highlight'; delta: number }
  | { type: 'pick'; sku: SkuLookup }
  | { type: 'qty'; text: string }
  | { type: 'cost'; text: string }
  | { type: 'addLine' }
  /** Esc in the entry fields: clear the SKU, quantity and cost. */
  | { type: 'clearEntry' }
  | { type: 'selectLine'; index: number | null }
  | { type: 'removeLine'; index: number }
  | { type: 'confirm'; on: boolean }
  | { type: 'submitting'; on: boolean }
  | { type: 'posted' }
  | { type: 'duplicate' }
  | { type: 'flash'; kind: Flash['kind']; text: string }

/** What still stops the entry fields from becoming a staged line, or null when they're ready. */
export function lineError(state: PurchaseState): string | null {
  if (!state.picked) return 'Pick a SKU'
  if (state.qty === '') return 'Enter the quantity received'
  const qty = Number(state.qty)
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) return 'Quantity must be 1 to 100,000 bottles'
  if (state.cost.trim() === '') return 'Enter the unit cost (0 for free bottles)'
  if (parseRupeesToPaise(state.cost) === null) return 'Enter rupees, e.g. 1100 or 1,100.50'
  return null
}

/** What still stops the invoice from being posted, or null when it's ready. */
export function submitError(state: PurchaseState): string | null {
  if (state.invoiceNo.trim() === '') return 'Enter the invoice number'
  if (state.lines.length === 0) return 'Add at least one line'
  return null
}

export function submitPayload(state: PurchaseState): { invoiceNo: string; vendorName: string | null; lines: ReceiptLinePayload[] } | null {
  if (submitError(state) !== null) return null
  return {
    invoiceNo: state.invoiceNo.trim(),
    vendorName: state.vendorName.trim() || null,
    lines: state.lines.map((l) => ({ skuId: l.sku.id, quantity: l.quantity, unitCost: l.unitCostPaise })),
  }
}

export function lineTotal(line: StagedLine): Paise {
  return BigInt(line.quantity) * line.unitCostPaise
}

export function stagedTotals(lines: readonly StagedLine[]): { lineCount: number; bottles: number; totalPaise: Paise } {
  return {
    lineCount: lines.length,
    bottles: lines.reduce((sum, l) => sum + l.quantity, 0),
    totalPaise: lines.reduce((sum, l) => sum + lineTotal(l), 0n),
  }
}

/**
 * The SKU an Enter in the search field means: an exact barcode or SKU code match (a scan), else
 * the only result, else the highlighted one.
 */
export function pickFromSearch(query: string, results: readonly SkuLookup[], highlighted: number): SkuLookup | null {
  const text = query.trim()
  const exact = results.find((s) => s.barcode === text || s.skuCode.toUpperCase() === text.toUpperCase())
  if (exact) return exact
  if (results.length === 1) return results[0] ?? null
  return results[highlighted] ?? null
}

function flash(state: PurchaseState, kind: Flash['kind'], text: string): Flash {
  return { kind, text, seq: (state.flash?.seq ?? 0) + 1 }
}

const CLEAR_ENTRY: Pick<PurchaseState, 'query' | 'results' | 'highlighted' | 'picked' | 'qty' | 'cost'> = {
  query: '',
  results: [],
  highlighted: 0,
  picked: null,
  qty: '',
  cost: '',
}

function addLine(state: PurchaseState): PurchaseState {
  const error = lineError(state)
  const cost = parseRupeesToPaise(state.cost)
  if (error !== null || !state.picked || cost === null) return { ...state, flash: flash(state, 'error', error ?? 'Check the line') }
  const sku = state.picked
  const quantity = Number(state.qty)

  const at = state.lines.findIndex((l) => l.sku.id === sku.id)
  if (at === -1) {
    const lines = [...state.lines, { sku, quantity, unitCostPaise: cost }]
    return { ...state, ...CLEAR_ENTRY, lines, selectedLine: lines.length - 1 }
  }
  const existing = state.lines[at]!
  if (existing.unitCostPaise !== cost) {
    const text = `${sku.displayName} is already on this invoice at ${formatPaise(existing.unitCostPaise)} — remove it first`
    return { ...state, flash: flash(state, 'error', text) }
  }
  if (existing.quantity + quantity > MAX_LINE_QTY) {
    return { ...state, flash: flash(state, 'error', `${sku.displayName} would exceed 100,000 bottles on one line`) }
  }
  const lines = state.lines.map((l, i) => (i === at ? { ...l, quantity: l.quantity + quantity } : l))
  return { ...state, ...CLEAR_ENTRY, lines, selectedLine: at }
}

export function purchaseReducer(state: PurchaseState, action: PurchaseAction): PurchaseState {
  switch (action.type) {
    case 'till':
      return { ...state, till: { cashier: action.cashier, date: action.date } }
    case 'loaded':
      return { ...state, load: 'ready', receipts: action.receipts }
    case 'noDay':
      return { ...state, load: 'noDay', receipts: [], confirming: false }
    case 'failed':
      // Once the form is up, a failed poll only flashes: the invoice being keyed in stays on screen.
      return { ...state, load: state.load === 'ready' ? 'ready' : 'offline', flash: flash(state, 'error', action.message) }
    case 'invoiceNo':
      return { ...state, invoiceNo: action.text, invoiceError: false }
    case 'vendorName':
      return { ...state, vendorName: action.text }
    case 'query':
      return { ...state, query: action.text, picked: null, highlighted: 0, ...(action.text.trim() === '' ? { results: [] } : {}) }
    case 'results':
      if (action.query !== state.query.trim() || state.picked) return state
      return { ...state, results: action.results, highlighted: 0 }
    case 'highlight': {
      const last = Math.max(0, state.results.length - 1)
      return { ...state, highlighted: Math.min(last, Math.max(0, state.highlighted + action.delta)) }
    }
    case 'pick':
      if (!action.sku.isActive) {
        return { ...state, flash: flash(state, 'error', `${action.sku.displayName} is inactive and cannot be received`) }
      }
      return { ...state, picked: action.sku, query: action.sku.displayName, results: [], highlighted: 0 }
    case 'qty':
      return { ...state, qty: action.text.replace(/\D/g, '') }
    case 'cost':
      return { ...state, cost: action.text }
    case 'addLine':
      return addLine(state)
    case 'clearEntry':
      return { ...state, ...CLEAR_ENTRY }
    case 'selectLine':
      return { ...state, selectedLine: action.index }
    case 'removeLine': {
      const lines = state.lines.filter((_, i) => i !== action.index)
      const selectedLine = lines.length === 0 ? null : Math.min(state.selectedLine ?? 0, lines.length - 1)
      return { ...state, lines, selectedLine }
    }
    case 'confirm':
      return { ...state, confirming: action.on && submitError(state) === null }
    case 'submitting':
      return { ...state, submitting: action.on }
    case 'posted':
      return { ...state, ...CLEAR_ENTRY, invoiceNo: '', vendorName: '', invoiceError: false, lines: [], selectedLine: null, confirming: false, submitting: false }
    case 'duplicate':
      return { ...state, confirming: false, submitting: false, invoiceError: true }
    case 'flash':
      return { ...state, flash: flash(state, action.kind, action.text) }
  }
}
