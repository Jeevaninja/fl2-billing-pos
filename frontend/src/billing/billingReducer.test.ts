import { describe, expect, it } from 'vitest'
import type { BillDetail } from '../api/types'
import {
  activeTab,
  billingReducer,
  cancelPlan,
  findTab,
  groupItems,
  initialBillingState,
  MAX_TABS,
  newTabBlock,
  screenMode,
  stockLeft,
  totals,
  type BillingState,
  type PeakEntry,
} from './billingReducer'
import { context, detail, line, PEAK, waiter, withWaiter } from './testData'

const ready = (over: Partial<BillingState> = {}): BillingState => ({
  ...billingReducer(initialBillingState, { type: 'contextLoaded', context: context(), resume: true }),
  ...over,
})

/** The current tab now holds `bill`, as after its first scan. */
const withBill = (state: BillingState, bill: BillDetail): BillingState => billingReducer(state, { type: 'billLoaded', tabId: state.activeTabId, detail: bill })

describe('groupItems', () => {
  it('merges repeat scans of a SKU into one row and drops fully cancelled rows', () => {
    const a1 = line({ skuId: 'a', quantity: 2, lineNo: 1 })
    const b1 = line({ skuId: 'b', quantity: 1, lineNo: 2, unitPricePaise: 15000n })
    const a2 = line({ skuId: 'a', quantity: 1, lineNo: 3 })
    const cancelA2 = line({ skuId: 'a', quantity: -1, lineNo: 4, reversesItemId: a2.id })
    const cancelB1 = line({ skuId: 'b', quantity: -1, lineNo: 5, reversesItemId: b1.id, unitPricePaise: 15000n })
    a2.remainingQuantity = 0
    b1.remainingQuantity = 0

    const rows = groupItems([a1, b1, a2, cancelA2, cancelB1])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ skuId: 'a', quantity: 2, amountPaise: 44000n, cancelItemId: a1.id })
  })

  it('cancels from the newest line that still has bottles', () => {
    const a1 = line({ skuId: 'a', quantity: 1, lineNo: 1 })
    const a2 = line({ skuId: 'a', quantity: 2, lineNo: 2 })
    expect(groupItems([a1, a2])[0]).toMatchObject({ quantity: 3, cancelItemId: a2.id })
  })

  it('keeps a price change mid-bill on separate rows', () => {
    const rows = groupItems([line({ skuId: 'a', unitPricePaise: 100n }), line({ skuId: 'a', unitPricePaise: 120n })])
    expect(rows.map((r) => r.unitPricePaise)).toEqual([100n, 120n])
  })

  it('totals lines and bottles', () => {
    const d = detail([line({ skuId: 'a', quantity: 2 }), line({ skuId: 'b', quantity: 3 })])
    expect(totals(d)).toEqual({ lines: 2, bottles: 5 })
    expect(totals(null)).toEqual({ lines: 0, bottles: 0 })
  })
})

describe('billingReducer', () => {
  it('loads the context and resumes open bills only when asked to', () => {
    const open = detail([line({ skuId: 'a' })])
    const resumed = billingReducer(initialBillingState, { type: 'contextLoaded', context: context({ openBill: open, openBills: [open] }), resume: true })
    expect(resumed.load).toBe('ready')
    expect(activeTab(resumed).bill).toBe(open)
    expect(resumed.context).not.toHaveProperty('openBill')
    expect(resumed.context).not.toHaveProperty('openBills')

    const other = detail([line({ skuId: 'b' })], { bill: { ...open.bill, id: 'bill-2', billNo: 43 } })
    const polled = billingReducer(initialBillingState, { type: 'contextLoaded', context: context({ openBill: other, openBills: [other] }), resume: false })
    expect(activeTab(polled).bill).toBeNull()
  })

  it('derives the screen mode: BLOCKED without a day, PEAK with a session, NORMAL otherwise', () => {
    expect(screenMode(initialBillingState)).toBe('LOADING')
    expect(screenMode(ready())).toBe('NORMAL')
    expect(screenMode(ready({ context: { ...context(), businessDay: null } }))).toBe('BLOCKED')
    expect(screenMode(ready({ context: { ...context(), peakSession: PEAK } }))).toBe('PEAK')
  })

  it('keeps an open NORMAL bill in NORMAL mode when a peak starts mid-bill', () => {
    const state = withBill(ready({ context: { ...context(), peakSession: PEAK } }), detail([line({ skuId: 'a' })]))
    expect(screenMode(state)).toBe('NORMAL')
    expect(screenMode(billingReducer(state, { type: 'billFinished', tabId: 1, receipt: null }))).toBe('PEAK')
  })

  it('selects the row of the SKU just scanned, and keeps a valid selection otherwise', () => {
    const d = detail([line({ skuId: 'a' }), line({ skuId: 'b' })])
    const s1 = billingReducer(ready(), { type: 'billLoaded', tabId: 1, detail: d, focusSkuId: 'a' })
    expect(activeTab(s1).selectedKey).toBe(groupItems(d.items)[0]?.key)
    const s2 = billingReducer(s1, { type: 'billLoaded', tabId: 1, detail: d })
    expect(activeTab(s2).selectedKey).toBe(activeTab(s1).selectedKey)
    const s3 = billingReducer(billingReducer(s1, { type: 'select', key: 'gone' }), { type: 'billLoaded', tabId: 1, detail: d })
    expect(activeTab(s3).selectedKey).toBe(groupItems(d.items)[1]?.key)
  })

  it('moves the selection with up/down, clamped to the rows', () => {
    const d = detail([line({ skuId: 'a' }), line({ skuId: 'b' }), line({ skuId: 'c' })])
    const keys = groupItems(d.items).map((r) => r.key)
    let s = billingReducer(ready(), { type: 'billLoaded', tabId: 1, detail: d, focusSkuId: 'c' })
    s = billingReducer(s, { type: 'move', delta: -1 })
    expect(activeTab(s).selectedKey).toBe(keys[1])
    s = billingReducer(billingReducer(s, { type: 'move', delta: -1 }), { type: 'move', delta: -1 })
    expect(activeTab(s).selectedKey).toBe(keys[0])
    s = billingReducer(s, { type: 'move', delta: 1 })
    expect(activeTab(s).selectedKey).toBe(keys[1])
  })

  it('applies pending member and waiter to the first bill, then clears them', () => {
    const member = { id: 'm-1', membershipNo: 'M-1', displayName: 'Anil' }
    let s = billingReducer(ready(), { type: 'pendingMember', tabId: 1, member })
    expect(activeTab(s).pendingMember).toEqual(member)
    s = billingReducer(s, { type: 'billLoaded', tabId: 1, detail: detail([line({ skuId: 'a' })], { member }) })
    expect(activeTab(s).pendingMember).toBeNull()
  })

  it('goes idle with a receipt when a bill is finished, closing any dialog', () => {
    const receipt = { billNo: 42, totalPaise: 22000n, changePaise: 3000n, summary: 'Cash' }
    const s = billingReducer(withBill(ready({ dialog: 'payment' }), detail([line({ skuId: 'a' })])), { type: 'billFinished', tabId: 1, receipt })
    expect(activeTab(s)).toMatchObject({ bill: null, receipt, selectedKey: null })
    expect(s.dialog).toBeNull()
    // The next bill clears the receipt.
    expect(activeTab(billingReducer(s, { type: 'billLoaded', tabId: 1, detail: detail() })).receipt).toBeNull()
  })

  it('tracks queued scans until they finish', () => {
    let s = billingReducer(ready(), { type: 'scanQueued', scan: { id: 1, tabId: 1, code: '890', quantity: 2 } })
    s = billingReducer(s, { type: 'scanQueued', scan: { id: 2, tabId: 1, code: 'X', quantity: 1 } })
    s = billingReducer(s, { type: 'scanDone', id: 1 })
    expect(s.pending).toEqual([{ id: 2, tabId: 1, code: 'X', quantity: 1 }])
  })

  it('keeps the newest 50 peak sales and marks an undone one', () => {
    const entry = (n: number): PeakEntry => ({
      billId: `b${n}`,
      billNo: n,
      displayName: 'Lager',
      sizeCode: 'BEER_650',
      quantity: 1,
      amountPaise: 22000n,
      at: '2026-10-14T15:00:00.000Z',
      undone: false,
    })
    let s = ready()
    for (let n = 1; n <= 55; n++) s = billingReducer(s, { type: 'peakSale', entry: entry(n) })
    expect(s.ticker).toHaveLength(50)
    expect(s.ticker[0]?.billNo).toBe(55)
    s = billingReducer(s, { type: 'peakUndone', billId: 'b55' })
    expect(s.ticker[0]?.undone).toBe(true)
    expect(s.ticker[1]?.undone).toBe(false)
  })

  it('bumps the flash sequence so a repeated message re-animates', () => {
    const a = billingReducer(ready(), { type: 'flash', kind: 'error', text: 'Out of stock' })
    const b = billingReducer(a, { type: 'flash', kind: 'error', text: 'Out of stock' })
    expect(b.flash?.seq).toBe((a.flash?.seq ?? 0) + 1)
  })

  it('marks the screen offline when the context cannot load', () => {
    expect(billingReducer(initialBillingState, { type: 'contextFailed', message: 'down' })).toMatchObject({
      load: 'offline',
      offlineMessage: 'down',
    })
  })
})

describe('billing tabs', () => {
  const billA = detail([line({ skuId: 'a', quantity: 2 })])
  const billB = detail([line({ skuId: 'b' })], { bill: { ...billA.bill, id: 'bill-2', billNo: 43 } })
  const member = { id: 'm-1', membershipNo: 'M-1', displayName: 'Anil' }

  /** Tab 1 holds bill A with a member; tab 2 is the current, empty one. */
  const holding = () => billingReducer(withBill(ready(), detail(billA.items, { member })), { type: 'tabOpened' })

  it('opens a new tab as "Bill 2" and makes it current, holding the first', () => {
    const s = holding()
    expect(s.tabs.map((t) => t.label)).toEqual([1, 2])
    expect(s.activeTabId).toBe(2)
    expect(activeTab(s).bill).toBeNull()
    expect(findTab(s, 1)?.bill?.member).toEqual(member)
  })

  it('keeps each tab\'s lines, member, waiter and selection across switches', () => {
    const w = waiter()
    let s = holding()
    s = billingReducer(s, { type: 'pendingWaiter', tabId: 2, waiter: w })
    s = billingReducer(s, { type: 'billLoaded', tabId: 2, detail: withWaiter(billB, w) })
    const selected2 = activeTab(s).selectedKey

    s = billingReducer(s, { type: 'tabSwitched', tabId: 1 })
    expect(activeTab(s).bill?.bill.id).toBe('bill-1')
    expect(activeTab(s).bill?.member).toEqual(member)
    expect(activeTab(s).bill?.waiter).toBeNull()
    s = billingReducer(s, { type: 'move', delta: -1 })

    s = billingReducer(s, { type: 'tabSwitched', tabId: 2 })
    expect(activeTab(s)).toMatchObject({ selectedKey: selected2 })
    expect(activeTab(s).bill?.waiter).toEqual(w)
    expect(activeTab(s).bill?.member).toBeNull()
    expect(totals(activeTab(s).bill)).toEqual({ lines: 1, bottles: 1 })
  })

  it('lands a reply on the tab it was made for, even after the cashier switched away', () => {
    let s = billingReducer(holding(), { type: 'pendingMember', tabId: 2, member })
    s = billingReducer(s, { type: 'tabSwitched', tabId: 1 })
    s = billingReducer(s, { type: 'billLoaded', tabId: 2, detail: billB })
    expect(s.activeTabId).toBe(1)
    expect(activeTab(s).bill?.bill.id).toBe('bill-1')
    expect(findTab(s, 2)?.bill?.bill.id).toBe('bill-2')

    s = billingReducer(s, { type: 'billFinished', tabId: 2, receipt: null })
    expect(findTab(s, 2)?.bill).toBeNull()
    expect(activeTab(s).bill?.bill.id).toBe('bill-1')
  })

  it('drops an empty tab when the cashier switches away from it', () => {
    let s = billingReducer(holding(), { type: 'tabSwitched', tabId: 1 })
    expect(s.tabs.map((t) => t.id)).toEqual([1])
    // … but not one with a member picked, or with a scan on its way.
    s = billingReducer(billingReducer(holding(), { type: 'pendingMember', tabId: 2, member }), { type: 'tabSwitched', tabId: 1 })
    expect(s.tabs).toHaveLength(2)
    s = billingReducer(billingReducer(holding(), { type: 'scanQueued', scan: { id: 1, tabId: 2, code: 'X', quantity: 1 } }), { type: 'tabSwitched', tabId: 1 })
    expect(s.tabs).toHaveLength(2)
  })

  it('refuses a new tab while on an empty one or beyond the limit', () => {
    expect(newTabBlock(ready())).toMatch(/Already on a new bill/)
    expect(billingReducer(ready(), { type: 'tabOpened' }).tabs).toHaveLength(1)

    let s = ready()
    for (let n = 1; n <= MAX_TABS + 2; n++) {
      s = billingReducer(s, { type: 'pendingMember', tabId: s.activeTabId, member })
      s = billingReducer(s, { type: 'tabOpened' })
    }
    expect(s.tabs).toHaveLength(MAX_TABS)
    expect(newTabBlock(s)).toMatch(/At most 9/)

  })

  it('lets a cashier leave a held NORMAL bill during a peak: the new, empty tab scans to peak', () => {
    const peak = withBill(ready({ context: { ...context(), peakSession: PEAK } }), billA)
    expect(screenMode(peak)).toBe('NORMAL')
    expect(newTabBlock(peak)).toBeNull()
    const s = billingReducer(peak, { type: 'tabOpened' })
    expect(s.tabs).toHaveLength(2)
    expect(screenMode(s)).toBe('PEAK')
    expect(newTabBlock(s)).toMatch(/Already on a new bill/)
  })

  it('reuses the lowest free label', () => {
    let s = holding() // Bill 1 (A), Bill 2
    s = billingReducer(s, { type: 'billLoaded', tabId: 2, detail: billB })
    s = billingReducer(s, { type: 'tabOpened' }) // Bill 3
    s = billingReducer(s, { type: 'tabSwitched', tabId: 1 }) // empty Bill 3 is dropped
    s = billingReducer(s, { type: 'billFinished', tabId: 1, receipt: null })
    s = billingReducer(s, { type: 'tabClosed', tabId: 1 })
    expect(s.tabs.map((t) => t.label)).toEqual([2])
    s = billingReducer(s, { type: 'tabOpened' })
    expect(s.tabs.map((t) => t.label)).toEqual([2, 1])
  })

  it('cycles through tabs in order, wrapping around', () => {
    let s = holding()
    s = billingReducer(s, { type: 'billLoaded', tabId: 2, detail: billB })
    s = billingReducer(s, { type: 'tabOpened' })
    s = billingReducer(s, { type: 'pendingMember', tabId: 3, member })
    expect(s.activeTabId).toBe(3)
    s = billingReducer(s, { type: 'tabCycled', delta: 1 })
    expect(s.activeTabId).toBe(1)
    s = billingReducer(s, { type: 'tabCycled', delta: -1 })
    expect(s.activeTabId).toBe(3)
    s = billingReducer(s, { type: 'tabCycled', delta: -1 })
    expect(s.activeTabId).toBe(2)
  })

  it('closes only empty tabs, moving to the neighbour; the last tab resets to Bill 1', () => {
    let s = holding()
    expect(billingReducer(s, { type: 'tabClosed', tabId: 1 }).tabs).toHaveLength(2) // has a bill
    s = billingReducer(s, { type: 'pendingMember', tabId: 2, member })
    s = billingReducer(s, { type: 'pendingMember', tabId: 2, member: null })
    s = billingReducer(s, { type: 'tabClosed', tabId: 2 })
    expect(s.tabs.map((t) => t.id)).toEqual([1])
    expect(s.activeTabId).toBe(1)

    s = billingReducer(s, { type: 'billFinished', tabId: 1, receipt: null })
    s = billingReducer(s, { type: 'tabClosed', tabId: 1 })
    expect(s.tabs).toEqual([expect.objectContaining({ label: 1, bill: null })])
  })

  it('keeps the settled tab current (empty, with its receipt) instead of jumping to a held bill', () => {
    const receipt = { billNo: 43, totalPaise: 22000n, changePaise: 0n, summary: 'Cash' }
    let s = billingReducer(holding(), { type: 'billLoaded', tabId: 2, detail: billB })
    s = billingReducer(s, { type: 'billFinished', tabId: 2, receipt })
    expect(s.activeTabId).toBe(2)
    expect(activeTab(s)).toMatchObject({ bill: null, receipt })
    expect(findTab(s, 1)?.bill?.bill.id).toBe('bill-1')
  })

  it('restores one tab per held bill on resume and lands on the newest', () => {
    const s = billingReducer(initialBillingState, { type: 'contextLoaded', context: context({ openBill: billB, openBills: [billA, billB] }), resume: true })
    expect(s.tabs.map((t) => [t.label, t.bill?.bill.id])).toEqual([
      [1, 'bill-1'],
      [2, 'bill-2'],
    ])
    expect(activeTab(s).bill?.bill.id).toBe('bill-2')
    // A later resume (after being offline) adds nothing twice and stays on the tab in use.
    const again = billingReducer(billingReducer(s, { type: 'tabSwitched', tabId: s.tabs[0]!.id }), {
      type: 'contextLoaded',
      context: context({ openBills: [billA, billB] }),
      resume: true,
    })
    expect(again.tabs).toHaveLength(2)
    expect(activeTab(again).bill?.bill.id).toBe('bill-1')
  })

  it('gives a server bill a tab back if its tab vanished while the write was in flight', () => {
    const s = billingReducer(ready(), { type: 'billLoaded', tabId: 99, detail: billB })
    expect(s.tabs.map((t) => t.bill?.bill.id ?? null)).toEqual([null, 'bill-2'])
  })

  it('decides PEAK mode from the current tab only', () => {
    let s = withBill(ready(), billA)
    s = { ...s, context: { ...context(), peakSession: PEAK } }
    expect(screenMode(s)).toBe('NORMAL')
    // A held NORMAL bill in another tab doesn't keep an empty current tab out of peak.
    s = { ...billingReducer({ ...s, context: context() }, { type: 'tabOpened' }), context: { ...context(), peakSession: PEAK } }
    expect(screenMode(s)).toBe('PEAK')
    expect(screenMode(billingReducer(s, { type: 'tabSwitched', tabId: 1 }))).toBe('NORMAL')
  })
})

describe('stockLeft', () => {
  it('shows the bottles left after a sale, and flags the last one', () => {
    expect(stockLeft(58, 1)).toBe('57 left')
    expect(stockLeft(3, 3)).toBe('last in stock')
    expect(stockLeft(1, 2)).toBe('last in stock')
  })
})

describe('cancelPlan', () => {
  it('takes bottles off a row from its newest lines first, never past what is left', () => {
    const a1 = line({ skuId: 'a', quantity: 2, lineNo: 1 })
    const b1 = line({ skuId: 'b', quantity: 1, lineNo: 2 })
    const a2 = line({ skuId: 'a', quantity: 1, lineNo: 3 })
    const a3 = line({ skuId: 'a', quantity: 3, lineNo: 4, remainingQuantity: 1 }) // 2 already cancelled
    const key = `a:${a1.unitPricePaise}`
    expect(cancelPlan([a1, b1, a2, a3], key, 1)).toEqual([{ itemId: a3.id, quantity: 1 }])
    expect(cancelPlan([a1, b1, a2, a3], key, 3)).toEqual([
      { itemId: a3.id, quantity: 1 },
      { itemId: a2.id, quantity: 1 },
      { itemId: a1.id, quantity: 1 },
    ])
    expect(cancelPlan([a1, b1, a2, a3], key, 9)).toHaveLength(3)
    expect(cancelPlan([a1, b1, a2, a3], key, 0)).toEqual([])
  })

  it('keeps rows at different prices apart', () => {
    const old = line({ skuId: 'a', quantity: 1, unitPricePaise: 20000n })
    const now = line({ skuId: 'a', quantity: 1, unitPricePaise: 22000n })
    expect(cancelPlan([old, now], 'a:20000', 1)).toEqual([{ itemId: old.id, quantity: 1 }])
  })
})
