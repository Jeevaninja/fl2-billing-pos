/**
 * Revenue Centers (Phase 22; Kitchen Kiosk in Phase 21): pure helpers behind the New Purchase modal,
 * the P&L cards and the center tabs. Rupees are parsed to whole paise; quantities are free-text labels
 * ("5 kg"), never numbers.
 */
import type { CenterPurchasePayload, DepartmentCode, Paise, PurchasePaidFrom, RevenueCenterOverview, RevenueCenterSummary } from '../api/types'
import { parseRupeesToPaise } from '../lib/money'

export const MAX_LINES = 30
export const MAX_DESCRIPTION = 60
export const MAX_QUANTITY_TEXT = 20

export interface PurchaseLineDraft {
  key: number
  description: string
  quantity: string
  amount: string
}

export interface PurchaseForm {
  /** The center the purchase belongs to. */
  department: DepartmentCode
  vendor: string
  paidFrom: PurchasePaidFrom
  note: string
  lines: PurchaseLineDraft[]
  nextKey: number
}

const blankLine = (key: number): PurchaseLineDraft => ({ key, description: '', quantity: '', amount: '' })

/** A fresh form for a center: paid from the drawer, unless a peak is running (drawer purchases wait for it to end). */
export function newPurchaseForm(peakRunning: boolean, department: DepartmentCode): PurchaseForm {
  return { department, vendor: '', paidFrom: peakRunning ? 'OUTSIDE' : 'DRAWER', note: '', lines: [blankLine(1)], nextKey: 2 }
}

export function setLine(form: PurchaseForm, key: number, patch: Partial<Omit<PurchaseLineDraft, 'key'>>): PurchaseForm {
  const clean: Partial<PurchaseLineDraft> = { ...patch }
  if (clean.amount !== undefined) clean.amount = clean.amount.replace(/[^\d.,]/g, '')
  if (clean.quantity !== undefined) clean.quantity = clean.quantity.slice(0, MAX_QUANTITY_TEXT)
  if (clean.description !== undefined) clean.description = clean.description.slice(0, MAX_DESCRIPTION)
  return { ...form, lines: form.lines.map((l) => (l.key === key ? { ...l, ...clean } : l)) }
}

export function addLine(form: PurchaseForm): PurchaseForm {
  if (form.lines.length >= MAX_LINES) return form
  return { ...form, lines: [...form.lines, blankLine(form.nextKey)], nextKey: form.nextKey + 1 }
}

export function removeLine(form: PurchaseForm, key: number): PurchaseForm {
  const lines = form.lines.filter((l) => l.key !== key)
  return { ...form, lines: lines.length > 0 ? lines : [blankLine(form.nextKey)], nextKey: lines.length > 0 ? form.nextKey : form.nextKey + 1 }
}

const isBlank = (l: PurchaseLineDraft) => l.description.trim() === '' && l.quantity.trim() === '' && l.amount.trim() === ''

/** Σ the filled lines in paise; null while any filled line has no valid amount. */
export function purchaseTotal(form: PurchaseForm): Paise | null {
  let total = 0n
  for (const line of form.lines) {
    if (isBlank(line)) continue
    const amount = parseRupeesToPaise(line.amount)
    if (amount === null || amount <= 0n) return null
    total += amount
  }
  return total
}

/** The first problem with the form, or null when it can be saved. Blank lines are ignored. */
export function purchaseFormError(form: PurchaseForm, peakRunning: boolean): string | null {
  if (form.department === '') return 'Choose the revenue center this purchase belongs to'
  const filled = form.lines.filter((l) => !isBlank(l))
  if (filled.length === 0) return 'Add at least one line: what was bought and its amount'
  for (const [i, line] of filled.entries()) {
    const n = i + 1
    if (line.description.trim() === '') return `Line ${n}: what was bought?`
    const amount = parseRupeesToPaise(line.amount)
    if (line.amount.trim() === '' || amount === null) return `Line ${n}: enter the amount in rupees`
    if (amount <= 0n) return `Line ${n}: the amount must be more than ₹0`
  }
  if (form.vendor.trim().length > 80) return 'Vendor must be at most 80 characters'
  if (form.note.trim().length > 200) return 'Note must be at most 200 characters'
  if (form.paidFrom === 'DRAWER' && peakRunning) return 'A peak is running — pay from Outside, or end the peak first'
  return null
}

export function purchasePayload(form: PurchaseForm): CenterPurchasePayload {
  const tidy = (text: string) => text.trim().replace(/\s+/g, ' ')
  return {
    department: form.department,
    vendorName: tidy(form.vendor) || null,
    paidFrom: form.paidFrom,
    note: tidy(form.note) || null,
    lines: form.lines
      .filter((l) => !isBlank(l))
      .map((l) => ({ description: tidy(l.description), quantity: tidy(l.quantity) || null, amount: parseRupeesToPaise(l.amount) ?? 0n })),
  }
}

export interface PnlCard {
  key: 'sales' | 'expenses' | 'purchases' | 'gross'
  /** "CIGARETTES SALES": the center's name in capitals. */
  label: string
  /** Signed as it adds to the gross. */
  value: Paise
  hint: string
}

/** The four P&L cards for one center: sales, minus expenses, minus purchases (GRN stock + own supplies), = gross. */
export function pnlCards(s: RevenueCenterSummary, formatRupees: (paise: Paise) => string): PnlCard[] {
  const name = s.center.name.toUpperCase()
  const split = [
    s.stockPurchasesPaise !== 0n ? `${formatRupees(s.stockPurchasesPaise)} stock (GRN)` : null,
    s.supplyPurchasesPaise !== 0n ? `${formatRupees(s.supplyPurchasesPaise)} supplies` : null,
    s.supplyDrawerPaise !== 0n ? `${formatRupees(s.supplyDrawerPaise)} from the drawer` : null,
  ].filter(Boolean)
  return [
    { key: 'sales', label: `${name} SALES`, value: s.salesPaise, hint: s.openTabsPaise !== 0n ? `+${formatRupees(s.openTabsPaise)} on open bills` : 'settled bills and ended peaks' },
    { key: 'expenses', label: `${name} EXPENSES`, value: -s.expensesPaise, hint: `petty cash in ${s.center.name} categories` },
    { key: 'purchases', label: `${name} PURCHASES`, value: -s.purchasesPaise, hint: split.length > 0 ? split.join(' · ') : 'none today' },
    { key: 'gross', label: `${name} GROSS`, value: s.grossPaise, hint: 'sales − expenses − purchases' },
  ]
}

export const ALL_CENTERS = 'ALL'

export interface CenterTab {
  code: DepartmentCode | typeof ALL_CENTERS
  label: string
}

/** "All centers" first, then every active non-liquor center in display order. */
export function centerTabs(overview: RevenueCenterOverview | null): CenterTab[] {
  return [{ code: ALL_CENTERS, label: 'All centers' }, ...(overview?.centers ?? []).map((c) => ({ code: c.code, label: c.name }))]
}

/** The tab `delta` steps from `current` (wrapping); an unknown current starts from "All centers". */
export function stepTab(tabs: readonly CenterTab[], current: string, delta: number): string {
  if (tabs.length === 0) return ALL_CENTERS
  const at = Math.max(0, tabs.findIndex((t) => t.code === current))
  return tabs[(at + delta + tabs.length) % tabs.length]!.code
}
