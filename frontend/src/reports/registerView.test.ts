import { describe, expect, it } from 'vitest'
import type { SalesRegisterRow, StockRegisterRow } from '../api/types'
import { filterSales, grandTotals, groupStock, itemsSummary, pageCount, pageOf, paidByLabel, stepReportTab } from './registerView'

const bill = (billNo: number, patch: Partial<SalesRegisterRow> = {}): SalesRegisterRow => ({
  billId: `b${billNo}`,
  businessDate: '2026-10-14',
  billNo,
  createdAt: '2026-10-14T15:00:00.000Z',
  settledAt: null,
  kind: 'SALE',
  reverses: null,
  voidedBy: null,
  mode: 'NORMAL',
  status: 'SETTLED',
  cashPaise: 0n,
  upiPaise: 0n,
  creditPaise: 0n,
  waiterName: null,
  items: [],
  totalPaise: 0n,
  ...patch,
})

const stock = (skuCode: string, categoryName: string, q: Partial<StockRegisterRow> = {}): StockRegisterRow => ({
  skuId: skuCode,
  skuCode,
  name: `${skuCode} item`,
  sizeCode: 'FULL',
  categoryName,
  centerName: 'Liquor',
  isActive: true,
  openingQty: 0,
  inwardQty: 0,
  salesQty: 0,
  otherQty: 0,
  closingQty: 0,
  ...q,
})

describe('reports view helpers', () => {
  it('steps the four tabs in a ring', () => {
    expect(stepReportTab('ledger', 1)).toBe('sales')
    expect(stepReportTab('ledger', -1)).toBe('payments')
    expect(stepReportTab('payments', 1)).toBe('ledger')
  })

  it('summarises items and the tenders', () => {
    expect(itemsSummary([{ name: '1848 — Quarter', sizeCode: 'QUARTER', qty: 2, lineTotalPaise: 1200_00n }, { name: 'Chicken 65', sizeCode: 'UNIT', qty: 1, lineTotalPaise: 180_00n }])).toBe(
      '2× 1848 — Quarter, 1× Chicken 65',
    )
    expect(itemsSummary([{ name: 'Rum', sizeCode: 'FULL', qty: -1, lineTotalPaise: -2200_00n }])).toBe('−1× Rum')
    expect(itemsSummary([])).toBe('— (empty bill)')
    expect(paidByLabel(bill(1, { mode: 'PEAK' }))).toBe('Peak')
    expect(paidByLabel(bill(1, { cashPaise: 1n, upiPaise: 2n }))).toBe('Cash + UPI')
    expect(paidByLabel(bill(1, { creditPaise: 5n }))).toBe('Waiter credit')
    expect(paidByLabel(bill(1))).toBe('—')
  })

  it('searches by bill number or by item / waiter, and pages', () => {
    const rows = [
      bill(1, { items: [{ name: 'Gold Flake', sizeCode: 'UNIT', qty: 1, lineTotalPaise: 20_00n }] }),
      bill(12, { waiterName: 'Ravi' }),
      bill(2),
    ]
    expect(filterSales(rows, '12').map((r) => r.billNo)).toEqual([12])
    expect(filterSales(rows, '#1').map((r) => r.billNo)).toEqual([1])
    expect(filterSales(rows, 'gold').map((r) => r.billNo)).toEqual([1])
    expect(filterSales(rows, 'ravi').map((r) => r.billNo)).toEqual([12])
    expect(filterSales(rows, '  ')).toHaveLength(3)
    const many = Array.from({ length: 450 }, (_, i) => i)
    expect(pageCount(450)).toBe(3)
    expect(pageCount(0)).toBe(1)
    expect(pageOf(many, 2)).toEqual(many.slice(400))
    expect(pageOf(many, 9)).toEqual(many.slice(400)) // clamped
  })

  it('groups stock by category in server order, totals each, and hides idle items', () => {
    const rows = [
      stock('A', 'FULL', { openingQty: 10, salesQty: 2, closingQty: 8 }),
      stock('B', 'FULL'),
      stock('C', 'BEER', { inwardQty: 24, closingQty: 24 }),
    ]
    const shown = groupStock(rows, { hideIdle: true })
    expect(shown.map((g) => [g.categoryName, g.rows.map((r) => r.skuCode)])).toEqual([
      ['FULL', ['A']],
      ['BEER', ['C']],
    ])
    expect(shown[0]!.totals).toEqual({ openingQty: 10, inwardQty: 0, salesQty: 2, otherQty: 0, closingQty: 8 })
    expect(grandTotals(shown)).toEqual({ openingQty: 10, inwardQty: 24, salesQty: 2, otherQty: 0, closingQty: 32 })
    expect(groupStock(rows, { hideIdle: false })[0]!.rows).toHaveLength(2)
    expect(groupStock(rows, { hideIdle: false, query: 'c ite' }).map((g) => g.categoryName)).toEqual(['BEER'])
  })
})
