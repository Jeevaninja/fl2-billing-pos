import { describe, expect, it } from 'vitest'
import { payOptions, planPayment } from './payment'
import { detail, line, waiter, withWaiter } from './testData'

// One full bottle at ₹220.00.
const bill = () => detail([line({ skuId: 'a', quantity: 1, unitPricePaise: 22000n })])
const trusted = waiter({ id: 'w-t', isTrusted: true })
const untrusted = waiter({ id: 'w-u', isTrusted: false })

describe('payOptions', () => {
  it('offers cash, UPI and split without a waiter', () => {
    expect(payOptions(bill())).toEqual(['cash', 'upi', 'split'])
  })
  it('offers only exact cash or UPI for an untrusted waiter (bill-on-bill)', () => {
    expect(payOptions(withWaiter(bill(), untrusted))).toEqual(['cash', 'upi'])
  })
  it('adds partial and collect-later for a trusted waiter', () => {
    expect(payOptions(withWaiter(bill(), trusted))).toEqual(['cash', 'upi', 'partial', 'credit'])
  })
  it('uses the trust snapshot taken when the bill was tagged, not the live flag', () => {
    const d = withWaiter(bill(), trusted)
    expect(payOptions({ ...d, bill: { ...d.bill, waiterTrustedAtBilling: false } })).toEqual(['cash', 'upi'])
  })
})

describe('planPayment without a waiter', () => {
  it('settles exact cash, or computes change from cash tendered', () => {
    expect(planPayment(bill(), { option: 'cash', amount: null, partialTender: 'CASH' })).toEqual({
      ok: true,
      plan: { kind: 'counter', payments: [{ mode: 'CASH', amount: 22000n }], changePaise: 0n },
    })
    expect(planPayment(bill(), { option: 'cash', amount: 50000n, partialTender: 'CASH' })).toMatchObject({
      ok: true,
      plan: { payments: [{ mode: 'CASH', amount: 22000n }], changePaise: 28000n },
    })
  })

  it('refuses cash tendered below the amount due', () => {
    expect(planPayment(bill(), { option: 'cash', amount: 21999n, partialTender: 'CASH' })).toMatchObject({ ok: false })
  })

  it('settles exact UPI', () => {
    expect(planPayment(bill(), { option: 'upi', amount: null, partialTender: 'CASH' })).toMatchObject({
      ok: true,
      plan: { kind: 'counter', payments: [{ mode: 'UPI', amount: 22000n }] },
    })
  })

  it('splits cash + UPI in bigint, with UPI = due − cash', () => {
    expect(planPayment(bill(), { option: 'split', amount: 7001n, partialTender: 'CASH' })).toMatchObject({
      ok: true,
      plan: { payments: [{ mode: 'CASH', amount: 7001n }, { mode: 'UPI', amount: 14999n }], changePaise: 0n },
    })
  })

  it.each([null, 0n, 22000n, 30000n])('refuses a split cash part of %s', (amount) => {
    expect(planPayment(bill(), { option: 'split', amount, partialTender: 'CASH' })).toMatchObject({ ok: false })
  })

  it('refuses waiter-only options and a bill with nothing due', () => {
    expect(planPayment(bill(), { option: 'credit', amount: null, partialTender: 'CASH' })).toMatchObject({ ok: false })
    expect(planPayment(detail(), { option: 'cash', amount: null, partialTender: 'CASH' })).toMatchObject({ ok: false })
  })
})

describe('planPayment for a waiter bill', () => {
  it('routes an untrusted waiter to one exact settle-waiter call, keeping change on screen', () => {
    expect(planPayment(withWaiter(bill(), untrusted), { option: 'cash', amount: 50000n, partialTender: 'CASH' })).toEqual({
      ok: true,
      plan: { kind: 'waiter', waiterId: 'w-u', steps: [{ tender: 'CASH' }], changePaise: 28000n },
    })
    expect(planPayment(withWaiter(bill(), untrusted), { option: 'split', amount: 100n, partialTender: 'CASH' })).toMatchObject({ ok: false })
  })

  it('collects later in full for a trusted waiter', () => {
    expect(planPayment(withWaiter(bill(), trusted), { option: 'credit', amount: null, partialTender: 'CASH' })).toEqual({
      ok: true,
      plan: { kind: 'waiter', waiterId: 'w-t', steps: [{ tender: 'WAITER_CREDIT' }], changePaise: 0n },
    })
  })

  it('takes part now and puts the rest on credit, in that order', () => {
    expect(planPayment(withWaiter(bill(), trusted), { option: 'partial', amount: 5000n, partialTender: 'UPI' })).toMatchObject({
      ok: true,
      plan: { steps: [{ tender: 'UPI', amount: 5000n }, { tender: 'WAITER_CREDIT' }] },
    })
    expect(planPayment(withWaiter(bill(), trusted), { option: 'partial', amount: 22000n, partialTender: 'CASH' })).toMatchObject({ ok: false })
  })

  it('works from the amount still due after an earlier part payment', () => {
    const paid = { ...withWaiter(bill(), trusted), tenderedPaise: 2000n, duePaise: 20000n }
    expect(planPayment(paid, { option: 'split', amount: 100n, partialTender: 'CASH' })).toMatchObject({ ok: false })
    expect(planPayment(paid, { option: 'cash', amount: null, partialTender: 'CASH' })).toMatchObject({
      ok: true,
      plan: { steps: [{ tender: 'CASH' }], changePaise: 0n },
    })
  })

  it('warns before exceeding the credit limit, counting the existing balance', () => {
    const limited = waiter({ id: 'w-l', isTrusted: true, outstandingPaise: 90000n, creditLimitPaise: 100000n })
    const d = withWaiter(bill(), limited)
    expect(planPayment(d, { option: 'credit', amount: null, partialTender: 'CASH' })).toEqual({
      ok: false,
      error: 'Over credit limit: ₹100.00 headroom, ₹220.00 asked',
    })
    expect(planPayment(d, { option: 'partial', amount: 12000n, partialTender: 'CASH' })).toMatchObject({ ok: true })
  })
})
