import type { Paise } from '../api/types'

const RUPEES = new Intl.NumberFormat('en-IN')

/** ₹1,02,050.00 style (Indian digit grouping), computed in bigint — no float ever touches the amount. */
export function formatPaise(paise: Paise): string {
  const negative = paise < 0n
  const abs = negative ? -paise : paise
  const rupees = RUPEES.format(abs / 100n)
  const fraction = (abs % 100n).toString().padStart(2, '0')
  return `${negative ? '−' : ''}₹${rupees}.${fraction}`
}

const RUPEE_INPUT = /^(\d{1,13})(?:\.(\d{1,2}))?$/

/**
 * Parses cashier-typed rupees ("1,020.5", "₹ 600") into whole paise by string splitting.
 * Returns null for anything that is not a non-negative amount with at most two decimals.
 */
export function parseRupeesToPaise(text: string): Paise | null {
  const cleaned = text.replace(/[₹,\s]/g, '')
  const match = RUPEE_INPUT.exec(cleaned)
  if (!match) return null
  const [, whole = '0', fraction = ''] = match
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
}
