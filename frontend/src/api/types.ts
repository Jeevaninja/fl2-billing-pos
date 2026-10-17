/**
 * Frontend view of the local API's JSON (see backend_state.md §4). Every field ending in `Paise`
 * is decoded to a bigint by the client, so money is never a JS number. Dates stay ISO strings.
 */
export type Paise = bigint

export type BillingMode = 'NORMAL' | 'PEAK'
export type BillStatus = 'OPEN' | 'SETTLED' | 'PEAK_UNSETTLED' | 'PEAK_RECONCILED'
export type BillSource = 'COUNTER' | 'WAITER_APP'
export type SizeCode = 'FULL' | 'HALF' | 'QUARTER' | 'BEER_650' | 'BEER_330'
export type CounterTender = 'CASH' | 'UPI'
export type Tender = CounterTender | 'WAITER_CREDIT'

export interface Bill {
  id: string
  billNo: number
  kind: 'SALE' | 'REVERSAL'
  mode: BillingMode
  status: BillStatus
  source: BillSource
  /** Handset that placed a Captain order; null on counter bills. */
  captainDeviceId: string | null
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
  /** Cash that should be in the drawer now (peak sales counted as cash). */
  expectedDrawerCashPaise: Paise
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
  /** Default per-bottle cost for a GRN line; null when the catalog has none. */
  purchasePricePaise: Paise | null
  /** Sealed bottles per supplier case. */
  caseSize: number
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

// ── Day End (backend_state.md §3 DayEndService) ─────────────────────────────

export interface DaySummary {
  id: string
  businessDate: string
  status: 'OPEN' | 'CLOSED'
  openedAt: string
  openingFloatPaise: Paise
  closedAt: string | null
  countedCashPaise: Paise | null
  expectedCashPaise: Paise | null
  cashVariancePaise: Paise | null
}

export interface OpenBillBlocker {
  billId: string
  billNo: number
  source: BillSource
  status: BillStatus
  waiter: WaiterSummary | null
  duePaise: Paise
  createdAt: string
}

export interface OwingWaiter extends WaiterSummary {
  isActive: boolean
}

export interface CashBreakdown {
  openingFloatPaise: Paise
  normalCashPaise: Paise
  peakCashPaise: Paise
  waiterCashPaise: Paise
  cashExpensesPaise: Paise
  expectedCashPaise: Paise
  upiTotalPaise: Paise
}

export interface PeakSessionCash {
  id: string
  sessionNo: number
  startedAt: string
  endedAt: string
  cashDeltaPaise: Paise
  upiDeltaPaise: Paise
  variancePaise: Paise
  /** Σ the session's peak bill totals. */
  salesPaise: Paise
  /** UPI recorded inside the window on normal bills and repayments. */
  inWindowUpiPaise: Paise
  /** upiDelta − inWindowUpi. */
  peakUpiPaise: Paise
  /** sales − peakUpi (the session variance lands here). */
  peakCashPaise: Paise
}

/** How the day's revenue was collected; ended peak sessions only. */
export interface SalesBreakdown {
  normal: { cashPaise: Paise; upiPaise: Paise; creditPaise: Paise; totalPaise: Paise }
  peak: { salesPaise: Paise; cashPaise: Paise; upiPaise: Paise; sessionCount: number; runningSessionNo: number | null }
  waiterRepayments: { cashPaise: Paise; upiPaise: Paise }
  total: { cashPaise: Paise; upiPaise: Paise; creditPaise: Paise; salesPaise: Paise }
}

export interface DayEndSummary {
  day: DaySummary
  blockers: { openBills: OpenBillBlocker[]; runningPeakSession: PeakSessionView | null; waitersOwing: OwingWaiter[] }
  canClose: boolean
  breakdown: CashBreakdown
  sales: SalesBreakdown
  peakSessions: PeakSessionCash[]
}

/** POST /api/peak/undo-last: the reversal and the scan it voided. */
export interface PeakUndoResult {
  reversal: Bill
  undone: { billId: string; billNo: number; sessionNo: number; displayName: string; sizeCode: SizeCode; quantity: number; totalPaise: Paise }
}

/** What the till should hold right now, shown when a peak session is started. */
export interface PeakStartBaseline {
  businessDayId: string
  openingFloatPaise: Paise
  normalCashPaise: Paise
  waiterCashPaise: Paise
  /** Earlier ended peaks' counted cash delta. */
  peakCashPaise: Paise
  cashExpensesPaise: Paise
  expectedCashPaise: Paise
  billUpiPaise: Paise
  waiterUpiPaise: Paise
  peakUpiPaise: Paise
  expectedUpiPaise: Paise
}

export interface PeakReconciliation {
  session: { id: string; sessionNo: number; variancePaise: Paise | null }
  breakdown: { expectedPaise: Paise; actualPaise: Paise; cashDeltaPaise: Paise; upiDeltaPaise: Paise; variancePaise: Paise }
}

export interface PeakSession {
  id: string
  businessDayId: string
  sessionNo: number
  startedAt: string
  startCashPaise: Paise
  startUpiPaise: Paise
}

// ── Expenses ────────────────────────────────────────────────────────────────

export type ExpenseCategory = 'ICE' | 'STAFF_FOOD' | 'TRANSPORT' | 'CLEANING' | 'REPAIRS' | 'OTHER'

export interface CashExpense {
  id: string
  businessDayId: string
  peakSessionId: string | null
  amountPaise: Paise
  reversesExpenseId: string | null
  category: ExpenseCategory
  description: string | null
  createdAt: string
}

export interface ExpenseEntry extends CashExpense {
  voidedAt: string | null
}

// ── Purchase (GRN) ──────────────────────────────────────────────────────────

export interface StockReceipt {
  id: string
  businessDayId: string
  invoiceNo: string
  vendorName: string | null
  receivedByStaffId: string
  receivedBy: string
  createdAt: string
  lineCount: number
  bottles: number
  totalCostPaise: Paise
}

export interface StockReceiptLine {
  id: string
  lineNo: number
  skuId: string
  skuCode: string
  displayName: string
  sizeCode: SizeCode
  /** Whole bottles posted to stock. */
  quantity: number
  cases: number
  /** Case size the line was counted at; null for a loose-only line. */
  caseSize: number | null
  looseBottles: number
  unitCostPaise: Paise
  lineTotalPaise: Paise
}

export interface StockReceiptDetail {
  receipt: StockReceipt
  lines: StockReceiptLine[]
}

/**
 * One invoice line as posted: the server computes cases × caseSize + looseBottles, and refuses the
 * line (PS002) if the catalog's case size has changed. `unitCost` is whole paise per bottle (0 = free).
 */
export interface ReceiptLinePayload {
  skuId: string
  cases: number
  looseBottles: number
  caseSize: number
  unitCost: Paise
}

// ── Inventory catalog ───────────────────────────────────────────────────────

export const PRODUCT_CATEGORIES = ['WHISKY', 'RUM', 'VODKA', 'BRANDY', 'GIN', 'WINE', 'BEER', 'OTHER'] as const
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]

export interface CatalogSku extends SkuLookup {
  productId: string
}

export interface CatalogProduct {
  id: string
  name: string
  category: ProductCategory
  isActive: boolean
  /** Ordered FULL → HALF → QUARTER → 650 → 330. */
  skus: CatalogSku[]
}

/** A size on a new liquor (or one added later). Prices are whole paise. */
export interface NewSkuPayload {
  sizeCode: SizeCode
  salePrice: Paise
  purchasePrice: Paise | null
  caseSize: number
  barcode: string | null
}

export interface NewProductPayload {
  name: string
  category: ProductCategory
  codePrefix: string
  skus: NewSkuPayload[]
}

export interface ProductPatch {
  name?: string
  category?: ProductCategory
  isActive?: boolean
}

/** `null` clears the purchase price or barcode; a missing key leaves the field as it is. */
export interface SkuPatchPayload {
  salePrice?: Paise
  purchasePrice?: Paise | null
  caseSize?: number
  barcode?: string | null
  isActive?: boolean
}
