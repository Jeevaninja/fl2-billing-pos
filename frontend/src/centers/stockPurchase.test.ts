import { describe, expect, it } from 'vitest'
import type { SkuLookup } from '../api/types'
import { unitLabel } from '../lib/ui'
import {
  countText,
  entryCount,
  entryError,
  newStockForm,
  perPackPaise,
  pick,
  pickFromResults,
  removeStockLine,
  setCost,
  setCount,
  setQuery,
  setResults,
  stageLine,
  stockFormError,
  stockPayload,
  stockTotals,
  type StockPurchaseForm,
} from './stockPurchase'

function sku(over: Partial<SkuLookup> = {}): SkuLookup {
  return {
    id: 'sku-gf',
    skuCode: 'GOFL-U',
    barcode: '8901725000001',
    displayName: 'Gold Flake — Unit',
    sizeCode: 'UNIT',
    pricePaise: 18_00n,
    purchasePricePaise: 15_00n,
    caseSize: 10,
    purchaseUnitName: 'Packet',
    saleUnitName: 'Stick',
    onHandQty: 0,
    isActive: true,
    department: 'CIGARETTES',
    departmentName: 'Cigarettes',
    tracksStock: true,
    itemCategory: { id: 'c-oth', name: 'OTHERS' },
    ...over,
  }
}

const GOLD = sku()
const COKE = sku({ id: 'sku-coke', skuCode: 'COCA-U', barcode: null, displayName: 'Coca-Cola 300ml', caseSize: 24, purchaseUnitName: 'Case', saleUnitName: 'Bottle', department: 'COOL_DRINKS', purchasePricePaise: null })

/** Picks `item`, types the counts and cost, and stages the line. */
function staged(form: StockPurchaseForm, item: SkuLookup, cases: string, loose: string, cost?: string): StockPurchaseForm {
  let next = setCount(setCount(pick(form, item), 'cases', cases), 'loose', loose)
  if (cost !== undefined) next = setCost(next, cost)
  const result = stageLine(next)
  if (typeof result === 'string') throw new Error(result)
  return result
}

describe('stock purchase: bulk-to-unit math', () => {
  it('turns 2 packets of 10 into exactly 20 sticks, costed per stick', () => {
    const form = staged(newStockForm(false, 'CIGARETTES'), GOLD, '2', '')
    expect(form.lines).toEqual([{ sku: GOLD, cases: 2, looseUnits: 0, caseSize: 10, quantity: 20, unitCostPaise: 15_00n }])
    expect(stockTotals(form.lines)).toEqual({ lineCount: 1, units: 20, totalPaise: 300_00n })
    expect(perPackPaise(10, 15_00n)).toBe(150_00n)
    expect(countText(form.lines[0]!, GOLD)).toBe('2 Packets × 10 = 20 Sticks')
    expect(stockPayload(form)).toEqual({
      department: 'CIGARETTES',
      invoiceNo: null,
      vendorName: null,
      paidFrom: 'DRAWER',
      lines: [{ skuId: GOLD.id, cases: 2, looseUnits: 0, caseSize: 10, unitCost: 15_00n }],
    })
  })

  it('adds loose units on top of whole cases (2 × 24 + 6 = 54) and merges a repeat with carry', () => {
    let form = newStockForm(false, 'COOL_DRINKS')
    form = staged(form, COKE, '2', '6', '15')
    expect(form.lines[0]).toMatchObject({ cases: 2, looseUnits: 6, quantity: 54 })
    expect(countText(form.lines[0]!, COKE)).toBe('2 Cases × 24 + 6 = 54 Bottles')
    // 6 + 20 loose = 26 → one more case and 2 loose.
    form = staged(form, COKE, '', '20', '15')
    expect(form.lines).toHaveLength(1)
    expect(form.lines[0]).toMatchObject({ cases: 3, looseUnits: 2, quantity: 74 })
    expect(countText({ cases: 0, looseUnits: 5, caseSize: 10 }, GOLD)).toBe('5 Sticks')
    expect(countText({ cases: 1, looseUnits: 0, caseSize: 10 }, GOLD)).toBe('1 Packet × 10 = 10 Sticks')
  })

  it('refuses an empty line, a full case of loose units, a missing cost and a different cost for the same item', () => {
    const picked = pick(newStockForm(false, 'COOL_DRINKS'), COKE)
    expect(picked.cost).toBe('')
    expect(entryError(picked)).toBe('Enter cases and / or loose bottles')
    expect(entryError(setCount(setCount(picked, 'cases', '0'), 'loose', '0'))).toBe('Enter at least one case or bottle')
    expect(entryError(setCount(picked, 'loose', '24'))).toBe('24 loose is a full case of 24 — add it to Cases')
    expect(entryError(setCount(picked, 'cases', '1'))).toBe('Enter the cost per bottle (0 for free)')
    expect(entryError(setCost(setCount(picked, 'cases', '1'), '0'))).toBeNull()
    expect(entryCount(setCount(picked, 'cases', '3x'))).toEqual({ cases: 3, loose: 0, total: 72 })

    const once = staged(newStockForm(false, 'COOL_DRINKS'), COKE, '1', '', '15')
    expect(stageLine(setCost(setCount(pick(once, COKE), 'cases', '1'), '16'))).toMatch(/already on this purchase at a different cost/)
  })

  it('pre-fills the catalog cost, keeps only the center’s active items, and picks a scan', () => {
    const form = setQuery(newStockForm(false, 'CIGARETTES'), 'gold')
    const inactive = sku({ id: 'x', isActive: false })
    const otherCenter = sku({ id: 'y', department: 'COOL_DRINKS' })
    const withResults = setResults(form, 'gold', [GOLD, inactive, otherCenter])
    expect(withResults.results.map((s) => s.id)).toEqual([GOLD.id])
    expect(setResults(form, 'old query', [GOLD]).results).toEqual([])
    expect(pick(form, GOLD).cost).toBe('15')
    expect(pickFromResults({ ...setQuery(form, '8901725000001'), results: [COKE, GOLD] })).toBe(GOLD)
  })

  it('saves only with lines and no half-entered item; a running peak forbids the drawer', () => {
    const empty = newStockForm(true, 'CIGARETTES')
    expect(empty.paidFrom).toBe('OUTSIDE')
    expect(stockFormError(empty, true)).toBe('Add at least one item')
    const form = staged(empty, GOLD, '1', '')
    expect(stockFormError(form, true)).toBeNull()
    expect(stockFormError({ ...form, paidFrom: 'DRAWER' }, true)).toMatch(/peak is running/)
    expect(stockFormError(pick(form, GOLD), false)).toMatch(/Add the entered item/)
    expect(stockPayload({ ...form, invoiceNo: ' RA/1 ', vendor: ' Ravi  Agencies ' })).toMatchObject({ invoiceNo: 'RA/1', vendorName: 'Ravi Agencies' })
    expect(removeStockLine(form, GOLD.id).lines).toEqual([])
  })

  it('pluralises unit labels lightly', () => {
    expect([unitLabel('Case', 1), unitLabel('Case', 2), unitLabel('Box', 3), unitLabel('Pouch', 2), unitLabel('Pcs', 4)]).toEqual(['Case', 'Cases', 'Boxes', 'Pouches', 'Pcs'])
  })
})
