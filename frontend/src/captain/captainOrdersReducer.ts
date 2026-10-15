/**
 * CaptainOrdersScreen state machine. Pure and unit-tested. Orders enter the state only as server
 * BillDetail responses (polled list, or a re-read after an edit), so totals are never summed here.
 */
import type { BillDetail } from '../api/types'
import { groupItems, type Flash, type Receipt } from '../billing/billingReducer'

export type CaptainDialog = 'payment' | 'member'
export type Pane = 'list' | 'detail'

export interface CaptainOrdersState {
  load: 'loading' | 'ready' | 'offline'
  offlineMessage: string | null
  /** Open Captain orders, oldest first, as the server listed them. */
  orders: BillDetail[]
  selectedId: string | null
  /** Selected line (ItemRow key) of the selected order. */
  selectedKey: string | null
  /** Which pane ↑/↓ moves through. */
  focus: Pane
  /** Every order id seen this visit; an id outside it on a refresh is a new order. */
  seenIds: ReadonlySet<string>
  /** Orders that arrived with the latest refresh (highlighted once). */
  freshIds: ReadonlySet<string>
  /** Epoch ms of the last successful refresh. */
  lastUpdated: number | null
  dialog: CaptainDialog | null
  receipt: Receipt | null
  flash: Flash | null
}

export const initialCaptainOrdersState: CaptainOrdersState = {
  load: 'loading',
  offlineMessage: null,
  orders: [],
  selectedId: null,
  selectedKey: null,
  focus: 'list',
  seenIds: new Set(),
  freshIds: new Set(),
  lastUpdated: null,
  dialog: null,
  receipt: null,
  flash: null,
}

export type CaptainOrdersAction =
  | { type: 'ordersLoaded'; orders: BillDetail[]; at: number }
  | { type: 'ordersFailed'; message: string }
  /** A re-read after a counter edit; an order that is no longer OPEN leaves the list. */
  | { type: 'orderUpdated'; detail: BillDetail }
  /** Settled or closed at this counter. */
  | { type: 'orderGone'; billId: string; receipt: Receipt | null }
  | { type: 'select'; id: string }
  | { type: 'selectLine'; key: string }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'focus'; pane: Pane }
  | { type: 'dialog'; dialog: CaptainDialog | null }
  | { type: 'flash'; kind: Flash['kind']; text: string }

export function selectedOrder(state: CaptainOrdersState): BillDetail | null {
  return state.orders.find((o) => o.bill.id === state.selectedId) ?? null
}

/** Why the cashier can't cancel lines on this order, or null when they can. */
export function editBlock(detail: BillDetail): string | null {
  return detail.tenderedPaise > 0n ? 'Lines are locked after a part-payment' : null
}

/** Order age for the list: "new" under a minute, then minutes, then hours. */
export function formatAge(createdAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(createdAt)) / 60_000)
  if (minutes < 1) return 'new'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** Keeps `key` when the order still has that row; otherwise the row at `fallbackIndex` (clamped). */
function pickLine(detail: BillDetail | undefined, key: string | null, fallbackIndex = 0): string | null {
  const rows = groupItems(detail?.items ?? [])
  if (rows.some((r) => r.key === key)) return key
  return rows[Math.min(Math.max(fallbackIndex, 0), rows.length - 1)]?.key ?? null
}

function lineIndex(detail: BillDetail | undefined, key: string | null): number {
  return groupItems(detail?.items ?? []).findIndex((r) => r.key === key)
}

/** Replaces the list, re-pointing a selection that vanished to the order that took its place. */
function withOrders(state: CaptainOrdersState, orders: BillDetail[]): CaptainOrdersState {
  const kept = orders.find((o) => o.bill.id === state.selectedId)
  if (kept) {
    const previous = selectedOrder(state)
    return { ...state, orders, selectedKey: pickLine(kept, state.selectedKey, lineIndex(previous ?? undefined, state.selectedKey)) }
  }
  const at = Math.max(0, state.orders.findIndex((o) => o.bill.id === state.selectedId))
  const next = orders[Math.min(at, orders.length - 1)]
  return { ...state, orders, selectedId: next?.bill.id ?? null, selectedKey: pickLine(next, null) }
}

function flash(state: CaptainOrdersState, kind: Flash['kind'], text: string): Flash {
  return { kind, text, seq: (state.flash?.seq ?? 0) + 1 }
}

export function captainOrdersReducer(state: CaptainOrdersState, action: CaptainOrdersAction): CaptainOrdersState {
  switch (action.type) {
    case 'ordersLoaded': {
      const firstLoad = state.lastUpdated === null
      const freshIds = new Set(firstLoad ? [] : action.orders.map((o) => o.bill.id).filter((id) => !state.seenIds.has(id)))
      const seenIds = new Set([...state.seenIds, ...action.orders.map((o) => o.bill.id)])
      const vanished = state.selectedId !== null && !action.orders.some((o) => o.bill.id === state.selectedId) ? selectedOrder(state) : null
      const next = withOrders({ ...state, load: 'ready', offlineMessage: null, lastUpdated: action.at, seenIds, freshIds }, action.orders)
      return vanished ? { ...next, flash: flash(state, 'error', `Order #${vanished.bill.billNo} was closed at another terminal`) } : next
    }
    case 'ordersFailed':
      return { ...state, load: 'offline', offlineMessage: action.message }
    case 'orderUpdated': {
      if (action.detail.bill.status !== 'OPEN') {
        return withOrders(state, state.orders.filter((o) => o.bill.id !== action.detail.bill.id))
      }
      const orders = state.orders.map((o) => (o.bill.id === action.detail.bill.id ? action.detail : o))
      return withOrders(state, orders)
    }
    case 'orderGone':
      return { ...withOrders(state, state.orders.filter((o) => o.bill.id !== action.billId)), receipt: action.receipt, dialog: null }
    case 'select': {
      const order = state.orders.find((o) => o.bill.id === action.id)
      if (!order) return state
      return { ...state, selectedId: action.id, selectedKey: pickLine(order, null), receipt: null }
    }
    case 'selectLine':
      return { ...state, selectedKey: action.key, focus: 'detail' }
    case 'move': {
      if (state.focus === 'detail') {
        const order = selectedOrder(state) ?? undefined
        const at = lineIndex(order, state.selectedKey)
        return { ...state, selectedKey: pickLine(order, null, at === -1 ? 0 : at + action.delta) }
      }
      if (state.orders.length === 0) return state
      const at = state.orders.findIndex((o) => o.bill.id === state.selectedId)
      const next = state.orders[Math.min(state.orders.length - 1, Math.max(0, at === -1 ? 0 : at + action.delta))]
      return next && next.bill.id !== state.selectedId ? captainOrdersReducer(state, { type: 'select', id: next.bill.id }) : state
    }
    case 'focus':
      return { ...state, focus: action.pane }
    case 'dialog':
      return { ...state, dialog: action.dialog }
    case 'flash':
      return { ...state, flash: flash(state, action.kind, action.text) }
  }
}
