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
  CounterQueries,
  NotFoundError,
  PeakSessionService,
  WaiterService,
  type CounterPayment,
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
  str,
} from './json.js';
import { created, createJsonHandler, HttpError, ok, type RequestContext, route, type Route } from './routing.js';

export interface ApiConfig {
  db: SqlDatabase;
  /** Staff row the counter acts as until staff login exists. */
  cashierId: string;
}

const COUNTER_TENDERS = ['CASH', 'UPI'] as const satisfies readonly CounterTender[];
const TENDERS = ['CASH', 'UPI', 'WAITER_CREDIT'] as const satisfies readonly Tender[];
/** Loopback names only: blocks DNS-rebinding pages from reaching the till through a foreign Host. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function buildRoutes({ db, cashierId }: ApiConfig): Route[] {
  const billing = new BillingService(db);
  const peak = new PeakSessionService(db);
  const waiters = new WaiterService(db);
  const queries = new CounterQueries(db);

  return [
    route('GET', '/api/health', async () => ok({ ok: true })),
    route('GET', '/api/context', async () => ok(await queries.getCounterContext(cashierId))),

    route('GET', '/api/skus/lookup', async ({ query }) => {
      const code = query.get('code') ?? '';
      const sku = await queries.lookupSku(code);
      if (!sku) throw new NotFoundError('sku', code);
      return ok(sku);
    }),
    route('GET', '/api/members', async ({ query }) => {
      const limit = query.has('limit') ? int(Number(query.get('limit')), 'limit') : undefined;
      if (limit !== undefined && (limit < 1 || limit > 100)) throw new BadRequestError('limit must be 1–100');
      return ok(await queries.searchMembers(query.get('q') ?? '', limit));
    }),
    route('GET', '/api/waiters', async () => ok(await queries.listWaiters())),

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

    // ── Waiter accounts ──
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
