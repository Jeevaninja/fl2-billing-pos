import { randomUUID } from 'node:crypto';
import type { PGliteInterface } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../../src/db/client.js';
import { IdempotencyConflictError, InactiveError, NotFoundError, PosErrorCode } from '../../src/db/errors.js';
import {
  CaptainService,
  CatalogService,
  type KotPrinter,
  type KotTicket,
  type RoundRequest,
  roundFingerprint,
  WaiterService,
} from '../../src/services/index.js';
import { expectSqlError, useSeededDb } from '../support/db.js';
import { OPENING_QTY, PRICE } from '../support/fixtures.js';
import { one, onHand, openBill } from '../support/pos.js';
import { expectPosError } from '../support/services.js';

function fakePrinter() {
  const tickets: KotTicket[] = [];
  const printer: KotPrinter = {
    async printKOT(ticket) {
      tickets.push(ticket);
      return { station: ticket.station, printedAt: new Date(), text: '' };
    },
  };
  return { tickets, printer };
}

/** A retry racing an in-flight original: the first round-key lookup sees nothing, so the attempt reaches the INSERT. */
function hideFirstRoundLookup(db: PGliteInterface): SqlDatabase {
  let hidden = false;
  return {
    query: <T,>(sql: string, params?: unknown[]) => {
      if (!hidden && sql.includes('FROM captain_order_rounds WHERE request_id = $1')) {
        hidden = true;
        return Promise.resolve({ rows: [] as T[] });
      }
      return db.query<T>(sql, params);
    },
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
  };
}

describe('Captain rounds and settle requests (0020)', () => {
  const ctx = useSeededDb();

  function setup() {
    const { db, fx } = ctx();
    const { tickets, printer } = fakePrinter();
    const captain = new CaptainService(db, printer);
    const order = (waiterId = fx.waiter.trusted, items = [{ skuId: fx.sku.full, quantity: 1 }]) =>
      captain.placeOrder({ requestId: randomUUID(), deviceId: 'handset-01', waiterId, items });
    const round = (billId: string, over: Partial<RoundRequest> = {}): RoundRequest => ({
      requestId: randomUUID(),
      deviceId: 'handset-01',
      waiterId: fx.waiter.trusted,
      billId,
      items: [{ skuId: fx.sku.beer650, quantity: 2 }],
      ...over,
    });
    const lineCount = async (billId: string) => (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM bill_items WHERE bill_id = $1`, [billId])).n;
    const roundCount = async () => (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM captain_order_rounds`)).n;
    return { db, fx, tickets, captain, order, round, lineCount, roundCount };
  }

  describe('addToBill', () => {
    it('appends the round to the open bill and prints only the new lines', async () => {
      const { db, fx, tickets, captain, order, round } = setup();
      const placed = await order();
      tickets.length = 0;

      const added = await captain.addToBill(round(placed.bill.id, { items: [{ skuId: fx.sku.beer650, quantity: 2 }, { skuId: fx.sku.half, quantity: 1 }] }));

      expect(added.replayed).toBe(false);
      expect(added.bill).toMatchObject({ id: placed.bill.id, status: 'OPEN', totalPaise: BigInt(PRICE.full + 2 * PRICE.beer650 + PRICE.half) });
      expect(added.items.map((i) => [i.lineNo, i.skuCode, i.quantity])).toEqual([
        [2, 'HLAG-650', 2],
        [3, 'HRUM-H', 1],
      ]);
      expect(added.kots).toMatchObject([{ station: 'BAR', printed: true, sentQuantity: 3 }]);
      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({ ticketNo: 2, lines: [{ skuCode: 'HLAG-650', quantity: 2 }, { skuCode: 'HRUM-H', quantity: 1 }] });
      expect(await onHand(db, fx.sku.beer650)).toBe(OPENING_QTY - 2);
      expect(
        await one(db, `SELECT bill_id, waiter_id, captain_device_id, first_line_no, line_count FROM captain_order_rounds`),
      ).toEqual({ bill_id: placed.bill.id, waiter_id: fx.waiter.trusted, captain_device_id: 'handset-01', first_line_no: 2, line_count: 2 });
    });

    it('sends kitchen lines of a round to the KITCHEN station', async () => {
      const { db, tickets, captain, order, round } = setup();
      const dish = await new CatalogService(db).createProduct({
        name: 'Chicken 65',
        category: 'FOOD',
        department: 'KITCHEN',
        codePrefix: 'CH65',
        skus: [{ sizeCode: 'UNIT', salePricePaise: 180_00n, caseSize: 1 }],
      });
      const placed = await order();
      tickets.length = 0;
      const added = await captain.addToBill(round(placed.bill.id, { items: [{ skuId: dish.skus[0]!.id, quantity: 2 }] }));
      expect(added.kots).toMatchObject([{ station: 'KITCHEN', printed: true, sentQuantity: 2 }]);
      expect(tickets.map((t) => t.station)).toEqual(['KITCHEN']);
    });

    it('replays a retry with the same key: same lines, no new lines, no reprint', async () => {
      const { tickets, captain, order, round, lineCount, roundCount } = setup();
      const placed = await order();
      const request = round(placed.bill.id);
      const first = await captain.addToBill(request);
      const printed = tickets.length;

      const retry = await captain.addToBill(request);
      expect(retry).toMatchObject({ replayed: true, kots: [], bill: { id: placed.bill.id } });
      expect(retry.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
      expect(await lineCount(placed.bill.id)).toBe(2);
      expect(await roundCount()).toBe(1);
      expect(tickets).toHaveLength(printed);
    });

    it('replays when a racing retry collides on the round key', async () => {
      const { db, fx, order, round, lineCount } = setup();
      const placed = await order();
      const request = round(placed.bill.id);
      const first = await new CaptainService(db, fakePrinter().printer).addToBill(request);

      const retry = await new CaptainService(hideFirstRoundLookup(db), fakePrinter().printer).addToBill(request);
      expect(retry).toMatchObject({ replayed: true, bill: { id: placed.bill.id } });
      expect(retry.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
      expect(await lineCount(placed.bill.id)).toBe(2);
      expect(await onHand(db, fx.sku.beer650)).toBe(OPENING_QTY - 2);
    });

    it('refuses a key reused for a different round', async () => {
      const { fx, captain, order, round } = setup();
      const placed = await order();
      const request = round(placed.bill.id);
      await captain.addToBill(request);
      await expect(captain.addToBill({ ...request, items: [{ skuId: fx.sku.full, quantity: 1 }] })).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('lets an untrusted waiter add to their open bill, though a second order is bill-on-bill', async () => {
      const { fx, captain, order, round } = setup();
      const placed = await order(fx.waiter.untrusted);
      await expectPosError(order(fx.waiter.untrusted), PosErrorCode.BILL_ON_BILL);
      const added = await captain.addToBill(round(placed.bill.id, { waiterId: fx.waiter.untrusted }));
      expect(added.bill).toMatchObject({ id: placed.bill.id, waiterId: fx.waiter.untrusted });
    });

    it('adds to a counter bill tagged to the waiter', async () => {
      const { db, fx, captain, round } = setup();
      const bill = await openBill(db, { waiterId: fx.waiter.trusted });
      const added = await captain.addToBill(round(bill.id));
      expect(added.bill).toMatchObject({ id: bill.id, source: 'COUNTER' });
      expect(added.items).toHaveLength(1);
    });

    it("refuses another waiter's bill (PS002) and saves nothing", async () => {
      const { fx, captain, order, round, lineCount, roundCount } = setup();
      const placed = await order(fx.waiter.trusted);
      await expectPosError(captain.addToBill(round(placed.bill.id, { waiterId: fx.waiter.limited })), PosErrorCode.ILLEGAL_TRANSITION, /not tagged/);
      expect(await lineCount(placed.bill.id)).toBe(1);
      expect(await roundCount()).toBe(0);
    });

    it('refuses a settled bill (PS001)', async () => {
      const { db, fx, captain, order, round } = setup();
      const placed = await order();
      await new WaiterService(db).settleWaiterBill(placed.bill.id, fx.waiter.trusted, 'CASH');
      await expectPosError(captain.addToBill(round(placed.bill.id)), PosErrorCode.APPEND_ONLY, /SETTLED/);
    });

    it('refuses a short line (PS003), saves nothing, and leaves the key free', async () => {
      const { db, fx, captain, order, round, lineCount, roundCount } = setup();
      const placed = await order();
      const requestId = randomUUID();
      await expectPosError(
        captain.addToBill(round(placed.bill.id, { requestId, items: [{ skuId: fx.sku.half, quantity: 1 }, { skuId: fx.sku.beer650, quantity: OPENING_QTY + 1 }] })),
        PosErrorCode.INSUFFICIENT_STOCK,
      );
      expect(await lineCount(placed.bill.id)).toBe(1);
      expect(await roundCount()).toBe(0);
      expect(await onHand(db, fx.sku.half)).toBe(OPENING_QTY);

      const added = await captain.addToBill(round(placed.bill.id, { requestId, items: [{ skuId: fx.sku.beer650, quantity: 1 }] }));
      expect(added.replayed).toBe(false);
    });

    it('refuses an inactive SKU, an unknown bill and a malformed order', async () => {
      const { db, fx, captain, order, round } = setup();
      const placed = await order();
      await db.query(`UPDATE skus SET is_active = false WHERE id = $1`, [fx.sku.quarter]);
      await expect(captain.addToBill(round(placed.bill.id, { items: [{ skuId: fx.sku.quarter, quantity: 1 }] }))).rejects.toBeInstanceOf(InactiveError);
      await expect(captain.addToBill(round(randomUUID()))).rejects.toBeInstanceOf(NotFoundError);
      await expect(captain.addToBill(round(placed.bill.id, { items: [] }))).rejects.toBeInstanceOf(RangeError);
      await expect(captain.addToBill(round(placed.bill.id, { items: [{ skuId: fx.sku.full, quantity: 0 }] }))).rejects.toBeInstanceOf(RangeError);
    });
  });

  describe('requestSettlement', () => {
    it('flags the bill once; a repeat returns the first request', async () => {
      const { fx, captain, order } = setup();
      const placed = await order();
      const first = await captain.requestSettlement({ deviceId: 'handset-01', waiterId: fx.waiter.trusted, billId: placed.bill.id });
      expect(first).toMatchObject({ alreadyRequested: false, bill: { id: placed.bill.id, status: 'OPEN' } });

      const again = await captain.requestSettlement({ deviceId: 'handset-02', waiterId: fx.waiter.trusted, billId: placed.bill.id });
      expect(again).toMatchObject({ alreadyRequested: true, requestedAt: first.requestedAt });

      const [open] = await captain.listOpenBills(fx.waiter.trusted);
      expect(open!.settleRequestedAt).toEqual(first.requestedAt);
    });

    it('moves no money, and still allows another round (D6)', async () => {
      const { db, fx, captain, order, round } = setup();
      const placed = await order();
      await captain.requestSettlement({ deviceId: 'handset-01', waiterId: fx.waiter.trusted, billId: placed.bill.id });
      expect((await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM bill_payments`)).n).toBe(0);
      const added = await captain.addToBill(round(placed.bill.id));
      expect(added.bill.totalPaise).toBe(BigInt(PRICE.full + 2 * PRICE.beer650));
    });

    it("refuses a settled bill (PS001) and another waiter's bill (PS002)", async () => {
      const { db, fx, captain, order } = setup();
      const placed = await order();
      await expectPosError(
        captain.requestSettlement({ deviceId: 'handset-01', waiterId: fx.waiter.limited, billId: placed.bill.id }),
        PosErrorCode.ILLEGAL_TRANSITION,
      );
      await new WaiterService(db).settleWaiterBill(placed.bill.id, fx.waiter.trusted, 'CASH');
      await expectPosError(
        captain.requestSettlement({ deviceId: 'handset-01', waiterId: fx.waiter.trusted, billId: placed.bill.id }),
        PosErrorCode.APPEND_ONLY,
      );
    });

    it('reports no request on bills that were never flagged', async () => {
      const { fx, captain, order } = setup();
      await order();
      expect((await captain.listOpenBills(fx.waiter.trusted))[0]!.settleRequestedAt).toBeNull();
    });
  });

  describe('schema rules', () => {
    it('keeps both tables append-only (PS001)', async () => {
      const { fx, captain, order, round, db } = setup();
      const placed = await order();
      await captain.addToBill(round(placed.bill.id));
      await captain.requestSettlement({ deviceId: 'handset-01', waiterId: fx.waiter.trusted, billId: placed.bill.id });
      for (const table of ['captain_order_rounds', 'bill_settle_requests']) {
        await expectSqlError(db.query(`UPDATE ${table} SET captain_device_id = 'handset-02'`), PosErrorCode.APPEND_ONLY);
        await expectSqlError(db.query(`DELETE FROM ${table}`), PosErrorCode.APPEND_ONLY);
      }
    });

    it("refuses a raw insert naming another waiter's bill (PS002) or a settled one (PS001)", async () => {
      const { db, fx, order } = setup();
      const placed = await order();
      const insert = (waiterId: string) =>
        db.query(`INSERT INTO bill_settle_requests (bill_id, waiter_id, captain_device_id) VALUES ($1, $2, 'handset-01')`, [placed.bill.id, waiterId]);
      await expectSqlError(insert(fx.waiter.limited), PosErrorCode.ILLEGAL_TRANSITION);
      await new WaiterService(db).settleWaiterBill(placed.bill.id, fx.waiter.trusted, 'CASH');
      await expectSqlError(insert(fx.waiter.trusted), PosErrorCode.APPEND_ONLY);
    });

    it('sends both tables to the sync outbox', async () => {
      const { fx, captain, order, round, db } = setup();
      const placed = await order();
      await captain.addToBill(round(placed.bill.id));
      await captain.requestSettlement({ deviceId: 'handset-01', waiterId: fx.waiter.trusted, billId: placed.bill.id });
      const { rows } = await db.query<{ event_type: string }>(
        `SELECT event_type FROM sync_outbox WHERE aggregate_type IN ('captain_order_rounds', 'bill_settle_requests') ORDER BY seq`,
      );
      expect(rows.map((r) => r.event_type)).toEqual(['captain_order_rounds.insert', 'bill_settle_requests.insert']);
    });
  });

  describe('handset lookups', () => {
    it('lists active waiters without balances', async () => {
      const { db, fx, captain } = setup();
      await db.query(`UPDATE waiters SET is_active = false WHERE id = $1`, [fx.waiter.limited]);
      expect(await captain.listWaiters()).toEqual([
        { id: fx.waiter.trusted, code: 'W01', displayName: 'Trusted', isTrusted: true },
        { id: fx.waiter.untrusted, code: 'W02', displayName: 'Untrusted', isTrusted: false },
      ]);
    });

    it('lists active items with price and stock, inactive ones left out', async () => {
      const { db, fx, captain, order } = setup();
      await order(fx.waiter.trusted, [{ skuId: fx.sku.full, quantity: 3 }]);
      await db.query(`UPDATE skus SET is_active = false WHERE id = $1`, [fx.sku.quarter]);
      const catalog = await captain.getCatalog();
      expect(catalog.map((i) => i.skuCode)).toEqual(['HLAG-650', 'HLAG-330', 'HRUM-F', 'HRUM-H']);
      expect(catalog.find((i) => i.id === fx.sku.full)).toEqual({
        id: fx.sku.full,
        skuCode: 'HRUM-F',
        displayName: 'House Rum — Full',
        sizeCode: 'FULL',
        pricePaise: BigInt(PRICE.full),
        saleUnitName: 'Bottle',
        onHandQty: OPENING_QTY - 3,
        tracksStock: true,
        department: 'LIQUOR',
        departmentName: expect.any(String),
        itemCategory: { id: expect.any(String), name: expect.any(String) },
      });
    });

    it('finds a member by card number, case-insensitively; inactive and unknown are refused', async () => {
      const { db, captain } = setup();
      const member = await one<{ id: string }>(db, `INSERT INTO members (membership_no, display_name) VALUES ('CHN01-0042', 'Anil Kumar') RETURNING id`);
      expect(await captain.findMemberByCode(' chn01-0042 ')).toEqual({ id: member.id, membershipNo: 'CHN01-0042', displayName: 'Anil Kumar' });
      await expect(captain.findMemberByCode('CHN01-9999')).rejects.toBeInstanceOf(NotFoundError);
      await db.query(`UPDATE members SET is_active = false WHERE id = $1`, [member.id]);
      await expect(captain.findMemberByCode('CHN01-0042')).rejects.toBeInstanceOf(InactiveError);
    });
  });
});

describe('roundFingerprint', () => {
  const base = { deviceId: 'handset-01', waiterId: randomUUID(), billId: randomUUID(), items: [{ skuId: randomUUID(), quantity: 1 }] };

  it('ignores id case but not the bill, handset, lines or their order', () => {
    const fp = roundFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(roundFingerprint({ ...base, waiterId: base.waiterId.toUpperCase(), billId: base.billId.toUpperCase() })).toBe(fp);
    expect(roundFingerprint({ ...base, billId: randomUUID() })).not.toBe(fp);
    expect(roundFingerprint({ ...base, deviceId: 'handset-02' })).not.toBe(fp);
    expect(roundFingerprint({ ...base, items: [{ ...base.items[0]!, quantity: 2 }] })).not.toBe(fp);
  });
});
