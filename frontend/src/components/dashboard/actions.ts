import {
  Boxes,
  CalendarCheck,
  ChartColumn,
  CreditCard,
  Landmark,
  PackagePlus,
  ReceiptText,
  Smartphone,
  UserSearch,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import type { ShortcutKey } from '../../hooks/useGlobalShortcuts'

export type PosActionId =
  | 'new-bill'
  | 'member'
  | 'pay'
  | 'billing'
  | 'captain-orders'
  | 'expense'
  | 'bank-deposit'
  | 'purchase'
  | 'catalog'
  | 'day-end'
  | 'reports'

export interface PosAction {
  id: PosActionId
  label: string
  hint: string
  icon: LucideIcon
  shortcut?: ShortcutKey
}

export const ACTIONS: Record<PosActionId, PosAction> = {
  'new-bill': { id: 'new-bill', label: 'New Bill', hint: 'Start a counter bill', icon: ReceiptText, shortcut: 'F1' },
  member: { id: 'member', label: 'Member', hint: 'Attach a member (optional)', icon: UserSearch, shortcut: 'F2' },
  pay: { id: 'pay', label: 'Pay', hint: 'Settle with Cash / UPI', icon: CreditCard, shortcut: 'F9' },
  billing: { id: 'billing', label: 'Billing Screen', hint: 'Scan bottles, take Cash / UPI', icon: ReceiptText },
  'captain-orders': { id: 'captain-orders', label: 'Captain Orders', hint: 'Edit and settle waiter handset orders', icon: Smartphone },
  expense: { id: 'expense', label: 'Expense', hint: 'Petty cash and daily spends', icon: Wallet },
  'bank-deposit': { id: 'bank-deposit', label: 'Bank Deposit', hint: 'Cash drops for bank / RTGS', icon: Landmark },
  purchase: { id: 'purchase', label: 'Purchase', hint: 'Stock inwarding (GRN)', icon: PackagePlus },
  catalog: { id: 'catalog', label: 'Inventory Catalog', hint: 'Liquors, prices and case sizes', icon: Boxes },
  'day-end': { id: 'day-end', label: 'Day End', hint: 'Peak reconciliation and close', icon: CalendarCheck },
  reports: { id: 'reports', label: 'Reports', hint: 'Sales, stock and F.Ac.2', icon: ChartColumn },
}

/** Dashboard tiles, in grid order. */
export const MODULE_TILES: readonly PosActionId[] = ['billing', 'captain-orders', 'expense', 'bank-deposit', 'purchase', 'catalog', 'day-end', 'reports']

/** Rail contents before the operator has used anything this session. */
export const DEFAULT_RECENT: readonly PosActionId[] = ['new-bill', 'member', 'pay', 'captain-orders', 'day-end']

const RECENT_LIMIT = 6

/** Moves `id` to the front of the recently-used list. */
export function pushRecent(prev: readonly PosActionId[], id: PosActionId): PosActionId[] {
  return [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_LIMIT)
}

/** Placeholder until backend services are wired in. */
export function runStub(id: PosActionId): void {
  console.info(`[FL2] ${ACTIONS[id].label}: stub handler, not wired yet`)
}

/** Actions that open the billing screen instead of a stub. */
export const BILLING_ACTIONS: ReadonlySet<PosActionId> = new Set(['billing', 'new-bill', 'member', 'pay'])
