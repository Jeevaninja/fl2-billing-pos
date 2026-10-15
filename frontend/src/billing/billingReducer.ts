/**
 * BillingScreen state machine. Pure: every transition is unit-tested, and the server stays the
 * source of truth — bills enter the state only as BillDetail responses, so totals are never summed
 * client-side from prices.
 */
import type { BillDetail, BillDetailItem, CounterContext, MemberSummary, Paise, SizeCode, WaiterSummary } from '../api/types'

export type DialogKind = 'payment' | 'member' | 'waiter' | 'abandon'
export type ScreenMode = 'LOADING' | 'OFFLINE' | 'BLOCKED' | 'NORMAL' | 'PEAK'

export interface ItemRow {
  key: string
  skuId: string
  skuCode: string
  displayName: string
  sizeCode: SizeCode
  quantity: number
  unitPricePaise: Paise
  /** Σ server line totals for the row (sales and cancellations). */
  amountPaise: Paise
  /** Newest line with bottles left: the one "−" cancels from. */
  cancelItemId: string | null
}

export interface PendingScan {
  id: number
  code: string
  quantity: number
}

export interface PeakEntry {
  billId: string
  billNo: number
  displayName: string
  sizeCode: SizeCode
  quantity: number
  amountPaise: Paise
  at: string
  undone: boolean
}

export interface Receipt {
  billNo: number
  totalPaise: Paise
  changePaise: Paise
  summary: string
}

export interface Flash {
  kind: 'ok' | 'error'
  text: string
  seq: number
}

export interface BillingState {
  load: 'loading' | 'ready' | 'offline'
  offlineMessage: string | null
  context: Omit<CounterContext, 'openBill'> | null
  /** The open NORMAL bill; null until the first scan creates one. */
  bill: BillDetail | null
  /** Chosen before the first scan; applied when the bill is created. */
  pendingMember: MemberSummary | null
  pendingWaiter: WaiterSummary | null
  selectedKey: string | null
  pending: PendingScan[]
  ticker: PeakEntry[]
  receipt: Receipt | null
  dialog: DialogKind | null
  flash: Flash | null
}

export const initialBillingState: BillingState = {
  load: 'loading',
  offlineMessage: null,
  context: null,
  bill: null,
  pendingMember: null,
  pendingWaiter: null,
  selectedKey: null,
  pending: [],
  ticker: [],
  receipt: null,
  dialog: null,
  flash: null,
}

export type BillingAction =
  | { type: 'contextLoaded'; context: CounterContext; resume: boolean }
  | { type: 'contextFailed'; message: string }
  | { type: 'billLoaded'; detail: BillDetail; focusSkuId?: string }
  | { type: 'billFinished'; receipt: Receipt | null }
  | { type: 'pendingMember'; member: MemberSummary | null }
  | { type: 'pendingWaiter'; waiter: WaiterSummary | null }
  | { type: 'scanQueued'; scan: PendingScan }
  | { type: 'scanDone'; id: number }
  | { type: 'peakSale'; entry: PeakEntry }
  | { type: 'peakUndone'; billId: string }
  | { type: 'select'; key: string }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'dialog'; dialog: DialogKind | null }
  | { type: 'flash'; kind: Flash['kind']; text: string }

const TICKER_LIMIT = 50

export function groupItems(items: readonly BillDetailItem[]): ItemRow[] {
  const rows = new Map<string, ItemRow>()
  for (const item of items) {
    const key = `${item.skuId}:${item.unitPricePaise}`
    let row = rows.get(key)
    if (!row) {
      row = {
        key,
        skuId: item.skuId,
        skuCode: item.skuCode,
        displayName: item.displayName,
        sizeCode: item.sizeCode,
        quantity: 0,
        unitPricePaise: item.unitPricePaise,
        amountPaise: 0n,
        cancelItemId: null,
      }
      rows.set(key, row)
    }
    row.amountPaise += item.lineTotalPaise
    if (item.quantity > 0 && item.remainingQuantity > 0) {
      row.quantity += item.remainingQuantity
      row.cancelItemId = item.id // items arrive in line order, so the last one wins
    }
  }
  return [...rows.values()].filter((r) => r.quantity > 0)
}

export function totals(detail: BillDetail | null): { lines: number; bottles: number } {
  const rows = detail ? groupItems(detail.items) : []
  return { lines: rows.length, bottles: rows.reduce((n, r) => n + r.quantity, 0) }
}

export function screenMode(state: BillingState): ScreenMode {
  if (state.load === 'offline') return 'OFFLINE'
  if (!state.context) return 'LOADING'
  if (!state.context.businessDay) return 'BLOCKED'
  // A NORMAL bill opened before a peak started is finished in NORMAL mode.
  return state.context.peakSession && !state.bill ? 'PEAK' : 'NORMAL'
}

export function billingReducer(state: BillingState, action: BillingAction): BillingState {
  switch (action.type) {
    case 'contextLoaded': {
      const { openBill, ...context } = action.context
      const resumed = action.resume && !state.bill && openBill ? openBill : state.bill
      return {
        ...state,
        load: 'ready',
        offlineMessage: null,
        context,
        bill: resumed,
        selectedKey: resumed === state.bill ? state.selectedKey : (groupItems(resumed?.items ?? []).at(-1)?.key ?? null),
      }
    }
    case 'contextFailed':
      return { ...state, load: 'offline', offlineMessage: action.message }
    case 'billLoaded': {
      const rows = groupItems(action.detail.items)
      const focused = action.focusSkuId ? rows.findLast((r) => r.skuId === action.focusSkuId) : undefined
      const kept = rows.some((r) => r.key === state.selectedKey) ? state.selectedKey : null
      return {
        ...state,
        bill: action.detail,
        pendingMember: null,
        pendingWaiter: null,
        receipt: null,
        selectedKey: focused?.key ?? kept ?? rows.at(-1)?.key ?? null,
      }
    }
    case 'billFinished':
      return { ...state, bill: null, receipt: action.receipt, dialog: null, selectedKey: null, pendingMember: null, pendingWaiter: null }
    case 'pendingMember':
      return { ...state, pendingMember: action.member }
    case 'pendingWaiter':
      return { ...state, pendingWaiter: action.waiter }
    case 'scanQueued':
      return { ...state, pending: [...state.pending, action.scan] }
    case 'scanDone':
      return { ...state, pending: state.pending.filter((p) => p.id !== action.id) }
    case 'peakSale':
      return { ...state, receipt: null, ticker: [action.entry, ...state.ticker].slice(0, TICKER_LIMIT) }
    case 'peakUndone':
      return { ...state, ticker: state.ticker.map((e) => (e.billId === action.billId ? { ...e, undone: true } : e)) }
    case 'select':
      return { ...state, selectedKey: action.key }
    case 'move': {
      const rows = groupItems(state.bill?.items ?? [])
      if (rows.length === 0) return state
      const at = rows.findIndex((r) => r.key === state.selectedKey)
      const next = at === -1 ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + action.delta))
      return { ...state, selectedKey: rows[next]?.key ?? null }
    }
    case 'dialog':
      return { ...state, dialog: action.dialog }
    case 'flash':
      return { ...state, flash: { kind: action.kind, text: action.text, seq: (state.flash?.seq ?? 0) + 1 } }
  }
}

/** Scan-flash stock note: bottles left after this sale, read from the lookup taken just before it. */
export function stockLeft(onHandBefore: number, sold: number): string {
  const left = Math.max(0, onHandBefore - sold)
  return left === 0 ? 'last in stock' : `${left} left`
}
