/**
 * Reports date range (Phase 23, D1): presets count from the current *business* date — the open day,
 * else the latest closed one — so "Today" at 1 am still means tonight's trading day. Dates are
 * YYYY-MM-DD strings, shifted in UTC so no time zone or DST can move them. Pure and unit-tested.
 */
import type { ReportRange } from '../api/types'

export type PresetId = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'lastMonth' | 'custom'

export const PRESETS: ReadonlyArray<{ id: PresetId; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'custom', label: 'Custom' },
]

/** The server's limit: a year, inclusive. */
export const MAX_RANGE_DAYS = 366

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** UTC midnight of a real YYYY-MM-DD date, else null. */
function toMs(iso: string): number | null {
  const m = ISO_DATE.exec(iso)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : null
}

const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export function addDays(iso: string, days: number): string {
  const ms = toMs(iso)
  if (ms === null) throw new RangeError(`not a date: ${iso}`)
  return fromMs(ms + days * DAY_MS)
}

export function presetRange(id: Exclude<PresetId, 'custom'>, anchor: string): ReportRange {
  const [y, m] = anchor.split('-').map(Number) as [number, number]
  switch (id) {
    case 'today':
      return { startDate: anchor, endDate: anchor }
    case 'yesterday': {
      const day = addDays(anchor, -1)
      return { startDate: day, endDate: day }
    }
    case 'last7':
      return { startDate: addDays(anchor, -6), endDate: anchor }
    case 'thisMonth':
      return { startDate: fromMs(Date.UTC(y, m - 1, 1)), endDate: anchor }
    case 'lastMonth':
      return { startDate: fromMs(Date.UTC(y, m - 2, 1)), endDate: fromMs(Date.UTC(y, m - 1, 0)) }
  }
}

/** Inclusive day count; 0 for an invalid range. */
export function rangeDays(range: ReportRange): number {
  const start = toMs(range.startDate)
  const end = toMs(range.endDate)
  return start === null || end === null || start > end ? 0 : (end - start) / DAY_MS + 1
}

/** Why the range can't be sent (the server's own rules), or null. */
export function rangeError(range: ReportRange): string | null {
  if (toMs(range.startDate) === null) return 'Pick a start date'
  if (toMs(range.endDate) === null) return 'Pick an end date'
  if (range.startDate > range.endDate) return 'The start date is after the end date'
  if (rangeDays(range) > MAX_RANGE_DAYS) return `A report covers at most ${MAX_RANGE_DAYS} days`
  return null
}

/** 2026-10-14 → "14 Oct 2026". */
export function formatBusinessDate(iso: string): string {
  const m = ISO_DATE.exec(iso)
  if (!m) return iso
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`
}

/** "14 Oct 2026" or "1 Oct 2026 – 19 Oct 2026". */
export function rangeLabel(range: ReportRange): string {
  return range.startDate === range.endDate ? formatBusinessDate(range.startDate) : `${formatBusinessDate(range.startDate)} – ${formatBusinessDate(range.endDate)}`
}
