import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatKot, type KotPrinter, type KotTicket } from '../../src/services/index.js';
import { bearer, type Call, HANDSETS, MISSING, useCaptainApi } from '../support/api.js';
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

/** POST /api/captain/kot with a fresh requestId unless the body brings its own. */
const kot = (call: Call, body: Record<string, unknown>, headers?: Record<string, string>) =>
  call('POST', '/api/captain/kot', { requestId: randomUUID(), ...body }, headers);

describe('Captain API (Wi-Fi server)', () => {
  const ctx = useSeededDb();
  const start = useCaptainApi(ctx);

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

  describe('device-token authentication', () => {
    it('answers a paired handset and reports which one it is', async () => {
      const { call } = await start();
      expect(await call('GET', '/api/captain/health')).toMatchObject({ status: 200, body: { ok: true, deviceId: 'handset-01' } });
      expect((await call('GET', '/api/captain/health', undefined, bearer(HANDSETS.two.token))).body.deviceId).toBe('handset-02');
    });

    it.each([
      ['no Authorization header', { authorization: '' }],
      ['a non-Bearer scheme', { authorization: `Basic ${HANDSETS.one.token}` }],
      ['an unknown token', bearer('not-a-paired-token')],
      ['a revoked handset', bearer(HANDSETS.revoked.token)],
    ])('rejects %s with 401 and a Bearer challenge', async (_label, headers) => {
      const { call } = await start();
      const res = await call('GET', '/api/captain/health', undefined, headers);
      expect(res).toMatchObject({ status: 401, body: { error: { code: 'UNAUTHORIZED' } } });
      expect(res.headers['www-authenticate']).toBe('Bearer realm="fl2-captain"');
    });

    it('authenticates before routing, so unknown paths reveal nothing', async () => {
      const { call } = await start();
      expect((await call('GET', '/api/bills/whatever', undefined, { authorization: '' })).status).toBe(401);
    });

    it('serves only Captain routes: counter routes do not exist here', async () => {
      const { call } = await start();
      for (const path of ['/api/context', '/api/waiters', '/api/health']) {
        expect(await call('GET', path)).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
      }
      expect((await call('POST', '/api/bills', { mode: 'NORMAL' })).status).toBe(404);
    });
  });

  describe('GET /api/captain/waiter/:waiterId', () => {
    it('returns profile, trust, credit limit, outstanding balance and headroom', async () => {
      const { fx, call, counter } = await start();
      expect(await call('GET', `/api/captain/waiter/${fx.waiter.trusted}`)).toEqual({
        status: 200,
        headers: expect.anything(),
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

      // Put ₹600 on the limited waiter's ₹1,000 account at the counter.
      const bill = (await counter('POST', '/api/bills', { mode: 'NORMAL' })).body;
      await counter('POST', `/api/bills/${bill.id}/items`, { skuId: fx.sku.quarter, quantity: 1 });
      await counter('PUT', `/api/bills/${bill.id}/waiter`, { waiterId: fx.waiter.limited });
      await counter('POST', `/api/bills/${bill.id}/settle-waiter`, { waiterId: fx.waiter.limited, tender: 'WAITER_CREDIT' });

      expect((await call('GET', `/api/captain/waiter/${fx.waiter.limited}`)).body).toMatchObject({
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
    it('opens a WAITER_APP bill for the waiter, records key and handset, adds the items and prints a KOT', async () => {
      const { tickets, printer } = fakePrinter();
      const { db, fx, call } = await start({ printer });
      const memberId = await addMember();
      const requestId = randomUUID();

      const res = await kot(call, {
        requestId,
        waiterId: fx.waiter.trusted,
        memberId,
        items: [
          { skuId: fx.sku.full, quantity: 2 },
          { skuId: fx.sku.beer650, quantity: 1 },
        ],
      });

      expect(res.status).toBe(201);
      expect(res.body.replayed).toBe(false);
      expect(res.body.bill).toMatchObject({
        source: 'WAITER_APP',
        mode: 'NORMAL',
        status: 'OPEN',
        waiterId: fx.waiter.trusted,
        waiterTrustedAtBilling: true,
        memberId,
        createdByStaffId: null,
        requestId,
        captainDeviceId: 'handset-01',
        totalPaise: String(2 * PRICE.full + PRICE.beer650),
      });
      expect(res.body.bill).not.toHaveProperty('requestFingerprint');
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

      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({
        kotNo: res.body.bill.billNo,
        billId: res.body.bill.id,
        station: 'COUNTER',
        waiter: { code: 'W01', displayName: 'Trusted' },
        member: { membershipNo: 'M-42', displayName: 'Anil Kumar' },
        lines: [
          { skuCode: 'HRUM-F', sizeCode: 'FULL', quantity: 2 },
          { skuCode: 'HLAG-650', sizeCode: 'BEER_650', quantity: 1 },
        ],
      });
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY - 2);
      expect(await onHand(db, fx.sku.beer650)).toBe(OPENING_QTY - 1);
    });

    it('accepts a walk-in (no member, or memberId null)', async () => {
      const { tickets, printer } = fakePrinter();
      const { fx, call } = await start({ printer });
      const a = await kot(call, { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.beer330, quantity: 3 }] });
      const b = await kot(call, { waiterId: fx.waiter.trusted, memberId: null, items: [{ skuId: fx.sku.beer330, quantity: 1 }] });
      expect(a).toMatchObject({ status: 201, body: { bill: { memberId: null }, member: null } });
      expect(b.body.bill.billNo).toBe(a.body.bill.billNo + 1);
      expect(tickets.map((t) => t.member)).toEqual([null, null]);
    });

    it('still opens NORMAL waiter bills while a peak session runs (peak bills are counter-only)', async () => {
      const { fx, call, counter } = await start({ printer: fakePrinter().printer });
      await counter('POST', '/api/peak/sessions', { businessDayId: fx.dayId, declaredCash: '0', declaredUpi: '0' });
      expect(await kot(call, { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.half, quantity: 1 }] })).toMatchObject({
        status: 201,
        body: { bill: { mode: 'NORMAL', status: 'OPEN', peakSessionId: null } },
      });
    });

    it('saves nothing and prints nothing when any line is short of stock (409 PS003)', async () => {
      const { tickets, printer } = fakePrinter();
      const { db, fx, call } = await start({ printer });
      const before = await billCount();
      const res = await kot(call, {
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
      const { fx, call, counter } = await start({ printer });
      const res = await kot(call, { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.quarter, quantity: 1 }] });
      expect(res).toMatchObject({
        status: 201,
        body: { bill: { status: 'OPEN' }, kot: { station: 'COUNTER', printed: false, printedAt: null, error: 'printer 192.168.1.50:9100 unreachable' } },
      });
      expect((await counter('GET', `/api/bills/${res.body.bill.id}`)).status).toBe(200);
    });

    it('prints through the console stub by default', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const { fx, call } = await start();
      const res = await kot(call, { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.beer650, quantity: 2 }] });
      expect(res.body.kot.printed).toBe(true);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).toContain(`KOT #${res.body.bill.billNo} - COUNTER`);
    });

    describe('idempotency (requestId)', () => {
      it('replays a retried order: same bill, 200, no second print, no stock or bill-number change', async () => {
        const { tickets, printer } = fakePrinter();
        const { db, fx, call } = await start({ printer });
        const order = { requestId: randomUUID(), waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.half, quantity: 2 }] };

        const first = await kot(call, order);
        const bills = await billCount();
        const retry = await kot(call, order);

        expect(first.status).toBe(201);
        expect(retry.status).toBe(200);
        expect(retry.body).toMatchObject({ replayed: true, kot: null, bill: { id: first.body.bill.id, billNo: first.body.bill.billNo } });
        expect(retry.body.items).toEqual(first.body.items);
        expect(retry.body.waiter).toEqual(first.body.waiter);
        expect(tickets).toHaveLength(1);
        expect(await billCount()).toBe(bills);
        expect(await onHand(db, fx.sku.half)).toBe(OPENING_QTY - 2);
      });

      it('replays only the original lines, even after the counter adds to the bill', async () => {
        const { fx, call, counter } = await start({ printer: fakePrinter().printer });
        const order = { requestId: randomUUID(), waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.half, quantity: 1 }] };
        const first = await kot(call, order);
        await counter('POST', `/api/bills/${first.body.bill.id}/items`, { skuId: fx.sku.beer330, quantity: 1 });

        const retry = await kot(call, order);
        expect(retry.body.items.map((i: { skuCode: string }) => i.skuCode)).toEqual(['HRUM-H']);
        expect(retry.body.bill.totalPaise).toBe(String(PRICE.half + PRICE.beer330));
      });

      it('rejects a key reused for a different order, or from another handset (409 IDEMPOTENCY_CONFLICT)', async () => {
        const { fx, call } = await start({ printer: fakePrinter().printer });
        const order = { requestId: randomUUID(), waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.half, quantity: 1 }] };
        await kot(call, order);

        const conflict = { status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT', requestId: order.requestId } } };
        expect(await kot(call, { ...order, items: [{ skuId: fx.sku.half, quantity: 2 }] })).toMatchObject(conflict);
        expect(await kot(call, { ...order, waiterId: fx.waiter.limited })).toMatchObject(conflict);
        expect(await kot(call, order, bearer(HANDSETS.two.token))).toMatchObject(conflict);
      });

      it('leaves the key unused when an attempt fails, so the retry can succeed', async () => {
        const { db, fx, call } = await start({ printer: fakePrinter().printer });
        const order = { requestId: randomUUID(), waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.full, quantity: OPENING_QTY + 5 }] };
        expect((await kot(call, order)).status).toBe(409);

        await db.query(
          `INSERT INTO stock_movements (sku_id, movement_type, qty_delta, reason, created_by_staff_id) VALUES ($1, 'ADJUSTMENT', 10, 'delivery', $2)`,
          [fx.sku.full, fx.manager],
        );
        expect(await kot(call, order)).toMatchObject({ status: 201, body: { replayed: false } });
      });

      it.each([
        ['missing', undefined],
        ['not a UUID', 'retry-1'],
      ])('rejects a %s requestId with 400', async (_label, requestId) => {
        const { fx, call } = await start({ printer: fakePrinter().printer });
        const res = await call('POST', '/api/captain/kot', { requestId, waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.full, quantity: 1 }] });
        expect(res).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST', message: expect.stringMatching(/requestId/) } } });
      });
    });

    describe('bill-on-bill for untrusted waiters (PS010)', () => {
      it('refuses a second order while the first is unpaid, then accepts once the counter settles it', async () => {
        const { tickets, printer } = fakePrinter();
        const { fx, call, counter } = await start({ printer });
        const first = await kot(call, { waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.quarter, quantity: 1 }] });
        expect(first).toMatchObject({ status: 201, body: { bill: { waiterTrustedAtBilling: false } } });

        const blocked = await kot(call, { waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.beer330, quantity: 1 }] });
        expect(blocked).toMatchObject({
          status: 409,
          body: { error: { code: 'PS010', message: expect.stringMatching(new RegExp(`W02 has unpaid bill #${first.body.bill.billNo}`)) } },
        });
        expect(tickets).toHaveLength(1);

        await counter('POST', `/api/bills/${first.body.bill.id}/settle-waiter`, { waiterId: fx.waiter.untrusted, tender: 'CASH' });
        expect((await kot(call, { waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.beer330, quantity: 1 }] })).status).toBe(201);
      });

      it('counts an open counter bill tagged to the waiter', async () => {
        const { fx, call, counter } = await start({ printer: fakePrinter().printer });
        const bill = (await counter('POST', '/api/bills', { mode: 'NORMAL' })).body;
        await counter('PUT', `/api/bills/${bill.id}/waiter`, { waiterId: fx.waiter.untrusted });
        expect(await kot(call, { waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.full, quantity: 1 }] })).toMatchObject({
          status: 409,
          body: { error: { code: 'PS010' } },
        });
      });

      it("replays an untrusted waiter's retry instead of refusing it as bill-on-bill", async () => {
        const { fx, call } = await start({ printer: fakePrinter().printer });
        const order = { requestId: randomUUID(), waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.quarter, quantity: 1 }] };
        const first = await kot(call, order);
        expect(await kot(call, order)).toMatchObject({ status: 200, body: { replayed: true, bill: { id: first.body.bill.id } } });
      });

      it('never applies to trusted waiters', async () => {
        const { fx, call } = await start({ printer: fakePrinter().printer });
        for (let i = 0; i < 3; i++) {
          expect((await kot(call, { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.beer330, quantity: 1 }] })).status).toBe(201);
        }
      });
    });

    describe('validation', () => {
      it('rejects an inactive SKU with 400 INACTIVE and saves nothing', async () => {
        const { tickets, printer } = fakePrinter();
        const { db, fx, call } = await start({ printer });
        await db.query(`UPDATE skus SET is_active = false WHERE id = $1`, [fx.sku.half]);
        const before = await billCount();
        const res = await kot(call, {
          waiterId: fx.waiter.trusted,
          items: [
            { skuId: fx.sku.full, quantity: 1 },
            { skuId: fx.sku.half, quantity: 1 },
          ],
        });
        expect(res).toMatchObject({
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
        expect(await kot(call, { waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.full, quantity: 1 }] })).toMatchObject({
          status: 400,
          body: { error: { code: 'INACTIVE', entity: 'waiter', message: 'waiter W02 is inactive' } },
        });
        const memberId = await addMember(false);
        expect(await kot(call, { waiterId: fx.waiter.trusted, memberId, items: [{ skuId: fx.sku.full, quantity: 1 }] })).toMatchObject({
          status: 400,
          body: { error: { code: 'INACTIVE', entity: 'member' } },
        });
      });

      it.each<[string, (fx: ReturnType<typeof ctx>['fx']) => Record<string, unknown>]>([
        ['waiter', (fx) => ({ waiterId: MISSING, items: [{ skuId: fx.sku.full, quantity: 1 }] })],
        ['sku', (fx) => ({ waiterId: fx.waiter.trusted, items: [{ skuId: MISSING, quantity: 1 }] })],
        ['member', (fx) => ({ waiterId: fx.waiter.trusted, memberId: MISSING, items: [{ skuId: fx.sku.full, quantity: 1 }] })],
      ])('returns 404 for an unknown %s', async (entity, body) => {
        const { fx, call } = await start({ printer: fakePrinter().printer });
        expect(await kot(call, body(fx))).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND', entity, id: MISSING } } });
      });

      type Fx = ReturnType<typeof ctx>['fx'];
      const order = (fx: Fx, items: unknown, extra: Record<string, unknown> = {}) => ({ waiterId: fx.waiter.trusted, items, ...extra });
      it.each<[string, (fx: Fx) => Record<string, unknown>]>([
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
        expect(await kot(call, body(fx))).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
      });
    });
  });

  describe('GET /api/captain/waiter/:waiterId/bills', () => {
    it("lists the waiter's open bills — app orders and counter bills tagged to them — oldest first", async () => {
      const { fx, call, counter } = await start({ printer: fakePrinter().printer });
      const kot1 = (await kot(call, { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.full, quantity: 1 }] })).body;
      const tagged = (await counter('POST', '/api/bills', { mode: 'NORMAL' })).body;
      await counter('POST', `/api/bills/${tagged.id}/items`, { skuId: fx.sku.beer330, quantity: 2 });
      await counter('PUT', `/api/bills/${tagged.id}/waiter`, { waiterId: fx.waiter.trusted });
      await kot(call, { waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.half, quantity: 1 }] });
      const kot2 = (await kot(call, { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.quarter, quantity: 1 }] })).body;

      const res = await call('GET', `/api/captain/waiter/${fx.waiter.trusted}/bills`);
      expect(res.status).toBe(200);
      expect(res.body.map((d: { bill: { id: string; source: string } }) => [d.bill.id, d.bill.source])).toEqual([
        [kot1.bill.id, 'WAITER_APP'],
        [tagged.id, 'COUNTER'],
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
      const { fx, call, counter } = await start({ printer: fakePrinter().printer });
      const order = (await kot(call, { waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.quarter, quantity: 1 }] })).body;
      expect((await call('GET', `/api/captain/waiter/${fx.waiter.untrusted}/bills`)).body).toHaveLength(1);

      const settled = await counter('POST', `/api/bills/${order.bill.id}/settle-waiter`, { waiterId: fx.waiter.untrusted, tender: 'CASH' });
      expect(settled).toMatchObject({ status: 200, body: { bill: { status: 'SETTLED' } } });
      expect((await call('GET', `/api/captain/waiter/${fx.waiter.untrusted}/bills`)).body).toEqual([]);
      expect((await call('GET', `/api/captain/waiter/${fx.waiter.limited}/bills`)).body).toEqual([]);
    });

    it('returns 404 for an unknown waiter', async () => {
      const { call } = await start();
      expect(await call('GET', `/api/captain/waiter/${MISSING}/bills`)).toMatchObject({ status: 404, body: { error: { entity: 'waiter' } } });
    });
  });

  describe('counter: GET /api/captain-orders and edits before settling', () => {
    it('lists open app orders oldest first, lets the cashier cancel a line and attach a member, then settle', async () => {
      const { fx, call, counter } = await start({ printer: fakePrinter().printer });
      const memberId = await addMember();
      const first = await kot(call, { waiterId: fx.waiter.untrusted, items: [{ skuId: fx.sku.half, quantity: 2 }, { skuId: fx.sku.beer650, quantity: 1 }] });
      const second = await kot(call, { waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.quarter, quantity: 1 }] });
      const counterBill = (await counter('POST', '/api/bills', { mode: 'NORMAL' })).body;
      await counter('POST', `/api/bills/${counterBill.id}/items`, { skuId: fx.sku.full, quantity: 1 });

      const listed = await counter('GET', '/api/captain-orders');
      expect(listed.status).toBe(200);
      expect(listed.body.map((o: { bill: { id: string } }) => o.bill.id)).toEqual([first.body.bill.id, second.body.bill.id]);
      expect(listed.body[0]).toMatchObject({
        bill: { source: 'WAITER_APP', captainDeviceId: HANDSETS.one.id, totalPaise: String(2 * PRICE.half + PRICE.beer650) },
        waiter: { code: 'W02', isTrusted: false },
        member: null,
      });

      const billId: string = first.body.bill.id;
      const beerLine = first.body.items[1].id;
      const cancelled = await counter('POST', `/api/bills/${billId}/items/${beerLine}/cancel`, { quantity: 1 });
      expect(cancelled).toMatchObject({ status: 201, body: { bill: { totalPaise: String(2 * PRICE.half) } } });
      expect(await onHand(ctx().db, fx.sku.beer650)).toBe(OPENING_QTY);
      expect(await counter('PUT', `/api/bills/${billId}/member`, { memberId })).toMatchObject({ status: 200, body: { memberId } });

      const settled = await counter('POST', `/api/bills/${billId}/settle-waiter`, { waiterId: fx.waiter.untrusted, tender: 'CASH' });
      expect(settled).toMatchObject({ status: 200, body: { bill: { status: 'SETTLED' }, remainingDuePaise: '0' } });
      const after = await counter('GET', '/api/captain-orders');
      expect(after.body.map((o: { bill: { id: string } }) => o.bill.id)).toEqual([second.body.bill.id]);
    });

    it('is not served on the Wi-Fi Captain server', async () => {
      const { call } = await start();
      expect(await call('GET', '/api/captain-orders')).toMatchObject({ status: 404 });
    });
  });
});
