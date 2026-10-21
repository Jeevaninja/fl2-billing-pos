import { describe, expect, it } from 'vitest'
import type { RevenueCenterOverview, RevenueCenterSummary } from '../api/types'
import { addLine, ALL_CENTERS, centerTabs, newPurchaseForm, pnlCards, purchaseFormError, purchasePayload, purchaseTotal, removeLine, setLine, stepTab } from './purchaseForm'

describe('center purchase form', () => {
  it('starts from the drawer for the given center unless a peak runs, and refuses the drawer during a peak', () => {
    expect(newPurchaseForm(false, 'KITCHEN')).toMatchObject({ paidFrom: 'DRAWER', department: 'KITCHEN' })
    expect(newPurchaseForm(true, 'CIGARETTES').paidFrom).toBe('OUTSIDE')
    const form = setLine(newPurchaseForm(false, 'KITCHEN'), 1, { description: 'Chicken', amount: '1200' })
    expect(purchaseFormError(form, false)).toBeNull()
    expect(purchaseFormError(form, true)).toMatch(/peak is running/)
    expect(purchaseFormError({ ...form, department: '' }, false)).toMatch(/revenue center/)
  })

  it('totals filled lines in paise, ignores blank ones, and builds the payload with its center', () => {
    let form = newPurchaseForm(false, 'CIGARETTES')
    form = setLine(form, 1, { description: '  Lighters ', quantity: ' 10 pcs ', amount: '1,200.50' })
    form = addLine(form)
    form = addLine(form) // left blank
    form = setLine(form, 2, { description: 'Ashtrays', amount: 'Rs 600' })
    expect(purchaseTotal(form)).toBe(1800_50n)
    expect(purchasePayload({ ...form, vendor: ' Metro  Cash ' })).toEqual({
      department: 'CIGARETTES',
      vendorName: 'Metro Cash',
      paidFrom: 'DRAWER',
      note: null,
      lines: [
        { description: 'Lighters', quantity: '10 pcs', amount: 1200_50n },
        { description: 'Ashtrays', quantity: null, amount: 600_00n },
      ],
    })
    expect(removeLine(removeLine(removeLine(form, 1), 2), 3).lines).toHaveLength(1)
  })

  it('names the first problem line by line', () => {
    const blank = newPurchaseForm(false, 'KITCHEN')
    expect(purchaseFormError(blank, false)).toMatch(/at least one line/)
    expect(purchaseFormError(setLine(blank, 1, { amount: '50' }), false)).toBe('Line 1: what was bought?')
    expect(purchaseFormError(setLine(blank, 1, { description: 'Veg', amount: '1.234' }), false)).toBe('Line 1: enter the amount in rupees')
    expect(purchaseFormError(setLine(blank, 1, { description: 'Veg', amount: '0' }), false)).toMatch(/more than ₹0/)
    expect(purchaseTotal(setLine(blank, 1, { description: 'Veg', amount: 'x' }))).toBeNull()
  })
})

describe('center P&L cards and tabs', () => {
  it('labels the cards with the center and splits purchases into GRN stock and supplies', () => {
    const summary = {
      center: { code: 'CIGARETTES', name: 'Cigarettes', tracksStock: true, kotStation: 'BAR' },
      salesPaise: 4200_00n,
      openTabsPaise: 200_00n,
      expensesPaise: 0n,
      purchasesPaise: 3100_00n,
      stockPurchasesPaise: 3000_00n,
      supplyPurchasesPaise: 100_00n,
      supplyDrawerPaise: 0n,
      stockDrawerPaise: 1200_00n,
      grossPaise: 1100_00n,
    } as RevenueCenterSummary
    const cards = pnlCards(summary, (p) => `₹${p / 100n}`)
    expect(cards.map((c) => [c.label, c.value, c.hint])).toEqual([
      ['CIGARETTES SALES', 4200_00n, '+₹200 on open bills'],
      ['CIGARETTES EXPENSES', 0n, 'petty cash in Cigarettes categories'],
      ['CIGARETTES PURCHASES', -3100_00n, '₹3000 stock · ₹100 supplies · ₹1200 from the drawer'],
      ['CIGARETTES GROSS', 1100_00n, 'sales − expenses − purchases'],
    ])
    expect(cards.reduce((sum, c) => (c.key === 'gross' ? sum : sum + c.value), 0n)).toBe(summary.grossPaise)
  })

  it('puts "All centers" first and steps through the tabs with wrap-around', () => {
    const overview = { centers: [{ code: 'KITCHEN', name: 'Kitchen' }, { code: 'CIGARETTES', name: 'Cigarettes' }] } as RevenueCenterOverview
    const tabs = centerTabs(overview)
    expect(tabs.map((t) => t.label)).toEqual(['All centers', 'Kitchen', 'Cigarettes'])
    expect(stepTab(tabs, ALL_CENTERS, 1)).toBe('KITCHEN')
    expect(stepTab(tabs, 'CIGARETTES', 1)).toBe(ALL_CENTERS)
    expect(stepTab(tabs, ALL_CENTERS, -1)).toBe('CIGARETTES')
    expect(stepTab(tabs, 'GONE', 1)).toBe('KITCHEN')
    expect(centerTabs(null)).toHaveLength(1)
  })
})
