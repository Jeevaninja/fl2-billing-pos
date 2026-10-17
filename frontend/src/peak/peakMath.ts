/** Pure helpers behind the peak start / end dialogs. Readings are whole paise; no floats. */
import type { Paise, PeakStartBaseline } from '../api/types'
import { formatPaise, parseRupeesToPaise } from '../lib/money'

export type ReadingsResult = { ok: true; cash: Paise; upi: Paise } | { ok: false; error: string }

const RUPEES_HINT = 'Enter rupees, e.g. 1500 or 1,500.50'

/** Validates the drawer cash and UPI readings typed at a peak start or end (both required, ₹0 allowed). */
export function parseReadings(cashText: string, upiText: string): ReadingsResult {
  if (cashText.trim() === '') return { ok: false, error: 'Enter the cash in the drawer' }
  if (upiText.trim() === '') return { ok: false, error: 'Enter the UPI reading (0 if none)' }
  const cash = parseRupeesToPaise(cashText)
  const upi = parseRupeesToPaise(upiText)
  if (cash === null || upi === null) return { ok: false, error: RUPEES_HINT }
  return { ok: true, cash, upi }
}

export interface VarianceWording {
  kind: 'short' | 'over' | 'exact'
  label: string
}

/** Variance = actual − expected: negative means the drawer is short. */
export function describeVariance(variance: Paise): VarianceWording {
  if (variance < 0n) return { kind: 'short', label: `${formatPaise(-variance)} short` }
  if (variance > 0n) return { kind: 'over', label: `${formatPaise(variance)} over` }
  return { kind: 'exact', label: 'Exact — no variance' }
}

export type ReadingComparison = { kind: 'none' } | { kind: 'match'; label: string } | { kind: 'short' | 'over'; label: string }

/**
 * A typed reading against the expected figure, as the cashier types at peak start. Display only:
 * nothing is blocked. 'none' while the field is empty, unparsable, or the expected figure is unknown.
 */
export function compareReading(text: string, expected: Paise | null): ReadingComparison {
  if (expected === null || text.trim() === '') return { kind: 'none' }
  const typed = parseRupeesToPaise(text)
  if (typed === null) return { kind: 'none' }
  if (typed === expected) return { kind: 'match', label: 'matches expected' }
  return typed < expected
    ? { kind: 'short', label: `${formatPaise(expected - typed)} short of expected` }
    : { kind: 'over', label: `${formatPaise(typed - expected)} over expected` }
}

/** One-line "where this figure comes from" under each expected figure; ₹0 terms are left out. */
export function describeBaseline(b: PeakStartBaseline): { cash: string; upi: string } {
  const join = (terms: [string, Paise][]) =>
    terms
      .filter(([, v], i) => i === 0 || v !== 0n)
      .map(([label, v], i) => {
        const amount = formatPaise(v < 0n ? -v : v)
        return i === 0 ? `${label} ${v < 0n ? '−' : ''}${amount}` : `${v < 0n ? '−' : '+'} ${label} ${amount}`
      })
      .join(' ')
  const cash = join([
    ['float', b.openingFloatPaise],
    ['cash sales', b.normalCashPaise],
    ['waiter cash', b.waiterCashPaise],
    ['earlier peaks', b.peakCashPaise],
    ['expenses', -b.cashExpensesPaise],
  ])
  const upiTerms: [string, Paise][] = [
    ['bills', b.billUpiPaise],
    ['waiter', b.waiterUpiPaise],
    ['earlier peaks', b.peakUpiPaise],
  ]
  const upi = upiTerms.every(([, v]) => v === 0n) ? 'no UPI recorded today yet' : join(upiTerms.filter(([, v]) => v !== 0n))
  return { cash, upi }
}
