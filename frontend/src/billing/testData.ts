import type { BillDetail, BillDetailItem, CounterContext, WaiterSummary } from '../api/types'

let seq = 0
const uid = (p: string) => `${p}-${++seq}`

export function line(over: Partial<BillDetailItem> & Pick<BillDetailItem, 'skuId'>): BillDetailItem {
  const quantity = over.quantity ?? 1
  const unitPricePaise = over.unitPricePaise ?? 22000n
  return {
    id: uid('item'),
    lineNo: 1,
    skuCode: over.skuId.toUpperCase(),
    displayName: `Item ${over.skuId}`,
    sizeCode: 'FULL',
    quantity,
    unitPricePaise,
    lineTotalPaise: BigInt(quantity) * unitPricePaise,
    reversesItemId: null,
    restock: true,
    remainingQuantity: quantity > 0 ? quantity : 0,
    ...over,
  }
}

export function detail(items: BillDetailItem[] = [], over: Partial<BillDetail> = {}): BillDetail {
  const total = items.reduce((s, i) => s + i.lineTotalPaise, 0n)
  const tendered = over.tenderedPaise ?? 0n
  return {
    bill: {
      id: 'bill-1',
      billNo: 42,
      kind: 'SALE',
      mode: 'NORMAL',
      status: 'OPEN',
      peakSessionId: null,
      waiterId: null,
      waiterTrustedAtBilling: null,
      memberId: null,
      totalPaise: total,
      createdAt: '2026-10-14T10:00:00.000Z',
    },
    items,
    payments: [],
    member: null,
    waiter: null,
    tenderedPaise: tendered,
    duePaise: total - tendered,
    ...over,
  }
}

export function waiter(over: Partial<WaiterSummary> = {}): WaiterSummary {
  return { id: 'w-1', code: 'W01', displayName: 'Suresh', isTrusted: true, outstandingPaise: 0n, creditLimitPaise: null, ...over }
}

export function withWaiter(d: BillDetail, w: WaiterSummary): BillDetail {
  return { ...d, waiter: w, bill: { ...d.bill, waiterId: w.id, waiterTrustedAtBilling: w.isTrusted } }
}

export function context(over: Partial<CounterContext> = {}): CounterContext {
  return {
    cashier: { id: 'staff-1', displayName: 'Counter 1', role: 'CASHIER' },
    businessDay: { id: 'day-1', businessDate: '2026-10-14', openedAt: '2026-10-14T04:00:00.000Z' },
    peakSession: null,
    openBill: null,
    ...over,
  }
}

export const PEAK = {
  id: 'peak-1',
  sessionNo: 1,
  startedAt: '2026-10-14T15:00:00.000Z',
  startCashPaise: 0n,
  startUpiPaise: 0n,
  runningExpectedPaise: 0n,
}
