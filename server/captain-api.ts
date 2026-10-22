/**
 * Captain (waiter app) routes, served only by the Wi-Fi Captain server (captain-server.ts) behind
 * device-token auth. Same JSON conventions as the counter API: paise as decimal strings, UUID ids
 * (malformed → 400), unknown rows → 404, inactive waiter / member / SKU → 400 INACTIVE.
 *
 * Phase 27 adds the handset's waiter picker, catalog and member lookup, rounds on an open bill, and
 * settle requests. Writes need a paired device; a replayed write answers 200 instead of 201.
 */
import type { CaptainService, OrderLine } from '../src/services/index.js';
import { BadRequestError, type Body, id, int } from './json.js';
import { created, HttpError, ok, type RequestContext, route, type Route } from './routing.js';

function parseItems(value: unknown): OrderLine[] {
  if (!Array.isArray(value)) throw new BadRequestError('items must be an array of { skuId, quantity }');
  return value.map((raw: unknown, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadRequestError(`items[${i}] must be an object`);
    const item = raw as Body;
    return { skuId: id(item.skuId, `items[${i}].skuId`), quantity: int(item.quantity, `items[${i}].quantity`) };
  });
}

function pairedDevice(context: RequestContext): string {
  if (!context.deviceId) throw new HttpError(401, 'UNAUTHORIZED', 'a paired device is required');
  return context.deviceId;
}

/** Longest member code accepted by the lookup; card numbers are far shorter. */
const MAX_MEMBER_CODE = 64;

export function captainRoutes(captain: CaptainService): Route[] {
  return [
    route('GET', '/api/captain/health', async ({ context }) => ok({ ok: true, deviceId: context.deviceId })),
    route('GET', '/api/captain/waiter/:waiterId', async ({ params }) => ok(await captain.getWaiterProfile(id(params.waiterId, 'waiterId')))),
    route('GET', '/api/captain/waiter/:waiterId/bills', async ({ params }) =>
      ok(await captain.listOpenBills(id(params.waiterId, 'waiterId'))),
    ),
    route('GET', '/api/captain/waiters', async () => ok(await captain.listWaiters())),
    route('GET', '/api/captain/catalog', async () => ok(await captain.getCatalog())),
    route('GET', '/api/captain/members/lookup', async ({ query }) => {
      const code = (query.get('code') ?? '').trim();
      if (code === '' || code.length > MAX_MEMBER_CODE) throw new BadRequestError(`code must be 1–${MAX_MEMBER_CODE} characters`);
      return ok(await captain.findMemberByCode(code));
    }),
    route('POST', '/api/captain/kot', async ({ body, context }) => {
      const order = await captain.placeOrder({
        requestId: id(body.requestId, 'requestId'),
        deviceId: pairedDevice(context),
        waiterId: id(body.waiterId, 'waiterId'),
        memberId: body.memberId === undefined || body.memberId === null ? undefined : id(body.memberId, 'memberId'),
        items: parseItems(body.items),
      });
      // A replay is not a new resource: 200, with `replayed: true` in the body.
      return order.replayed ? ok(order) : created(order);
    }),
    route('POST', '/api/captain/bills/:billId/items', async ({ params, body, context }) => {
      const round = await captain.addToBill({
        requestId: id(body.requestId, 'requestId'),
        deviceId: pairedDevice(context),
        waiterId: id(body.waiterId, 'waiterId'),
        billId: id(params.billId, 'billId'),
        items: parseItems(body.items),
      });
      return round.replayed ? ok(round) : created(round);
    }),
    route('POST', '/api/captain/bills/:billId/settle-request', async ({ params, body, context }) => {
      const result = await captain.requestSettlement({
        deviceId: pairedDevice(context),
        waiterId: id(body.waiterId, 'waiterId'),
        billId: id(params.billId, 'billId'),
      });
      return result.alreadyRequested ? ok(result) : created(result);
    }),
  ];
}
