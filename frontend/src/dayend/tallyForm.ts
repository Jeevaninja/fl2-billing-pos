/**
 * The Day End "Adjust Cash ⇄ UPI" form. Pure and unit-tested. Revenue only moves between the two
 * tenders: the request carries one signed cash delta and the UPI side is always its negative, so
 * the total can't change. The database re-checks every rule.
 */
import type { Paise, SalesBreakdown } from '../api/types'
import { formatPaise, parseRupeesToPaise } from '../lib/money'

export type TallyDirection = 'UPI_TO_CASH' | 'CASH_TO_UPI'

export interface TallyForm {
  direction: TallyDirection
  amount: string
  reason: string
}

export const EMPTY_TALLY: TallyForm = { direction: 'UPI_TO_CASH', amount: '', reason: '' }
export const MAX_REASON = 200

export type TallyResult =
  | { ok: true; cashDeltaPaise: Paise; reason: string; after: { cashPaise: Paise; upiPaise: Paise; totalPaise: Paise } }
  | { ok: false; error: string }

/** Validates the form against the day's (already adjusted) normal tenders and previews the result. */
export function tallyResult(normal: SalesBreakdown['normal'], form: TallyForm): TallyResult {
  if (form.amount.trim() === '') return { ok: false, error: 'Enter the amount to move' }
  const amount = parseRupeesToPaise(form.amount)
  if (amount === null) return { ok: false, error: 'Enter rupees, e.g. 500 or 1,500.50' }
  if (amount <= 0n) return { ok: false, error: 'The amount must be more than ₹0' }
  const fromCash = form.direction === 'CASH_TO_UPI'
  const available = fromCash ? normal.cashPaise : normal.upiPaise
  if (amount > available) return { ok: false, error: `Only ${formatPaise(available)} of normal ${fromCash ? 'cash' : 'UPI'} to move` }
  const reason = form.reason.trim()
  if (reason === '') return { ok: false, error: 'Give a reason (it is kept in the audit log)' }
  if (reason.length > MAX_REASON) return { ok: false, error: `Keep the reason under ${MAX_REASON} characters` }
  const cashDeltaPaise = fromCash ? -amount : amount
  return {
    ok: true,
    cashDeltaPaise,
    reason,
    after: { cashPaise: normal.cashPaise + cashDeltaPaise, upiPaise: normal.upiPaise - cashDeltaPaise, totalPaise: normal.totalPaise },
  }
}

/** "UPI → Cash ₹500.00" for an adjustment row. */
export function describeShift(cashDeltaPaise: Paise): string {
  return cashDeltaPaise > 0n ? `UPI → Cash ${formatPaise(cashDeltaPaise)}` : `Cash → UPI ${formatPaise(-cashDeltaPaise)}`
}
