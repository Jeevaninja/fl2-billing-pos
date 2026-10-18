/**
 * Counter HTTP API (loopback only): a thin JSON bridge from the POS frontend to the service layer.
 * It holds no business rules of its own; every rule is enforced by the services and the database.
 * The Captain app has its own server (captain-server.ts).
 */
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import type { SqlDatabase } from '../src/db/client.js';
import type { CounterTender, Tender } from '../src/domain/types.js';
import {
  BillingService,
  CatalogService,
  CounterQueries,
  DayEndService,
  EXPENSE_CATEGORIES,
  NotFoundError,
  OrdersQueries,
  PeakSessionService,
  PrinterService,
  PRODUCT_CATEGORIES,
  PurchaseService,
  receiptFor,
  SIZE_CODES,
  WaiterService,
  type CounterPayment,
  type NewSkuInput,
  type ReceiptLineInput,
  type ReceiptPrinter,
  type SkuPatch,
} from '../src/services/index.js';
import {
  BadRequestError,
  type Body,
  id,
  int,
  oneOf,
  optBool,
  optId,
  optOneOf,
  optPaise,
  paise,
  signedPaise,
  str,
} from './json.js';
import { created, createJsonHandler, HttpError, ok, type RequestContext, route, type Route } from './routing.js';

export interface ApiConfig {
  db: SqlDatabase;
  /** Staff row the counter acts as until staff login exists. */
  cashierId: string;
  /** Receipt printer for Orders reprints; defaults to the console stub. */
  printer?: ReceiptPrinter;
}

const COUNTER_TENDERS = ['CASH', 'UPI'] as const satisfies readonly CounterTender[];
const TENDERS = ['CASH', 'UPI', 'WAITER_CREDIT'] as const satisfies readonly Tender[];
/** Loopback names only: blocks DNS-rebinding pages from reaching the till through a foreign Host. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Optional, nullable text: undefined = unchanged, null = clear. */
function optNullableStr(value: unknown, name: string): string | null | undefined {
  return value === undefined || value === null ? (value as null | undefined) : str(value, name);
}

function newSku(value: unknown, name: string): NewSkuInput {
  const sku = (value ?? {}) as Body;
  return {
    sizeCode: oneOf(sku.sizeCode, `${name}.sizeCode`, SIZE_CODES),
    salePricePaise: paise(sku.salePrice, `${name}.salePrice`),
    purchasePricePaise: sku.purchasePrice === undefined || sku.purchasePrice === null ? null : paise(sku.purchasePrice, `${name}.purchasePrice`),
    caseSize: int(sku.caseSize, `${name}.caseSize`),
    barcode: optNullableStr(sku.barcode, `${name}.barcode`) ?? null,
  };
}

/** A GRN line: `{ cases, looseBottles, caseSize }` (Phase 10) or the loose-only `{ quantity }`. */
function receiptLine(value: unknown, i: number): ReceiptLineInput {
  const line = (value ?? {}) as Body;
  const name = `lines[${i}]`;
  const base = { skuId: id(line.skuId, `${name}.skuId`), unitCostPaise: paise(line.unitCost, `${name}.unitCost`) };
  if (line.cases === undefined) return { ...base, quantity: int(line.quantity, `${name}.quantity`) };
  return {
    ...base,
    cases: int(line.cases, `${name}.cases`),
    looseBottles: line.looseBottles === undefined ? 0 : int(line.looseBottles, `${name}.looseBottles`),
    caseSize: int(line.caseSize, `${name}.caseSize`),
  };
}

function buildRoutes({ db, cashierId, printer = new PrinterService() }: ApiConfig): Route[] {
  const billing = new BillingService(db);
  const peak = new PeakSessionService(db);
  const waiters = new WaiterService(db);
  const queries = new CounterQueries(db);
  const dayEnd = new DayEndService(db);
  const purchases = new PurchaseService(db);
  const catalog = new CatalogService(db);
  const orders = new OrdersQueries(db);

  return [
    route('GET', '/api/health', async () => ok({ ok: true })),
    route('GET', '/api/context', async () => ok(await queries.getCounterContext(cashierId))),

    route('GET', '/api/skus/lookup', async ({ query }) => {
      const code = query.get('code') ?? '';
      const sku = await queries.lookupSku(code);
      if (!sku) throw new NotFoundError('sku', code);
      return ok(sku);
    }),
    route('GET', '/api/skus', async ({ query }) => {
      const limit = query.has('limit') ? int(Number(query.get('limit')), 'limit') : undefined;
      if (limit !== undefined && (limit < 1 || limit > 50)) throw new BadRequestError('limit must be 1–50');
      return ok(await queries.searchSkus(query.get('q') ?? '', limit));
    }),
    route('GET', '/api/members', async ({ query }) => {
      const limit = query.has('limit') ? int(Number(query.get('limit')), 'limit') : undefined;
      if (limit !== undefined && (limit < 1 || limit > 100)) throw new BadRequestError('limit must be 1–100');
      return ok(await queries.searchMembers(query.get('q') ?? '', limit));
    }),
    route('GET', '/api/waiters', async () => ok(await queries.listWaiters())),
    route('GET', '/api/waiters/stats', async () => ok(await queries.getWaiterStats())),
    route('GET', '/api/captain-orders', async () => ok(await queries.listCaptainOrders())),

    // ── Bills ──
    route('GET', '/api/bills/:billId', async ({ params }) => ok(await queries.getBillDetail(id(params.billId, 'billId')))),
    route('POST', '/api/bills', async ({ body }) =>
      created(await billing.createBill(oneOf(body.mode, 'mode', ['NORMAL', 'PEAK']), cashierId, optId(body.memberId, 'memberId'))),
    ),
    route('POST', '/api/bills/:billId/items', async ({ params, body }) =>
      created(await billing.addItemToBill(id(params.billId, 'billId'), id(body.skuId, 'skuId'), int(body.quantity, 'quantity'))),
    ),
    route('POST', '/api/bills/:billId/items/:itemId/cancel', async ({ params, body }) => {
      const restock = optBool(body.restock, 'restock');
      return created(
        await billing.cancelBillItem(
          id(params.billId, 'billId'),
          id(params.itemId, 'itemId'),
          int(body.quantity, 'quantity'),
          restock === undefined ? {} : { restock },
        ),
      );
    }),
    route('PUT', '/api/bills/:billId/member', async ({ params, body }) => {
      if (!('memberId' in body)) throw new BadRequestError('memberId is required (null to clear)');
      return ok(await billing.setBillMember(id(params.billId, 'billId'), body.memberId === null ? null : id(body.memberId, 'memberId')));
    }),
    route('PUT', '/api/bills/:billId/waiter', async ({ params, body }) =>
      ok(await waiters.tagBillToWaiter(id(params.billId, 'billId'), id(body.waiterId, 'waiterId'))),
    ),
    route('POST', '/api/bills/:billId/settle', async ({ params, body }) => {
      if (!Array.isArray(body.payments)) throw new BadRequestError('payments must be an array');
      const payments = body.payments.map((p: unknown, i): CounterPayment => {
        const tender = (p ?? {}) as Body;
        return {
          mode: oneOf(tender.mode, `payments[${i}].mode`, COUNTER_TENDERS),
          amount: paise(tender.amount, `payments[${i}].amount`),
        };
      });
      return ok(await billing.settleNormalBill(id(params.billId, 'billId'), payments));
    }),
    route('POST', '/api/bills/:billId/settle-waiter', async ({ params, body }) =>
      ok(
        await waiters.settleWaiterBill(
          id(params.billId, 'billId'),
          id(body.waiterId, 'waiterId'),
          oneOf(body.tender, 'tender', TENDERS),
          optPaise(body.amount, 'amount'),
        ),
      ),
    ),
    route('POST', '/api/bills/:billId/close-empty', async ({ params }) => ok(await billing.closeEmptyBill(id(params.billId, 'billId')))),
    route('POST', '/api/bills/:billId/reverse', async ({ params, body }) => {
      const restock = optBool(body.restock, 'restock');
      const creditRefundTender = optOneOf(body.creditRefundTender, 'creditRefundTender', COUNTER_TENDERS);
      const peakRefundTender = optOneOf(body.peakRefundTender, 'peakRefundTender', COUNTER_TENDERS);
      return created(
        await billing.reverseBill(id(params.billId, 'billId'), str(body.reason, 'reason'), cashierId, {
          ...(restock === undefined ? {} : { restock }),
          ...(creditRefundTender === undefined ? {} : { creditRefundTender }),
          ...(peakRefundTender === undefined ? {} : { peakRefundTender }),
        }),
      );
    }),

    // ── Peak ──
    route('POST', '/api/peak/undo-last', async () => created(await billing.undoLastPeakSale(cashierId))),
    route('GET', '/api/peak/baseline', async () => {
      const day = await queries.getCounterContext(cashierId);
      if (!day.businessDay) throw new NotFoundError('business day', 'open');
      return ok(await peak.getStartBaseline(day.businessDay.id));
    }),
    route('POST', '/api/peak/sales', async ({ body }) =>
      created(
        await billing.recordPeakSale(id(body.sessionId, 'sessionId'), id(body.skuId, 'skuId'), int(body.quantity, 'quantity'), cashierId),
      ),
    ),
    route('POST', '/api/peak/sessions', async ({ body }) =>
      created(
        await peak.startPeakSession(
          id(body.businessDayId, 'businessDayId'),
          paise(body.declaredCash, 'declaredCash'),
          paise(body.declaredUpi, 'declaredUpi'),
          cashierId,
        ),
      ),
    ),
    route('POST', '/api/peak/sessions/:sessionId/end', async ({ params, body }) =>
      ok(
        await peak.endPeakSession(
          id(params.sessionId, 'sessionId'),
          paise(body.countedCash, 'countedCash'),
          paise(body.countedUpi, 'countedUpi'),
          cashierId,
        ),
      ),
    ),

    // ── Day End ──
    route('GET', '/api/day-end', async () => {
      const dayId = await dayEnd.getCurrentDayId();
      if (!dayId) throw new NotFoundError('business day', 'current');
      return ok(await dayEnd.getDayEndSummary(dayId));
    }),
    route('POST', '/api/days', async ({ body }) => created(await dayEnd.openBusinessDay(paise(body.openingFloat, 'openingFloat'), cashierId))),
    route('POST', '/api/days/:dayId/close', async ({ params, body }) =>
      ok(await dayEnd.closeBusinessDay(id(params.dayId, 'dayId'), paise(body.countedCash, 'countedCash'), cashierId)),
    ),
    route('POST', '/api/days/:dayId/tender-adjustments', async ({ params, body }) =>
      created(await dayEnd.adjustTenderSplit(id(params.dayId, 'dayId'), signedPaise(body.cashDelta, 'cashDelta'), str(body.reason, 'reason'), cashierId)),
    ),
    route('POST', '/api/tender-adjustments/:adjustmentId/void', async ({ params }) =>
      created(await dayEnd.voidTenderAdjustment(id(params.adjustmentId, 'adjustmentId'), cashierId)),
    ),
    route('GET', '/api/expenses', async () => {
      const day = await queries.getCounterContext(cashierId);
      if (!day.businessDay) throw new NotFoundError('business day', 'open');
      return ok(await dayEnd.listCashExpenses(day.businessDay.id));
    }),
    route('POST', '/api/expenses', async ({ body }) =>
      created(
        await dayEnd.recordCashExpense(
          paise(body.amount, 'amount'),
          body.description === undefined || body.description === null ? null : str(body.description, 'description'),
          cashierId,
          optOneOf(body.category, 'category', EXPENSE_CATEGORIES) ?? 'OTHER',
        ),
      ),
    ),
    route('POST', '/api/expenses/:expenseId/void', async ({ params }) =>
      created(await dayEnd.voidCashExpense(id(params.expenseId, 'expenseId'), cashierId)),
    ),
    route('GET', '/api/bank-deposits', async () => {
      const day = await queries.getCounterContext(cashierId);
      if (!day.businessDay) throw new NotFoundError('business day', 'open');
      return ok(await dayEnd.listBankDeposits(day.businessDay.id));
    }),
    route('POST', '/api/bank-deposits', async ({ body }) =>
      created(
        await dayEnd.recordBankDeposit(
          paise(body.amount, 'amount'),
          body.reference === undefined || body.reference === null ? null : str(body.reference, 'reference'),
          cashierId,
        ),
      ),
    ),
    route('POST', '/api/bank-deposits/:depositId/void', async ({ params }) =>
      created(await dayEnd.voidBankDeposit(id(params.depositId, 'depositId'), cashierId)),
    ),

    // ── Purchase (GRN) ──
    route('GET', '/api/purchases', async () => {
      const day = await queries.getCounterContext(cashierId);
      if (!day.businessDay) throw new NotFoundError('business day', 'open');
      return ok(await purchases.listReceipts(day.businessDay.id));
    }),
    route('GET', '/api/purchases/:receiptId', async ({ params }) => ok(await purchases.getReceipt(id(params.receiptId, 'receiptId')))),
    route('POST', '/api/purchases', async ({ body }) => {
      if (!Array.isArray(body.lines)) throw new BadRequestError('lines must be an array');
      const lines = body.lines.map((l: unknown, i) => receiptLine(l, i));
      const vendorName = body.vendorName === undefined || body.vendorName === null ? null : str(body.vendorName, 'vendorName');
      return created(await purchases.recordReceipt({ invoiceNo: str(body.invoiceNo, 'invoiceNo'), vendorName, lines }, cashierId));
    }),

    // ── Inventory catalog ──
    route('GET', '/api/catalog', async ({ query }) =>
      ok(await catalog.listCatalog({ q: query.get('q') ?? '', includeInactive: query.get('includeInactive') === 'true' })),
    ),
    route('POST', '/api/catalog/products', async ({ body }) => {
      if (!Array.isArray(body.skus)) throw new BadRequestError('skus must be an array');
      return created(
        await catalog.createProduct({
          name: str(body.name, 'name'),
          category: oneOf(body.category, 'category', PRODUCT_CATEGORIES),
          codePrefix: str(body.codePrefix, 'codePrefix'),
          skus: body.skus.map((s: unknown, i) => newSku(s, `skus[${i}]`)),
        }),
      );
    }),
    route('PATCH', '/api/catalog/products/:productId', async ({ params, body }) =>
      ok(
        await catalog.updateProduct(id(params.productId, 'productId'), {
          name: body.name === undefined ? undefined : str(body.name, 'name'),
          category: optOneOf(body.category, 'category', PRODUCT_CATEGORIES),
          isActive: optBool(body.isActive, 'isActive'),
        }),
      ),
    ),
    route('POST', '/api/catalog/products/:productId/skus', async ({ params, body }) =>
      created(
        await catalog.addSku(id(params.productId, 'productId'), {
          ...newSku(body, 'sku'),
          codePrefix: body.codePrefix === undefined ? undefined : str(body.codePrefix, 'codePrefix'),
        }),
      ),
    ),
    route('PATCH', '/api/catalog/skus/:skuId', async ({ params, body }) => {
      const patch: SkuPatch = {
        salePricePaise: optPaise(body.salePrice, 'salePrice'),
        purchasePricePaise: body.purchasePrice === null ? null : optPaise(body.purchasePrice, 'purchasePrice'),
        caseSize: body.caseSize === undefined ? undefined : int(body.caseSize, 'caseSize'),
        barcode: optNullableStr(body.barcode, 'barcode'),
        isActive: optBool(body.isActive, 'isActive'),
      };
      return ok(await catalog.updateSku(id(params.skuId, 'skuId'), patch));
    }),

    // ── Orders (Phase 17) ──
    route('GET', '/api/orders', async () => ok(await orders.listOrders())),
    route('GET', '/api/orders/:billId', async ({ params }) => ok(await orders.getOrder(id(params.billId, 'billId')))),
    route('POST', '/api/orders/:billId/reprint', async ({ params }) => {
      const order = await orders.getOrder(id(params.billId, 'billId'));
      return created(await printer.printReceipt(receiptFor(order, new Date())));
    }),

    // ── Waiter accounts ──
    route('GET', '/api/waiter-ledger', async () => ok(await queries.listWaiterLedger())),
    route('GET', '/api/waiter-ledger/:waiterId', async ({ params }) => ok(await queries.getWaiterLedger(id(params.waiterId, 'waiterId')))),
    route('POST', '/api/waiters/:waiterId/settle-bills', async ({ params, body }) => {
      if (!Array.isArray(body.billIds)) throw new BadRequestError('billIds must be an array of bill ids');
      return created(
        await waiters.settleWaiterBills(
          id(params.waiterId, 'waiterId'),
          body.billIds.map((b: unknown, i: number) => id(b, `billIds[${i}]`)),
          oneOf(body.tender, 'tender', TENDERS),
          cashierId,
        ),
      );
    }),
    route('POST', '/api/waiters/:waiterId/receive', async ({ params, body }) =>
      created(
        await waiters.receiveWaiterPayment(
          id(params.waiterId, 'waiterId'),
          paise(body.amount, 'amount'),
          oneOf(body.tender, 'tender', COUNTER_TENDERS),
          cashierId,
        ),
      ),
    ),
    route('POST', '/api/waiters/:waiterId/repayments', async ({ params, body }) =>
      created(
        await waiters.recordWaiterRepayment(
          id(params.waiterId, 'waiterId'),
          paise(body.amount, 'amount'),
          oneOf(body.tender, 'tender', COUNTER_TENDERS),
          cashierId,
        ),
      ),
    ),
  ];
}

/** Counter API admission: loopback Host names only (blocks DNS-rebinding pages). */
function admitLocal(req: IncomingMessage): RequestContext {
  if (!LOCAL_HOST.test(req.headers.host ?? '')) throw new HttpError(403, 'FORBIDDEN', 'the POS API only answers on localhost');
  return {};
}

export function createApiHandler(config: ApiConfig): RequestListener {
  return createJsonHandler(buildRoutes(config), admitLocal);
}

export function createApiServer(config: ApiConfig): Server {
  return createServer(createApiHandler(config));
}
