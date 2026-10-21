/**
 * Revenue Centers — stock purchase (Phase 26): a stock-tracked center (Cigarettes, Cool Drinks…) buys
 * its items in purchase units and the shelf count rises in selling units: 2 Packets × 10 = 20 sticks.
 * Pure and unit-tested. Counts are whole numbers, costs whole paise per selling unit (D6), no floats.
 * The server posts it as a GRN tagged with the center and re-checks every rule.
 */
import type { CenterStockPurchasePayload, DepartmentCode, Paise, PurchasePaidFrom, SkuLookup } from '../api/types'
import { paiseToRupeeInput, parseRupeesToPaise } from '../lib/money'
import { unitLabel } from '../lib/ui'
import { MAX_LINE_QTY, mergeCounts } from '../purchase/purchaseReducer'

export const MAX_STOCK_LINES = 200
export const MAX_INVOICE_NO = 60
export const MAX_VENDOR = 100

export interface StockLine {
  sku: SkuLookup
  /** Whole purchase units (Cases, Packets). */
  cases: number
  /** Single units on top, fewer than one purchase unit. */
  looseUnits: number
  /** The item's units per purchase unit when counted (the server re-checks it). */
  caseSize: number
  /** Selling units: cases × caseSize + looseUnits. */
  quantity: number
  /** Cost of one selling unit. */
  unitCostPaise: Paise
}

export interface StockPurchaseForm {
  department: DepartmentCode
  vendor: string
  /** Blank: the server numbers it. */
  invoiceNo: string
  paidFrom: PurchasePaidFrom
  /** Item search text, or the picked item's name. */
  query: string
  results: SkuLookup[]
  highlighted: number
  picked: SkuLookup | null
  /** Digits only; empty counts as 0. */
  cases: string
  loose: string
  /** Rupees per selling unit; pre-filled from the catalog purchase price. */
  cost: string
  lines: StockLine[]
}

/** A fresh form: paid from the drawer, unless a peak is running (drawer purchases wait for it to end). */
export function newStockForm(peakRunning: boolean, department: DepartmentCode): StockPurchaseForm {
  return { department, vendor: '', invoiceNo: '', paidFrom: peakRunning ? 'OUTSIDE' : 'DRAWER', ...CLEAR_ENTRY, lines: [] }
}

const CLEAR_ENTRY = { query: '', results: [] as SkuLookup[], highlighted: 0, picked: null, cases: '', loose: '', cost: '' }

export function clearEntry(form: StockPurchaseForm): StockPurchaseForm {
  return { ...form, ...CLEAR_ENTRY }
}

export function setQuery(form: StockPurchaseForm, text: string): StockPurchaseForm {
  return { ...form, query: text, picked: null, highlighted: 0, ...(text.trim() === '' ? { results: [] } : {}) }
}

/** Search results for `query`; dropped when the field has moved on or an item is picked. */
export function setResults(form: StockPurchaseForm, query: string, results: readonly SkuLookup[]): StockPurchaseForm {
  if (query !== form.query.trim() || form.picked) return form
  return { ...form, results: results.filter((s) => s.isActive && s.department === form.department), highlighted: 0 }
}

export function moveHighlight(form: StockPurchaseForm, delta: number): StockPurchaseForm {
  if (form.results.length === 0) return form
  return { ...form, highlighted: Math.min(form.results.length - 1, Math.max(0, form.highlighted + delta)) }
}

/** Picks an item: its name fills the search and its catalog purchase price pre-fills the cost. */
export function pick(form: StockPurchaseForm, sku: SkuLookup): StockPurchaseForm {
  const cost = sku.purchasePricePaise === null ? '' : paiseToRupeeInput(sku.purchasePricePaise)
  return { ...form, picked: sku, query: sku.displayName, results: [], highlighted: 0, cases: '', loose: '', cost }
}

/** The item an Enter in the search means: an exact barcode or code (a scan), the only result, else the highlighted one. */
export function pickFromResults(form: StockPurchaseForm): SkuLookup | null {
  const text = form.query.trim().toUpperCase()
  const exact = form.results.find((s) => s.barcode?.toUpperCase() === text || s.skuCode.toUpperCase() === text)
  return exact ?? (form.results.length === 1 ? form.results[0]! : (form.results[form.highlighted] ?? null))
}

export function setCount(form: StockPurchaseForm, field: 'cases' | 'loose', text: string): StockPurchaseForm {
  return { ...form, [field]: text.replace(/\D/g, '').slice(0, 6) }
}

export function setCost(form: StockPurchaseForm, text: string): StockPurchaseForm {
  return { ...form, cost: text.replace(/[^\d.,]/g, '') }
}

/** The entry fields as whole numbers (empty = 0) and their selling-unit total, or null before a pick. */
export function entryCount(form: Pick<StockPurchaseForm, 'picked' | 'cases' | 'loose'>): { cases: number; loose: number; total: number } | null {
  if (!form.picked) return null
  const cases = form.cases === '' ? 0 : Number(form.cases)
  const loose = form.loose === '' ? 0 : Number(form.loose)
  return { cases, loose, total: cases * form.picked.caseSize + loose }
}

/** What stops the entry from becoming a line, in the item's own units, or null when it's ready. */
export function entryError(form: StockPurchaseForm): string | null {
  const count = entryCount(form)
  if (!form.picked || !count) return 'Pick an item'
  const { caseSize, purchaseUnitName, saleUnitName } = form.picked
  if (form.cases === '' && form.loose === '') return `Enter ${unitLabel(purchaseUnitName, 2).toLowerCase()} and / or loose ${unitLabel(saleUnitName, 2).toLowerCase()}`
  if (count.loose >= caseSize) return `${count.loose} loose is a full ${purchaseUnitName.toLowerCase()} of ${caseSize} — add it to ${unitLabel(purchaseUnitName, 2)}`
  if (count.total < 1) return `Enter at least one ${purchaseUnitName.toLowerCase()} or ${saleUnitName.toLowerCase()}`
  if (count.total > MAX_LINE_QTY) return `A line can have at most ${MAX_LINE_QTY.toLocaleString('en-IN')} ${unitLabel(saleUnitName, 2).toLowerCase()}`
  if (form.cost.trim() === '') return `Enter the cost per ${saleUnitName.toLowerCase()} (0 for free)`
  if (parseRupeesToPaise(form.cost) === null) return 'Enter rupees, e.g. 15 or 15.50'
  return null
}

/** Stages the entry as a line (merging the same item at the same cost), or returns why it can't. */
export function stageLine(form: StockPurchaseForm): StockPurchaseForm | string {
  const error = entryError(form)
  const count = entryCount(form)
  const cost = parseRupeesToPaise(form.cost)
  if (error !== null || !form.picked || !count || cost === null) return error ?? 'Check the line'
  const sku = form.picked
  const at = form.lines.findIndex((l) => l.sku.id === sku.id)
  if (at === -1) {
    if (form.lines.length >= MAX_STOCK_LINES) return `A purchase can have at most ${MAX_STOCK_LINES} items`
    const line: StockLine = { sku, cases: count.cases, looseUnits: count.loose, caseSize: sku.caseSize, quantity: count.total, unitCostPaise: cost }
    return { ...form, ...CLEAR_ENTRY, lines: [...form.lines, line] }
  }
  const existing = form.lines[at]!
  if (existing.unitCostPaise !== cost) return `${sku.displayName} is already on this purchase at a different cost — remove it first`
  if (existing.caseSize !== sku.caseSize) return `${sku.displayName}'s units per ${sku.purchaseUnitName.toLowerCase()} changed — remove the line and add it again`
  if (existing.quantity + count.total > MAX_LINE_QTY) return `${sku.displayName} would exceed ${MAX_LINE_QTY.toLocaleString('en-IN')} on one line`
  const merged = mergeCounts({ cases: existing.cases, looseBottles: existing.looseUnits }, { cases: count.cases, looseBottles: count.loose }, existing.caseSize)
  const line: StockLine = { ...existing, cases: merged.cases, looseUnits: merged.looseBottles, quantity: existing.quantity + count.total }
  return { ...form, ...CLEAR_ENTRY, lines: form.lines.map((l, i) => (i === at ? line : l)) }
}

export function removeStockLine(form: StockPurchaseForm, skuId: string): StockPurchaseForm {
  return { ...form, lines: form.lines.filter((l) => l.sku.id !== skuId) }
}

export function lineCost(line: Pick<StockLine, 'quantity' | 'unitCostPaise'>): Paise {
  return BigInt(line.quantity) * line.unitCostPaise
}

/** One purchase unit's cost at a per-unit cost (₹15 × 24 = ₹360 per Case). */
export function perPackPaise(caseSize: number, unitCostPaise: Paise): Paise {
  return BigInt(caseSize) * unitCostPaise
}

export function stockTotals(lines: readonly StockLine[]): { lineCount: number; units: number; totalPaise: Paise } {
  return {
    lineCount: lines.length,
    units: lines.reduce((sum, l) => sum + l.quantity, 0),
    totalPaise: lines.reduce((sum, l) => sum + lineCost(l), 0n),
  }
}

/** "2 Packets × 10 = 20 Sticks", "1 Case × 24 + 6 = 30 Bottles", "5 Sticks". */
export function countText(count: { cases: number; looseUnits: number; caseSize: number }, units: { purchaseUnitName: string; saleUnitName: string }): string {
  const total = count.cases * count.caseSize + count.looseUnits
  const sold = `${total} ${unitLabel(units.saleUnitName, total)}`
  if (count.cases === 0) return sold
  const packs = `${count.cases} ${unitLabel(units.purchaseUnitName, count.cases)} × ${count.caseSize}`
  return count.looseUnits === 0 ? `${packs} = ${sold}` : `${packs} + ${count.looseUnits} = ${sold}`
}

/** What stops the purchase from being saved, or null when it's ready. */
export function stockFormError(form: StockPurchaseForm, peakRunning: boolean): string | null {
  if (form.picked) return 'Add the entered item (Enter) or clear it first'
  if (form.lines.length === 0) return 'Add at least one item'
  if (form.invoiceNo.trim().length > MAX_INVOICE_NO) return `Bill no. must be at most ${MAX_INVOICE_NO} characters`
  if (form.vendor.trim().length > MAX_VENDOR) return `Vendor must be at most ${MAX_VENDOR} characters`
  if (form.paidFrom === 'DRAWER' && peakRunning) return 'A peak is running: pay from outside, or wait for it to end'
  return null
}

export function stockPayload(form: StockPurchaseForm): CenterStockPurchasePayload {
  return {
    department: form.department,
    invoiceNo: form.invoiceNo.trim() || null,
    vendorName: form.vendor.trim().replace(/\s+/g, ' ') || null,
    paidFrom: form.paidFrom,
    lines: form.lines.map((l) => ({ skuId: l.sku.id, cases: l.cases, looseUnits: l.looseUnits, caseSize: l.caseSize, unitCost: l.unitCostPaise })),
  }
}
