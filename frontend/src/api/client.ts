import type {
  BankDeposit,
  BankDepositEntry,
  Bill,
  BillDetail,
  BillingMode,
  BillLine,
  CounterContext,
  CounterPayment,
  CounterTender,
  DayEndSummary,
  DaySummary,
  Department,
  DepartmentCode,
  CashExpense,
  CatalogProduct,
  ExpenseCategory,
  ExpenseCategoryPatch,
  ExpenseEntry,
  KotStatus,
  MemberSummary,
  NewProductPayload,
  NewSkuPayload,
  Paise,
  PeakReconciliation,
  PeakSession,
  PeakStartBaseline,
  PeakUndoResult,
  TenderAdjustment,
  ProductPatch,
  ReceiptLinePayload,
  SkuLookup,
  SkuPatchPayload,
  StockReceipt,
  StockReceiptDetail,
  Tender,
  OrderDetail,
  OrderSummary,
  WaiterBillsSettlement,
  WaiterLedger,
  WaiterLedgerRow,
  WaiterReceipt,
  WaiterSettlement,
  WaiterStatsReport,
  WaiterSummary,
} from './types'

/** A failed API call. `code` is the server's error code (PS001–PS012, NOT_FOUND, …) or NETWORK. */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly status: number
  readonly code: string
  /** The database constraint behind a 409, when one fired (e.g. `skus_barcode_unique`). */
  readonly constraint: string | undefined

  constructor(status: number, code: string, message: string, constraint?: string) {
    super(message)
    this.status = status
    this.code = code
    this.constraint = constraint
  }
}

const PAISE_STRING = /^-?\d+$/

/** JSON.parse reviver: every `…Paise` field arrives as a decimal string and becomes a bigint. */
export function reviveJson(key: string, value: unknown): unknown {
  return key.endsWith('Paise') && typeof value === 'string' && PAISE_STRING.test(value) ? BigInt(value) : value
}

/** JSON.stringify replacer: bigint paise go out as decimal strings, never JS numbers. */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
}

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : encodeJson(body ?? {}),
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'cannot reach the POS server')
  }
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text, reviveJson) : undefined
  } catch {
    // The Vite proxy answers with a non-JSON 5xx when the API process is down.
    throw new ApiError(res.status, res.status >= 500 ? 'NETWORK' : 'BAD_RESPONSE', 'unexpected response from the POS server')
  }
  if (!res.ok) {
    const error = (parsed as { error?: { code?: string; message?: string; constraint?: string } } | undefined)?.error
    throw new ApiError(res.status, error?.code ?? 'INTERNAL', error?.message ?? `HTTP ${res.status}`, error?.constraint)
  }
  return parsed as T
}

const bill = (billId: string) => `/api/bills/${encodeURIComponent(billId)}`

export const api = {
  context: () => call<CounterContext>('GET', '/api/context'),
  lookupSku: (code: string) => call<SkuLookup>('GET', `/api/skus/lookup?code=${encodeURIComponent(code)}`),
  searchSkus: (q: string) => call<SkuLookup[]>('GET', `/api/skus?q=${encodeURIComponent(q)}&limit=12`),
  searchMembers: (q: string) => call<MemberSummary[]>('GET', `/api/members?q=${encodeURIComponent(q)}&limit=12`),
  listWaiters: () => call<WaiterSummary[]>('GET', '/api/waiters'),
  waiterStats: () => call<WaiterStatsReport>('GET', '/api/waiters/stats'),
  getBill: (billId: string) => call<BillDetail>('GET', bill(billId)),
  captainOrders: () => call<BillDetail[]>('GET', '/api/captain-orders'),

  createBill: (mode: BillingMode, memberId?: string) =>
    call<Bill>('POST', '/api/bills', memberId === undefined ? { mode } : { mode, memberId }),
  addItem: (billId: string, skuId: string, quantity: number) =>
    call<BillLine>('POST', `${bill(billId)}/items`, { skuId, quantity }),
  /** `restock: false` keeps the bottle out of stock (broken or opened). */
  cancelItem: (billId: string, itemId: string, quantity: number, restock = true) =>
    call<BillLine>('POST', `${bill(billId)}/items/${encodeURIComponent(itemId)}/cancel`, { quantity, restock }),
  setMember: (billId: string, memberId: string | null) => call<Bill>('PUT', `${bill(billId)}/member`, { memberId }),
  tagWaiter: (billId: string, waiterId: string) => call<Bill>('PUT', `${bill(billId)}/waiter`, { waiterId }),
  settle: (billId: string, payments: CounterPayment[]) => call<{ bill: Bill; kots: KotStatus[] }>('POST', `${bill(billId)}/settle`, { payments }),
  /** F6: prints the bill's pending Kitchen lines (and CANCELs). */
  sendKot: (billId: string) => call<{ kots: KotStatus[] }>('POST', `${bill(billId)}/kot`, {}),
  settleWaiter: (billId: string, waiterId: string, tender: Tender, amount?: Paise) =>
    call<WaiterSettlement>('POST', `${bill(billId)}/settle-waiter`, amount === undefined ? { waiterId, tender } : { waiterId, tender, amount }),
  closeEmpty: (billId: string) => call<Bill>('POST', `${bill(billId)}/close-empty`),
  reverse: (billId: string, reason: string) => call<{ reversal: Bill }>('POST', `${bill(billId)}/reverse`, { reason }),
  peakSale: (sessionId: string, skuId: string, quantity: number) =>
    call<BillLine>('POST', '/api/peak/sales', { sessionId, skuId, quantity }),
  /** Voids this till's newest peak scan in the running session (404 when none is left). */
  undoLastPeak: () => call<PeakUndoResult>('POST', '/api/peak/undo-last'),
  /** Expected drawer cash and UPI so far on the open day (404 when no day is open). */
  peakBaseline: () => call<PeakStartBaseline>('GET', '/api/peak/baseline'),
  startPeak: (businessDayId: string, declaredCash: Paise, declaredUpi: Paise) =>
    call<PeakSession>('POST', '/api/peak/sessions', { businessDayId, declaredCash, declaredUpi }),
  endPeak: (sessionId: string, countedCash: Paise, countedUpi: Paise) =>
    call<PeakReconciliation>('POST', `/api/peak/sessions/${encodeURIComponent(sessionId)}/end`, { countedCash, countedUpi }),
  orders: () => call<OrderSummary[]>('GET', '/api/orders'),
  order: (billId: string) => call<OrderDetail>('GET', `/api/orders/${encodeURIComponent(billId)}`),
  /** Prints a DUPLICATE receipt on the counter printer and returns its text. */
  reprintOrder: (billId: string) => call<{ printedAt: string; text: string }>('POST', `/api/orders/${encodeURIComponent(billId)}/reprint`),
  waiterLedger: () => call<WaiterLedgerRow[]>('GET', '/api/waiter-ledger'),
  waiterLedgerDetail: (waiterId: string) => call<WaiterLedger>('GET', `/api/waiter-ledger/${encodeURIComponent(waiterId)}`),
  /** Mode A: the chosen bills, each for exactly its due, with one tender (all or nothing). */
  settleWaiterBills: (waiterId: string, billIds: string[], tender: Tender) =>
    call<WaiterBillsSettlement>('POST', `/api/waiters/${encodeURIComponent(waiterId)}/settle-bills`, { billIds, tender }),
  /** Mode B (trusted waiters): a lump sum, oldest open bill first, then the credit balance. */
  receiveWaiterPayment: (waiterId: string, amount: Paise, tender: CounterTender) =>
    call<WaiterReceipt>('POST', `/api/waiters/${encodeURIComponent(waiterId)}/receive`, { amount, tender }),
  repayWaiter: (waiterId: string, amount: Paise, tender: CounterTender) =>
    call<{ outstandingPaise: Paise }>('POST', `/api/waiters/${encodeURIComponent(waiterId)}/repayments`, { amount, tender }),

  /** The open day's checklist and cash breakdown, else the last closed day's (404 before any day). */
  dayEnd: () => call<DayEndSummary>('GET', '/api/day-end'),
  /** Tally tool: positive cashDelta moves revenue UPI → Cash; the UPI side is always −cashDelta. */
  adjustTenderSplit: (dayId: string, cashDelta: Paise, reason: string) =>
    call<TenderAdjustment>('POST', `/api/days/${encodeURIComponent(dayId)}/tender-adjustments`, { cashDelta, reason }),
  voidTenderAdjustment: (adjustmentId: string) =>
    call<TenderAdjustment>('POST', `/api/tender-adjustments/${encodeURIComponent(adjustmentId)}/void`),
  closeDay: (dayId: string, countedCash: Paise) => call<DayEndSummary>('POST', `/api/days/${encodeURIComponent(dayId)}/close`, { countedCash }),
  openDay: (openingFloat: Paise) => call<DaySummary>('POST', '/api/days', { openingFloat }),

  /** The open day's expenses, newest first (404 when no day is open). */
  listExpenses: () => call<ExpenseEntry[]>('GET', '/api/expenses'),
  addExpense: (amount: Paise, categoryId: string, description: string | null) =>
    call<CashExpense>('POST', '/api/expenses', { amount, categoryId, description }),
  /** Active categories in picker order; with `includeInactive`, disabled ones too (Settings). */
  listExpenseCategories: (includeInactive = false) =>
    call<ExpenseCategory[]>('GET', `/api/expense-categories${includeInactive ? '?includeInactive=1' : ''}`),
  createExpenseCategory: (name: string, noteRequired: boolean, department: DepartmentCode | null) =>
    call<ExpenseCategory>('POST', '/api/expense-categories', { name, noteRequired, department }),
  updateExpenseCategory: (categoryId: string, patch: ExpenseCategoryPatch) =>
    call<ExpenseCategory>('PATCH', `/api/expense-categories/${encodeURIComponent(categoryId)}`, patch),
  voidExpense: (expenseId: string) => call<CashExpense>('POST', `/api/expenses/${encodeURIComponent(expenseId)}/void`),
  listBankDeposits: () => call<BankDepositEntry[]>('GET', '/api/bank-deposits'),
  addBankDeposit: (amount: Paise, reference: string | null) => call<BankDeposit>('POST', '/api/bank-deposits', { amount, reference }),
  voidBankDeposit: (depositId: string) => call<BankDeposit>('POST', `/api/bank-deposits/${encodeURIComponent(depositId)}/void`),

  /** The open day's stock receipts, newest first (404 when no day is open). */
  listPurchases: () => call<StockReceipt[]>('GET', '/api/purchases'),
  postPurchase: (invoiceNo: string, vendorName: string | null, lines: ReceiptLinePayload[]) =>
    call<StockReceiptDetail>('POST', '/api/purchases', { invoiceNo, vendorName, lines }),

  /** Liquors with their sizes; inactive ones only with `includeInactive`. */
  listDepartments: () => call<Department[]>('GET', '/api/departments'),
  listCatalog: (q: string, includeInactive: boolean) =>
    call<CatalogProduct[]>('GET', `/api/catalog?q=${encodeURIComponent(q)}&includeInactive=${includeInactive}`),
  createProduct: (payload: NewProductPayload) => call<CatalogProduct>('POST', '/api/catalog/products', payload),
  updateProduct: (productId: string, patch: ProductPatch) =>
    call<CatalogProduct>('PATCH', `/api/catalog/products/${encodeURIComponent(productId)}`, patch),
  addSku: (productId: string, sku: NewSkuPayload) =>
    call<CatalogProduct>('POST', `/api/catalog/products/${encodeURIComponent(productId)}/skus`, sku),
  updateSku: (skuId: string, patch: SkuPatchPayload) => call<CatalogProduct>('PATCH', `/api/catalog/skus/${encodeURIComponent(skuId)}`, patch),
}
