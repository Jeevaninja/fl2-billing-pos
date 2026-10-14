import {
  CalendarCheck,
  ChartColumn,
  CreditCard,
  PackagePlus,
  Printer,
  ReceiptText,
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
  | 'kots'
  | 'expense'
  | 'purchase'
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
  kots: { id: 'kots', label: 'KOTs', hint: 'Waiter orders to counter printer', icon: Printer },
  expense: { id: 'expense', label: 'Expense', hint: 'Petty cash and daily spends', icon: Wallet },
  purchase: { id: 'purchase', label: 'Purchase', hint: 'Stock receipts and POs', icon: PackagePlus },
  'day-end': { id: 'day-end', label: 'Day End', hint: 'Peak reconciliation and close', icon: CalendarCheck },
  reports: { id: 'reports', label: 'Reports', hint: 'Sales, stock and F.Ac.2', icon: ChartColumn },
}

/** Dashboard tiles, in grid order. */
export const MODULE_TILES: readonly PosActionId[] = ['billing', 'kots', 'expense', 'purchase', 'day-end', 'reports']

/** Rail contents before the operator has used anything this session. */
export const DEFAULT_RECENT: readonly PosActionId[] = ['new-bill', 'member', 'pay', 'kots', 'day-end']

/** Placeholder until backend services are wired in. */
export function runStub(id: PosActionId): void {
  console.info(`[FL2] ${ACTIONS[id].label}: stub handler, not wired yet`)
}
