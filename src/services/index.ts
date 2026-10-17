export { BillingService } from './billing.service.js';
export type { BillLine, CounterPayment, ReversalResult, ReverseBillOptions, SettledBill } from './billing.service.js';
export {
  CatalogService,
  DEFAULT_CASE_SIZE,
  MAX_CASE_SIZE,
  PRODUCT_CATEGORIES,
  SIZE_CODES,
  displayNameFor,
  skuCodeFor,
} from './catalog.service.js';
export type { CatalogFilter, CatalogProduct, CatalogSku, NewProductInput, NewSkuInput, ProductCategory, ProductPatch, SkuPatch } from './catalog.service.js';
export { CaptainService, MAX_ORDER_LINES, orderFingerprint } from './captain.service.js';
export type { KotStatus, OrderLine, OrderRequest, PlacedOrder, WaiterProfile } from './captain.service.js';
export { CounterQueries } from './counter-queries.js';
export type {
  BillDetail,
  BillDetailItem,
  BusinessDaySummary,
  CounterContext,
  MemberSummary,
  PeakSessionView,
  SkuLookup,
  StaffRole,
  StaffSummary,
  WaiterSummary,
} from './counter-queries.js';
export { DayEndService, EXPENSE_CATEGORIES } from './day-end.service.js';
export type {
  CashBreakdown,
  CashExpense,
  DayEndBlockers,
  DayEndSummary,
  DaySummary,
  ExpenseCategory,
  ExpenseEntry,
  OpenBillBlocker,
  OwingWaiter,
  PeakSessionCash,
} from './day-end.service.js';
export { PeakSessionService } from './peak-session.service.js';
export { MAX_RECEIPT_LINES, MAX_RECEIPT_QTY, PurchaseService } from './purchase.service.js';
export type { ReceiptInput, ReceiptLineInput, StockReceipt, StockReceiptDetail, StockReceiptLine } from './purchase.service.js';
export { formatKot, PrinterService } from './printer.service.js';
export type { KotFormat, KotPrinter, KotPrintResult, KotStation, KotTicket } from './printer.service.js';
export type { PeakBreakdown, PeakReconciliation } from './peak-session.service.js';
export { WaiterService } from './waiter.service.js';
export type { WaiterRepayment, WaiterSettlement } from './waiter.service.js';
export { IdempotencyConflictError, InactiveError, NotFoundError, PosError, PosErrorCode, isPosError } from '../db/errors.js';
