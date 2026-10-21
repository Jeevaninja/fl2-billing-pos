import {
  Boxes,
  CalendarCheck,
  Store,
  Building2,
  ChartColumn,
  ClipboardList,
  LayoutList,
  CreditCard,
  Landmark,
  PackagePlus,
  ReceiptText,
  Smartphone,
  Tags,
  UserCog,
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
  | 'revenue-centers'
  | 'catalog'
  | 'orders'
  | 'expense-categories'
  | 'item-categories'
  | 'center-settings'
  | 'day-end'
  | 'reports'
  | 'staff'

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
  'captain-orders': { id: 'captain-orders', label: 'Waiter Ledger', hint: 'Captain orders, waiter balances and payments', icon: Smartphone },
  expense: { id: 'expense', label: 'Expense', hint: 'Petty cash and daily spends', icon: Wallet },
  'bank-deposit': { id: 'bank-deposit', label: 'Bank Deposit', hint: 'Cash drops for bank / RTGS', icon: Landmark },
  purchase: { id: 'purchase', label: 'Purchase', hint: 'Stock inwarding (GRN)', icon: PackagePlus },
  'revenue-centers': { id: 'revenue-centers', label: 'Revenue Centers', hint: 'P&L for Kitchen, Cigarettes, Cool Drinks…', icon: Store },
  catalog: { id: 'catalog', label: 'Inventory Catalog', hint: 'Items by category, prices and stock', icon: Boxes },
  'item-categories': { id: 'item-categories', label: 'Item Categories', hint: 'FULL, HALF, QUARTER… and their order', icon: LayoutList },
  'center-settings': { id: 'center-settings', label: 'Revenue Centers', hint: 'Kitchen, Cigarettes… KOT and stock rules', icon: Building2 },
  orders: { id: 'orders', label: 'Orders', hint: "Today's bills, receipts and reprints", icon: ClipboardList },
  'expense-categories': { id: 'expense-categories', label: 'Expense Categories', hint: 'Petty-cash categories and their order', icon: Tags },
  'day-end': { id: 'day-end', label: 'Day End', hint: 'Peak reconciliation and close', icon: CalendarCheck },
  reports: { id: 'reports', label: 'Reports', hint: 'Sales, stock register, Day End and Tally sheets', icon: ChartColumn },
  staff: { id: 'staff', label: 'Staff & PINs', hint: 'Cashiers, managers and Day Open PINs', icon: UserCog },
}

/**
 * Dashboard tiles, in grid order. Phase 25 (D7): 5 × 2 with Billing spanning both rows of the first
 * column (the hero tile), then four tiles per row; Reports left the Settings menu for the last slot.
 * This fills the grid: HR / Payroll will need a sixth column.
 */
export const MODULE_TILES: readonly PosActionId[] = ['billing', 'captain-orders', 'expense', 'bank-deposit', 'purchase', 'revenue-centers', 'orders', 'day-end', 'reports']

/** The tile that spans two rows. */
export const HERO_TILE: PosActionId = 'billing'

/** Header Settings menu entries: screens that don't need a grid tile. */
export const SETTINGS_ACTIONS: readonly PosActionId[] = ['catalog', 'item-categories', 'center-settings', 'expense-categories', 'staff']

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
