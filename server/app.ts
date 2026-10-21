/**
 * Counter HTTP API (loopback only): a thin JSON bridge from the POS frontend to the service layer.
 * It holds no business rules of its own; every rule is enforced by the services and the database.
 * The Captain app has its own server (captain-server.ts).
 */
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import type { SqlDatabase } from '../src/db/client.js';
import type { CounterTender, Tender } from '../src/domain/types.js';
import {
  AuthService,
  BillingService,
  COUNTER_ROLES,
  CatalogService,
  CounterQueries,
  DayEndService,
  DEPARTMENT_STATIONS,
  DepartmentService,
  ExpenseCategoryService,
  ItemCategoryService,
  RevenueCenterService,
  KotService,
  ReportService,
  NotFoundError,
  OrdersQueries,
  PeakSessionService,
  PrinterService,
  PRODUCT_CATEGORIES,
  PurchaseService,
  receiptFor,
  SIZE_CODES,
  EXCISE_GROUPS,
  WaiterService,
  type CounterPayment,
  type ExpenseCategoryPatch,
  type ItemCategoryPatch,
  type ItemPatch,
  type KotPrinter,
  type NewSkuInput,
  type ReceiptLineInput,
  type ReceiptPrinter,
  type ScryptCost,
  type SkuPatch,
  type StaffPatch,
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
import { clearedSessionCookie, type Session, sessionCookie, SessionStore, sessionToken } from './sessions.js';

export interface ApiConfig {
  db: SqlDatabase;
  /** Staff row the counter acts as until staff login exists. */
  cashierId: string;
  /** Receipt printer for Orders reprints; defaults to the console stub. */
  printer?: ReceiptPrinter;
  /** KOT printer (BAR / KITCHEN stations); defaults to the console stub. */
  kotPrinter?: KotPrinter;
  /** Signed-in sessions (Phase 25); a fresh in-memory store by default. */
  sessions?: SessionStore;
  /** scrypt cost for PINs set through the API (tests pass a cheap one). */
  scryptCost?: ScryptCost;
}

/** Routes answered without a session: health, and the sign-in endpoints themselves. */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/api/health', '/api/auth/session', '/api/auth/login', '/api/auth/logout']);

/** The signed-in admin, or 403 (every session is an admin's today; the check keeps it that way). */
function requireAdmin(session: Session | undefined): Session {
  if (!session || session.staff.role !== 'ADMIN') throw new HttpError(403, 'FORBIDDEN', 'only an admin can manage staff');
  return session;
}

/** A PIN as a string of digits (the service checks 4–6), or null to clear it. */
function pinValue(value: unknown, name: string, { nullable = false } = {}): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') throw new BadRequestError(`${name} must be a string of digits`);
  return value;
}

const COUNTER_TENDERS = ['CASH', 'UPI'] as const satisfies readonly CounterTender[];
const TENDERS = ['CASH', 'UPI', 'WAITER_CREDIT'] as const satisfies readonly Tender[];
/** Loopback names only: blocks DNS-rebinding pages from reaching the till through a foreign Host. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Optional revenue-center code (the service checks it exists); `null` only where it means Shared (expense categories). */
function optDepartment(value: unknown, name: string, { nullable = false } = {}): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{1,29}$/.test(value)) throw new BadRequestError(`${name} must be a revenue center code`);
  return value;
}

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

function buildRoutes(
  { db, cashierId, printer = new PrinterService(), kotPrinter = new PrinterService(), scryptCost }: ApiConfig,
  sessions: SessionStore,
): Route[] {
  const auth = new AuthService(db, scryptCost);
  const billing = new BillingService(db);
  const peak = new PeakSessionService(db);
  const waiters = new WaiterService(db);
  const queries = new CounterQueries(db);
  const dayEnd = new DayEndService(db);
  const purchases = new PurchaseService(db);
  const catalog = new CatalogService(db);
  const orders = new OrdersQueries(db);
  const expenseCategories = new ExpenseCategoryService(db);
  const itemCategories = new ItemCategoryService(db);
  const centers = new RevenueCenterService(db);
  const departments = new DepartmentService(db);
  const reports = new ReportService(db);
  /** `?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` (business dates; the service validates them). */
  const reportRange = (query: URLSearchParams) => ({ startDate: query.get('startDate') ?? '', endDate: query.get('endDate') ?? '' });
  const currentDayId = async () => {
    const dayId = await dayEnd.getCurrentDayId();
    if (!dayId) throw new NotFoundError('business day', 'current');
    return dayId;
  };
  const kot = new KotService(db, kotPrinter);
  /** Sends a bill's pending Kitchen lines after the sale committed (the counter is the bar). */
  const sendKitchen = (billId: string, includeReversals = false) =>
    kot.sendPending(billId, { staffId: cashierId }, { stations: ['KITCHEN'], includeReversals });

  return [
    route('GET', '/api/health', async () => ok({ ok: true })),

    // Phase 25: Super Admin sign-in (D1, D3) and staff PINs (D5, D6).
    route('GET', '/api/auth/session', async ({ context }) => {
      const adminConfigured = await auth.adminConfigured();
      const { session } = context;
      return ok(session ? { authenticated: true, staff: session.staff, expiresAt: session.expiresAt, adminConfigured } : { authenticated: false, adminConfigured });
    }),
    route('POST', '/api/auth/login', async ({ body, context }) => {
      const staff = await auth.login(str(body.username, 'username'), str(body.password, 'password'));
      sessions.revoke(context.sessionToken);
      const { token, session } = sessions.issue(staff);
      const maxAge = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
      return { body: { authenticated: true, staff, expiresAt: session.expiresAt }, headers: { 'set-cookie': sessionCookie(token, maxAge) } };
    }),
    route('POST', '/api/auth/logout', async ({ context }) => {
      sessions.revoke(context.sessionToken);
      return { body: { authenticated: false }, headers: { 'set-cookie': clearedSessionCookie() } };
    }),
    route('GET', '/api/staff/pin-holders', async () => ok(await auth.pinHolders())),
    route('GET', '/api/staff', async ({ context }) => {
      requireAdmin(context.session);
      return ok(await auth.listStaff());
    }),
    route('POST', '/api/staff', async ({ body, context }) => {
      requireAdmin(context.session);
      return created(
        await auth.createStaff({
          displayName: str(body.displayName, 'displayName'),
          role: oneOf(body.role, 'role', COUNTER_ROLES),
          pin: body.pin === undefined || body.pin === null ? null : pinValue(body.pin, 'pin'),
        }),
      );
    }),
    route('PATCH', '/api/staff/:staffId', async ({ params, body, context }) => {
      const { staff: admin } = requireAdmin(context.session);
      const patch: StaffPatch = {};
      if (body.displayName !== undefined) patch.displayName = str(body.displayName, 'displayName');
      const role = optOneOf(body.role, 'role', COUNTER_ROLES);
      if (role !== undefined) patch.role = role;
      const isActive = optBool(body.isActive, 'isActive');
      if (isActive !== undefined) patch.isActive = isActive;
      const staffId = id(params.staffId, 'staffId');
      const updated = await auth.updateStaff(staffId, patch, admin.id);
      if (!updated.isActive) sessions.revokeStaff(staffId);
      return ok(updated);
    }),
    route('PUT', '/api/staff/:staffId/pin', async ({ params, body, context }) => {
      requireAdmin(context.session);
      return ok(await auth.setPin(id(params.staffId, 'staffId'), pinValue(body.pin, 'pin', { nullable: true })));
    }),
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
      return ok(await queries.searchSkus(query.get('q') ?? '', limit, { activeOnly: query.get('active') === '1' }));
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
      const billId = id(params.billId, 'billId');
      const line = await billing.cancelBillItem(billId, id(params.itemId, 'itemId'), int(body.quantity, 'quantity'), restock === undefined ? {} : { restock });
      // A dish already sent to the kitchen gets a CANCEL ticket; unsent lines print nothing.
      const kots = line.item.department === 'KITCHEN' ? await sendKitchen(billId) : [];
      return created({ ...line, kots });
    }),
    route('POST', '/api/bills/:billId/kot', async ({ params }) => created({ kots: await sendKitchen(id(params.billId, 'billId')) })),
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
      const billId = id(params.billId, 'billId');
      const settled = await billing.settleNormalBill(billId, payments);
      return ok({ ...settled, kots: await sendKitchen(billId) });
    }),
    route('POST', '/api/bills/:billId/settle-waiter', async ({ params, body }) => {
      const billId = id(params.billId, 'billId');
      const settlement = await waiters.settleWaiterBill(billId, id(body.waiterId, 'waiterId'), oneOf(body.tender, 'tender', TENDERS), optPaise(body.amount, 'amount'));
      // Paying a waiter bill at the counter sends its pending Kitchen lines, as F9 does.
      return ok({ ...settlement, kots: await sendKitchen(billId) });
    }),
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
    route('POST', '/api/peak/undo-last', async () => {
      const result = await billing.undoLastPeakSale(cashierId);
      // A Kitchen scan already sent is cancelled at the kitchen too.
      return created({ ...result, kots: await sendKitchen(result.undone.billId, true) });
    }),
    route('GET', '/api/peak/baseline', async () => {
      const day = await queries.getCounterContext(cashierId);
      if (!day.businessDay) throw new NotFoundError('business day', 'open');
      return ok(await peak.getStartBaseline(day.businessDay.id));
    }),
    route('POST', '/api/peak/sales', async ({ body }) => {
      const line = await billing.recordPeakSale(id(body.sessionId, 'sessionId'), id(body.skuId, 'skuId'), int(body.quantity, 'quantity'), cashierId);
      return created({ ...line, kots: await sendKitchen(line.bill.id) });
    }),
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
    // Phase 25 (D5): the day opens only on a cashier's, manager's or admin's PIN, and is opened by them.
    route('POST', '/api/days', async ({ body }) =>
      created(await dayEnd.openBusinessDayWithPin(paise(body.openingFloat, 'openingFloat'), id(body.staffId, 'staffId'), pinValue(body.pin, 'pin') as string)),
    ),
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
          id(body.categoryId, 'categoryId'),
        ),
      ),
    ),
    // ── Expense categories (Phase 18, Settings) ──
    route('GET', '/api/expense-categories', async ({ query }) =>
      ok(await expenseCategories.listCategories({ includeInactive: query.get('includeInactive') === '1' })),
    ),
    route('POST', '/api/expense-categories', async ({ body }) =>
      created(
        await expenseCategories.createCategory({
          name: str(body.name, 'name'),
          noteRequired: optBool(body.noteRequired, 'noteRequired') ?? false,
          department: optDepartment(body.department, 'department', { nullable: true }) ?? null,
        }),
      ),
    ),
    route('PATCH', '/api/expense-categories/:categoryId', async ({ params, body }) => {
      const patch: ExpenseCategoryPatch = {};
      if (body.name !== undefined) patch.name = str(body.name, 'name');
      const noteRequired = optBool(body.noteRequired, 'noteRequired');
      if (noteRequired !== undefined) patch.noteRequired = noteRequired;
      const isActive = optBool(body.isActive, 'isActive');
      if (isActive !== undefined) patch.isActive = isActive;
      const department = optDepartment(body.department, 'department', { nullable: true });
      if (department !== undefined) patch.department = department;
      const move = optOneOf(body.move, 'move', ['up', 'down'] as const);
      if (move !== undefined) patch.move = move;
      return ok(await expenseCategories.updateCategory(id(params.categoryId, 'categoryId'), patch));
    }),
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

    // ── Revenue centers (Phase 22; departments are the manager's list) ──
    route('GET', '/api/departments', async ({ query }) => ok(await departments.listDepartments({ includeInactive: query.get('includeInactive') === '1' }))),
    route('POST', '/api/departments', async ({ body }) => {
      const tracksStock = optBool(body.tracksStock, 'tracksStock');
      if (tracksStock === undefined) throw new BadRequestError('tracksStock is required (true or false)');
      return created(
        await departments.createDepartment({ name: str(body.name, 'name'), kotStation: oneOf(body.kotStation, 'kotStation', DEPARTMENT_STATIONS), tracksStock }),
      );
    }),
    route('PATCH', '/api/departments/:code', async ({ params, body }) => {
      const code = params.code ?? '';
      if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(code)) throw new BadRequestError('code must be a revenue center code');
      const kotStation = optOneOf(body.kotStation, 'kotStation', DEPARTMENT_STATIONS);
      const tracksStock = optBool(body.tracksStock, 'tracksStock');
      const isActive = optBool(body.isActive, 'isActive');
      const move = optOneOf(body.move, 'move', ['up', 'down'] as const);
      return ok(
        await departments.updateDepartment(code, {
          ...(body.name !== undefined ? { name: str(body.name, 'name') } : {}),
          ...(kotStation ? { kotStation } : {}),
          ...(tracksStock !== undefined ? { tracksStock } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
          ...(move ? { move } : {}),
        }),
      );
    }),
    route('GET', '/api/revenue-centers/overview', async () => ok(await centers.getOverview(await currentDayId()))),
    route('GET', '/api/revenue-centers/:code/summary', async ({ params }) => {
      const code = params.code ?? '';
      if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(code)) throw new BadRequestError('code must be a revenue center code');
      return ok(await centers.getSummary(await currentDayId(), code));
    }),
    route('POST', '/api/revenue-centers/purchases', async ({ body }) => {
      if (!Array.isArray(body.lines)) throw new BadRequestError('lines must be an array');
      const department = optDepartment(body.department, 'department');
      if (!department) throw new BadRequestError('department is required');
      return created(
        await centers.recordPurchase(
          {
            department,
            vendorName: optNullableStr(body.vendorName, 'vendorName') ?? null,
            paidFrom: oneOf(body.paidFrom, 'paidFrom', ['DRAWER', 'OUTSIDE'] as const),
            note: optNullableStr(body.note, 'note') ?? null,
            lines: body.lines.map((l: unknown, i) => {
              const line = (l ?? {}) as Body;
              return {
                description: str(line.description, `lines[${i}].description`),
                quantity: optNullableStr(line.quantity, `lines[${i}].quantity`) ?? null,
                amountPaise: paise(line.amount, `lines[${i}].amount`),
              };
            }),
          },
          cashierId,
        ),
      );
    }),
    route('POST', '/api/revenue-centers/purchases/:purchaseId/void', async ({ params }) =>
      created(await centers.voidPurchase(id(params.purchaseId, 'purchaseId'), cashierId)),
    ),

    // ── Reports (Phase 23; read-only, by business date) ──
    route('GET', '/api/reports/range-presets', async () => ok(await reports.getRangeAnchor())),
    route('GET', '/api/reports/ledger', async ({ query }) => ok(await reports.getLedger(reportRange(query)))),
    route('GET', '/api/reports/sales', async ({ query }) => ok(await reports.getSalesRegister(reportRange(query)))),
    route('GET', '/api/reports/stock', async ({ query }) => ok(await reports.getStockRegister(reportRange(query)))),
    route('GET', '/api/reports/payments', async ({ query }) => ok(await reports.getPayments(reportRange(query)))),
    // Phase 24: the eight-module reporting suite (every one takes the same range; Expenses / Purchases take ?center=).
    route('GET', '/api/reports/sales-summary', async ({ query }) => ok(await reports.getSalesSummary(reportRange(query)))),
    route('GET', '/api/reports/member-sales', async ({ query }) => ok(await reports.getMemberSales(reportRange(query)))),
    route('GET', '/api/reports/orders', async ({ query }) => ok(await reports.getOrderSummary(reportRange(query)))),
    route('GET', '/api/reports/stock-summary', async ({ query }) => ok(await reports.getStockSummary(reportRange(query)))),
    route('GET', '/api/reports/expenses', async ({ query }) => ok(await reports.getExpenseSummary(reportRange(query), query.get('center') ?? undefined))),
    route('GET', '/api/reports/purchases', async ({ query }) => ok(await reports.getPurchaseSummary(reportRange(query), query.get('center') ?? undefined))),
    route('GET', '/api/reports/bank-deposits', async ({ query }) => ok(await reports.getBankDeposits(reportRange(query)))),
    route('GET', '/api/reports/day-end', async ({ query }) => ok(await reports.getDayEndLog(reportRange(query)))),
    route('GET', '/api/reports/full', async ({ query }) => ok(await reports.getFullReport(reportRange(query)))),

    // ── Item categories and flat items (Phase 20) ──
    route('GET', '/api/item-categories', async ({ query }) =>
      ok(await itemCategories.listCategories({ includeInactive: query.get('includeInactive') === '1' })),
    ),
    route('POST', '/api/item-categories', async ({ body }) => {
      const defaultDepartment = optDepartment(body.defaultDepartment, 'defaultDepartment');
      return created(
        await itemCategories.createCategory({
          name: str(body.name, 'name'),
          defaultSizeCode: body.defaultSizeCode === null ? null : (optOneOf(body.defaultSizeCode, 'defaultSizeCode', SIZE_CODES) ?? null),
          ...(defaultDepartment ? { defaultDepartment } : {}),
        }),
      );
    }),
    route('PATCH', '/api/item-categories/:categoryId', async ({ params, body }) => {
      const patch: ItemCategoryPatch = {};
      if (body.name !== undefined) patch.name = str(body.name, 'name');
      if (body.defaultSizeCode === null) patch.defaultSizeCode = null;
      else {
        const size = optOneOf(body.defaultSizeCode, 'defaultSizeCode', SIZE_CODES);
        if (size !== undefined) patch.defaultSizeCode = size;
      }
      const defaultDepartment = optDepartment(body.defaultDepartment, 'defaultDepartment');
      if (defaultDepartment) patch.defaultDepartment = defaultDepartment;
      const isActive = optBool(body.isActive, 'isActive');
      if (isActive !== undefined) patch.isActive = isActive;
      const move = optOneOf(body.move, 'move', ['up', 'down'] as const);
      if (move !== undefined) patch.move = move;
      return ok(await itemCategories.updateCategory(id(params.categoryId, 'categoryId'), patch));
    }),
    route('GET', '/api/catalog/items', async ({ query }) =>
      ok(await catalog.listItems({ q: query.get('q') ?? '', includeInactive: query.get('includeInactive') === 'true' })),
    ),
    route('POST', '/api/catalog/items', async ({ body }) => {
      const department = optDepartment(body.department, 'department');
      const productCategory = optOneOf(body.productCategory, 'productCategory', PRODUCT_CATEGORIES);
      return created(
        await catalog.createItem(
          {
            categoryId: id(body.categoryId, 'categoryId'),
            name: str(body.name, 'name'),
            sizeCode: optOneOf(body.sizeCode, 'sizeCode', SIZE_CODES),
            salePricePaise: paise(body.salePrice, 'salePrice'),
            purchasePricePaise: body.purchasePrice === undefined || body.purchasePrice === null ? null : paise(body.purchasePrice, 'purchasePrice'),
            caseSize: body.caseSize === undefined ? undefined : int(body.caseSize, 'caseSize'),
            barcode: optNullableStr(body.barcode, 'barcode') ?? null,
            codePrefix: body.codePrefix === undefined || body.codePrefix === null ? undefined : str(body.codePrefix, 'codePrefix'),
            openingQty: body.openingQty === undefined ? undefined : int(body.openingQty, 'openingQty'),
            ...(department ? { department } : {}),
            ...(productCategory ? { productCategory } : {}),
          },
          cashierId,
        ),
      );
    }),
    route('PATCH', '/api/catalog/items/:skuId', async ({ params, body }) => {
      const patch: ItemPatch = {};
      if (body.name !== undefined) patch.name = str(body.name, 'name');
      if (body.categoryId !== undefined) patch.categoryId = id(body.categoryId, 'categoryId');
      if (body.salePrice !== undefined) patch.salePricePaise = paise(body.salePrice, 'salePrice');
      if (body.purchasePrice !== undefined) patch.purchasePricePaise = body.purchasePrice === null ? null : paise(body.purchasePrice, 'purchasePrice');
      if (body.caseSize !== undefined) patch.caseSize = int(body.caseSize, 'caseSize');
      if (body.barcode !== undefined) patch.barcode = optNullableStr(body.barcode, 'barcode') ?? null;
      if (body.volumeMl !== undefined) patch.volumeMl = body.volumeMl === null ? null : int(body.volumeMl, 'volumeMl');
      if (body.exciseGroup !== undefined) patch.exciseGroup = body.exciseGroup === null ? null : oneOf(body.exciseGroup, 'exciseGroup', EXCISE_GROUPS);
      const isActive = optBool(body.isActive, 'isActive');
      if (isActive !== undefined) patch.isActive = isActive;
      return ok(await catalog.updateItem(id(params.skuId, 'skuId'), patch));
    }),
    route('GET', '/api/catalog', async ({ query }) =>
      ok(await catalog.listCatalog({ q: query.get('q') ?? '', includeInactive: query.get('includeInactive') === 'true' })),
    ),
    route('POST', '/api/catalog/products', async ({ body }) => {
      if (!Array.isArray(body.skus)) throw new BadRequestError('skus must be an array');
      return created(
        await catalog.createProduct({
          name: str(body.name, 'name'),
          category: oneOf(body.category, 'category', PRODUCT_CATEGORIES),
          department: optDepartment(body.department, 'department') ?? 'LIQUOR',
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
          department: optDepartment(body.department, 'department') ?? undefined,
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

/**
 * Counter API admission: loopback Host names only (blocks DNS-rebinding pages), then a signed-in
 * session for everything but PUBLIC_PATHS (Phase 25, D3).
 */
function admitCounter(sessions: SessionStore): (req: IncomingMessage) => RequestContext {
  return (req) => {
    if (!LOCAL_HOST.test(req.headers.host ?? '')) throw new HttpError(403, 'FORBIDDEN', 'the POS API only answers on localhost');
    const token = sessionToken(req.headers.cookie);
    const session = sessions.resolve(token);
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!session && !PUBLIC_PATHS.has(path)) throw new HttpError(401, 'UNAUTHENTICATED', 'sign in to use the POS');
    return { ...(session ? { session } : {}), ...(token ? { sessionToken: token } : {}) };
  };
}

export function createApiHandler(config: ApiConfig): RequestListener {
  const sessions = config.sessions ?? new SessionStore();
  return createJsonHandler(buildRoutes(config, sessions), admitCounter(sessions));
}

export function createApiServer(config: ApiConfig): Server {
  return createServer(createApiHandler(config));
}
