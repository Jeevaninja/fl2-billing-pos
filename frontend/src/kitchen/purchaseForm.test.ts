import { describe, expect, it } from 'vitest'
import type { KitchenSummary } from '../api/types'
import { addLine, newPurchaseForm, pnlCards, purchaseFormError, purchasePayload, purchaseTotal, removeLine, setLine } from './purchaseForm'

describe('kitchen purchase form', () => {
  it('starts from the drawer unless a peak runs, and refuses the drawer during a peak', () => {
    expect(newPurchaseForm(false).paidFrom).toBe('DRAWER')
    expect(newPurchaseForm(true).paidFrom).toBe('OUTSIDE')
    const form = setLine(newPurchaseForm(false), 1, { description: 'Chicken', amount: '1200' })
    expect(purchaseFormError(form, false)).toBeNull()
    expect(purchaseFormError(form, true)).toMatch(/peak is running/)
  })

  it('totals filled lines in paise, ignores blank ones, and builds the payload', () => {
    let form = newPurchaseForm(false)
    form = setLine(form, 1, { description: '  Chicken ', quantity: ' 5 kg ', amount: '1,200.50' })
    form = addLine(form)
    form = addLine(form) // left blank
    form = setLine(form, 2, { description: 'Oil', amount: 'Rs 600' })
    expect(purchaseTotal(form)).toBe(1800_50n)
    expect(purchasePayload({ ...form, vendor: ' Raju  Chicken ' })).toEqual({
      vendorName: 'Raju Chicken',
      paidFrom: 'DRAWER',
      note: null,
      lines: [
        { description: 'Chicken', quantity: '5 kg', amount: 1200_50n },
        { description: 'Oil', quantity: null, amount: 600_00n },
      ],
    })
    expect(removeLine(removeLine(removeLine(form, 1), 2), 3).lines).toHaveLength(1)
  })

  it('names the first problem line by line', () => {
    expect(purchaseFormError(newPurchaseForm(false), false)).toMatch(/at least one line/)
    expect(purchaseFormError(setLine(newPurchaseForm(false), 1, { amount: '50' }), false)).toBe('Line 1: what was bought?')
    expect(purchaseFormError(setLine(newPurchaseForm(false), 1, { description: 'Veg', amount: '1.234' }), false)).toBe('Line 1: enter the amount in rupees')
    expect(purchaseFormError(setLine(newPurchaseForm(false), 1, { description: 'Veg', amount: '0' }), false)).toMatch(/more than ₹0/)
    expect(purchaseTotal(setLine(newPurchaseForm(false), 1, { description: 'Veg', amount: 'x' }))).toBeNull()
  })

  it('lays out the P&L as sales − expenses − purchases = gross', () => {
    const summary = {
      salesPaise: 6350_00n,
      openTabsPaise: 380_00n,
      expensesPaise: 420_00n,
      purchasesPaise: 3200_00n,
      purchasesDrawerPaise: 1800_00n,
      grossPaise: 2730_00n,
    } as KitchenSummary
    const cards = pnlCards(summary, (p) => `₹${p / 100n}`)
    expect(cards.map((c) => [c.key, c.value, c.hint])).toEqual([
      ['sales', 6350_00n, '+₹380 on open bills'],
      ['expenses', -420_00n, 'petty cash in Kitchen categories'],
      ['purchases', -3200_00n, '₹1800 from the drawer'],
      ['gross', 2730_00n, 'sales − expenses − purchases'],
    ])
    expect(cards.reduce((sum, c) => (c.key === 'gross' ? sum : sum + c.value), 0n)).toBe(summary.grossPaise)
  })
})
