import { describe, expect, it } from 'vitest'
import type { OrderSummaryRow, SalesSummaryRow, StockSummaryRow } from '../api/types'
import {
  filterOrders,
  filterStockGroups,
  formatLitres,
  formatMl,
  groupSalesSummary,
  itemsSummary,
  kotLabel,
  orderTags,
  pageCount,
  pageOf,
  paidByLabel,
  REPORT_TABS,
  rungBy,
  stepReportTab,
  stockTotals,
} from './registerView'

const bill = (billNo: number, patch: Partial<OrderSummaryRow> = {}): OrderSummaryRow => ({
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
  cashierName: 'Counter 1',
  source: 'COUNTER',
  settledByName: null,
  peakSessionNo: null,
  kots: [],
  cancelledQty: 0,
  ...patch,
})

const stock = (skuCode: string, categoryName: string, q: Partial<StockSummaryRow> = {}): StockSummaryRow => ({
  skuId: skuCode,
  skuCode,
  name: `${skuCode} item`,
  sizeCode: 'FULL',
  categoryName,
  centerCode: 'LIQUOR',
  centerName: 'Liquor',
  isActive: true,
  volumeMl: 750,
  exciseGroup: 'LIQUOR',
  opStk: 0,
  purch: 0,
  total: 0,
  sale: 0,
  adj: 0,
  closing: 0,
  pRatePaise: null,
  pRateSource: null,
  sRatePaise: 1000_00n,
  cloPurchValPaise: null,
  cloSalesValPaise: 0n,
  salesTotalPaise: 0n,
  openingValPaise: null,
  ...q,
})

const sale = (skuCode: string, centerCode: string, categoryName: string, qty: number, amountPaise: bigint): SalesSummaryRow => ({
  skuId: skuCode,
  skuCode,
  name: `${skuCode} item`,
  sizeCode: 'FULL',
  categoryName,
  centerCode,
  centerName: centerCode === 'LIQUOR' ? 'Liquor' : 'Kitchen',
  qty,
  sRatePaise: null,
  amountPaise,
})

describe('reports view helpers', () => {
  it('has the eight Phase 24 tabs in key order, stepping in a ring', () => {
    expect(REPORT_TABS.map((t) => t.id)).toEqual(['sales', 'orders', 'stock', 'expenses', 'purchases', 'bank', 'dayEnd', 'full'])
    expect(stepReportTab('sales', 1)).toBe('orders')
    expect(stepReportTab('sales', -1)).toBe('full')
    expect(stepReportTab('full', 1)).toBe('sales')
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

  it('labels KOTs, VOID / CANCEL tags and who rang the bill', () => {
    expect(kotLabel(12, { station: 'KITCHEN', ticketNo: 1 })).toBe('KITCHEN #12')
    expect(kotLabel(12, { station: 'BAR', ticketNo: 2 })).toBe('BAR #12/2')
    expect(orderTags(bill(3, { cancelledQty: 2 }))).toEqual(['CANCEL 2'])
    expect(orderTags(bill(4, { kind: 'REVERSAL', reverses: { billNo: 1, businessDate: '2026-10-14' } }))).toEqual(['VOID of #1'])
    expect(orderTags(bill(1, { voidedBy: { billNo: 4, businessDate: '2026-10-14' } }))).toEqual(['VOIDED by #4'])
    expect(rungBy(bill(1))).toBe('Counter 1')
    expect(rungBy(bill(1, { source: 'WAITER_APP', cashierName: null, waiterName: 'Ravi' }))).toBe('Captain · Ravi')
  })

  it('searches by bill number or by item / waiter / cashier, and pages', () => {
    const rows = [
      bill(1, { items: [{ name: 'Gold Flake', sizeCode: 'UNIT', qty: 1, lineTotalPaise: 20_00n }] }),
      bill(12, { waiterName: 'Ravi' }),
      bill(2, { cashierName: 'Meena' }),
    ]
    expect(filterOrders(rows, '12').map((r) => r.billNo)).toEqual([12])
    expect(filterOrders(rows, '#1').map((r) => r.billNo)).toEqual([1])
    expect(filterOrders(rows, 'gold').map((r) => r.billNo)).toEqual([1])
    expect(filterOrders(rows, 'ravi').map((r) => r.billNo)).toEqual([12])
    expect(filterOrders(rows, 'meena').map((r) => r.billNo)).toEqual([2])
    expect(filterOrders(rows, '  ')).toHaveLength(3)
    const many = Array.from({ length: 450 }, (_, i) => i)
    expect(pageCount(450)).toBe(3)
    expect(pageCount(0)).toBe(1)
    expect(pageOf(many, 2)).toEqual(many.slice(400))
    expect(pageOf(many, 9)).toEqual(many.slice(400)) // clamped
  })

  it('groups the sales summary by center then category, with totals', () => {
    const rows = [sale('OM-F', 'LIQUOR', 'FULL', 10, 18000_00n), sale('OM-H', 'LIQUOR', 'HALF', 2, 1900_00n), sale('C65', 'KITCHEN', 'FOOD', 3, 540_00n)]
    const centers = groupSalesSummary(rows)
    expect(centers.map((c) => [c.code, c.qty, c.amountPaise, c.categories.map((g) => g.categoryName)])).toEqual([
      ['LIQUOR', 12, 19900_00n, ['FULL', 'HALF']],
      ['KITCHEN', 3, 540_00n, ['FOOD']],
    ])
    expect(groupSalesSummary(rows, 'c65').map((c) => c.code)).toEqual(['KITCHEN'])
  })

  it('filters stock groups and recomputes the totals from what is shown (unrated left out of value)', () => {
    const groups = [
      {
        categoryName: 'FULL',
        rows: [
          stock('A', 'FULL', { opStk: 10, total: 10, sale: 2, closing: 8, pRatePaise: 1500_00n, cloPurchValPaise: 8n * 1500_00n, cloSalesValPaise: 8000_00n, salesTotalPaise: 2000_00n }),
          stock('B', 'FULL'),
          stock('U', 'FULL', { opStk: 5, total: 5, closing: 5, cloSalesValPaise: 5000_00n }),
        ],
      },
      { categoryName: 'BEER', rows: [stock('C', 'BEER', { purch: 24, total: 24, closing: 24, pRatePaise: 150_00n, cloPurchValPaise: 24n * 150_00n })] },
    ]
    const shown = filterStockGroups(groups, { hideIdle: true })
    expect(shown.map((g) => [g.categoryName, g.rows.map((r) => r.skuCode)])).toEqual([
      ['FULL', ['A', 'U']],
      ['BEER', ['C']],
    ])
    expect(shown[0]!.totals).toMatchObject({ opStk: 15, sale: 2, closing: 13, cloPurchValPaise: 12000_00n, unratedCount: 1, unratedClosingQty: 5 })
    const all = stockTotals(shown.flatMap((g) => g.rows))
    expect(all).toMatchObject({ closing: 37, cloPurchValPaise: 12000_00n + 3600_00n, cloSalesValPaise: 13000_00n, salesTotalPaise: 2000_00n })
    expect(filterStockGroups(groups, { hideIdle: false })[0]!.rows).toHaveLength(3)
    expect(filterStockGroups(groups, { hideIdle: false, query: 'c ite' }).map((g) => g.categoryName)).toEqual(['BEER'])
  })

  it('formats integer ml and litres without floats', () => {
    expect(formatMl(146115)).toBe('1,46,115')
    expect(formatLitres(49500)).toBe('49.500 L')
    expect(formatLitres(180)).toBe('0.180 L')
    expect(formatLitres(1234567)).toBe('1,234.567 L')
    expect(formatLitres(-750)).toBe('−0.750 L')
  })
})
