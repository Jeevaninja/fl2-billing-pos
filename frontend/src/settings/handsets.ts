/**
 * Settings → Staff & PINs → Captain handsets. Pure form rules; the server re-checks every one of them.
 */
import type { Handset } from '../api/types'

export const MAX_HANDSET_LABEL = 40
/** Same format the server's devices file and bills.captain_device_id accept. */
const HANDSET_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/
const NUMBERED = /^handset-(\d+)$/

/** The next free `handset-NN` id (revoked ids stay taken). */
export function nextHandsetId(handsets: readonly Handset[]): string {
  const highest = handsets.reduce((max, h) => Math.max(max, Number(NUMBERED.exec(h.id)?.[1] ?? 0)), 0)
  return `handset-${String(highest + 1).padStart(2, '0')}`
}

/** Why a new handset can't be paired, or null. */
export function handsetFormError(id: string, label: string, handsets: readonly Handset[]): string | null {
  if (!HANDSET_ID.test(id)) return 'The ID uses lowercase letters, digits, - and _ (e.g. handset-03)'
  if (handsets.some((h) => h.id === id)) return `${id} is already used${handsets.find((h) => h.id === id)?.active ? '' : ' by a revoked handset'}; pick another ID`
  const name = label.trim()
  if (name === '') return 'Enter a name, e.g. Captain 3'
  if (name.length > MAX_HANDSET_LABEL) return `Keep the name under ${MAX_HANDSET_LABEL} characters`
  return null
}

/** Active handsets first, then by id. */
export function sortHandsets(handsets: readonly Handset[]): Handset[] {
  return [...handsets].sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id))
}

/** "22 Oct 2026" in the till's locale. */
export function pairedOn(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The IP the app's "POS IP address" field takes (the app fixes the port), from a server URL. */
export function phoneAddress(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
