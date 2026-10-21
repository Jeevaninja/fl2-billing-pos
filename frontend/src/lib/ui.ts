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

// ── Phase 25 primitives (plan D8): one button, card and badge vocabulary for every screen ──

export type ButtonVariant = 'primary' | 'secondary' | 'success' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl'

const BUTTON_BASE = `inline-flex shrink-0 select-none items-center whitespace-nowrap justify-center gap-2 rounded-lg font-bold tracking-tight disabled:opacity-40 ${FOCUS_RING}`

const BUTTON_VARIANT: Readonly<Record<ButtonVariant, string>> = {
  primary: 'bg-amber-400 text-zinc-950 shadow-[0_1px_0_0_rgb(255_255_255/0.35)_inset] hover:bg-amber-300 disabled:hover:bg-amber-400',
  secondary: 'border-2 border-zinc-600 bg-zinc-900 text-zinc-100 hover:border-zinc-400 hover:bg-zinc-800 disabled:hover:border-zinc-600 disabled:hover:bg-zinc-900',
  success: 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400 disabled:hover:bg-emerald-500',
  danger: 'bg-rose-500 text-zinc-950 hover:bg-rose-400 disabled:hover:bg-rose-500',
  ghost: 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50',
}

const BUTTON_SIZE: Readonly<Record<ButtonSize, string>> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-base',
  lg: 'h-14 px-5 text-lg',
  xl: 'h-16 px-6 text-xl',
}

/** Class list for a button (or a link styled as one). */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string {
  return `${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]}`
}

/** A raised panel on the page background. */
export const CARD = 'rounded-xl border border-zinc-800 bg-zinc-900 shadow-tile'

/** Small uppercase section label. */
export const EYEBROW = 'text-xs font-bold tracking-widest text-zinc-400 uppercase'

export type BadgeTone = 'neutral' | 'amber' | 'emerald' | 'rose' | 'sky' | 'violet'

const BADGE_TONE: Readonly<Record<BadgeTone, string>> = {
  neutral: 'border-zinc-600 bg-zinc-800 text-zinc-200',
  amber: 'border-amber-400/50 bg-amber-400/15 text-amber-200',
  emerald: 'border-emerald-400/50 bg-emerald-400/15 text-emerald-200',
  rose: 'border-rose-400/50 bg-rose-400/15 text-rose-200',
  sky: 'border-sky-400/50 bg-sky-400/15 text-sky-200',
  violet: 'border-violet-400/50 bg-violet-400/15 text-violet-200',
}

export function badgeClass(tone: BadgeTone = 'neutral'): string {
  return `inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wide uppercase ${BADGE_TONE[tone]}`
}

/** Phase 26 unit labels with a light plural for counts: "1 Case", "2 Packets", "3 Boxes". */
export function unitLabel(name: string, count: number): string {
  if (count === 1 || /s$/i.test(name)) return name
  return /(x|ch|sh)$/i.test(name) ? `${name}es` : `${name}s`
}
