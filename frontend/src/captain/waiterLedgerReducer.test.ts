import { describe, expect, it } from 'vitest'
import type { BillDetail, WaiterLedger, WaiterLedgerRow } from '../api/types'
import { detail, line, waiter } from '../billing/testData'
import {
  allocate,
  billsToSettle,
  cursorBill,
  initialWaiterLedgerState,
  initialWaiterLedgerStateFor,
  openBills,
  receiveError,
  selectedWaiter,
  selectionTotal,
  waiterLedgerReducer,
  type WaiterLedgerState,
} from './waiterLedgerReducer'

const row = (over: Partial<WaiterLedgerRow> = {}): WaiterLedgerRow => ({
  ...waiter(),
  billedPaise: 0n,
  paidPaise: 0n,
  balancePaise: 0n,
  openBills: 0,
  openDuePaise: 0n,
  newestOpenAt: null,
  settleRequests: 0,
  newestSettleRequestAt: null,
  ...over,
})

/** An open bill #n of `due` paise with one line, created at minute n. */
const bill = (n: number, due: bigint, over: Partial<BillDetail> = {}): BillDetail => {
  const d = detail([line({ skuId: `s${n}`, unitPricePaise: due })], over)
  return { ...d, bill: { ...d.bill, id: `bill-${n}`, billNo: n, createdAt: `2026-10-18T10:0${n}:00.000Z` } }
}

const W1 = row({ id: 'w-1', code: 'W01', displayName: 'Suresh', balancePaise: 265000n, openBills: 3, newestOpenAt: '2026-10-18T10:03:00.000Z' })
const W2 = row({ id: 'w-2', code: 'W02', displayName: 'Manoj', isTrusted: false, balancePaise: 60000n, openBills: 1, newestOpenAt: '2026-10-18T10:05:00.000Z' })
const BILLS = [bill(1, 120000n), bill(2, 120000n), bill(3, 25000n)]
const ledgerOf = (w: WaiterLedgerRow, bills: BillDetail[] = BILLS, creditPaise = 0n): WaiterLedger => ({ waiter: w, creditPaise, openBills: bills, receipts: [] })

const loaded = (): WaiterLedgerState => {
  const s = waiterLedgerReducer(initialWaiterLedgerState, { type: 'listLoaded', waiters: [W1, W2], at: 1 })
  return waiterLedgerReducer(s, { type: 'ledgerLoaded', ledger: ledgerOf(W1) })
}

describe('waiterLedgerReducer', () => {
  it('selects the top waiter on the first load and puts the cursor on their oldest bill', () => {
    const s = loaded()
    expect(selectedWaiter(s)?.code).toBe('W01')
    expect(openBills(s).map((b) => b.bill.billNo)).toEqual([1, 2, 3])
    expect(cursorBill(s)?.bill.billNo).toBe(1)
    expect(s.selectedKey).not.toBeNull()
    expect(s.freshWaiterIds.size).toBe(0)
  })

  it('drops a ledger that arrives for a waiter the cashier already left', () => {
    let s = waiterLedgerReducer(initialWaiterLedgerState, { type: 'listLoaded', waiters: [W1, W2], at: 1 })
    s = waiterLedgerReducer(s, { type: 'selectWaiter', id: 'w-2' })
    s = waiterLedgerReducer(s, { type: 'ledgerLoaded', ledger: ledgerOf(W1) })
    expect(s.ledger).toBeNull()
    expect(openBills(s)).toEqual([])
  })

  it('ticks bills, totals the selection, and settles the highlighted bill when none is ticked', () => {
    let s = loaded()
    expect(billsToSettle(s).map((b) => b.bill.billNo)).toEqual([1])
    s = waiterLedgerReducer(s, { type: 'toggleCheck', billId: 'bill-3' })
    s = waiterLedgerReducer(s, { type: 'toggleCheck', billId: 'bill-2' })
    expect(billsToSettle(s).map((b) => b.bill.billNo)).toEqual([2, 3])
    expect(selectionTotal(billsToSettle(s))).toBe(145000n)
    s = waiterLedgerReducer(s, { type: 'toggleCheck', billId: 'bill-2' })
    expect(billsToSettle(s).map((b) => b.bill.billNo)).toEqual([3])
    s = waiterLedgerReducer(s, { type: 'checkAll' })
    expect(s.checked.size).toBe(3)
    s = waiterLedgerReducer(s, { type: 'checkAll' })
    expect(s.checked.size).toBe(0)
  })

  it('keeps ticks and cursor across a refresh, dropping bills that were settled', () => {
    let s = waiterLedgerReducer(loaded(), { type: 'toggleCheck', billId: 'bill-1' })
    s = waiterLedgerReducer(s, { type: 'toggleCheck', billId: 'bill-3' })
    s = waiterLedgerReducer(s, { type: 'cursor', billId: 'bill-2' })
    s = waiterLedgerReducer(s, { type: 'ledgerLoaded', ledger: ledgerOf(W1, [BILLS[1]!, BILLS[2]!]) })
    expect([...s.checked]).toEqual(['bill-3'])
    expect(cursorBill(s)?.bill.billNo).toBe(2)
    // The highlighted bill settles: the cursor moves to the bill in its place.
    s = waiterLedgerReducer(s, { type: 'ledgerLoaded', ledger: ledgerOf(W1, [BILLS[2]!]) })
    expect(cursorBill(s)?.bill.billNo).toBe(3)
  })

  it('moves through waiters, bills and lines by focused pane', () => {
    let s = loaded()
    s = waiterLedgerReducer(s, { type: 'move', delta: 1 })
    expect(selectedWaiter(s)?.code).toBe('W02')
    expect(s.ledger).toBeNull()
    s = waiterLedgerReducer(s, { type: 'move', delta: -1 })
    s = waiterLedgerReducer(s, { type: 'ledgerLoaded', ledger: ledgerOf(W1) })
    s = waiterLedgerReducer(s, { type: 'cycleFocus' })
    expect(s.focus).toBe('bills')
    s = waiterLedgerReducer(waiterLedgerReducer(s, { type: 'move', delta: 1 }), { type: 'move', delta: 1 })
    expect(cursorBill(s)?.bill.billNo).toBe(3)
    s = waiterLedgerReducer(s, { type: 'move', delta: 1 })
    expect(cursorBill(s)?.bill.billNo).toBe(3)
    s = waiterLedgerReducer(waiterLedgerReducer(s, { type: 'cycleFocus' }), { type: 'cycleFocus' })
    expect(s.focus).toBe('waiters')
  })

  it('flags a waiter whose newest open bill is newer than last seen, and moves off a waiter who drops out', () => {
    let s = loaded()
    const newer = { ...W2, newestOpenAt: '2026-10-18T10:09:00.000Z' }
    s = waiterLedgerReducer(s, { type: 'listLoaded', waiters: [W1, newer], at: 2 })
    expect([...s.freshWaiterIds]).toEqual(['w-2'])
    s = waiterLedgerReducer(s, { type: 'listLoaded', waiters: [W1, newer], at: 3 })
    expect(s.freshWaiterIds.size).toBe(0)

    s = waiterLedgerReducer(s, { type: 'listLoaded', waiters: [newer], at: 4 })
    expect(selectedWaiter(s)?.code).toBe('W02')
    s = waiterLedgerReducer(s, { type: 'listLoaded', waiters: [], at: 5 })
    expect(s.selectedWaiterId).toBeNull()
  })

  it('flags a waiter whose handset asked to settle a bill since the last refresh (Phase 27)', () => {
    let s = loaded()
    const asked = { ...W1, settleRequests: 1, newestSettleRequestAt: '2026-10-18T10:07:00.000Z' }
    s = waiterLedgerReducer(s, { type: 'listLoaded', waiters: [asked, W2], at: 2 })
    expect([...s.freshWaiterIds]).toEqual(['w-1'])
    s = waiterLedgerReducer(s, { type: 'listLoaded', waiters: [asked, W2], at: 3 })
    expect(s.freshWaiterIds.size).toBe(0)
    // An older request than the newest order seen is not news.
    const late = { ...W2, settleRequests: 1, newestSettleRequestAt: '2026-10-18T10:04:00.000Z' }
    s = waiterLedgerReducer(s, { type: 'listLoaded', waiters: [asked, late], at: 4 })
    expect(s.freshWaiterIds.size).toBe(0)
  })
})

describe('jump from Orders', () => {
  it('selects the waiter and highlights the bill once both load, then forgets the focus', () => {
    let s = waiterLedgerReducer(initialWaiterLedgerStateFor({ waiterId: 'w-2', billId: 'bill-9' }), { type: 'listLoaded', waiters: [W1, W2], at: 1 })
    expect(selectedWaiter(s)?.code).toBe('W02')
    s = waiterLedgerReducer(s, { type: 'ledgerLoaded', ledger: ledgerOf(W2, [bill(8, 1000n), bill(9, 2000n)]) })
    expect(cursorBill(s)?.bill.billNo).toBe(9)
    expect(s.focus).toBe('bills')
    expect(s.pendingFocus).toBeNull()
    // Later refreshes behave normally.
    s = waiterLedgerReducer(s, { type: 'listLoaded', waiters: [W1, W2], at: 2 })
    expect(selectedWaiter(s)?.code).toBe('W02')
  })

  it('falls back to the normal first selection when the waiter is gone', () => {
    const s = waiterLedgerReducer(initialWaiterLedgerStateFor({ waiterId: 'w-9', billId: 'x' }), { type: 'listLoaded', waiters: [W1, W2], at: 1 })
    expect(selectedWaiter(s)?.code).toBe('W01')
  })
})

describe('allocate', () => {
  it('pays the oldest bills first, part-pays the next, then the credit balance', () => {
    expect(allocate(BILLS, 0n, 200000n)).toEqual({
      slices: [
        { kind: 'BILL', billNo: 1, amountPaise: 120000n, settled: true, remainingDuePaise: 0n },
        { kind: 'BILL', billNo: 2, amountPaise: 80000n, settled: false, remainingDuePaise: 40000n },
      ],
      overPaise: 0n,
    })
    expect(allocate([BILLS[2]!], 60000n, 50000n).slices).toEqual([
      { kind: 'BILL', billNo: 3, amountPaise: 25000n, settled: true, remainingDuePaise: 0n },
      { kind: 'CREDIT', amountPaise: 25000n },
    ])
    expect(allocate([BILLS[2]!], 1000n, 30000n).overPaise).toBe(4000n)
  })

  it('skips a part-paid bill only by what is still due', () => {
    const partPaid = bill(4, 100000n, { tenderedPaise: 70000n })
    expect(allocate([partPaid], 0n, 30000n).slices).toEqual([{ kind: 'BILL', billNo: 4, amountPaise: 30000n, settled: true, remainingDuePaise: 0n }])
  })
})

describe('receiveError', () => {
  it('checks the waiter, then the amount', () => {
    expect(receiveError(null, '100')).toMatch(/Pick a waiter/)
    expect(receiveError(ledgerOf(W2), '100')).toMatch(/bill-on-bill/)
    expect(receiveError(ledgerOf({ ...W1, balancePaise: 0n }), '100')).toMatch(/owes nothing/)
    expect(receiveError(ledgerOf(W1), '')).toBe('Enter the amount received')
    expect(receiveError(ledgerOf(W1), '1.2.3')).toMatch(/Enter rupees/)
    expect(receiveError(ledgerOf(W1), '0')).toBe('Enter the amount received')
    expect(receiveError(ledgerOf(W1), '2650.01')).toBe('Suresh owes only ₹2,650.00')
    expect(receiveError(ledgerOf(W1), '2,650')).toBeNull()
  })
})
