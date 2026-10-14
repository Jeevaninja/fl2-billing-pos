/**
 * Local HTTP API: a thin JSON bridge from the POS frontend to the service layer. It holds no
 * business rules of its own; every rule is enforced by the services and the database.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SqlDatabase } from '../src/db/client.js';
import type { CounterTender, Tender } from '../src/domain/types.js';
import {
  BillingService,
  CaptainService,
  CounterQueries,
  InactiveError,
  type KotPrinter,
  NotFoundError,
  PeakSessionService,
  PosError,
  PrinterService,
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
  parseBody,
  str,
  toJson,
} from './json.js';
import { captainRoutes } from './captain-api.js';
import { created, HttpError, ok, route, type Route } from './routing.js';

export interface ApiConfig {
  db: SqlDatabase;
  /** Staff row the counter acts as until staff login exists. */
  cashierId: string;
  /** KOT printer for Captain orders; defaults to the console stub. */
  printer?: KotPrinter;
}

const MAX_BODY_BYTES = 64 * 1024;
const COUNTER_TENDERS = ['CASH', 'UPI'] as const satisfies readonly CounterTender[];
const TENDERS = ['CASH', 'UPI', 'WAITER_CREDIT'] as const satisfies readonly Tender[];
/** Loopback names only: blocks DNS-rebinding pages from reaching the till through a foreign Host. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function buildRoutes({ db, cashierId, printer = new PrinterService() }: ApiConfig): Route[] {
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

    ...captainRoutes(new CaptainService(db, printer)),
  ];
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Maps any thrown error to an HTTP status and a `{ error: { code, message, … } }` body. */
export function errorResponse(err: unknown): { status: number; body: { error: Record<string, unknown> } } {
  if (err instanceof HttpError) return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  if (err instanceof BadRequestError || err instanceof RangeError) {
    return { status: 400, body: { error: { code: 'BAD_REQUEST', message: err.message } } };
  }
  if (err instanceof InactiveError) {
    return { status: 400, body: { error: { code: 'INACTIVE', message: err.message, entity: err.entity, id: err.id } } };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: err.message, entity: err.entity, id: err.id } } };
  }
  if (err instanceof PosError) {
    return {
      status: 409,
      body: { error: { code: err.code, message: err.message, ...(err.constraint ? { constraint: err.constraint } : {}) } },
    };
  }
  console.error('[fl2-api] unhandled error', err);
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'internal error' } } };
}

export function createApiHandler(config: ApiConfig): (req: IncomingMessage, res: ServerResponse) => void {
  const routes = buildRoutes(config);

  async function handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    if (!LOCAL_HOST.test(req.headers.host ?? '')) throw new HttpError(403, 'FORBIDDEN', 'the POS API only answers on localhost');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const matches = routes
      .map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
      .filter((x): x is { r: Route; m: RegExpExecArray } => x.m !== null);
    if (matches.length === 0) throw new HttpError(404, 'NOT_FOUND', `no route for ${url.pathname}`);
    const match = matches.find((x) => x.r.method === req.method);
    if (!match) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method ?? ''} not allowed on ${url.pathname}`);

    let body: Body = {};
    if (req.method !== 'GET') {
      // Requiring JSON forces a CORS preflight for cross-origin pages, which this server never approves.
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'send Content-Type: application/json');
      }
      body = parseBody(await readBody(req));
    }

    // Path params are only ever UUIDs, validated by each handler, so they are used undecoded.
    const result = await match.r.handler({ params: { ...match.m.groups }, query: url.searchParams, body });
    return { status: result.status ?? 200, body: result.body };
  }

  return (req, res) => {
    handle(req)
      .catch(errorResponse)
      .then(({ status, body }) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(toJson(body));
      });
  };
}

export function createApiServer(config: ApiConfig): Server {
  return createServer(createApiHandler(config));
}
