/**
 * Revenue centers on screen (Phase 22): the list is manager-defined, so names come from the server
 * and chip colours from a stable palette (Liquor amber and Kitchen emerald, as before).
 */
import type { Department, DepartmentCode } from '../api/types'

/** The seeded centers get distinct fixed colours; centers the manager adds are hashed into the palette. */
const FIXED_CHIP: Readonly<Record<string, string>> = {
  LIQUOR: 'border-amber-700 bg-amber-950 text-amber-200',
  KITCHEN: 'border-emerald-700 bg-emerald-950 text-emerald-200',
  CIGARETTES: 'border-rose-700 bg-rose-950 text-rose-200',
  COOL_DRINKS: 'border-cyan-700 bg-cyan-950 text-cyan-200',
  WATER: 'border-sky-700 bg-sky-950 text-sky-200',
  AC_CHARGES: 'border-violet-700 bg-violet-950 text-violet-200',
  ANCILLARY: 'border-zinc-500 bg-zinc-800 text-zinc-200',
}

const PALETTE = [
  'border-pink-700 bg-pink-950 text-pink-200',
  'border-lime-700 bg-lime-950 text-lime-200',
  'border-orange-700 bg-orange-950 text-orange-200',
  'border-teal-700 bg-teal-950 text-teal-200',
  'border-fuchsia-700 bg-fuchsia-950 text-fuchsia-200',
  'border-indigo-700 bg-indigo-950 text-indigo-200',
] as const

/** Chip classes for a center: fixed for Liquor / Kitchen, else picked from the palette by its code. */
export function departmentChip(code: DepartmentCode): string {
  const fixed = FIXED_CHIP[code]
  if (fixed) return fixed
  let hash = 0
  for (const ch of code) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]!
}

/** "COOL_DRINKS" → "Cool Drinks": a readable fallback when the list hasn't loaded. */
export function prettyCode(code: DepartmentCode): string {
  return code
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

export function departmentName(departments: readonly Department[], code: DepartmentCode): string {
  return departments.find((d) => d.code === code)?.name ?? prettyCode(code)
}
