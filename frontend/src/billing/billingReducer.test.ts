import { describe, expect, it } from 'vitest'
import { billingReducer, groupItems, initialBillingState, screenMode, totals, type BillingState, type PeakEntry } from './billingReducer'
import { context, detail, line, PEAK } from './testData'

const ready = (over: Partial<BillingState> = {}): BillingState => ({
  ...billingReducer(initialBillingState, { type: 'contextLoaded', context: context(), resume: true }),
  ...over,
})

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
  it('loads the context and resumes an open bill only when asked to', () => {
    const open = detail([line({ skuId: 'a' })])
    const resumed = billingReducer(initialBillingState, { type: 'contextLoaded', context: context({ openBill: open }), resume: true })
    expect(resumed).toMatchObject({ load: 'ready', bill: open })
    expect(resumed.context).not.toHaveProperty('openBill')

    const polled = billingReducer({ ...resumed, bill: null }, { type: 'contextLoaded', context: context({ openBill: open }), resume: false })
    expect(polled.bill).toBeNull()
  })

  it('derives the screen mode: BLOCKED without a day, PEAK with a session, NORMAL otherwise', () => {
    expect(screenMode(initialBillingState)).toBe('LOADING')
    expect(screenMode(ready())).toBe('NORMAL')
    expect(screenMode(ready({ context: { ...context(), businessDay: null } }))).toBe('BLOCKED')
    expect(screenMode(ready({ context: { ...context(), peakSession: PEAK } }))).toBe('PEAK')
  })

  it('keeps an open NORMAL bill in NORMAL mode when a peak starts mid-bill', () => {
    const state = ready({ bill: detail([line({ skuId: 'a' })]), context: { ...context(), peakSession: PEAK } })
    expect(screenMode(state)).toBe('NORMAL')
    expect(screenMode(billingReducer(state, { type: 'billFinished', receipt: null }))).toBe('PEAK')
  })

  it('selects the row of the SKU just scanned, and keeps a valid selection otherwise', () => {
    const d = detail([line({ skuId: 'a' }), line({ skuId: 'b' })])
    const s1 = billingReducer(ready(), { type: 'billLoaded', detail: d, focusSkuId: 'a' })
    expect(s1.selectedKey).toBe(groupItems(d.items)[0]?.key)
    const s2 = billingReducer(s1, { type: 'billLoaded', detail: d })
    expect(s2.selectedKey).toBe(s1.selectedKey)
    const s3 = billingReducer({ ...s1, selectedKey: 'gone' }, { type: 'billLoaded', detail: d })
    expect(s3.selectedKey).toBe(groupItems(d.items)[1]?.key)
  })

  it('moves the selection with up/down, clamped to the rows', () => {
    const d = detail([line({ skuId: 'a' }), line({ skuId: 'b' }), line({ skuId: 'c' })])
    const keys = groupItems(d.items).map((r) => r.key)
    let s = billingReducer(ready(), { type: 'billLoaded', detail: d, focusSkuId: 'c' })
    s = billingReducer(s, { type: 'move', delta: -1 })
    expect(s.selectedKey).toBe(keys[1])
    s = billingReducer(billingReducer(s, { type: 'move', delta: -1 }), { type: 'move', delta: -1 })
    expect(s.selectedKey).toBe(keys[0])
    s = billingReducer(s, { type: 'move', delta: 1 })
    expect(s.selectedKey).toBe(keys[1])
  })

  it('applies pending member and waiter to the first bill, then clears them', () => {
    const member = { id: 'm-1', membershipNo: 'M-1', displayName: 'Anil' }
    let s = billingReducer(ready(), { type: 'pendingMember', member })
    expect(s.pendingMember).toEqual(member)
    s = billingReducer(s, { type: 'billLoaded', detail: detail([line({ skuId: 'a' })], { member }) })
    expect(s.pendingMember).toBeNull()
  })

  it('goes idle with a receipt when a bill is finished, closing any dialog', () => {
    const receipt = { billNo: 42, totalPaise: 22000n, changePaise: 3000n, summary: 'Cash' }
    const s = billingReducer(ready({ bill: detail([line({ skuId: 'a' })]), dialog: 'payment' }), { type: 'billFinished', receipt })
    expect(s).toMatchObject({ bill: null, receipt, dialog: null, selectedKey: null })
    // The next bill clears the receipt.
    expect(billingReducer(s, { type: 'billLoaded', detail: detail() }).receipt).toBeNull()
  })

  it('tracks queued scans until they finish', () => {
    let s = billingReducer(ready(), { type: 'scanQueued', scan: { id: 1, code: '890', quantity: 2 } })
    s = billingReducer(s, { type: 'scanQueued', scan: { id: 2, code: 'X', quantity: 1 } })
    s = billingReducer(s, { type: 'scanDone', id: 1 })
    expect(s.pending).toEqual([{ id: 2, code: 'X', quantity: 1 }])
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
