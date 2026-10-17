import { describe, expect, it } from 'vitest'
import type { SkuLookup, StockReceipt } from '../api/types'
import {
  countLabel,
  entryCount,
  initialPurchaseState,
  lineError,
  mergeCounts,
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
    purchasePricePaise: null,
    caseSize: 12,
    onHandQty: 48,
    isActive: true,
    ...over,
  }
}
const HALF = sku({ id: 'sku-h', skuCode: 'HWHS-H', barcode: '8900000000002', displayName: 'House Whisky — Half', sizeCode: 'HALF', caseSize: 32 })
/** A 180ml quarter packed 64 to a case, with a catalog purchase price of ₹210. */
const QUARTER = sku({
  id: 'sku-q',
  skuCode: 'HWHS-Q',
  barcode: '8900000000003',
  displayName: 'House Whisky — Quarter',
  sizeCode: 'QUARTER',
  caseSize: 64,
  purchasePricePaise: 210_00n,
})

const ready = run(initialPurchaseState, { type: 'loaded', receipts: [] })

/** Picks `s`, types loose bottles (and optionally cases) and cost, and stages the line. */
function stage(state: PurchaseState, s: SkuLookup, loose: string, cost: string, cases = ''): PurchaseState {
  return run(
    state,
    { type: 'pick', sku: s },
    { type: 'cases', text: cases },
    { type: 'loose', text: loose },
    { type: 'cost', text: cost },
    { type: 'addLine' },
  )
}

describe('case + loose entry', () => {
  it('2 cases + 3 loose of a 64-bottle quarter case is 131 bottles', () => {
    const state = run(ready, { type: 'pick', sku: QUARTER }, { type: 'cases', text: '2' }, { type: 'loose', text: '3' })
    expect(entryCount(state)).toEqual({ cases: 2, loose: 3, total: 131 })
    const staged = run(state, { type: 'addLine' })
    expect(staged.lines).toEqual([{ sku: QUARTER, cases: 2, looseBottles: 3, caseSize: 64, quantity: 131, unitCostPaise: 210_00n }])
  })

  it('treats an empty field as 0: cases only, or loose only', () => {
    expect(entryCount(run(ready, { type: 'pick', sku: QUARTER }, { type: 'cases', text: '3' }))).toEqual({ cases: 3, loose: 0, total: 192 })
    expect(entryCount(run(ready, { type: 'pick', sku: QUARTER }, { type: 'loose', text: '7' }))).toEqual({ cases: 0, loose: 7, total: 7 })
    expect(entryCount(ready)).toBeNull()
  })

  it('pre-fills the unit cost from the catalog, and the operator can override it', () => {
    const picked = run(ready, { type: 'pick', sku: QUARTER })
    expect(picked.cost).toBe('210')
    expect(run(ready, { type: 'pick', sku: sku({ purchasePricePaise: 1_100_50n }) }).cost).toBe('1100.50')
    expect(run(ready, { type: 'pick', sku: sku() }).cost).toBe('')

    const overridden = run(picked, { type: 'cases', text: '1' }, { type: 'cost', text: '205.25' }, { type: 'addLine' })
    expect(overridden.lines[0]).toMatchObject({ quantity: 64, unitCostPaise: 205_25n })
  })

  it('needs a SKU, a count of 1–100,000 with loose under a case, and a unit cost (₹0 allowed)', () => {
    expect(lineError(ready)).toBe('Pick a SKU')
    const picked = run(ready, { type: 'pick', sku: sku() })
    expect(lineError(picked)).toBe('Enter cases and / or loose bottles')
    expect(lineError(run(picked, { type: 'cases', text: '0' }, { type: 'loose', text: '0' }))).toBe('Enter at least one case or bottle')
    expect(lineError(run(picked, { type: 'loose', text: '12' }))).toBe('12 loose is a full case of 12 — add it to Cases')
    expect(lineError(run(picked, { type: 'cases', text: '8334' }))).toBe('A line can have at most 100,000 bottles')
    const counted = run(picked, { type: 'loose', text: '11' })
    expect(lineError(counted)).toBe('Enter the unit cost (0 for free bottles)')
    expect(lineError(run(counted, { type: 'cost', text: '1.234' }))).toBe('Enter rupees, e.g. 1100 or 1,100.50')
    expect(lineError(run(counted, { type: 'cost', text: '0' }))).toBeNull()
    expect(lineError(run(counted, { type: 'cost', text: '1,100.50' }))).toBeNull()
  })

  it('keeps only digits in the cases and loose fields', () => {
    expect(run(ready, { type: 'cases', text: '1.5x2' }).cases).toBe('152')
    expect(run(ready, { type: 'loose', text: '-3' }).loose).toBe('3')
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
    const state = stage(ready, sku(), '0', '1100', '1')
    expect(state.lines).toEqual([{ sku: sku(), cases: 1, looseBottles: 0, caseSize: 12, quantity: 12, unitCostPaise: 1_100_00n }])
    expect(state).toMatchObject({ picked: null, query: '', cases: '', loose: '', cost: '' })
    const two = stage(state, HALF, '24', '560.50')
    expect(stagedTotals(two.lines)).toEqual({ lineCount: 2, bottles: 36, totalPaise: 12n * 1_100_00n + 24n * 560_50n })
  })

  it('merges a re-added SKU at the same cost, carrying loose bottles into cases, and refuses a different cost', () => {
    let state = stage(ready, QUARTER, '40', '210')
    state = stage(state, QUARTER, '40', '210.00', '1')
    expect(state.lines).toEqual([{ sku: QUARTER, cases: 2, looseBottles: 16, caseSize: 64, quantity: 144, unitCostPaise: 210_00n }])
    state = stage(ready, sku(), '6', '1100')
    state = stage(state, sku(), '6', '1,100.00')
    expect(state.lines).toEqual([{ sku: sku(), cases: 1, looseBottles: 0, caseSize: 12, quantity: 12, unitCostPaise: 1_100_00n }])

    const refused = stage(state, sku(), '1', '1000')
    expect(refused.lines).toEqual(state.lines)
    expect(refused.flash).toMatchObject({ kind: 'error', text: 'House Whisky — Full is already on this invoice at ₹1,100.00 — remove it first' })
    expect(refused.picked).toEqual(sku())
  })

  it('refuses a merge that would exceed the per-line cap', () => {
    const state = stage(stage(ready, sku(), '3', '0', '8333'), sku(), '2', '0')
    expect(state.lines[0]?.quantity).toBe(99999)
    expect(state.flash?.kind).toBe('error')
  })

  it('refuses a merge when the case size changed between picks', () => {
    const state = stage(stage(ready, sku(), '1', '0'), sku({ caseSize: 6 }), '1', '0')
    expect(state.lines).toHaveLength(1)
    expect(state.flash?.text).toMatch(/case size changed to 6/)
  })

  it('does not stage an invalid line', () => {
    const state = stage(ready, sku(), '', '1100')
    expect(state.lines).toEqual([])
    expect(state.flash).toMatchObject({ kind: 'error', text: 'Enter cases and / or loose bottles' })
  })

  it('labels counts and merges them with carry', () => {
    expect(countLabel({ cases: 2, looseBottles: 3 })).toBe('2 cs + 3')
    expect(countLabel({ cases: 2, looseBottles: 0 })).toBe('2 cs')
    expect(countLabel({ cases: 0, looseBottles: 5 })).toBe('5')
    expect(mergeCounts({ cases: 1, looseBottles: 63 }, { cases: 0, looseBottles: 65 }, 64)).toEqual({ cases: 3, looseBottles: 0 })
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
    const full = stage(withInvoice, QUARTER, '3', '0', '2')
    expect(submitError(full)).toBeNull()
    expect(submitPayload(full)).toEqual({
      invoiceNo: 'INV-1',
      vendorName: null,
      lines: [{ skuId: 'sku-q', cases: 2, looseBottles: 3, caseSize: 64, unitCost: 0n }],
    })
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
