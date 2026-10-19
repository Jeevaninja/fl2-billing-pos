import type { DepartmentCode, SizeCode } from '../api/types'

export const FOCUS_RING =
  'outline-none focus-visible:ring-4 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950'

/** Size names with their bottle volume, for the catalog and GRN. A label only: no ml is tracked. */
export const SIZE_NAME: Readonly<Record<SizeCode, string>> = {
  FULL: 'Full 750ml',
  HALF: 'Half 375ml',
  QUARTER: 'Quarter 180ml',
  BEER_650: 'Beer 650ml',
  BEER_330: 'Beer 330ml',
  UNIT: 'Unit (single size)',
}

/** Kitchen items are plates, not bottles: Full / Half plate, or a single size. */
const KITCHEN_SIZE_NAME: Partial<Record<SizeCode, string>> = { FULL: 'Full plate', HALF: 'Half plate', UNIT: 'Single size' }

/** The size name as the department reads it. */
export function sizeNameFor(size: SizeCode, department: DepartmentCode): string {
  return (department === 'KITCHEN' ? KITCHEN_SIZE_NAME[size] : undefined) ?? SIZE_NAME[size]
}

/** Catalog display order. */
export const SIZE_ORDER: readonly SizeCode[] = ['FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330', 'UNIT']

export function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/** Keeps keyboard focus where it is when a button is clicked, so scans keep flowing to the page. */
export const keepFocus = { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() }
