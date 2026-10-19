/**
 * Frontend view of the local API's JSON (see backend_state.md §4). Every field ending in `Paise`
 * is decoded to a bigint by the client, so money is never a JS number. Dates stay ISO strings.
 */
export type Paise = bigint

export type BillingMode = 'NORMAL' | 'PEAK'
export type BillStatus = 'OPEN' | 'SETTLED' | 'PEAK_UNSETTLED' | 'PEAK_RECONCILED'
export type BillSource = 'COUNTER' | 'WAITER_APP'
export type SizeCode = 'FULL' | 'HALF' | 'QUARTER' | 'BEER_650' | 'BEER_330' | 'UNIT'
/** P&L department (Phase 19). Bills and the drawer stay unified; lines carry one each. */
/** A revenue center code (Phase 22: manager-defined) — LIQUOR, KITCHEN, CIGARETTES, … */
export type DepartmentCode = string
export type KotStation = 'BAR' | 'KITCHEN'
/** Where a center's KOT prints; NONE = no ticket (a service such as AC charges). */
export type DepartmentStation = KotStation | 'NONE'
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
  /** Snapshotted when the line was rung up. */
  department: DepartmentCode
}

export interface BillDetailItem extends BillItem {
  remainingQuantity: number
  /** Where the line's KOT prints; NONE = never. */
  kotStation: DepartmentStation
  /** Quantity already sent to that station on KOTs. */
  kotSentQuantity: number
}

/** One KOT print attempt (Phase 19). A failed print leaves its lines pending for the next send. */
export interface KotStatus {
  station: KotStation
  ticketNo: number | null
  printed: boolean
  printedAt: string | null
  sentQuantity: number
  cancelledQuantity: number
  error: string | null
}

/** A revenue center (Phase 22; a "department" in the data). */
export interface Department {
  code: DepartmentCode
  name: string
  kotStation: DepartmentStation
  tracksStock: boolean
  isActive: boolean
  sortOrder: number
  itemCount: number
  onHandQty: number
}

export interface DepartmentPatch {
  name?: string
  kotStation?: DepartmentStation
  tracksStock?: boolean
  isActive?: boolean
  move?: 'up' | 'down'
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
  /** Σ peak bill totals so far. */
  runningSalesPaise: Paise
  /** UPI recorded inside the window (normal bills, waiter repayments): it moves the UPI reading too. */
  runningInWindowUpiPaise: Paise
}

export interface CounterContext {
  cashier: { id: string; displayName: string; role: string }
  businessDay: { id: string; businessDate: string; openedAt: string } | null
  peakSession: PeakSessionView | null
  openBill: BillDetail | null
  /** Every open NORMAL counter bill of this cashier, oldest first: the held billing tabs to restore. */
  openBills: BillDetail[]
}

/** Today's figures for one waiter (GET /api/waiters/stats). */
export interface WaiterDayTotals {
  openBills: number
  /** Σ due (total − tendered) on today's open bills. */
  openDuePaise: Paise
  /** Settled, not reversed. */
  closedBills: number
  settledPaise: Paise
}

export type WaiterStats = WaiterSummary & WaiterDayTotals

/** Phase 16 Day End blocker: open waiter-bill dues + credit balances. */
export interface WaiterBalanceBlocker {
  totalPaise: Paise
  openBillsPaise: Paise
  creditPaise: Paise
  waiters: number
}

/** A waiter's account for the open day (GET /api/waiter-ledger). Billed − Paid = Balance. */
export interface WaiterLedgerRow extends WaiterSummary {
  billedPaise: Paise
  paidPaise: Paise
  /** Open-bill dues + credit balance. */
  balancePaise: Paise
  openBills: number
  openDuePaise: Paise
  newestOpenAt: string | null
}

export type LedgerAllocation =
  | { kind: 'BILL'; billId: string; billNo: number; amountPaise: Paise; settled: boolean; remainingDuePaise: Paise }
  | { kind: 'CREDIT'; amountPaise: Paise }
  | { kind: 'VOID'; amountPaise: Paise }

export interface LedgerReceipt {
  at: string
  tender: CounterTender
  amountPaise: Paise
  allocations: LedgerAllocation[]
}

/** GET /api/waiter-ledger/:waiterId */
export interface WaiterLedger {
  waiter: WaiterLedgerRow
  creditPaise: Paise
  /** OPEN bills, oldest first. */
  openBills: BillDetail[]
  /** Today's money from the waiter, newest first. */
  receipts: LedgerReceipt[]
}

export interface WaiterBillsSettlement {
  bills: Bill[]
  totalPaise: Paise
  balancePaise: Paise
}

export interface WaiterReceipt {
  tender: CounterTender
  amountPaise: Paise
  allocations: Array<Exclude<LedgerAllocation, { kind: 'VOID' }>>
  balancePaise: Paise
}

export interface WaiterStatsReport {
  businessDayId: string | null
  waiters: WaiterStats[]
  totals: WaiterDayTotals
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
  department: DepartmentCode
  departmentName: string
  /** false for Kitchen items: no stock is counted or needed. */
  tracksStock: boolean
  /** Phase 20: the catalog grouping (FULL, QUARTER, BEER…). */
  itemCategory: { id: string; name: string }
}

export interface BillLine {
  bill: Bill
  item: BillItem
  /** Kitchen KOTs printed by this call (peak scans, cancellations); absent on plain adds. */
  kots?: KotStatus[]
}

export interface CounterPayment {
  mode: CounterTender
  amount: Paise
}

export interface WaiterSettlement {
  bill: Bill
  payment: BillPayment
  remainingDuePaise: Paise
  /** Kitchen KOTs printed with the payment (Phase 19). */
  kots?: KotStatus[]
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
  /** Σ tally adjustments' cash deltas (positive = UPI revenue reclassified as cash). */
  tenderAdjustmentPaise: Paise
  /** Cash taken out of the drawer to be banked (subtracted). Not an expense, not revenue. */
  bankDepositsPaise: Paise
  /** Revenue-center purchases paid from the drawer (Phase 21 / 22; subtracted). */
  centerPurchasesPaise: Paise
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
  /** cash / upi include tally adjustments; systemCash / systemUpi are as recorded on bills. */
  normal: { cashPaise: Paise; upiPaise: Paise; creditPaise: Paise; totalPaise: Paise; systemCashPaise: Paise; systemUpiPaise: Paise }
  peak: { salesPaise: Paise; cashPaise: Paise; upiPaise: Paise; sessionCount: number; runningSessionNo: number | null }
  waiterRepayments: { cashPaise: Paise; upiPaise: Paise }
  total: { cashPaise: Paise; upiPaise: Paise; creditPaise: Paise; salesPaise: Paise }
  /** Phase 19, info only: the same sales by department (every department listed). */
  byDepartment: Array<{ code: DepartmentCode; name: string; salesPaise: Paise }>
  /** Counted tenders on bills still open (part-paid) or inside a running peak: not split yet. */
  unallocatedPaise: Paise
}

export interface DayEndSummary {
  day: DaySummary
  blockers: {
    openBills: OpenBillBlocker[]
    runningPeakSession: PeakSessionView | null
    waitersOwing: OwingWaiter[]
    /** Phase 16: everything waiters owe; Day End locks only at ₹0. */
    waiterBalance: WaiterBalanceBlocker
  }
  canClose: boolean
  breakdown: CashBreakdown
  sales: SalesBreakdown
  peakSessions: PeakSessionCash[]
  /** Tally adjustments, newest first (originals, with voidedAt). */
  tenderAdjustments: TenderAdjustmentEntry[]
}

/** A Cash ⇄ UPI reclassification of normal-bill revenue: cashDelta + upiDelta = 0. */
export interface TenderAdjustment {
  id: string
  businessDayId: string
  cashDeltaPaise: Paise
  upiDeltaPaise: Paise
  systemCashPaise: Paise
  systemUpiPaise: Paise
  reason: string
  reversesAdjustmentId: string | null
  createdAt: string
}

export interface TenderAdjustmentEntry extends TenderAdjustment {
  voidedAt: string | null
}

/** POST /api/peak/undo-last: the reversal and the scan it voided. */
export interface PeakUndoResult {
  reversal: Bill
  /** A Kitchen scan already sent gets a CANCEL ticket. */
  kots: KotStatus[]
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
  /** Σ Day End tally adjustments' cash deltas. */
  tenderAdjustmentPaise: Paise
  bankDepositsPaise: Paise
  centerPurchasesPaise: Paise
  expectedCashPaise: Paise
  billUpiPaise: Paise
  waiterUpiPaise: Paise
  peakUpiPaise: Paise
  expectedUpiPaise: Paise
}

export interface PeakReconciliation {
  session: { id: string; sessionNo: number; variancePaise: Paise | null }
  breakdown: {
    expectedPaise: Paise
    actualPaise: Paise
    cashDeltaPaise: Paise
    upiDeltaPaise: Paise
    variancePaise: Paise
    /** Σ the session's peak bills (its sales). */
    peakBillsPaise: Paise
    /** UPI taken inside the window on normal bills / waiter repayments. */
    billUpiPaise: Paise
    waiterUpiPaise: Paise
  }
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

/** A managed expense category (Phase 18, Settings → Expense Categories). */
export interface ExpenseCategory {
  id: string
  name: string
  isActive: boolean
  noteRequired: boolean
  /** Picker order: the first nine active categories get keys 1–9. */
  sortOrder: number
  /** The P&L its expenses go to; null = Shared (overheads). */
  department: DepartmentCode | null
  /** The pre-Phase-18 code old expenses carry (ICE, OTHER, …); null for categories added since. */
  legacyCode: string | null
  usedCount: number
}

export interface ExpenseCategoryPatch {
  name?: string
  noteRequired?: boolean
  isActive?: boolean
  /** null = Shared. */
  department?: DepartmentCode | null
  move?: 'up' | 'down'
}

export interface CashExpense {
  id: string
  businessDayId: string
  peakSessionId: string | null
  amountPaise: Paise
  reversesExpenseId: string | null
  /** Resolved by the server (old rows through their legacy code). */
  category: { id: string; name: string; department: DepartmentCode | null }
  description: string | null
  createdAt: string
}

export interface ExpenseEntry extends CashExpense {
  voidedAt: string | null
}

// ── Revenue centers (Phase 22; Kitchen Kiosk in Phase 21) ────────────────────

export type PurchasePaidFrom = 'DRAWER' | 'OUTSIDE'

export interface CenterPurchaseLine {
  lineNo: number
  description: string
  /** Free text ("5 kg"): a label, never arithmetic. */
  quantity: string | null
  amountPaise: Paise
}

export interface CenterPurchase {
  id: string
  businessDayId: string
  department: DepartmentCode
  vendorName: string | null
  paidFrom: PurchasePaidFrom
  /** Negative on a void row. */
  amountPaise: Paise
  note: string | null
  reversesPurchaseId: string | null
  createdAt: string
  lines: CenterPurchaseLine[]
}

export interface CenterPurchaseEntry extends CenterPurchase {
  voidedAt: string | null
}

export interface CenterPurchasePayload {
  department: DepartmentCode
  vendorName: string | null
  paidFrom: PurchasePaidFrom
  note: string | null
  lines: Array<{ description: string; quantity: string | null; amount: Paise }>
}

export interface RevenueCenterSummary {
  center: { code: DepartmentCode; name: string; tracksStock: boolean; kotStation: DepartmentStation }
  day: { id: string; businessDate: string; status: 'OPEN' | 'CLOSED' }
  /** The center's lines on counted bills (= Day End's figure for it). */
  salesPaise: Paise
  /** Its lines on bills not counted yet (open tabs, a running peak). */
  openTabsPaise: Paise
  expensesPaise: Paise
  /** stock (GRN) + supply purchases. */
  purchasesPaise: Paise
  stockPurchasesPaise: Paise
  supplyPurchasesPaise: Paise
  supplyDrawerPaise: Paise
  grossPaise: Paise
  itemsSold: Array<{ skuId: string; displayName: string; quantity: number; amountPaise: Paise }>
  expenses: ExpenseEntry[]
  purchases: CenterPurchaseEntry[]
}

export interface RevenueCenterOverviewRow {
  code: DepartmentCode
  name: string
  salesPaise: Paise
  expensesPaise: Paise
  purchasesPaise: Paise
  grossPaise: Paise
}

export interface RevenueCenterOverview {
  day: { id: string; businessDate: string; status: 'OPEN' | 'CLOSED' }
  centers: RevenueCenterOverviewRow[]
  total: { salesPaise: Paise; expensesPaise: Paise; purchasesPaise: Paise; grossPaise: Paise }
}

// ── Bank deposits (cash drops) ──────────────────────────────────────────────

export interface BankDeposit {
  id: string
  businessDayId: string
  /** Negative on a void row. */
  amountPaise: Paise
  /** Optional, e.g. "RTGS to Sri Balaji". */
  reference: string | null
  reversesDepositId: string | null
  createdAt: string
}

export interface BankDepositEntry extends BankDeposit {
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

export const PRODUCT_CATEGORIES = ['WHISKY', 'RUM', 'VODKA', 'BRANDY', 'GIN', 'WINE', 'BEER', 'OTHER', 'FOOD', 'BEVERAGE', 'TOBACCO'] as const
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]

// ── Item categories and flat items (Phase 20) ───────────────────────────────

export interface ItemCategory {
  id: string
  name: string
  sortOrder: number
  isActive: boolean
  /** Pre-fills a new item's size; null = always ask. */
  defaultSizeCode: SizeCode | null
  /** Pre-fills a new brand's department. */
  defaultDepartment: DepartmentCode
  /** The seeded category (FULL … OTHERS); null for categories added since. */
  systemKey: string | null
  itemCount: number
  onHandQty: number
}

export interface ItemCategoryPatch {
  name?: string
  defaultSizeCode?: SizeCode | null
  defaultDepartment?: DepartmentCode
  isActive?: boolean
  move?: 'up' | 'down'
}

/** One item = one SKU in one category; the brand is found or created by name. */
export interface CatalogItem extends SkuLookup {
  productId: string
  brandName: string
  productCategory: ProductCategory
  brandActive: boolean
  /** Nominal ml of one sealed bottle (excise ML summary label; stock stays whole bottles). */
  volumeMl: number | null
  exciseGroup: ExciseGroup | null
}

export interface NewItemPayload {
  categoryId: string
  name: string
  sizeCode: SizeCode
  salePrice: Paise
  purchasePrice: Paise | null
  caseSize: number
  barcode: string | null
  /** Sent only for a new brand. */
  codePrefix?: string
  /** Optional opening stock (whole bottles); never for Kitchen items. */
  openingQty?: number
  /** New brands only. */
  department?: DepartmentCode
}

/** `null` clears the purchase price or barcode; a missing key leaves the field as it is. */
export interface ItemPatchPayload {
  name?: string
  categoryId?: string
  salePrice?: Paise
  purchasePrice?: Paise | null
  caseSize?: number
  barcode?: string | null
  isActive?: boolean
  volumeMl?: number | null
  exciseGroup?: ExciseGroup | null
}

// ── Orders (Phase 17, GET /api/orders) ───────────────────────────────────────

export type OrderStatus = 'OPEN' | 'SETTLED' | 'CANCELLED' | 'VOIDED' | 'PEAK_PENDING' | 'PEAK_RECONCILED'

export interface OrderSummary {
  billId: string
  billNo: number
  createdAt: string
  settledAt: string | null
  status: OrderStatus
  mode: 'NORMAL' | 'PEAK'
  source: 'COUNTER' | 'WAITER_APP'
  waiter: { id: string; code: string; displayName: string } | null
  member: { membershipNo: string; displayName: string } | null
  peakSessionId: string | null
  peakSessionNo: number | null
  createdByStaffId: string
  lines: number
  bottles: number
  totalPaise: Paise
  cashPaise: Paise
  upiPaise: Paise
  creditPaise: Paise
  duePaise: Paise
  voidedAt: string | null
}

export interface OrderPayment {
  id: string
  tender: Tender
  amountPaise: Paise
  at: string
  /** The whole waiter payment this tender was a slice of (Waiter Ledger lump sum), or null. */
  receiptTotalPaise: Paise | null
}

export interface OrderDetail {
  summary: OrderSummary
  detail: BillDetail
  payments: OrderPayment[]
  cashier: string
  settledVia: 'COUNTER' | 'WAITER' | 'PEAK' | null
  peakSession: { sessionNo: number; endedAt: string | null } | null
  reversal: { billNo: number; at: string; reason: string; refunds: Array<{ tender: Tender; amountPaise: Paise }> } | null
}

// ── Reports (Phase 23; read-only, by business date) ─────────────────────────

export interface ReportRange {
  /** Business dates, YYYY-MM-DD. */
  startDate: string
  endDate: string
}

export interface ReportDay {
  id: string
  businessDate: string
  status: 'OPEN' | 'CLOSED'
}

export interface ReportHeader {
  range: ReportRange
  days: ReportDay[]
  /** A day in the range is still open: its figures change until Day End. */
  provisional: boolean
}

export interface RangeAnchor {
  /** The open day, else the latest closed one, else today. */
  currentBusinessDate: string
  firstBusinessDate: string | null
}

export interface SalesRegisterItem {
  name: string
  sizeCode: SizeCode
  /** Negative on a reversal. */
  qty: number
  lineTotalPaise: Paise
}

export interface SalesRegisterRow {
  billId: string
  businessDate: string
  billNo: number
  createdAt: string
  settledAt: string | null
  kind: 'SALE' | 'REVERSAL'
  reverses: { billNo: number; businessDate: string } | null
  voidedBy: { billNo: number; businessDate: string } | null
  mode: BillingMode
  status: 'SETTLED' | 'PEAK_UNSETTLED' | 'PEAK_RECONCILED'
  cashPaise: Paise
  upiPaise: Paise
  creditPaise: Paise
  waiterName: string | null
  items: SalesRegisterItem[]
  /** Negative on a reversal. */
  totalPaise: Paise
}


// ── Reports (Phase 24: the eight-module suite; TN FL2 statutory registers) ──

/** Statutory ML-summary group of a liquor SKU. */
export type ExciseGroup = 'LIQUOR' | 'BEER' | 'TIN_BEER' | 'WINE'

export interface MlFigures {
  saleUnits: number
  saleMl: number
  closingUnits: number
  closingMl: number
}

export interface MlSummary {
  groups: Array<MlFigures & { group: ExciseGroup; label: string; bySize: Array<MlFigures & { volumeMl: number }> }>
  total: MlFigures
  /** Liquor items with stock or sales but no volume / excise group (left out), by SKU code. */
  missing: string[]
}

export interface SalesSummaryRow {
  skuId: string
  skuCode: string
  name: string
  sizeCode: SizeCode
  categoryName: string
  centerCode: DepartmentCode
  centerName: string
  qty: number
  /** Billed unit price; null = the price changed inside the range ("Mixed"). */
  sRatePaise: Paise | null
  amountPaise: Paise
}

export interface SalesSummary extends ReportHeader {
  rows: SalesSummaryRow[]
  byCenter: Array<{ code: DepartmentCode; name: string; qty: number; amountPaise: Paise }>
  totalQty: number
  totalPaise: Paise
  ml: MlSummary
}

export interface MemberVisit {
  businessDate: string
  firstBillAt: string
  lastBillAt: string
  billNos: number[]
  items: Array<{ name: string; sizeCode: SizeCode; qty: number; amountPaise: Paise }>
  totalPaise: Paise
}

export interface MemberSales extends ReportHeader {
  members: Array<{ memberId: string; membershipNo: string; name: string; visits: MemberVisit[]; totalQty: number; totalPaise: Paise }>
  untagged: { billCount: number; qty: number; totalPaise: Paise }
  totalPaise: Paise
}

export interface OrderSummaryRow extends SalesRegisterRow {
  cashierName: string | null
  source: 'COUNTER' | 'WAITER_APP'
  settledByName: string | null
  peakSessionNo: number | null
  kots: Array<{ station: 'BAR' | 'KITCHEN'; ticketNo: number }>
  cancelledQty: number
}

export interface OrderSummaryReport extends ReportHeader {
  rows: OrderSummaryRow[]
  totals: { billCount: number; reversalCount: number; salesPaise: Paise; reversalsPaise: Paise; netPaise: Paise; cancelledQty: number }
  openBillCount: number
}

export interface StockSummaryRow {
  skuId: string
  skuCode: string
  name: string
  sizeCode: SizeCode
  categoryName: string
  centerCode: DepartmentCode
  centerName: string
  isActive: boolean
  volumeMl: number | null
  exciseGroup: ExciseGroup | null
  opStk: number
  purch: number
  total: number
  sale: number
  adj: number
  closing: number
  pRatePaise: Paise | null
  pRateSource: 'GRN' | 'CATALOG' | null
  sRatePaise: Paise
  cloPurchValPaise: Paise | null
  cloSalesValPaise: Paise
  salesTotalPaise: Paise
  openingValPaise: Paise | null
}

export interface StockSummaryTotals {
  opStk: number
  purch: number
  total: number
  sale: number
  adj: number
  closing: number
  cloPurchValPaise: Paise
  cloSalesValPaise: Paise
  salesTotalPaise: Paise
  openingValPaise: Paise
  unratedCount: number
  unratedClosingQty: number
}

export interface StockSummary extends ReportHeader {
  groups: Array<{ categoryName: string; rows: StockSummaryRow[]; totals: StockSummaryTotals }>
  totals: StockSummaryTotals
  hasAdjustments: boolean
  ml: MlSummary
}

export interface ExpenseReportEntry {
  id: string
  businessDate: string
  at: string
  description: string
  amountPaise: Paise
  isVoid: boolean
  voided: boolean
  byName: string
}

export interface ExpenseSummary extends ReportHeader {
  center: string | null
  byCategory: Array<{
    categoryId: string
    name: string
    centerCode: DepartmentCode | null
    centerName: string | null
    amountPaise: Paise
    count: number
    entries: ExpenseReportEntry[]
  }>
  /** code 'SHARED' = categories with no center. */
  byCenter: Array<{ code: string; name: string; amountPaise: Paise }>
  totalPaise: Paise
}

export interface PurchaseGrn {
  receiptId: string
  businessDate: string
  at: string
  invoiceNo: string
  vendorName: string | null
  receivedByName: string
  lines: Array<{ name: string; sizeCode: SizeCode; qty: number; unitCostPaise: Paise; amountPaise: Paise }>
  amountPaise: Paise
}

export interface PurchaseSupply {
  purchaseId: string
  businessDate: string
  at: string
  vendorName: string | null
  paidFrom: 'DRAWER' | 'OUTSIDE'
  note: string | null
  lines: Array<{ description: string; quantity: string | null; amountPaise: Paise }>
  amountPaise: Paise
  isVoid: boolean
  voided: boolean
  byName: string
}

export interface PurchaseSummary extends ReportHeader {
  center: string | null
  centers: Array<{
    code: DepartmentCode
    name: string
    grn: PurchaseGrn[]
    supplies: PurchaseSupply[]
    grnPaise: Paise
    suppliesPaise: Paise
    suppliesDrawerPaise: Paise
    totalPaise: Paise
  }>
  totalPaise: Paise
}

export interface BankDepositLog extends ReportHeader {
  rows: Array<{ id: string; businessDate: string; at: string; amountPaise: Paise; reference: string | null; depositorName: string; isVoid: boolean; voided: boolean }>
  totalPaise: Paise
}

export interface DayEndLogRow {
  businessDate: string
  status: 'OPEN' | 'CLOSED'
  openingFloatPaise: Paise
  expectedCashPaise: Paise
  recomputedExpectedPaise: Paise
  countedCashPaise: Paise | null
  variancePaise: Paise | null
  peakVariancePaise: Paise
  cashSalesPaise: Paise
  upiPaise: Paise
  waiterCreditPaise: Paise
  totalSalesPaise: Paise
  closedAt: string | null
  closedByName: string | null
  closedByRole: string | null
}

export interface DayEndLog extends ReportHeader {
  rows: DayEndLogRow[]
  totals: { expectedCashPaise: Paise; countedCashPaise: Paise; variancePaise: Paise; peakVariancePaise: Paise; upiPaise: Paise; totalSalesPaise: Paise }
}

export interface FullReport extends ReportHeader {
  cash: {
    openingBalancePaise: Paise
    cashSalesPaise: Paise
    waiterCashRepaidPaise: Paise
    cashExpensesPaise: Paise
    drawerPurchasesPaise: Paise
    bankDepositsPaise: Paise
    peakVariancePaise: Paise
    unreconciledPaise: Paise
    dayEndVariancePaise: Paise
    betweenDaysPaise: Paise
    closingBalancePaise: Paise
    runningPeakExpensesPaise: Paise
  }
  sales: { byCenter: Array<{ code: DepartmentCode; name: string; salesPaise: Paise }>; unallocatedPaise: Paise; totalPaise: Paise }
  payments: { cashPaise: Paise; upiPaise: Paise; waiterCreditPaise: Paise }
  expenses: { byCenter: Array<{ code: string; name: string; amountPaise: Paise }>; totalPaise: Paise }
  purchases: { byCenter: Array<{ code: DepartmentCode; name: string; grnPaise: Paise; suppliesPaise: Paise; totalPaise: Paise }>; totalPaise: Paise }
  bankDepositsPaise: Paise
  stock: { openingValuePaise: Paise; closingValuePaise: Paise; unratedCount: number }
}
