import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatKot, type KotPrinter, type KotTicket } from '../../src/services/index.js';
import { MISSING, useApi } from '../support/api.js';
import { useSeededDb } from '../support/db.js';
import { OPENING_QTY, PRICE } from '../support/fixtures.js';
import { one, onHand } from '../support/pos.js';

/** Records every ticket instead of printing it. */
function fakePrinter() {
  const tickets: KotTicket[] = [];
  const printer: KotPrinter = {
    async printKOT(ticket) {
      tickets.push(ticket);
      return { station: ticket.station, printedAt: new Date(), text: formatKot(ticket) };
    },
  };
  return { tickets, printer };
}

describe('Captain API', () => {
  const ctx = useSeededDb();
  const start = useApi(ctx);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const billCount = async () => Number((await one<{ n: number }>(ctx().db, `SELECT count(*)::int AS n FROM bills`)).n);
  const addMember = async (active = true) =>
    (
      await one<{ id: string }>(
        ctx().db,
        `INSERT INTO members (membership_no, display_name, is_active) VALUES ('M-42', 'Anil Kumar', $1) RETURNING id`,
        [active],
      )
    ).id;

  describe('GET /api/captain/waiter/:waiterId', () => {
    it('returns profile, trust, credit limit, outstanding balance and headroom', async () => {
      const { fx, call } = await start();
      expect(await call('GET', `/api/captain/waiter/${fx.waiter.trusted}`)).toEqual({
        status: 200,
        body: {
          id: fx.waiter.trusted,
          code: 'W01',
          displayName: 'Trusted',
          isTrusted: true,
          isActive: true,
          outstandingPaise: '0',
          creditLimitPaise: null,
          creditHeadroomPaise: null,
        },
      });

      // Put ₹600 on the limited waiter's ₹1,000 account.
      const bill = (await call('POST', '/api/bills', { mode: 'NORMAL' })).body;
      await call('POST', `/api/bills/${bill.id}/items`, { skuId: fx.sku.quarter, quantity: 1 });
      await call('PUT', `/api/bills/${bill.id}/waiter`, { waiterId: fx.waiter.limited });
      await call('POST', `/api/bills/${bill.id}/settle-waiter`, { waiterId: fx.waiter.limited, tender: 'WAITER_CREDIT' });

      expect((await call('GET', `/api/captain/waiter/${fx.waiter.limited}`)).body).toMatchObject({
        isTrusted: true,
        outstandingPaise: String(PRICE.quarter),
        creditLimitPaise: '100000',
        creditHeadroomPaise: String(100000 - PRICE.quarter),
      });
      expect((await call('GET', `/api/captain/waiter/${fx.waiter.untrusted}`)).body).toMatchObject({ isTrusted: false });
    });

    it('reports an inactive waiter as inactive, an unknown one as 404, a malformed id as 400', async () => {
      const { db, fx, call } = await start();
      await db.query(`UPDATE waiters SET is_active = false WHERE id = $1`, [fx.waiter.untrusted]);
      expect((await call('GET', `/api/captain/waiter/${fx.waiter.untrusted}`)).body).toMatchObject({ isActive: false });
      expect(await call('GET', `/api/captain/waiter/${MISSING}`)).toMatchObject({
        status: 404,
        body: { error: { code: 'NOT_FOUND', entity: 'waiter', id: MISSING } },
      });
      expect(await call('GET', '/api/captain/waiter/W01')).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    });
  });

  describe('POST /api/captain/kot', () => {
    it('opens a WAITER_APP bill tagged to the waiter, adds the items and prints a KOT at the counter', async () => {
      const { tickets, printer } = fakePrinter();
      const { db, fx, call } = await start({ printer });
      const memberId = await addMember();

      const res = await call('POST', '/api/captain/kot', {
        waiterId: fx.waiter.trusted,
        memberId,
        items: [
          { skuId: fx.sku.full, quantity: 2 },
          { skuId: fx.sku.beer650, quantity: 1 },
        ],
      });

      expect(res.status).toBe(201);
      expect(res.body.bill).toMatchObject({
        source: 'WAITER_APP',
        mode: 'NORMAL',
        status: 'OPEN',
        kind: 'SALE',
        waiterId: fx.waiter.trusted,
        waiterTrustedAtBilling: true,
        memberId,
        createdByStaffId: null,
        totalPaise: String(2 * PRICE.full + PRICE.beer650),
      });
      expect(res.body.items.map((i: { skuCode: string; quantity: number }) => [i.skuCode, i.quantity])).toEqual([
        ['HRUM-F', 2],
        ['HLAG-650', 1],
      ]);
      expect(res.body.waiter).toEqual({
        id: fx.waiter.trusted,
        code: 'W01',
        displayName: 'Trusted',
        isTrusted: true,
        outstandingPaise: '0',
        creditLimitPaise: null,
      });
      expect(res.body.member).toEqual({ id: memberId, membershipNo: 'M-42', displayName: 'Anil Kumar' });
      expect(res.body.kot).toMatchObject({ station: 'COUNTER', printed: true, error: null });
      expect(res.body.kot.printedAt).toMatch(/Z$/);

      // The printer stub received exactly one ticket for this bill.
      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({
        kotNo: res.body.bill.billNo,
        billId: res.body.bill.id,
        station: 'COUNTER',
        waiter: { code: 'W01', displayName: 'Trusted' },
        member: { membershipNo: 'M-42', displayName: 'Anil Kumar' },
        lines: [
          { skuCode: 'HRUM-F', displayName: 'House Rum — Full', sizeCode: 'FULL', quantity: 2 },
          { skuCode: 'HLAG-650', displayName: 'House Lager — 650', sizeCode: 'BEER_650', quantity: 1 },
        ],
      });

      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY - 2);
      expect(await onHand(db, fx.sku.beer650)).toBe(OPENING_QTY - 1);
    });

    it('accepts an untrusted waiter and a walk-in (no member, or memberId null)', async () => {
      const { tickets, printer } = fakePrinter();
      const { fx, call } = await start({ printer });
      const a = await call('POST', '/api/captain/kot', { waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.beer330, quantity: 3 }] });
      const b = await call('POST', '/api/captain/kot', { waiterId: fx.waiter.untrusted, memberId: null, items: [{ skuId: fx.sku.beer330, quantity: 1 }] });
      expect(a).toMatchObject({ status: 201, body: { bill: { waiterTrustedAtBilling: false, memberId: null }, member: null } });
      expect(b.status).toBe(201);
      expect(b.body.bill.billNo).toBe(a.body.bill.billNo + 1);
      expect(tickets.map((t) => t.member)).toEqual([null, null]);
    });

    it('still opens NORMAL waiter bills while a peak session runs (peak bills are counter-only)', async () => {
      const { fx, call } = await start({ printer: fakePrinter().printer });
      await call('POST', '/api/peak/sessions', { businessDayId: fx.dayId, declaredCash: '0', declaredUpi: '0' });
      expect(await call('POST', '/api/captain/kot', { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.half, quantity: 1 }] })).toMatchObject({
        status: 201,
        body: { bill: { mode: 'NORMAL', status: 'OPEN', peakSessionId: null } },
      });
    });

    it('saves nothing and prints nothing when any line is short of stock (409 PS003)', async () => {
      const { tickets, printer } = fakePrinter();
      const { db, fx, call } = await start({ printer });
      const before = await billCount();
      const res = await call('POST', '/api/captain/kot', {
        waiterId: fx.waiter.trusted,
        items: [
          { skuId: fx.sku.full, quantity: 1 },
          { skuId: fx.sku.half, quantity: OPENING_QTY + 1 },
        ],
      });
      expect(res).toMatchObject({ status: 409, body: { error: { code: 'PS003' } } });
      expect(await billCount()).toBe(before);
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY);
      expect(tickets).toEqual([]);
    });

    it('keeps the order when the printer fails, reporting the failure in kot', async () => {
      const printer: KotPrinter = {
        printKOT: async () => {
          throw new Error('printer 192.168.1.50:9100 unreachable');
        },
      };
      const { fx, call } = await start({ printer });
      const res = await call('POST', '/api/captain/kot', { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.quarter, quantity: 1 }] });
      expect(res).toMatchObject({
        status: 201,
        body: { bill: { status: 'OPEN' }, kot: { station: 'COUNTER', printed: false, printedAt: null, error: 'printer 192.168.1.50:9100 unreachable' } },
      });
      expect((await call('GET', `/api/bills/${res.body.bill.id}`)).status).toBe(200);
    });

    it('prints through the console stub by default', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const { fx, call } = await start();
      const res = await call('POST', '/api/captain/kot', { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.beer650, quantity: 2 }] });
      expect(res.body.kot.printed).toBe(true);
      expect(log).toHaveBeenCalledTimes(1);
      const text = String(log.mock.calls[0]?.[0]);
      expect(text).toContain(`KOT #${res.body.bill.billNo} - COUNTER`);
      expect(text).toMatch(/^\s+2 {2}House Lager — 650\s+650ML$/m);
    });

    describe('validation', () => {
      it('rejects an inactive SKU with 400 INACTIVE and saves nothing', async () => {
        const { tickets, printer } = fakePrinter();
        const { db, fx, call } = await start({ printer });
        await db.query(`UPDATE skus SET is_active = false WHERE id = $1`, [fx.sku.half]);
        const before = await billCount();
        const res = await call('POST', '/api/captain/kot', {
          waiterId: fx.waiter.trusted,
          items: [
            { skuId: fx.sku.full, quantity: 1 },
            { skuId: fx.sku.half, quantity: 1 },
          ],
        });
        expect(res).toEqual({
          status: 400,
          body: { error: { code: 'INACTIVE', message: 'sku HRUM-H is inactive', entity: 'sku', id: fx.sku.half } },
        });
        expect(await billCount()).toBe(before);
        expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY);
        expect(tickets).toEqual([]);
      });

      it('rejects an inactive waiter or member with 400 INACTIVE', async () => {
        const { db, fx, call } = await start({ printer: fakePrinter().printer });
        await db.query(`UPDATE waiters SET is_active = false WHERE id = $1`, [fx.waiter.untrusted]);
        expect(await call('POST', '/api/captain/kot', { waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.full, quantity: 1 }] })).toMatchObject({
          status: 400,
          body: { error: { code: 'INACTIVE', entity: 'waiter', message: 'waiter W02 is inactive' } },
        });
        const memberId = await addMember(false);
        expect(
          await call('POST', '/api/captain/kot', { waiterId: fx.waiter.trusted, memberId, items: [{ skuId: fx.sku.full, quantity: 1 }] }),
        ).toMatchObject({ status: 400, body: { error: { code: 'INACTIVE', entity: 'member' } } });
      });

      it.each<[string, (fx: ReturnType<typeof ctx>['fx']) => unknown]>([
        ['waiter', (fx) => ({ waiterId: MISSING, items: [{ skuId: fx.sku.full, quantity: 1 }] })],
        ['sku', (fx) => ({ waiterId: fx.waiter.trusted, items: [{ skuId: MISSING, quantity: 1 }] })],
        ['member', (fx) => ({ waiterId: fx.waiter.trusted, memberId: MISSING, items: [{ skuId: fx.sku.full, quantity: 1 }] })],
      ])('returns 404 for an unknown %s', async (entity, body) => {
        const { fx, call } = await start({ printer: fakePrinter().printer });
        expect(await call('POST', '/api/captain/kot', body(fx))).toMatchObject({
          status: 404,
          body: { error: { code: 'NOT_FOUND', entity, id: MISSING } },
        });
      });

      type Fx = ReturnType<typeof ctx>['fx'];
      const order = (fx: Fx, items: unknown, extra: Record<string, unknown> = {}) => ({ waiterId: fx.waiter.trusted, items, ...extra });
      it.each<[string, (fx: Fx) => unknown]>([
        ['a malformed waiterId', (fx) => order(fx, [{ skuId: fx.sku.full, quantity: 1 }], { waiterId: 'W01' })],
        ['a missing items array', (fx) => ({ waiterId: fx.waiter.trusted })],
        ['items that is not an array', (fx) => order(fx, { skuId: fx.sku.full, quantity: 1 })],
        ['an empty order', (fx) => order(fx, [])],
        ['a non-object item', (fx) => order(fx, ['HRUM-F'])],
        ['a malformed skuId', (fx) => order(fx, [{ skuId: 'HRUM-F', quantity: 1 }])],
        ['a zero quantity', (fx) => order(fx, [{ skuId: fx.sku.full, quantity: 0 }])],
        ['a fractional quantity', (fx) => order(fx, [{ skuId: fx.sku.full, quantity: 1.5 }])],
        ['a quantity sent as a string', (fx) => order(fx, [{ skuId: fx.sku.full, quantity: '2' }])],
        ['a malformed memberId', (fx) => order(fx, [{ skuId: fx.sku.full, quantity: 1 }], { memberId: 42 })],
        ['more than 50 lines', (fx) => order(fx, Array.from({ length: 51 }, () => ({ skuId: fx.sku.beer330, quantity: 1 })))],
      ])('rejects %s with 400', async (_label, body) => {
        const { fx, call } = await start({ printer: fakePrinter().printer });
        expect(await call('POST', '/api/captain/kot', body(fx))).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
      });
    });
  });

  describe('GET /api/captain/waiter/:waiterId/bills', () => {
    it("lists the waiter's open bills — app orders and counter bills tagged to them — oldest first", async () => {
      const { fx, call } = await start({ printer: fakePrinter().printer });
      const kot1 = (await call('POST', '/api/captain/kot', { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.full, quantity: 1 }] })).body;
      const counter = (await call('POST', '/api/bills', { mode: 'NORMAL' })).body;
      await call('POST', `/api/bills/${counter.id}/items`, { skuId: fx.sku.beer330, quantity: 2 });
      await call('PUT', `/api/bills/${counter.id}/waiter`, { waiterId: fx.waiter.trusted });
      await call('POST', '/api/captain/kot', { waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.half, quantity: 1 }] });
      const kot2 = (await call('POST', '/api/captain/kot', { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.quarter, quantity: 1 }] })).body;

      const res = await call('GET', `/api/captain/waiter/${fx.waiter.trusted}/bills`);
      expect(res.status).toBe(200);
      expect(res.body.map((d: { bill: { id: string; source: string } }) => [d.bill.id, d.bill.source])).toEqual([
        [kot1.bill.id, 'WAITER_APP'],
        [counter.id, 'COUNTER'],
        [kot2.bill.id, 'WAITER_APP'],
      ]);
      expect(res.body[1]).toMatchObject({
        items: [{ skuCode: 'HLAG-330', quantity: 2, remainingQuantity: 2 }],
        tenderedPaise: '0',
        duePaise: String(2 * PRICE.beer330),
        waiter: { code: 'W01' },
      });
    });

    it('drops a bill once the counter settles it, and is empty for a waiter with none', async () => {
      const { fx, call } = await start({ printer: fakePrinter().printer });
      const kot = (await call('POST', '/api/captain/kot', { waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.quarter, quantity: 1 }] })).body;
      expect((await call('GET', `/api/captain/waiter/${fx.waiter.untrusted}/bills`)).body).toHaveLength(1);

      const settled = await call('POST', `/api/bills/${kot.bill.id}/settle-waiter`, { waiterId: fx.waiter.untrusted, tender: 'CASH' });
      expect(settled).toMatchObject({ status: 200, body: { bill: { status: 'SETTLED' } } });
      expect(await call('GET', `/api/captain/waiter/${fx.waiter.untrusted}/bills`)).toEqual({ status: 200, body: [] });
      expect(await call('GET', `/api/captain/waiter/${fx.waiter.limited}/bills`)).toEqual({ status: 200, body: [] });
    });

    it('returns 404 for an unknown waiter', async () => {
      const { call } = await start();
      expect(await call('GET', `/api/captain/waiter/${MISSING}/bills`)).toMatchObject({ status: 404, body: { error: { entity: 'waiter' } } });
    });
  });
});
