/** Pure rows behind the Day End "Sales breakdown" card. Whole paise; no floats. */
import type { Paise, SalesBreakdown } from '../api/types'

export interface SalesRow {
  key: 'normal' | 'peak' | 'total'
  label: string
  cash: Paise
  upi: Paise
  /** null renders as "—" (peak bills are never on credit). */
  credit: Paise | null
  total: Paise
}

export interface SalesCard {
  rows: SalesRow[]
  repayments: { cash: Paise; upi: Paise }
  /** Amber hints shown under the table. */
  warnings: string[]
}

function sessionsLabel(count: number): string {
  if (count === 0) return 'Peak sales'
  return `Peak sales (${count} session${count === 1 ? '' : 's'})`
}

export function salesCard(sales: SalesBreakdown): SalesCard {
  const { normal, peak, total, waiterRepayments } = sales
  const warnings: string[] = []
  if (peak.runningSessionNo !== null) warnings.push(`Peak #${peak.runningSessionNo} is still running — its sales appear once it ends.`)
  if (peak.cashPaise < 0n) warnings.push('Peak UPI readings exceed peak sales — check the UPI readings.')
  return {
    rows: [
      { key: 'normal', label: 'Normal bills', cash: normal.cashPaise, upi: normal.upiPaise, credit: normal.creditPaise, total: normal.totalPaise },
      { key: 'peak', label: sessionsLabel(peak.sessionCount), cash: peak.cashPaise, upi: peak.upiPaise, credit: null, total: peak.salesPaise },
      { key: 'total', label: 'Total sales', cash: total.cashPaise, upi: total.upiPaise, credit: total.creditPaise, total: total.salesPaise },
    ],
    repayments: { cash: waiterRepayments.cashPaise, upi: waiterRepayments.upiPaise },
    warnings,
  }
}
