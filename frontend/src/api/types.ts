/**
 * Frontend view of the local API's JSON (see backend_state.md §4). Every field ending in `Paise`
 * is decoded to a bigint by the client, so money is never a JS number. Dates stay ISO strings.
 */
export type Paise = bigint

export type BillingMode = 'NORMAL' | 'PEAK'
export type BillStatus = 'OPEN' | 'SETTLED' | 'PEAK_UNSETTLED' | 'PEAK_RECONCILED'
export type SizeCode = 'FULL' | 'HALF' | 'QUARTER' | 'BEER_650' | 'BEER_330'
export type CounterTender = 'CASH' | 'UPI'
export type Tender = CounterTender | 'WAITER_CREDIT'

export interface Bill {
  id: string
  billNo: number
  kind: 'SALE' | 'REVERSAL'
  mode: BillingMode
  status: BillStatus
  peakSessionId: string | null
  waiterId: string | null
  waiterTrustedAtBilling: boolean | null
  memberId: string | null
  totalPaise: Paise
  createdAt: string
}

export interface BillItem {
  id: string
  lineNo: number
  skuId: string
  skuCode: string
  displayName: string
  sizeCode: SizeCode
  quantity: number
  unitPricePaise: Paise
  lineTotalPaise: Paise
  reversesItemId: string | null
  restock: boolean
}

export interface BillDetailItem extends BillItem {
  remainingQuantity: number
}

export interface BillPayment {
  id: string
  tender: Tender
  amountPaise: Paise
  createdAt: string
}

export interface MemberSummary {
  id: string
  membershipNo: string
  displayName: string
}

export interface WaiterSummary {
  id: string
  code: string
  displayName: string
  isTrusted: boolean
  outstandingPaise: Paise
  creditLimitPaise: Paise | null
}

export interface BillDetail {
  bill: Bill
  items: BillDetailItem[]
  payments: BillPayment[]
  member: MemberSummary | null
  waiter: WaiterSummary | null
  tenderedPaise: Paise
  duePaise: Paise
}

export interface PeakSessionView {
  id: string
  sessionNo: number
  startedAt: string
  startCashPaise: Paise
  startUpiPaise: Paise
  runningExpectedPaise: Paise
}

export interface CounterContext {
  cashier: { id: string; displayName: string; role: string }
  businessDay: { id: string; businessDate: string; openedAt: string } | null
  peakSession: PeakSessionView | null
  openBill: BillDetail | null
}

export interface SkuLookup {
  id: string
  skuCode: string
  barcode: string | null
  displayName: string
  sizeCode: SizeCode
  pricePaise: Paise
  onHandQty: number
  isActive: boolean
}

export interface BillLine {
  bill: Bill
  item: BillItem
}

export interface CounterPayment {
  mode: CounterTender
  amount: Paise
}

export interface WaiterSettlement {
  bill: Bill
  payment: BillPayment
  remainingDuePaise: Paise
}
