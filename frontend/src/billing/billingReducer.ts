/**
 * BillingScreen state machine. Pure: every transition is unit-tested, and the server stays the
 * source of truth — bills enter the state only as BillDetail responses, so totals are never summed
 * client-side from prices.
 */
import type { BillDetail, BillDetailItem, CounterContext, DepartmentCode, KotStatus, MemberSummary, Paise, SizeCode, WaiterSummary } from '../api/types'

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
  /** Phase 19: the line's P&L department (KITCHEN lines print a kitchen KOT). */
  department: DepartmentCode
  /** Kitchen lines only: quantity not yet on a KOT (negative = a cancel still to print); 0 otherwise. */
  kotPending: number
}

export interface PendingScan {
  id: number
  /** The tab the scan was made on: its bottles go to that tab's bill even after a switch. */
  tabId: number
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

/** One billing tab: a held or current customer. Its bill lives on the server once the first bottle is scanned. */
export interface BillTab {
  id: number
  /** "Bill n": the lowest number free when the tab opened. */
  label: number
  /** The tab's open NORMAL bill; null until its first scan creates one. */
  bill: BillDetail | null
  /** Chosen before the first scan; applied when the bill is created. */
  pendingMember: MemberSummary | null
  pendingWaiter: WaiterSummary | null
  selectedKey: string | null
  /** The last bill settled in this tab. */
  receipt: Receipt | null
}

export interface BillingState {
  load: 'loading' | 'ready' | 'offline'
  offlineMessage: string | null
  context: Omit<CounterContext, 'openBill' | 'openBills'> | null
  tabs: BillTab[]
  activeTabId: number
  nextTabId: number
  pending: PendingScan[]
  ticker: PeakEntry[]
  dialog: DialogKind | null
  flash: Flash | null
}

export const MAX_TABS = 9

function emptyTab(id: number, label: number): BillTab {
  return { id, label, bill: null, pendingMember: null, pendingWaiter: null, selectedKey: null, receipt: null }
}

export const initialBillingState: BillingState = {
  load: 'loading',
  offlineMessage: null,
  context: null,
  tabs: [emptyTab(1, 1)],
  activeTabId: 1,
  nextTabId: 2,
  pending: [],
  ticker: [],
  dialog: null,
  flash: null,
}

export type BillingAction =
  | { type: 'contextLoaded'; context: CounterContext; resume: boolean }
  | { type: 'contextFailed'; message: string }
  | { type: 'billLoaded'; tabId: number; detail: BillDetail; focusSkuId?: string }
  | { type: 'billFinished'; tabId: number; receipt: Receipt | null }
  | { type: 'pendingMember'; tabId: number; member: MemberSummary | null }
  | { type: 'pendingWaiter'; tabId: number; waiter: WaiterSummary | null }
  | { type: 'scanQueued'; scan: PendingScan }
  | { type: 'scanDone'; id: number }
  | { type: 'peakSale'; entry: PeakEntry }
  | { type: 'peakUndone'; billId: string }
  | { type: 'select'; key: string }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'tabOpened' }
  | { type: 'tabSwitched'; tabId: number }
  | { type: 'tabCycled'; delta: 1 | -1 }
  | { type: 'tabClosed'; tabId: number }
  /** Orders → "Jump to bill": activate the tab holding this server bill (after a resume). */
  | { type: 'focusBill'; billId: string }
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
        department: item.department,
        kotPending: 0,
      }
      rows.set(key, row)
    }
    row.amountPaise += item.lineTotalPaise
    if (item.quantity > 0 && item.kotStation === 'KITCHEN') row.kotPending += item.remainingQuantity - item.kotSentQuantity
    if (item.quantity > 0 && item.remainingQuantity > 0) {
      row.quantity += item.remainingQuantity
      row.cancelItemId = item.id // items arrive in line order, so the last one wins
    }
  }
  return [...rows.values()].filter((r) => r.quantity > 0)
}

/**
 * What F6 would print for a bill (Phase 19): Kitchen quantity not yet sent, and sent quantity since
 * cancelled. Both 0 when the kitchen is up to date.
 */
export function kitchenKotPending(items: readonly BillDetailItem[]): { send: number; cancel: number } {
  let send = 0
  let cancel = 0
  for (const item of items) {
    if (item.quantity <= 0 || item.kotStation !== 'KITCHEN') continue
    const pending = item.remainingQuantity - item.kotSentQuantity
    if (pending > 0) send += pending
    else cancel -= pending
  }
  return { send, cancel }
}

/** A flash sentence for KOTs just printed (or failed); null when nothing was sent. */
export function kotMessage(kots: readonly KotStatus[] | undefined, billNo: number): { kind: 'ok' | 'error'; text: string } | null {
  if (!kots || kots.length === 0) return null
  const failed = kots.find((k) => !k.printed)
  if (failed) return { kind: 'error', text: `Kitchen KOT not printed (${failed.error ?? 'printer error'}) — F6 retries` }
  const parts = kots.map((k) => {
    const what = [k.sentQuantity > 0 ? `${k.sentQuantity} item${k.sentQuantity === 1 ? '' : 's'}` : null, k.cancelledQuantity > 0 ? `${k.cancelledQuantity} cancelled` : null]
      .filter(Boolean)
      .join(', ')
    const label = k.station === 'KITCHEN' ? 'Kitchen' : 'Bar'
    return `${label} KOT #${billNo}${k.ticketNo !== null && k.ticketNo > 1 ? `/${k.ticketNo}` : ''} sent · ${what}`
  })
  return { kind: 'ok', text: parts.join(' · ') }
}

export function totals(detail: BillDetail | null): { lines: number; bottles: number } {
  const rows = detail ? groupItems(detail.items) : []
  return { lines: rows.length, bottles: rows.reduce((n, r) => n + r.quantity, 0) }
}

export function activeTab(state: BillingState): BillTab {
  return state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0] ?? emptyTab(state.activeTabId, 1)
}

export function findTab(state: BillingState, tabId: number): BillTab | undefined {
  return state.tabs.find((t) => t.id === tabId)
}

/** A tab with nothing on it: no bill, no member or waiter picked, no scan on its way. */
export function isEmptyTab(state: BillingState, tab: BillTab): boolean {
  return tab.bill === null && tab.pendingMember === null && tab.pendingWaiter === null && !state.pending.some((p) => p.tabId === tab.id)
}

/**
 * Why a new tab can't open right now (null = it can). During a peak a new tab is simply an empty one,
 * which scans to peak: that is how the cashier leaves a held NORMAL bill to keep peak billing.
 */
export function newTabBlock(state: BillingState): string | null {
  if (state.tabs.length >= MAX_TABS) return `At most ${MAX_TABS} bills can be held — settle one first`
  if (isEmptyTab(state, activeTab(state))) return 'Already on a new bill — scan the first bottle'
  return null
}

function lowestFreeLabel(tabs: readonly BillTab[]): number {
  const used = new Set(tabs.map((t) => t.label))
  let label = 1
  while (used.has(label)) label += 1
  return label
}

function updateTab(state: BillingState, tabId: number, patch: (tab: BillTab) => BillTab): BillingState {
  return { ...state, tabs: state.tabs.map((t) => (t.id === tabId ? patch(t) : t)) }
}

/** Activates `tabId`, dropping the tab being left if it is empty: abandoned new tabs don't pile up. */
function switchTo(state: BillingState, tabId: number): BillingState {
  if (tabId === state.activeTabId || !findTab(state, tabId)) return state
  const leaving = activeTab(state)
  const tabs = isEmptyTab(state, leaving) ? state.tabs.filter((t) => t.id !== leaving.id) : state.tabs
  return { ...state, tabs, activeTabId: tabId }
}

/** Puts every server-side open bill not already in a tab into one: empty tabs first, then new tabs. */
function adoptOpenBills(state: BillingState, bills: readonly BillDetail[]): BillingState {
  const known = new Set(state.tabs.flatMap((t) => (t.bill ? [t.bill.bill.id] : [])))
  const fresh = bills.filter((b) => !known.has(b.bill.id))
  if (fresh.length === 0) return state
  let tabs = [...state.tabs]
  let nextTabId = state.nextTabId
  let newestTabId: number | null = null
  for (const detail of fresh) {
    const slot = tabs.find((t) => t.bill === null && t.pendingMember === null && t.pendingWaiter === null && !state.pending.some((p) => p.tabId === t.id))
    const rows = groupItems(detail.items)
    const filled = { bill: detail, selectedKey: rows.at(-1)?.key ?? null, receipt: null }
    if (slot) {
      tabs = tabs.map((t) => (t.id === slot.id ? { ...t, ...filled } : t))
      newestTabId = slot.id
    } else {
      const tab = { ...emptyTab(nextTabId, lowestFreeLabel(tabs)), ...filled }
      tabs = [...tabs, tab]
      newestTabId = nextTabId
      nextTabId += 1
    }
  }
  // Land on the newest resumed bill unless the cashier is already busy on a tab.
  const current = tabs.find((t) => t.id === state.activeTabId)
  const stay = current !== undefined && current.bill !== null && !fresh.some((b) => b.bill.id === current.bill?.bill.id)
  return { ...state, tabs, nextTabId, activeTabId: stay || newestTabId === null ? state.activeTabId : newestTabId }
}

export function screenMode(state: BillingState): ScreenMode {
  if (state.load === 'offline') return 'OFFLINE'
  if (!state.context) return 'LOADING'
  if (!state.context.businessDay) return 'BLOCKED'
  // A NORMAL bill opened before a peak started is finished in NORMAL mode.
  return state.context.peakSession && !activeTab(state).bill ? 'PEAK' : 'NORMAL'
}

export function billingReducer(state: BillingState, action: BillingAction): BillingState {
  switch (action.type) {
    case 'contextLoaded': {
      const { openBill, openBills, ...context } = action.context
      const next: BillingState = { ...state, load: 'ready', offlineMessage: null, context }
      if (!action.resume) return next
      return adoptOpenBills(next, openBills ?? (openBill ? [openBill] : []))
    }
    case 'contextFailed':
      return { ...state, load: 'offline', offlineMessage: action.message }
    case 'billLoaded': {
      const rows = groupItems(action.detail.items)
      const focused = action.focusSkuId ? rows.findLast((r) => r.skuId === action.focusSkuId) : undefined
      const load = (tab: BillTab): BillTab => {
        const kept = rows.some((r) => r.key === tab.selectedKey) ? tab.selectedKey : null
        return {
          ...tab,
          bill: action.detail,
          pendingMember: null,
          pendingWaiter: null,
          receipt: null,
          selectedKey: focused?.key ?? kept ?? rows.at(-1)?.key ?? null,
        }
      }
      if (findTab(state, action.tabId)) return updateTab(state, action.tabId, load)
      // The tab went away while its write was in flight: never lose a server bill, give it a tab back.
      const tab = load(emptyTab(state.nextTabId, lowestFreeLabel(state.tabs)))
      return { ...state, tabs: [...state.tabs, tab], nextTabId: state.nextTabId + 1 }
    }
    case 'billFinished':
      return {
        ...updateTab(state, action.tabId, (t) => ({ ...t, bill: null, receipt: action.receipt, selectedKey: null, pendingMember: null, pendingWaiter: null })),
        dialog: null,
      }
    case 'pendingMember':
      return updateTab(state, action.tabId, (t) => ({ ...t, pendingMember: action.member }))
    case 'pendingWaiter':
      return updateTab(state, action.tabId, (t) => ({ ...t, pendingWaiter: action.waiter }))
    case 'scanQueued':
      return { ...state, pending: [...state.pending, action.scan] }
    case 'scanDone':
      return { ...state, pending: state.pending.filter((p) => p.id !== action.id) }
    case 'peakSale':
      return { ...updateTab(state, state.activeTabId, (t) => ({ ...t, receipt: null })), ticker: [action.entry, ...state.ticker].slice(0, TICKER_LIMIT) }
    case 'peakUndone':
      return { ...state, ticker: state.ticker.map((e) => (e.billId === action.billId ? { ...e, undone: true } : e)) }
    case 'select':
      return updateTab(state, state.activeTabId, (t) => ({ ...t, selectedKey: action.key }))
    case 'move': {
      const tab = activeTab(state)
      const rows = groupItems(tab.bill?.items ?? [])
      if (rows.length === 0) return state
      const at = rows.findIndex((r) => r.key === tab.selectedKey)
      const next = at === -1 ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + action.delta))
      return updateTab(state, tab.id, (t) => ({ ...t, selectedKey: rows[next]?.key ?? null }))
    }
    case 'tabOpened': {
      if (newTabBlock(state) !== null) return state
      const tab = emptyTab(state.nextTabId, lowestFreeLabel(state.tabs))
      return { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id, nextTabId: state.nextTabId + 1 }
    }
    case 'tabSwitched':
      return switchTo(state, action.tabId)
    case 'tabCycled': {
      if (state.tabs.length < 2) return state
      const at = Math.max(0, state.tabs.findIndex((t) => t.id === state.activeTabId))
      const target = state.tabs[(at + action.delta + state.tabs.length) % state.tabs.length]
      return target ? switchTo(state, target.id) : state
    }
    case 'tabClosed': {
      const tab = findTab(state, action.tabId)
      // Only an empty tab closes here; a bill is cancelled (or settled) first.
      if (!tab || tab.bill !== null || state.pending.some((p) => p.tabId === tab.id)) return state
      if (state.tabs.length === 1) return { ...state, tabs: [emptyTab(tab.id, 1)] }
      const at = state.tabs.indexOf(tab)
      const tabs = state.tabs.filter((t) => t.id !== tab.id)
      const activeTabId = tab.id === state.activeTabId ? (tabs[Math.max(0, at - 1)]?.id ?? state.activeTabId) : state.activeTabId
      return { ...state, tabs, activeTabId }
    }
    case 'focusBill': {
      const tab = state.tabs.find((t) => t.bill?.bill.id === action.billId)
      return tab ? switchTo(state, tab.id) : state
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

/**
 * Which lines to cancel to take `count` bottles off a grouped row: newest lines first, each by at
 * most its bottles left. Cancellations are append-only lines that restock.
 */
export function cancelPlan(items: readonly BillDetailItem[], rowKey: string, count: number): Array<{ itemId: string; quantity: number }> {
  const plan: Array<{ itemId: string; quantity: number }> = []
  let left = count
  for (const item of [...items].reverse()) {
    if (left === 0) break
    if (`${item.skuId}:${item.unitPricePaise}` !== rowKey || item.quantity <= 0 || item.remainingQuantity <= 0) continue
    const take = Math.min(left, item.remainingQuantity)
    plan.push({ itemId: item.id, quantity: take })
    left -= take
  }
  return plan
}
