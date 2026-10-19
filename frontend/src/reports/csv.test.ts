import { describe, expect, it } from 'vitest'
import type { FullReport, MemberSales, MlSummary, OrderSummaryReport, SalesSummary, StockSummary, StockSummaryTotals } from '../api/types'
import { csvCell, fullReportCsv, memberSalesCsv, ordersCsv, paiseCsv, salesSummaryCsv, stockSummaryCsv, toCsv } from './csv'

const head = { range: { startDate: '2026-10-01', endDate: '2026-10-19' }, days: [], provisional: true }

const ml: MlSummary = {
  groups: [
    {
      group: 'LIQUOR',
      label: 'LIQUOR',
      saleUnits: 10,
      saleMl: 7500,
      closingUnits: 4,
      closingMl: 3000,
      bySize: [{ volumeMl: 750, saleUnits: 10, saleMl: 7500, closingUnits: 4, closingMl: 3000 }],
    },
  ],
  total: { saleUnits: 10, saleMl: 7500, closingUnits: 4, closingMl: 3000 },
  missing: [],
}

const zeroTotals: StockSummaryTotals = {
  opStk: 0,
  purch: 0,
  total: 0,
  sale: 0,
  adj: 0,
  closing: 0,
  cloPurchValPaise: 0n,
  cloSalesValPaise: 0n,
  salesTotalPaise: 0n,
  openingValPaise: 0n,
  unratedCount: 0,
  unratedClosingQty: 0,
}

describe('report CSV', () => {
  it('writes paise as plain rupees without a float', () => {
    expect(paiseCsv(8423000n)).toBe('84230.00')
    expect(paiseCsv(-120050n)).toBe('-1200.50')
    expect(paiseCsv(5n)).toBe('0.05')
    expect(paiseCsv(123456789012345678n)).toBe('1234567890123456.78')
  })

  it('quotes commas and quotes, and defuses formulas', () => {
    expect(csvCell('Chicken 65, dry')).toBe('"Chicken 65, dry"')
    expect(csvCell('6" pipe')).toBe('"6"" pipe"')
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvCell(-3)).toBe('-3')
    expect(toCsv([['a', 1n], ['b', 2]])).toBe('a,0.01\r\nb,2\r\n')
  })

  it('sales summary: one line per item with SRate (or Mixed), then the ML block', () => {
    const summary: SalesSummary = {
      ...head,
      rows: [
        { skuId: 's', skuCode: 'OM-F', name: 'Old Monk — Full', sizeCode: 'FULL', categoryName: 'FULL', centerCode: 'LIQUOR', centerName: 'Liquor', qty: 10, sRatePaise: 1800_00n, amountPaise: 18000_00n },
        { skuId: 'h', skuCode: 'OM-H', name: 'Old Monk — Half', sizeCode: 'HALF', categoryName: 'HALF', centerCode: 'LIQUOR', centerName: 'Liquor', qty: 2, sRatePaise: null, amountPaise: 1900_00n },
      ],
      byCenter: [{ code: 'LIQUOR', name: 'Liquor', qty: 12, amountPaise: 19900_00n }],
      totalQty: 12,
      totalPaise: 19900_00n,
      ml,
    }
    const lines = salesSummaryCsv(summary).split('\r\n')
    expect(lines[0]).toBe('Sales Summary,2026-10-01,2026-10-19,PROVISIONAL: includes a day still open')
    expect(lines).toContain('Liquor,FULL,OM-F,Old Monk — Full,10,1800.00,18000.00')
    expect(lines).toContain('Liquor,HALF,OM-H,Old Monk — Half,2,Mixed,1900.00')
    expect(lines).toContain('Total,12,19900.00')
    expect(lines).toContain('LIQUOR,750,10,7500,4,3000')
    expect(lines).toContain('Grand total,,10,7500,4,3000')
  })

  it('member-wise: one row per item per visit, the untagged line, and the total', () => {
    const report: MemberSales = {
      ...head,
      members: [
        {
          memberId: 'm',
          membershipNo: 'M001',
          name: 'Asha',
          totalQty: 2,
          totalPaise: 4400_00n,
          visits: [{ businessDate: '2026-10-14', firstBillAt: 'a', lastBillAt: 'b', billNos: [3, 4], items: [{ name: 'Rum, Full', sizeCode: 'FULL', qty: 2, amountPaise: 4400_00n }], totalPaise: 4400_00n }],
        },
      ],
      untagged: { billCount: 5, qty: 7, totalPaise: 1700_00n },
      totalPaise: 6100_00n,
    }
    const lines = memberSalesCsv(report, (iso) => (iso === 'a' ? '19:00' : '21:30')).split('\r\n')
    expect(lines).toContain('M001,Asha,2026-10-14,19:00,21:30,#3 #4,"Rum, Full",2,4400.00')
    expect(lines).toContain('Not tagged to a member,,,,,5 bills,,7,1700.00')
    expect(lines).toContain('Total,,,,,,,,6100.00')
  })

  it('orders: rung by, peak session, KOT and tags on each bill', () => {
    const report: OrderSummaryReport = {
      ...head,
      rows: [
        {
          billId: 'b', businessDate: '2026-10-14', billNo: 3, createdAt: 'x', settledAt: null, kind: 'SALE', reverses: null, voidedBy: null,
          mode: 'NORMAL', status: 'SETTLED', cashPaise: 600_00n, upiPaise: 0n, creditPaise: 0n, waiterName: null,
          items: [{ name: 'Rum', sizeCode: 'QUARTER', qty: 1, lineTotalPaise: 600_00n }], totalPaise: 600_00n,
          cashierName: 'Counter 1', source: 'COUNTER', settledByName: null, peakSessionNo: null, kots: [{ station: 'KITCHEN', ticketNo: 1 }], cancelledQty: 1,
        },
      ],
      totals: { billCount: 1, reversalCount: 0, salesPaise: 600_00n, reversalsPaise: 0n, netPaise: 600_00n, cancelledQty: 1 },
      openBillCount: 0,
    }
    expect(ordersCsv(report, () => '21:05').split('\r\n')[3]).toBe('2026-10-14,3,21:05,Counter 1,,KITCHEN #3,CANCEL 1,1× Rum,Cash,,600.00,0.00,0.00,600.00')
  })

  it('stock summary: the TN FL2 columns, Adj. only when present, unrated left blank', () => {
    const report: StockSummary = {
      ...head,
      groups: [
        {
          categoryName: 'FULL',
          rows: [
            {
              skuId: 'f', skuCode: 'HRUM-F', name: 'House Rum — Full', sizeCode: 'FULL', categoryName: 'FULL', centerCode: 'LIQUOR', centerName: 'Liquor', isActive: true,
              volumeMl: 750, exciseGroup: 'LIQUOR', opStk: 50, purch: 18, total: 68, sale: 2, adj: 0, closing: 66,
              pRatePaise: 1600_00n, pRateSource: 'GRN', sRatePaise: 2200_00n, cloPurchValPaise: 105600_00n, cloSalesValPaise: 145200_00n, salesTotalPaise: 4400_00n, openingValPaise: 80000_00n,
            },
            {
              skuId: 'q', skuCode: 'HRUM-Q', name: 'House Rum — Quarter', sizeCode: 'QUARTER', categoryName: 'FULL', centerCode: 'LIQUOR', centerName: 'Liquor', isActive: true,
              volumeMl: 180, exciseGroup: 'LIQUOR', opStk: 5, purch: 0, total: 5, sale: 0, adj: 0, closing: 5,
              pRatePaise: null, pRateSource: null, sRatePaise: 600_00n, cloPurchValPaise: null, cloSalesValPaise: 3000_00n, salesTotalPaise: 0n, openingValPaise: null,
            },
          ],
          totals: { ...zeroTotals, opStk: 55, purch: 18, total: 73, sale: 2, closing: 71, cloPurchValPaise: 105600_00n, cloSalesValPaise: 148200_00n, salesTotalPaise: 4400_00n, unratedCount: 1, unratedClosingQty: 5 },
        },
      ],
      totals: { ...zeroTotals, opStk: 55, purch: 18, total: 73, sale: 2, closing: 71, cloPurchValPaise: 105600_00n, cloSalesValPaise: 148200_00n, salesTotalPaise: 4400_00n, unratedCount: 1, unratedClosingQty: 5 },
      hasAdjustments: false,
      ml,
    }
    const lines = stockSummaryCsv(report).split('\r\n')
    expect(lines[2]).toBe('Category,Code,Item Name,Op.Stk,Purch,Total,Sale,Closing,P.Rate,SRate,Clo.Purch Val,Clo.Sales Val,Sales Total')
    expect(lines[3]).toBe('FULL,HRUM-F,House Rum — Full,50,18,68,2,66,1600.00,2200.00,105600.00,145200.00,4400.00')
    expect(lines[4]).toBe('FULL,HRUM-Q,House Rum — Quarter,5,0,5,0,5,,600.00,,3000.00,0.00')
    expect(lines).toContain(',,Grand total,55,18,73,2,71,,,105600.00,148200.00,4400.00')
    expect(lines.some((l) => l.startsWith('1 item(s) without a purchase rate'))).toBe(true)

    const withAdj = stockSummaryCsv({ ...report, hasAdjustments: true }).split('\r\n')
    expect(withAdj[2]).toBe('Category,Code,Item Name,Op.Stk,Purch,Total,Sale,Adj.,Closing,P.Rate,SRate,Clo.Purch Val,Clo.Sales Val,Sales Total')
  })

  it('full report: the cash book in order, signed, then grouped totals', () => {
    const report: FullReport = {
      ...head,
      cash: {
        openingBalancePaise: 1000_00n,
        cashSalesPaise: 5000_00n,
        waiterCashRepaidPaise: 0n,
        cashExpensesPaise: 200_00n,
        drawerPurchasesPaise: 120_00n,
        bankDepositsPaise: 500_00n,
        peakVariancePaise: -10_00n,
        unreconciledPaise: 0n,
        dayEndVariancePaise: -20_00n,
        betweenDaysPaise: 0n,
        closingBalancePaise: 5150_00n,
        runningPeakExpensesPaise: 0n,
      },
      sales: { byCenter: [{ code: 'LIQUOR', name: 'Liquor', salesPaise: 6700_00n }], unallocatedPaise: 0n, totalPaise: 6700_00n },
      payments: { cashPaise: 5000_00n, upiPaise: 1700_00n, waiterCreditPaise: 0n },
      expenses: { byCenter: [{ code: 'SHARED', name: 'Shared', amountPaise: 200_00n }], totalPaise: 200_00n },
      purchases: { byCenter: [{ code: 'LIQUOR', name: 'Liquor', grnPaise: 31200_00n, suppliesPaise: 0n, totalPaise: 31200_00n }], totalPaise: 31200_00n },
      bankDepositsPaise: 500_00n,
      stock: { openingValuePaise: 0n, closingValuePaise: 105600_00n, unratedCount: 0 },
    }
    const lines = fullReportCsv(report).split('\r\n')
    expect(lines.slice(3, 15)).toEqual([
      'Opening cash balance,1000.00',
      'Add: cash sales,5000.00',
      'Add: waiter cash repayments,0.00',
      'Less: cash expenses,-200.00',
      'Less: purchases paid from the drawer,-120.00',
      'Less: bank deposits,-500.00',
      'Peak session variance,-10.00',
      'Day End variance (short / over),-20.00',
      'Less: cash taken out between days,0.00',
      'Closing cash balance,5150.00',
      '',
      'Sales by department,Amount',
    ])
    expect(lines).toContain('Liquor,31200.00,0.00,31200.00')
    const added = fullReportCsv({ ...report, cash: { ...report.cash, betweenDaysPaise: -12850_00n } }).split('\r\n')
    expect(added).toContain('Add: cash added between days,12850.00')
    expect(lines).toContain('Closing stock,105600.00')
    expect(lines.join('\n')).not.toMatch(/profit/i)
  })
})
