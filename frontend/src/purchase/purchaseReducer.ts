/**
 * PurchaseScreen (GRN) state machine. Pure and unit-tested: the invoice header, the SKU picker,
 * line entry in cases + loose bottles, the staging list (add / merge / refuse / remove), totals and
 * the submit states. Quantities are whole bottles (cases × case size + loose) and costs whole
 * paise; no floats.
 */
import type { Paise, ReceiptLinePayload, SkuLookup, StockReceipt } from '../api/types'
import type { Flash } from '../billing/billingReducer'
import { formatPaise, paiseToRupeeInput, parseRupeesToPaise } from '../lib/money'

/** Per-line cap, mirrored from the server (MAX_RECEIPT_QTY): catches a mistyped quantity. */
export const MAX_LINE_QTY = 100_000

export interface StagedLine {
  sku: SkuLookup
  cases: number
  looseBottles: number
  /** The SKU's case size when the line was counted (the server re-checks it). */
  caseSize: number
  /** Whole bottles: cases × caseSize + looseBottles. */
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
  /** Digits only; empty counts as 0. */
  cases: string
  loose: string
  /** Pre-filled from the catalog's default purchase price on pick; editable. */
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
  cases: '',
  loose: '',
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
  | { type: 'cases'; text: string }
  | { type: 'loose'; text: string }
  | { type: 'cost'; text: string }
  | { type: 'addLine' }
  /** Esc in the entry fields: clear the SKU, cases, loose bottles and cost. */
  | { type: 'clearEntry' }
  | { type: 'selectLine'; index: number | null }
  | { type: 'removeLine'; index: number }
  | { type: 'confirm'; on: boolean }
  | { type: 'submitting'; on: boolean }
  | { type: 'posted' }
  | { type: 'duplicate' }
  | { type: 'flash'; kind: Flash['kind']; text: string }

/** Whole bottles for `cases` full cases plus `loose` bottles. */
export function bottlesFor(cases: number, loose: number, caseSize: number): number {
  return cases * caseSize + loose
}

/**
 * The entry fields' count: cases, loose bottles and their whole-bottle total (empty fields are 0),
 * or null before a SKU is picked.
 */
export function entryCount(state: Pick<PurchaseState, 'picked' | 'cases' | 'loose'>): { cases: number; loose: number; total: number } | null {
  if (!state.picked) return null
  const cases = state.cases === '' ? 0 : Number(state.cases)
  const loose = state.loose === '' ? 0 : Number(state.loose)
  return { cases, loose, total: bottlesFor(cases, loose, state.picked.caseSize) }
}

/** What still stops the entry fields from becoming a staged line, or null when they're ready. */
export function lineError(state: PurchaseState): string | null {
  const count = entryCount(state)
  if (!state.picked || !count) return 'Pick a SKU'
  if (state.cases === '' && state.loose === '') return 'Enter cases and / or loose bottles'
  const { caseSize } = state.picked
  if (count.loose >= caseSize) return `${count.loose} loose is a full case of ${caseSize} — add it to Cases`
  if (!Number.isSafeInteger(count.total) || count.total < 1) return 'Enter at least one case or bottle'
  if (count.total > MAX_LINE_QTY) return 'A line can have at most 100,000 bottles'
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
    lines: state.lines.map((l) => ({ skuId: l.sku.id, cases: l.cases, looseBottles: l.looseBottles, caseSize: l.caseSize, unitCost: l.unitCostPaise })),
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

const CLEAR_ENTRY: Pick<PurchaseState, 'query' | 'results' | 'highlighted' | 'picked' | 'cases' | 'loose' | 'cost'> = {
  query: '',
  results: [],
  highlighted: 0,
  picked: null,
  cases: '',
  loose: '',
  cost: '',
}

/** Adds two counts of the same SKU, carrying loose bottles that make up a full case into cases. */
export function mergeCounts(a: Pick<StagedLine, 'cases' | 'looseBottles'>, b: Pick<StagedLine, 'cases' | 'looseBottles'>, caseSize: number) {
  const loose = a.looseBottles + b.looseBottles
  return { cases: a.cases + b.cases + Math.floor(loose / caseSize), looseBottles: loose % caseSize }
}

function addLine(state: PurchaseState): PurchaseState {
  const error = lineError(state)
  const cost = parseRupeesToPaise(state.cost)
  const count = entryCount(state)
  if (error !== null || !state.picked || cost === null || !count) return { ...state, flash: flash(state, 'error', error ?? 'Check the line') }
  const sku = state.picked
  const { caseSize } = sku

  const at = state.lines.findIndex((l) => l.sku.id === sku.id)
  if (at === -1) {
    const line: StagedLine = { sku, cases: count.cases, looseBottles: count.loose, caseSize, quantity: count.total, unitCostPaise: cost }
    const lines = [...state.lines, line]
    return { ...state, ...CLEAR_ENTRY, lines, selectedLine: lines.length - 1 }
  }
  const existing = state.lines[at]!
  if (existing.unitCostPaise !== cost) {
    const text = `${sku.displayName} is already on this invoice at ${formatPaise(existing.unitCostPaise)} — remove it first`
    return { ...state, flash: flash(state, 'error', text) }
  }
  if (existing.caseSize !== caseSize) {
    const text = `${sku.displayName}'s case size changed to ${caseSize} — remove the staged line and add it again`
    return { ...state, flash: flash(state, 'error', text) }
  }
  if (existing.quantity + count.total > MAX_LINE_QTY) {
    return { ...state, flash: flash(state, 'error', `${sku.displayName} would exceed 100,000 bottles on one line`) }
  }
  const merged = mergeCounts(existing, { cases: count.cases, looseBottles: count.loose }, caseSize)
  const lines = state.lines.map((l, i) => (i === at ? { ...l, ...merged, quantity: l.quantity + count.total } : l))
  return { ...state, ...CLEAR_ENTRY, lines, selectedLine: at }
}

/** Totals by line: `2 cs + 3` (or just `5` / `2 cs` when one part is zero). */
export function countLabel(line: Pick<StagedLine, 'cases' | 'looseBottles'>): string {
  if (line.cases === 0) return String(line.looseBottles)
  return line.looseBottles === 0 ? `${line.cases} cs` : `${line.cases} cs + ${line.looseBottles}`
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
      return {
        ...state,
        picked: action.sku,
        query: action.sku.displayName,
        results: [],
        highlighted: 0,
        // The catalog's default cost, still editable; with no default the operator must type one.
        cost: action.sku.purchasePricePaise === null ? '' : paiseToRupeeInput(action.sku.purchasePricePaise),
      }
    case 'cases':
      return { ...state, cases: action.text.replace(/\D/g, '').slice(0, 6) }
    case 'loose':
      return { ...state, loose: action.text.replace(/\D/g, '').slice(0, 6) }
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
