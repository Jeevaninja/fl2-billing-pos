import { describe, expect, it } from 'vitest'
import type { LedgerReport, SalesRegister } from '../api/types'
import { csvCell, ledgerCsv, paiseCsv, salesCsv, toCsv } from './csv'

const head = { range: { startDate: '2026-10-01', endDate: '2026-10-19' }, days: [], provisional: true }

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

  it('lays out the ledger as Tally groups with a total under each', () => {
    const ledger: LedgerReport = {
      ...head,
      sales: { byCenter: [{ code: 'LIQUOR', name: 'Liquor', salesPaise: 84230000n }], unallocatedPaise: 0n, totalPaise: 84230000n },
      purchases: { liquorGrnPaise: 61000000n, byCenter: [{ code: 'KITCHEN', name: 'Kitchen', grnPaise: 0n, suppliesPaise: 6230000n, suppliesDrawerPaise: 0n, totalPaise: 6230000n }], totalPaise: 67230000n },
      expenses: { byCategory: [{ categoryId: 'x', name: 'Ice', centerName: null, amountPaise: 1240000n, count: 31 }], totalPaise: 1240000n },
      contra: { bankDepositsPaise: 50000000n },
    }
    const lines = ledgerCsv(ledger).split('\r\n')
    expect(lines[0]).toBe('Business dates,2026-10-01,2026-10-19,PROVISIONAL: includes a day still open')
    expect(lines).toContain('Liquor Sales,842300.00')
    expect(lines).toContain('Liquor purchases,610000.00,0.00,610000.00')
    expect(lines).toContain('Kitchen purchases,0.00,62300.00,62300.00')
    expect(lines).toContain('Ice,Shared,31,12400.00')
    expect(lines).toContain('Cash deposited to bank,500000.00')
  })

  it('writes one line per bill, voids marked', () => {
    const register: SalesRegister = {
      ...head,
      rows: [
        {
          billId: 'b', businessDate: '2026-10-14', billNo: 3, createdAt: 'x', settledAt: null, kind: 'REVERSAL', reverses: { billNo: 1, businessDate: '2026-10-13' }, voidedBy: null,
          mode: 'NORMAL', status: 'SETTLED', cashPaise: -60000n, upiPaise: 0n, creditPaise: 0n, waiterName: null,
          items: [{ name: 'Rum, dark', sizeCode: 'QUARTER', qty: -1, lineTotalPaise: -60000n }], totalPaise: -60000n,
        },
      ],
      totals: { billCount: 0, reversalCount: 1, salesPaise: 0n, reversalsPaise: -60000n, netPaise: -60000n },
      openBillCount: 0,
    }
    expect(salesCsv(register, () => '21:05').split('\r\n')[3]).toBe('2026-10-14,3,21:05,VOID of #1 (2026-10-13),"−1× Rum, dark",Cash,,-600.00,0.00,0.00,-600.00')
  })
})
