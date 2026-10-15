import { describe, expect, it } from 'vitest'
import type { SkuLookup, StockReceipt } from '../api/types'
import {
  initialPurchaseState,
  lineError,
  pickFromSearch,
  purchaseReducer,
  stagedTotals,
  submitError,
  submitPayload,
  type PurchaseAction,
  type PurchaseState,
} from './purchaseReducer'

const run = (state: PurchaseState, ...actions: PurchaseAction[]) => actions.reduce(purchaseReducer, state)

function sku(over: Partial<SkuLookup> = {}): SkuLookup {
  return {
    id: 'sku-f',
    skuCode: 'HWHS-F',
    barcode: '8900000000001',
    displayName: 'House Whisky — Full',
    sizeCode: 'FULL',
    pricePaise: 1_800_00n,
    onHandQty: 48,
    isActive: true,
    ...over,
  }
}
const HALF = sku({ id: 'sku-h', skuCode: 'HWHS-H', barcode: '8900000000002', displayName: 'House Whisky — Half', sizeCode: 'HALF' })

const ready = run(initialPurchaseState, { type: 'loaded', receipts: [] })

/** Picks `s`, types qty and cost, and stages the line. */
function stage(state: PurchaseState, s: SkuLookup, qty: string, cost: string): PurchaseState {
  return run(state, { type: 'pick', sku: s }, { type: 'qty', text: qty }, { type: 'cost', text: cost }, { type: 'addLine' })
}

describe('line entry', () => {
  it('needs a SKU, a whole quantity of 1–100,000 and a unit cost (₹0 allowed)', () => {
    expect(lineError(ready)).toBe('Pick a SKU')
    const picked = run(ready, { type: 'pick', sku: sku() })
    expect(lineError(picked)).toBe('Enter the quantity received')
    expect(lineError(run(picked, { type: 'qty', text: '0' }))).toBe('Quantity must be 1 to 100,000 bottles')
    expect(lineError(run(picked, { type: 'qty', text: '100001' }))).toBe('Quantity must be 1 to 100,000 bottles')
    const withQty = run(picked, { type: 'qty', text: '12' })
    expect(lineError(withQty)).toBe('Enter the unit cost (0 for free bottles)')
    expect(lineError(run(withQty, { type: 'cost', text: '1.234' }))).toBe('Enter rupees, e.g. 1100 or 1,100.50')
    expect(lineError(run(withQty, { type: 'cost', text: '0' }))).toBeNull()
    expect(lineError(run(withQty, { type: 'cost', text: '1,100.50' }))).toBeNull()
  })

  it('keeps only digits in the quantity field', () => {
    expect(run(ready, { type: 'qty', text: '1.5x2' }).qty).toBe('152')
  })

  it('refuses an inactive SKU', () => {
    const state = run(ready, { type: 'pick', sku: sku({ isActive: false }) })
    expect(state.picked).toBeNull()
    expect(state.flash).toMatchObject({ kind: 'error', text: 'House Whisky — Full is inactive and cannot be received' })
  })

  it('a new search clears the picked SKU and stale results are ignored', () => {
    let state = run(ready, { type: 'query', text: 'house' }, { type: 'results', query: 'house', results: [sku(), HALF] })
    expect(state.results).toHaveLength(2)
    state = run(state, { type: 'results', query: 'hou', results: [] })
    expect(state.results).toHaveLength(2)
    state = run(state, { type: 'pick', sku: HALF })
    expect(state).toMatchObject({ picked: HALF, query: 'House Whisky — Half', results: [] })
    state = run(state, { type: 'query', text: 'rum' })
    expect(state.picked).toBeNull()
  })

  it('moves the highlight within the results, clamped', () => {
    let state = run(ready, { type: 'query', text: 'house' }, { type: 'results', query: 'house', results: [sku(), HALF] })
    expect(state.highlighted).toBe(0)
    state = run(state, { type: 'highlight', delta: 1 }, { type: 'highlight', delta: 1 })
    expect(state.highlighted).toBe(1)
    state = run(state, { type: 'highlight', delta: -5 })
    expect(state.highlighted).toBe(0)
  })
})

describe('pickFromSearch (Enter in the SKU field)', () => {
  it('takes an exact barcode or SKU code match, else the only result, else the highlighted one', () => {
    expect(pickFromSearch('8900000000002', [sku(), HALF], 0)).toBe(HALF)
    expect(pickFromSearch('hwhs-h', [sku(), HALF], 0)).toBe(HALF)
    expect(pickFromSearch('half', [HALF], 0)).toBe(HALF)
    expect(pickFromSearch('house', [sku(), HALF], 1)).toBe(HALF)
    expect(pickFromSearch('house', [], 0)).toBeNull()
  })
})

describe('staging', () => {
  it('adds a line, resets the entry fields and totals in bigint paise', () => {
    const state = stage(ready, sku(), '12', '1100')
    expect(state.lines).toEqual([{ sku: sku(), quantity: 12, unitCostPaise: 1_100_00n }])
    expect(state).toMatchObject({ picked: null, query: '', qty: '', cost: '' })
    const two = stage(state, HALF, '24', '560.50')
    expect(stagedTotals(two.lines)).toEqual({ lineCount: 2, bottles: 36, totalPaise: 12n * 1_100_00n + 24n * 560_50n })
  })

  it('merges a re-added SKU at the same cost, and refuses it at a different cost', () => {
    let state = stage(ready, sku(), '12', '1100')
    state = stage(state, sku(), '6', '1,100.00')
    expect(state.lines).toEqual([{ sku: sku(), quantity: 18, unitCostPaise: 1_100_00n }])

    const refused = stage(state, sku(), '1', '1000')
    expect(refused.lines).toEqual(state.lines)
    expect(refused.flash).toMatchObject({ kind: 'error', text: 'House Whisky — Full is already on this invoice at ₹1,100.00 — remove it first' })
    expect(refused.picked).toEqual(sku())
  })

  it('refuses a merge that would exceed the per-line cap', () => {
    const state = stage(stage(ready, sku(), '99999', '0'), sku(), '2', '0')
    expect(state.lines[0]?.quantity).toBe(99999)
    expect(state.flash?.kind).toBe('error')
  })

  it('does not stage an invalid line', () => {
    const state = stage(ready, sku(), '', '1100')
    expect(state.lines).toEqual([])
    expect(state.flash).toMatchObject({ kind: 'error', text: 'Enter the quantity received' })
  })

  it('removes a line and keeps the selection in range', () => {
    let state = stage(stage(ready, sku(), '1', '1'), HALF, '2', '2')
    state = run(state, { type: 'selectLine', index: 1 }, { type: 'removeLine', index: 1 })
    expect(state.lines.map((l) => l.sku.id)).toEqual(['sku-f'])
    expect(state.selectedLine).toBe(0)
    state = run(state, { type: 'removeLine', index: 0 })
    expect(state.selectedLine).toBeNull()
  })
})

describe('submit', () => {
  it('needs an invoice number and at least one line', () => {
    expect(submitError(ready)).toBe('Enter the invoice number')
    const withInvoice = run(ready, { type: 'invoiceNo', text: ' INV-1 ' })
    expect(submitError(withInvoice)).toBe('Add at least one line')
    const full = stage(withInvoice, sku(), '10', '0')
    expect(submitError(full)).toBeNull()
    expect(submitPayload(full)).toEqual({ invoiceNo: 'INV-1', vendorName: null, lines: [{ skuId: 'sku-f', quantity: 10, unitCost: 0n }] })
    expect(submitPayload(run(full, { type: 'vendorName', text: '  Sri Balaji ' }))?.vendorName).toBe('Sri Balaji')
  })

  it('confirm → posted clears the invoice; a duplicate keeps the lines and flags the invoice', () => {
    const filled = stage(run(ready, { type: 'invoiceNo', text: 'INV-1' }, { type: 'vendorName', text: 'Depot' }), sku(), '10', '0')
    const confirming = run(filled, { type: 'confirm', on: true }, { type: 'submitting', on: true })
    expect(confirming).toMatchObject({ confirming: true, submitting: true })

    const posted = run(confirming, { type: 'posted' })
    expect(posted).toMatchObject({ invoiceNo: '', vendorName: '', lines: [], confirming: false, submitting: false, invoiceError: false })

    const duplicate = run(confirming, { type: 'duplicate' })
    expect(duplicate).toMatchObject({ invoiceNo: 'INV-1', confirming: false, submitting: false, invoiceError: true })
    expect(duplicate.lines).toHaveLength(1)
    expect(run(duplicate, { type: 'invoiceNo', text: 'INV-2' }).invoiceError).toBe(false)
  })

  it('will not open the confirm dialog while the invoice is incomplete', () => {
    expect(run(ready, { type: 'confirm', on: true }).confirming).toBe(false)
  })
})

describe('load', () => {
  it("stores the day's receipts and survives a poll without touching the form", () => {
    const receipt: StockReceipt = {
      id: 'r-1',
      businessDayId: 'day-1',
      invoiceNo: 'INV-1',
      vendorName: null,
      receivedByStaffId: 'st-1',
      receivedBy: 'Counter 1',
      createdAt: '2026-10-15T08:30:00.000Z',
      lineCount: 1,
      bottles: 10,
      totalCostPaise: 0n,
    }
    const filled = stage(run(ready, { type: 'invoiceNo', text: 'INV-2' }), sku(), '1', '1')
    const polled = run(filled, { type: 'loaded', receipts: [receipt] })
    expect(polled.receipts).toEqual([receipt])
    expect(polled.lines).toEqual(filled.lines)
    expect(run(polled, { type: 'noDay' })).toMatchObject({ load: 'noDay', receipts: [] })
  })

  it('goes offline before the first load, but keeps the form once it is up', () => {
    expect(run(initialPurchaseState, { type: 'failed', message: 'down' }).load).toBe('offline')
    const filled = stage(ready, sku(), '1', '1')
    const failed = run(filled, { type: 'failed', message: 'down' })
    expect(failed).toMatchObject({ load: 'ready', flash: { kind: 'error', text: 'down' } })
    expect(failed.lines).toEqual(filled.lines)
  })
})
