import { describe, expect, it } from 'vitest'
import type { BillDetail, BillDetailItem } from '../api/types'
import { groupItems, type Receipt } from '../billing/billingReducer'
import { detail, line, waiter, withWaiter } from '../billing/testData'
import {
  captainOrdersReducer,
  editBlock,
  formatAge,
  initialCaptainOrdersState,
  selectedOrder,
  type CaptainOrdersAction,
  type CaptainOrdersState,
} from './captainOrdersReducer'

function order(id: string, billNo: number, items: BillDetailItem[] = [line({ skuId: 'a' })], over: Partial<BillDetail> = {}): BillDetail {
  const d = withWaiter(detail(items, over), waiter())
  return { ...d, bill: { ...d.bill, id, billNo, source: 'WAITER_APP', captainDeviceId: 'handset-01' } }
}

const run = (state: CaptainOrdersState, ...actions: CaptainOrdersAction[]) => actions.reduce(captainOrdersReducer, state)
const loaded = (orders: BillDetail[], at = 1000): CaptainOrdersAction => ({ type: 'ordersLoaded', orders, at })
const keys = (d: BillDetail) => groupItems(d.items).map((r) => r.key)

describe('captainOrdersReducer: refreshes', () => {
  it('selects the oldest order on the first load and marks nothing as new', () => {
    const s = run(initialCaptainOrdersState, loaded([order('o1', 14), order('o2', 17)]))
    expect(s).toMatchObject({ load: 'ready', selectedId: 'o1', lastUpdated: 1000 })
    expect(s.freshIds.size).toBe(0)
    expect(selectedOrder(s)?.bill.billNo).toBe(14)
  })

  it('marks only orders not seen before as new, and keeps the selection by bill id', () => {
    const s1 = run(initialCaptainOrdersState, loaded([order('o1', 14), order('o2', 17)]), { type: 'select', id: 'o2' })
    const s2 = run(s1, loaded([order('o2', 17), order('o3', 18)], 6000))
    expect(s2.selectedId).toBe('o2')
    expect([...s2.freshIds]).toEqual(['o3'])
    expect(s2.lastUpdated).toBe(6000)

    const s3 = run(s2, loaded([order('o2', 17), order('o3', 18)], 11000))
    expect(s3.freshIds.size).toBe(0)
  })

  it('moves a vanished selection to the order that took its place, with a note', () => {
    const s1 = run(initialCaptainOrdersState, loaded([order('o1', 14), order('o2', 17), order('o3', 18)]), { type: 'select', id: 'o2' })
    const s2 = run(s1, loaded([order('o1', 14), order('o3', 18)]))
    expect(s2.selectedId).toBe('o3')
    expect(s2.flash).toMatchObject({ kind: 'error', text: expect.stringContaining('#17') })

    const s3 = run(s2, loaded([order('o1', 14)]))
    expect(s3.selectedId).toBe('o1')
    const s4 = run(s3, loaded([]))
    expect(s4.selectedId).toBeNull()
  })

  it('keeps the selected line across refreshes, and starts at the first line of a newly selected order', () => {
    const items = [line({ skuId: 'a' }), line({ skuId: 'b' }), line({ skuId: 'c' })]
    const o1 = order('o1', 14, items)
    const s1 = run(initialCaptainOrdersState, loaded([o1, order('o2', 17, [line({ skuId: 'b' })])]))
    expect(s1.selectedKey).toBe(keys(o1)[0])

    const s2 = run(s1, { type: 'focus', pane: 'detail' }, { type: 'move', delta: 1 }, { type: 'move', delta: 1 })
    expect(s2.selectedKey).toBe(keys(o1)[2])
    expect(run(s2, loaded([o1, order('o2', 17)])).selectedKey).toBe(keys(o1)[2])

    const s3 = run(s2, { type: 'select', id: 'o2' })
    expect(s3.selectedKey).toBe(keys(selectedOrder(s3)!)[0])
  })

  it('goes offline on a failed refresh and keeps the last list', () => {
    const s1 = run(initialCaptainOrdersState, loaded([order('o1', 14)]))
    const s2 = run(s1, { type: 'ordersFailed', message: 'down' })
    expect(s2).toMatchObject({ load: 'offline', offlineMessage: 'down', selectedId: 'o1' })
    expect(s2.orders).toHaveLength(1)
    expect(run(s2, loaded([order('o1', 14)])).load).toBe('ready')
  })
})

describe('captainOrdersReducer: edits and settlement', () => {
  it('replaces an edited order and moves the line selection when its row empties', () => {
    const a = line({ skuId: 'a' })
    const b = line({ skuId: 'b' })
    const o1 = order('o1', 14, [a, b])
    const s1 = run(initialCaptainOrdersState, loaded([o1]), { type: 'focus', pane: 'detail' }, { type: 'move', delta: 1 })
    expect(s1.selectedKey).toBe(keys(o1)[1])

    const cancelled = order('o1', 14, [a, { ...b, remainingQuantity: 0 }, line({ skuId: 'b', quantity: -1, reversesItemId: b.id })])
    const s2 = run(s1, { type: 'orderUpdated', detail: cancelled })
    expect(selectedOrder(s2)?.bill.totalPaise).toBe(cancelled.bill.totalPaise)
    expect(s2.selectedKey).toBe(keys(o1)[0])
  })

  it('drops an updated order that is no longer open', () => {
    const o1 = order('o1', 14)
    const s1 = run(initialCaptainOrdersState, loaded([o1, order('o2', 17)]))
    const settled = { ...o1, bill: { ...o1.bill, status: 'SETTLED' as const } }
    const s2 = run(s1, { type: 'orderUpdated', detail: settled })
    expect(s2.orders.map((o) => o.bill.id)).toEqual(['o2'])
    expect(s2.selectedId).toBe('o2')
  })

  it('removes a settled order, selects the next one, shows the receipt and closes the dialog', () => {
    const receipt: Receipt = { billNo: 14, totalPaise: 22000n, changePaise: 3000n, summary: 'Cash via Suresh' }
    const s1 = run(initialCaptainOrdersState, loaded([order('o1', 14), order('o2', 17)]), { type: 'dialog', dialog: 'payment' })
    const s2 = run(s1, { type: 'orderGone', billId: 'o1', receipt })
    expect(s2).toMatchObject({ selectedId: 'o2', receipt, dialog: null })
    expect(s2.orders).toHaveLength(1)

    // The receipt stays up until the cashier picks another order.
    expect(run(s2, { type: 'select', id: 'o2' }).receipt).toBeNull()
  })

  it('moves through orders or lines depending on the focused pane, clamped at the ends', () => {
    const o1 = order('o1', 14, [line({ skuId: 'a' }), line({ skuId: 'b' })])
    let s = run(initialCaptainOrdersState, loaded([o1, order('o2', 17), order('o3', 18)]))
    s = run(s, { type: 'move', delta: -1 })
    expect(s.selectedId).toBe('o1')
    s = run(s, { type: 'move', delta: 1 }, { type: 'move', delta: 1 }, { type: 'move', delta: 1 })
    expect(s.selectedId).toBe('o3')

    s = run(s, { type: 'select', id: 'o1' }, { type: 'focus', pane: 'detail' }, { type: 'move', delta: 1 }, { type: 'move', delta: 1 })
    expect(s.selectedId).toBe('o1')
    expect(s.selectedKey).toBe(keys(o1)[1])
  })

  it('focuses the detail pane when a line is clicked', () => {
    const o1 = order('o1', 14, [line({ skuId: 'a' }), line({ skuId: 'b' })])
    const s = run(initialCaptainOrdersState, loaded([o1]), { type: 'selectLine', key: keys(o1)[1]! })
    expect(s).toMatchObject({ focus: 'detail', selectedKey: keys(o1)[1] })
  })
})

describe('selectors', () => {
  it('blocks line edits once a part-payment is recorded', () => {
    expect(editBlock(order('o1', 14))).toBeNull()
    expect(editBlock(order('o1', 14, [line({ skuId: 'a' })], { tenderedPaise: 5000n }))).toMatch(/part-payment/)
  })

  it('formats the age of an order', () => {
    const placed = '2026-10-15T10:00:00.000Z'
    const at = (minutes: number, seconds = 0) => Date.parse(placed) + (minutes * 60 + seconds) * 1000
    expect(formatAge(placed, at(0, 30))).toBe('new')
    expect(formatAge(placed, at(1))).toBe('1 min')
    expect(formatAge(placed, at(59, 59))).toBe('59 min')
    expect(formatAge(placed, at(65))).toBe('1 h 05 min')
    expect(formatAge(placed, at(-1))).toBe('new')
  })
})
