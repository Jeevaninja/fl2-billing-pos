/**
 * Settings → Revenue Centers (Phase 22): pure helpers behind the center modal (also opened from the
 * Revenue Centers screen's "+ Center"). The server is the judge; these catch the obvious early.
 */
import type { Department, DepartmentPatch, DepartmentStation } from '../api/types'

export const MAX_CENTER_NAME = 30

export interface CenterForm {
  /** null for a new center. */
  code: string | null
  name: string
  kotStation: DepartmentStation
  tracksStock: boolean
  isActive: boolean
}

export const NEW_CENTER: CenterForm = { code: null, name: '', kotStation: 'BAR', tracksStock: true, isActive: true }

export function centerFormFor(d: Department): CenterForm {
  return { code: d.code, name: d.name, kotStation: d.kotStation, tracksStock: d.tracksStock, isActive: d.isActive }
}

const tidy = (name: string) => name.trim().replace(/\s+/g, ' ')

/** The first problem with the form, or null when it can be saved. */
export function centerFormError(form: CenterForm, departments: readonly Department[]): string | null {
  const name = tidy(form.name)
  if (name === '') return 'Enter a name'
  if (name.length > MAX_CENTER_NAME) return `At most ${MAX_CENTER_NAME} characters`
  const clash = departments.find((d) => d.code !== form.code && d.name.toLowerCase() === name.toLowerCase())
  if (clash) return `“${clash.name}” already exists${clash.isActive ? '' : ' (disabled — enable it instead)'}`
  const original = departments.find((d) => d.code === form.code)
  if (original?.code === 'LIQUOR' && (!form.isActive || form.kotStation !== original.kotStation || form.tracksStock !== original.tracksStock)) {
    return 'Liquor stays active, stock-tracked and printed at the bar — only its name can change'
  }
  if (original?.isActive && !form.isActive && original.itemCount > 0) {
    return `${original.name} still has ${original.itemCount} active item${original.itemCount === 1 ? '' : 's'} — move or deactivate them first`
  }
  if (original?.tracksStock && !form.tracksStock && original.onHandQty !== 0) {
    return `${original.name} still has ${original.onHandQty} on hand — it can't stop tracking stock`
  }
  return null
}

/** Only what changed on an existing center; {} when nothing did. */
export function centerPatch(original: Department, form: CenterForm): DepartmentPatch {
  const patch: DepartmentPatch = {}
  const name = tidy(form.name)
  if (name !== original.name) patch.name = name
  if (form.kotStation !== original.kotStation) patch.kotStation = form.kotStation
  if (form.tracksStock !== original.tracksStock) patch.tracksStock = form.tracksStock
  if (form.isActive !== original.isActive) patch.isActive = form.isActive
  return patch
}

export const STATION_LABEL: Readonly<Record<DepartmentStation, string>> = { BAR: 'Bar', KITCHEN: 'Kitchen', NONE: 'No ticket' }

/** Active centers in display order, then disabled ones when shown. */
export function visibleCenters(departments: readonly Department[], showDisabled: boolean): Department[] {
  const byOrder = [...departments].sort((a, b) => a.sortOrder - b.sortOrder)
  const active = byOrder.filter((d) => d.isActive)
  return showDisabled ? [...active, ...byOrder.filter((d) => !d.isActive)] : active
}
