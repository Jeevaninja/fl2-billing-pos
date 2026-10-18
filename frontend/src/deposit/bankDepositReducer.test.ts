import { describe, expect, it } from 'vitest'
import type { BankDepositEntry } from '../api/types'
import {
  bankDepositReducer,
  formError,
  formPayload,
  initialBankDepositState,
  overDrawerWarning,
  todayTotals,
  type BankDepositAction,
  type BankDepositState,
} from './bankDepositReducer'

const run = (state: BankDepositState, ...actions: BankDepositAction[]) => actions.reduce(bankDepositReducer, state)

function entry(over: Partial<BankDepositEntry> = {}): BankDepositEntry {
  return {
    id: 'd-1',
    businessDayId: 'day-1',
    amountPaise: 10_000_00n,
    reference: null,
    reversesDepositId: null,
    createdAt: '2026-10-18T06:30:00.000Z',
    voidedAt: null,
    ...over,
  }
}

const ready = run(initialBankDepositState, { type: 'loaded', entries: [], expectedCashPaise: 15_000_00n })

describe('bank deposit form', () => {
  it('needs an amount above ₹0 in valid rupees; the reference is optional', () => {
    expect(formError(ready)).toBe('Enter the amount')
    expect(formError(run(ready, { type: 'amount', text: '12.345' }))).toMatch(/rupees/)
    expect(formError(run(ready, { type: 'amount', text: '0' }))).toBe('Amount must be more than ₹0')
    const ok = run(ready, { type: 'amount', text: '10,000' })
    expect(formError(ok)).toBeNull()
    expect(formPayload(ok)).toEqual({ amount: 10_000_00n, reference: null })
    expect(formPayload(run(ok, { type: 'reference', text: '  RTGS to Sri Balaji ' }))).toEqual({ amount: 10_000_00n, reference: 'RTGS to Sri Balaji' })
    expect(formError(run(ok, { type: 'reference', text: 'x'.repeat(201) }))).toMatch(/at most 200/)
  })

  it('is blocked while a peak session runs', () => {
    const s = run(ready, { type: 'till', cashier: 'Ravi', date: '2026-10-18', peakRunning: true }, { type: 'amount', text: '500' })
    expect(formError(s)).toBe('End the peak session before a bank deposit')
    expect(formPayload(s)).toBeNull()
    expect(formError(run(s, { type: 'till', cashier: 'Ravi', date: '2026-10-18', peakRunning: false }))).toBeNull()
  })

  it('warns, without blocking, when the amount is more than the drawer should hold', () => {
    expect(overDrawerWarning(run(ready, { type: 'amount', text: '15000' }))).toBeNull()
    const over = run(ready, { type: 'amount', text: '15000.01' })
    expect(overDrawerWarning(over)).toBe('More than the drawer should hold (₹15,000.00). Check the amount.')
    expect(formError(over)).toBeNull()
    expect(overDrawerWarning(run(initialBankDepositState, { type: 'amount', text: '99999' }))).toBeNull()
  })

  it('clears the form once recorded', () => {
    const s = run(ready, { type: 'amount', text: '500' }, { type: 'reference', text: 'x' }, { type: 'submitting', on: true }, { type: 'recorded' })
    expect(s).toMatchObject({ amount: '', reference: '', submitting: false })
  })
})

describe('deposit list', () => {
  it('totals only deposits that still stand', () => {
    expect(todayTotals([entry(), entry({ id: 'd-2', amountPaise: 2_500_00n, voidedAt: '2026-10-18T07:00:00.000Z' }), entry({ id: 'd-3', amountPaise: 500_00n })])).toEqual({
      count: 2,
      totalPaise: 10_500_00n,
    })
  })

  it('drops a void confirmation once the list no longer offers that deposit', () => {
    const asking = run(ready, { type: 'loaded', entries: [entry()], expectedCashPaise: 0n }, { type: 'confirmVoid', id: 'd-1' })
    expect(asking.confirmVoidId).toBe('d-1')
    expect(run(asking, { type: 'loaded', entries: [entry()], expectedCashPaise: 0n }).confirmVoidId).toBe('d-1')
    expect(run(asking, { type: 'loaded', entries: [entry({ voidedAt: '2026-10-18T07:00:00.000Z' })], expectedCashPaise: 0n }).confirmVoidId).toBeNull()
    expect(run(asking, { type: 'noDay' })).toMatchObject({ load: 'noDay', confirmVoidId: null, expectedCashPaise: null })
  })
})
