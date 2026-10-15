/** Pure helpers behind the peak start / end dialogs. Readings are whole paise; no floats. */
import type { Paise } from '../api/types'
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
