/**
 * Captain (waiter app) routes. Same JSON conventions as the counter API: paise as decimal strings,
 * UUID ids (malformed → 400), unknown rows → 404, inactive waiter / member / SKU → 400 INACTIVE.
 */
import type { CaptainService, OrderLine } from '../src/services/index.js';
import { BadRequestError, type Body, id, int } from './json.js';
import { created, ok, route, type Route } from './routing.js';

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
    route('GET', '/api/captain/waiter/:waiterId', async ({ params }) => ok(await captain.getWaiterProfile(id(params.waiterId, 'waiterId')))),
    route('GET', '/api/captain/waiter/:waiterId/bills', async ({ params }) =>
      ok(await captain.listOpenBills(id(params.waiterId, 'waiterId'))),
    ),
    route('POST', '/api/captain/kot', async ({ body }) => {
      const waiterId = id(body.waiterId, 'waiterId');
      const memberId = body.memberId === undefined || body.memberId === null ? undefined : id(body.memberId, 'memberId');
      return created(await captain.placeOrder(waiterId, parseItems(body.items), memberId));
    }),
  ];
}
