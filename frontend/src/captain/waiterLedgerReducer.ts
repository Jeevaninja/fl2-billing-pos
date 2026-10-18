/**
 * Waiter Ledger screen state (Phase 16, replaces the Captain Orders queue). Pure and unit-tested.
 * Figures enter only as server responses (the polled waiter list and the selected waiter's ledger),
 * so balances are never summed here; `allocate` only previews where a lump sum will go.
 */
import type { BillDetail, Paise, WaiterLedger, WaiterLedgerRow } from '../api/types'
import { groupItems, type Flash } from '../billing/billingReducer'
import { formatPaise, parseRupeesToPaise } from '../lib/money'

export type LedgerDialog = 'settle' | 'receive' | 'member'
export type LedgerPane = 'waiters' | 'bills' | 'lines'

export interface WaiterLedgerState {
  load: 'loading' | 'ready' | 'offline'
  offlineMessage: string | null
  /** Waiters with activity today or a balance, biggest balance first (server order). */
  waiters: WaiterLedgerRow[]
  selectedWaiterId: string | null
  /** The selected waiter's ledger; null until it loads (or when it belongs to another waiter). */
  ledger: WaiterLedger | null
  /** Open bills ticked for "Settle selected". */
  checked: ReadonlySet<string>
  /** The highlighted open bill: its lines show below, and −, X and F2 act on it. */
  cursorBillId: string | null
  /** Selected line (ItemRow key) of the highlighted bill. */
  selectedKey: string | null
  focus: LedgerPane
  /** Each waiter's newest open bill as last seen; a later one on a refresh is a new order. */
  seenNewest: ReadonlyMap<string, string>
  /** Waiters whose list row got a new order with the latest refresh (highlighted, one beep). */
  freshWaiterIds: ReadonlySet<string>
  lastUpdated: number | null
  dialog: LedgerDialog | null
  flash: Flash | null
}

export const initialWaiterLedgerState: WaiterLedgerState = {
  load: 'loading',
  offlineMessage: null,
  waiters: [],
  selectedWaiterId: null,
  ledger: null,
  checked: new Set(),
  cursorBillId: null,
  selectedKey: null,
  focus: 'waiters',
  seenNewest: new Map(),
  freshWaiterIds: new Set(),
  lastUpdated: null,
  dialog: null,
  flash: null,
}

export type WaiterLedgerAction =
  | { type: 'listLoaded'; waiters: WaiterLedgerRow[]; at: number }
  | { type: 'listFailed'; message: string }
  | { type: 'ledgerLoaded'; ledger: WaiterLedger }
  | { type: 'selectWaiter'; id: string }
  | { type: 'cursor'; billId: string }
  | { type: 'toggleCheck'; billId: string }
  | { type: 'checkAll' }
  | { type: 'clearChecks' }
  | { type: 'selectLine'; key: string }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'focus'; pane: LedgerPane }
  | { type: 'cycleFocus' }
  | { type: 'dialog'; dialog: LedgerDialog | null }
  | { type: 'flash'; kind: Flash['kind']; text: string }

// ── Selectors ────────────────────────────────────────────────────────────────

export function selectedWaiter(state: WaiterLedgerState): WaiterLedgerRow | null {
  return state.waiters.find((w) => w.id === state.selectedWaiterId) ?? null
}

/** The open bills of the selected waiter, oldest first (empty while their ledger loads). */
export function openBills(state: WaiterLedgerState): BillDetail[] {
  return state.ledger && state.ledger.waiter.id === state.selectedWaiterId ? state.ledger.openBills : []
}

export function cursorBill(state: WaiterLedgerState): BillDetail | null {
  return openBills(state).find((b) => b.bill.id === state.cursorBillId) ?? null
}

/** Ticked bills in list order; with none ticked, the highlighted bill (F9 settles what you are on). */
export function billsToSettle(state: WaiterLedgerState): BillDetail[] {
  const bills = openBills(state)
  const ticked = bills.filter((b) => state.checked.has(b.bill.id))
  if (ticked.length > 0) return ticked
  const cursor = cursorBill(state)
  return cursor ? [cursor] : []
}

export function selectionTotal(bills: readonly BillDetail[]): Paise {
  return bills.reduce((sum, b) => sum + b.duePaise, 0n)
}

/** Why the cashier can't cancel lines on this bill, or null when they can. */
export function editBlock(detail: BillDetail): string | null {
  return detail.tenderedPaise > 0n ? 'Lines are locked after a part-payment' : null
}

/** Order age: "new" under a minute, then minutes, then hours. */
export function formatAge(createdAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(createdAt)) / 60_000)
  if (minutes < 1) return 'new'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

export type PreviewSlice =
  | { kind: 'BILL'; billNo: number; amountPaise: Paise; settled: boolean; remainingDuePaise: Paise }
  | { kind: 'CREDIT'; amountPaise: Paise }

/**
 * Where a lump sum will go — the server's rule (WaiterService.receiveWaiterPayment): the oldest open
 * bill first, settling each one it covers and part-paying the next, then the credit balance.
 * `overPaise` is anything beyond what the waiter owes (the server refuses it).
 */
export function allocate(bills: readonly BillDetail[], creditPaise: Paise, amount: Paise): { slices: PreviewSlice[]; overPaise: Paise } {
  const slices: PreviewSlice[] = []
  let left = amount
  for (const b of bills) {
    if (left <= 0n) break
    const due = b.duePaise
    if (due <= 0n) continue
    const paying = left < due ? left : due
    slices.push({ kind: 'BILL', billNo: b.bill.billNo, amountPaise: paying, settled: paying === due, remainingDuePaise: due - paying })
    left -= paying
  }
  if (left > 0n && creditPaise > 0n) {
    const paying = left < creditPaise ? left : creditPaise
    slices.push({ kind: 'CREDIT', amountPaise: paying })
    left -= paying
  }
  return { slices, overPaise: left }
}

/** The receive form's first problem, or null when it can be recorded. */
export function receiveError(ledger: WaiterLedger | null, text: string): string | null {
  if (!ledger) return 'Pick a waiter first'
  const waiter = ledger.waiter
  if (!waiter.isTrusted) return `${waiter.displayName} is bill-on-bill — settle whole bills (tick them, F9)`
  if (waiter.balancePaise <= 0n) return `${waiter.displayName} owes nothing`
  if (text.trim() === '') return 'Enter the amount received'
  const amount = parseRupeesToPaise(text)
  if (amount === null) return 'Enter rupees, e.g. 2000 or 2,000.50'
  if (amount <= 0n) return 'Enter the amount received'
  if (amount > waiter.balancePaise) return `${waiter.displayName} owes only ${formatPaise(waiter.balancePaise)}`
  return null
}

// ── Reducer ──────────────────────────────────────────────────────────────────

function pickLine(detail: BillDetail | null, key: string | null): string | null {
  const rows = groupItems(detail?.items ?? [])
  return rows.some((r) => r.key === key) ? key : (rows[0]?.key ?? null)
}

/** Keeps the cursor and ticks on bills that are still open; a vanished cursor moves to the bill in its place. */
function withLedger(state: WaiterLedgerState, ledger: WaiterLedger | null): WaiterLedgerState {
  const bills = ledger?.openBills ?? []
  const ids = new Set(bills.map((b) => b.bill.id))
  const checked = new Set([...state.checked].filter((id) => ids.has(id)))
  let cursorBillId = state.cursorBillId !== null && ids.has(state.cursorBillId) ? state.cursorBillId : null
  if (cursorBillId === null) {
    const before = openBills(state).findIndex((b) => b.bill.id === state.cursorBillId)
    cursorBillId = bills[Math.min(Math.max(before, 0), bills.length - 1)]?.bill.id ?? null
  }
  const cursor = bills.find((b) => b.bill.id === cursorBillId) ?? null
  return { ...state, ledger, checked, cursorBillId, selectedKey: pickLine(cursor, state.selectedKey) }
}

function select(state: WaiterLedgerState, id: string): WaiterLedgerState {
  if (id === state.selectedWaiterId) return state
  return { ...state, selectedWaiterId: id, ledger: null, checked: new Set(), cursorBillId: null, selectedKey: null }
}

function flash(state: WaiterLedgerState, kind: Flash['kind'], text: string): Flash {
  return { kind, text, seq: (state.flash?.seq ?? 0) + 1 }
}

const PANES: readonly LedgerPane[] = ['waiters', 'bills', 'lines']

export function waiterLedgerReducer(state: WaiterLedgerState, action: WaiterLedgerAction): WaiterLedgerState {
  switch (action.type) {
    case 'listLoaded': {
      const firstLoad = state.lastUpdated === null
      const fresh = new Set<string>()
      const seenNewest = new Map(state.seenNewest)
      for (const w of action.waiters) {
        if (w.newestOpenAt === null) continue
        const seen = seenNewest.get(w.id)
        if (!firstLoad && (seen === undefined || w.newestOpenAt > seen)) fresh.add(w.id)
        seenNewest.set(w.id, w.newestOpenAt)
      }
      let next: WaiterLedgerState = { ...state, load: 'ready', offlineMessage: null, waiters: action.waiters, lastUpdated: action.at, seenNewest, freshWaiterIds: fresh }
      const stillThere = action.waiters.some((w) => w.id === state.selectedWaiterId)
      if (!stillThere) {
        // First load, or the selected waiter dropped off: take the row in its place (or the top one).
        const at = Math.max(0, state.waiters.findIndex((w) => w.id === state.selectedWaiterId))
        const replacement = action.waiters[Math.min(at, action.waiters.length - 1)]
        next = replacement ? select(next, replacement.id) : { ...next, selectedWaiterId: null, ledger: null, checked: new Set(), cursorBillId: null, selectedKey: null }
      }
      return next
    }
    case 'listFailed':
      return { ...state, load: 'offline', offlineMessage: action.message }
    case 'ledgerLoaded':
      // A ledger for a waiter the cashier has already moved away from is dropped.
      if (action.ledger.waiter.id !== state.selectedWaiterId) return state
      return {
        ...withLedger(state, action.ledger),
        waiters: state.waiters.map((w) => (w.id === action.ledger.waiter.id ? action.ledger.waiter : w)),
      }
    case 'selectWaiter':
      return state.waiters.some((w) => w.id === action.id) ? select(state, action.id) : state
    case 'cursor': {
      const bill = openBills(state).find((b) => b.bill.id === action.billId)
      if (!bill) return state
      return { ...state, cursorBillId: action.billId, selectedKey: pickLine(bill, null) }
    }
    case 'toggleCheck': {
      if (!openBills(state).some((b) => b.bill.id === action.billId)) return state
      const checked = new Set(state.checked)
      if (checked.has(action.billId)) checked.delete(action.billId)
      else checked.add(action.billId)
      return { ...state, checked }
    }
    case 'checkAll': {
      const ids = openBills(state).map((b) => b.bill.id)
      const all = ids.length > 0 && ids.every((id) => state.checked.has(id))
      return { ...state, checked: all ? new Set() : new Set(ids) }
    }
    case 'clearChecks':
      return { ...state, checked: new Set() }
    case 'selectLine':
      return { ...state, selectedKey: action.key, focus: 'lines' }
    case 'move': {
      if (state.focus === 'waiters') {
        if (state.waiters.length === 0) return state
        const at = state.waiters.findIndex((w) => w.id === state.selectedWaiterId)
        const next = state.waiters[Math.min(state.waiters.length - 1, Math.max(0, at === -1 ? 0 : at + action.delta))]
        return next ? select(state, next.id) : state
      }
      if (state.focus === 'bills') {
        const bills = openBills(state)
        if (bills.length === 0) return state
        const at = bills.findIndex((b) => b.bill.id === state.cursorBillId)
        const next = bills[Math.min(bills.length - 1, Math.max(0, at === -1 ? 0 : at + action.delta))]
        return next ? waiterLedgerReducer(state, { type: 'cursor', billId: next.bill.id }) : state
      }
      const rows = groupItems(cursorBill(state)?.items ?? [])
      if (rows.length === 0) return state
      const at = rows.findIndex((r) => r.key === state.selectedKey)
      const next = rows[Math.min(rows.length - 1, Math.max(0, at === -1 ? 0 : at + action.delta))]
      return { ...state, selectedKey: next?.key ?? null }
    }
    case 'focus':
      return { ...state, focus: action.pane }
    case 'cycleFocus':
      return { ...state, focus: PANES[(PANES.indexOf(state.focus) + 1) % PANES.length] ?? 'waiters' }
    case 'dialog':
      return { ...state, dialog: action.dialog }
    case 'flash':
      return { ...state, flash: flash(state, action.kind, action.text) }
  }
}
