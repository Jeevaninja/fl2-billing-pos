/**
 * Captain (waiter app) routes, served only by the Wi-Fi Captain server (captain-server.ts) behind
 * device-token auth. Same JSON conventions as the counter API: paise as decimal strings, UUID ids
 * (malformed → 400), unknown rows → 404, inactive waiter / member / SKU → 400 INACTIVE.
 */
import type { CaptainService, OrderLine } from '../src/services/index.js';
import { BadRequestError, type Body, id, int } from './json.js';
import { created, HttpError, ok, route, type Route } from './routing.js';

function parseItems(value: unknown): OrderLine[] {
  if (!Array.isArray(value)) throw new BadRequestError('items must be an array of { skuId, quantity }');
  return value.map((raw: unknown, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadRequestError(`items[${i}] must be an object`);
    const item = raw as Body;
    return { skuId: id(item.skuId, `items[${i}].skuId`), quantity: int(item.quantity, `items[${i}].quantity`) };
  });
}

export function captainRoutes(captain: CaptainService): Route[] {
  return [
    route('GET', '/api/captain/health', async ({ context }) => ok({ ok: true, deviceId: context.deviceId })),
    route('GET', '/api/captain/waiter/:waiterId', async ({ params }) => ok(await captain.getWaiterProfile(id(params.waiterId, 'waiterId')))),
    route('GET', '/api/captain/waiter/:waiterId/bills', async ({ params }) =>
      ok(await captain.listOpenBills(id(params.waiterId, 'waiterId'))),
    ),
    route('POST', '/api/captain/kot', async ({ body, context }) => {
      if (!context.deviceId) throw new HttpError(401, 'UNAUTHORIZED', 'a paired device is required');
      const order = await captain.placeOrder({
        requestId: id(body.requestId, 'requestId'),
        deviceId: context.deviceId,
        waiterId: id(body.waiterId, 'waiterId'),
        memberId: body.memberId === undefined || body.memberId === null ? undefined : id(body.memberId, 'memberId'),
        items: parseItems(body.items),
      });
      // A replay is not a new resource: 200, with `replayed: true` in the body.
      return order.replayed ? ok(order) : created(order);
    }),
  ];
}
