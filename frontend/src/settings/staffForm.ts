/**
 * Phase 25 (D6): Settings → Staff & PINs. Pure form rules; the server re-checks every one of them.
 */
import type { CounterRole, StaffMember, StaffPatch } from '../api/types'
import type { BadgeTone } from '../lib/ui'
import { formatCountdown } from '../auth/pinPad'

export const MAX_STAFF_NAME = 40
const PIN = /^\d{4,6}$/

export interface StaffForm {
  /** null = a new cashier / manager. */
  id: string | null
  displayName: string
  role: CounterRole
  isActive: boolean
  /** New staff only: an optional first PIN. */
  pin: string
  pinConfirm: string
}

export const NEW_STAFF: StaffForm = { id: null, displayName: '', role: 'CASHIER', isActive: true, pin: '', pinConfirm: '' }

export function formFor(member: StaffMember): StaffForm {
  return { id: member.id, displayName: member.displayName, role: member.role === 'MANAGER' ? 'MANAGER' : 'CASHIER', isActive: member.isActive, pin: '', pinConfirm: '' }
}

const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ')

/** Why a PIN pair can't be saved, or null. */
export function pinError(pin: string, confirm: string): string | null {
  if (!PIN.test(pin)) return 'A PIN is 4 to 6 digits'
  if (pin !== confirm) return 'The two PINs don’t match'
  return null
}

/** Why the form can't be saved, or null. Names are unique ignoring case and spacing. */
export function staffFormError(form: StaffForm, staff: readonly StaffMember[]): string | null {
  const name = cleanName(form.displayName)
  if (name === '') return 'Enter a name'
  if (name.length > MAX_STAFF_NAME) return `A name is at most ${MAX_STAFF_NAME} characters`
  if (staff.some((s) => s.id !== form.id && s.displayName.toLowerCase() === name.toLowerCase())) return `${name} is already on the staff list`
  if (form.id === null && (form.pin !== '' || form.pinConfirm !== '')) return pinError(form.pin, form.pinConfirm)
  return null
}

/** Only what changed. Admin rows never send a role (admins are managed on the till's CLI). */
export function staffPatch(original: StaffMember, form: StaffForm): StaffPatch {
  const patch: StaffPatch = {}
  const name = cleanName(form.displayName)
  if (name !== original.displayName) patch.displayName = name
  if (original.role !== 'ADMIN' && form.role !== original.role) patch.role = form.role
  if (form.isActive !== original.isActive) patch.isActive = form.isActive
  return patch
}

export interface StatusChip {
  label: string
  tone: BadgeTone
}

/** The chips on a staff row, most important first. */
export function staffChips(member: StaffMember, nowMs: number, loadedAtMs: number): StatusChip[] {
  const chips: StatusChip[] = []
  if (!member.isActive) chips.push({ label: 'Inactive', tone: 'neutral' })
  if (member.pinLockedForSeconds !== null) {
    const left = member.pinLockedForSeconds * 1000 - (nowMs - loadedAtMs)
    if (left > 0) chips.push({ label: `PIN locked ${formatCountdown(left)}`, tone: 'rose' })
  }
  chips.push(member.hasPin ? { label: 'PIN set', tone: 'emerald' } : { label: 'No PIN', tone: 'amber' })
  if (member.hasPassword && member.username) chips.push({ label: `Signs in as ${member.username}`, tone: 'violet' })
  return chips
}

/** Active first, then cashiers, managers, admins, then by name. */
export function sortStaff(staff: readonly StaffMember[]): StaffMember[] {
  const rank = { CASHIER: 0, MANAGER: 1, ADMIN: 2 } as const
  return [...staff].sort((a, b) => Number(b.isActive) - Number(a.isActive) || rank[a.role] - rank[b.role] || a.displayName.localeCompare(b.displayName))
}
