/**
 * Kitchen Kiosk (Phase 21): pure helpers behind the New Purchase modal and the P&L cards. Rupees are
 * parsed to whole paise; quantities are free-text labels ("5 kg"), never numbers.
 */
import type { KitchenPaidFrom, KitchenPurchasePayload, KitchenSummary, Paise } from '../api/types'
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
  vendor: string
  paidFrom: KitchenPaidFrom
  note: string
  lines: PurchaseLineDraft[]
  nextKey: number
}

const blankLine = (key: number): PurchaseLineDraft => ({ key, description: '', quantity: '', amount: '' })

/** A fresh form: paid from the drawer, unless a peak is running (drawer purchases wait for it to end). */
export function newPurchaseForm(peakRunning: boolean): PurchaseForm {
  return { vendor: '', paidFrom: peakRunning ? 'OUTSIDE' : 'DRAWER', note: '', lines: [blankLine(1)], nextKey: 2 }
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

export function purchasePayload(form: PurchaseForm): KitchenPurchasePayload {
  const tidy = (text: string) => text.trim().replace(/\s+/g, ' ')
  return {
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
  label: string
  /** Signed as it adds to the gross. */
  value: Paise
  hint: string
}

/** The four P&L cards: sales, minus expenses, minus purchases, = gross. */
export function pnlCards(s: KitchenSummary, formatRupees: (paise: Paise) => string): PnlCard[] {
  return [
    { key: 'sales', label: 'Kitchen sales', value: s.salesPaise, hint: s.openTabsPaise !== 0n ? `+${formatRupees(s.openTabsPaise)} on open bills` : 'settled bills and ended peaks' },
    { key: 'expenses', label: 'Kitchen expenses', value: -s.expensesPaise, hint: 'petty cash in Kitchen categories' },
    {
      key: 'purchases',
      label: 'Kitchen purchases',
      value: -s.purchasesPaise,
      hint: s.purchasesDrawerPaise !== 0n ? `${formatRupees(s.purchasesDrawerPaise)} from the drawer` : 'none from the drawer',
    },
    { key: 'gross', label: 'Kitchen gross', value: s.grossPaise, hint: 'sales − expenses − purchases' },
  ]
}
