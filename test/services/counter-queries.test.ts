import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../src/db/errors.js';
import { CaptainService, CounterQueries, DayEndService, type KotPrinter } from '../../src/services/index.js';
import { useSeededDb } from '../support/db.js';
import { OPENING_QTY } from '../support/fixtures.js';
import { one } from '../support/pos.js';
import { makeServices, PAISE } from '../support/services.js';

const MISSING = '00000000-0000-0000-0000-000000000000';
const silentPrinter: KotPrinter = { printKOT: async (t) => ({ station: t.station, printedAt: new Date(), text: '' }) };

describe('CounterQueries', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, queries: new CounterQueries(db), ...makeServices(db) };
  };

  describe('getCounterContext', () => {
    it('reports the cashier and open day, with no peak and no open bill on a fresh day', async () => {
      const { fx, queries } = setup();
      expect(await queries.getCounterContext(fx.cashier)).toEqual({
        cashier: { id: fx.cashier, displayName: 'Counter 1', role: 'CASHIER' },
        businessDay: { id: fx.dayId, businessDate: '2026-10-14', openedAt: expect.any(Date) },
        peakSession: null,
        openBill: null,
        openBills: [],
      });
    });

    it('includes the running peak session with its running expected total', async () => {
      const { fx, queries, peak, billing } = setup();
      const session = await peak.startPeakSession(fx.dayId, 500_00n, 0n, fx.cashier);
      await billing.recordPeakSale(session.id, fx.sku.beer650, 2, fx.cashier);

      const { peakSession } = await queries.getCounterContext(fx.cashier);
      expect(peakSession).toMatchObject({ id: session.id, sessionNo: 1, startCashPaise: 500_00n, endedAt: null });
      expect(peakSession?.runningExpectedPaise).toBe(2n * PAISE.beer650);

      await peak.endPeakSession(session.id, 1000_00n, 0n, fx.cashier);
      expect((await queries.getCounterContext(fx.cashier)).peakSession).toBeNull();
    });

    it('reports the expected drawer cash of a running peak: start cash + peak sales + in-peak cash − in-peak expenses', async () => {
      const { db, fx, queries, peak, billing, waiters } = setup();
      const dayEnd = new DayEndService(db);
      // A trusted waiter owes for a bill from before the peak; a counter bill is still open.
      const credit = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(credit.id, fx.sku.quarter, 1);
      await waiters.tagBillToWaiter(credit.id, fx.waiter.trusted);
      await waiters.settleWaiterBill(credit.id, fx.waiter.trusted, 'WAITER_CREDIT');
      const open = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(open.id, fx.sku.beer330, 1);

      const session = await peak.startPeakSession(fx.dayId, 1000_00n, 50_00n, fx.cashier);
      expect((await queries.getCounterContext(fx.cashier)).peakSession?.expectedDrawerCashPaise).toBe(1000_00n);

      await billing.recordPeakSale(session.id, fx.sku.beer650, 2, fx.cashier); // + 2 × 250 (no tender: counted as cash)
      await billing.settleNormalBill(open.id, [{ mode: 'CASH', amount: PAISE.beer330 }]); // + 150 cash
      await waiters.recordWaiterRepayment(fx.waiter.trusted, 100_00n, 'CASH', fx.cashier); // + 100 cash
      await waiters.recordWaiterRepayment(fx.waiter.trusted, 50_00n, 'UPI', fx.cashier); // UPI: not in the drawer
      await dayEnd.recordCashExpense(30_00n, null, fx.cashier, fx.expenseCategory.ICE); // − 30

      const expected = 1000_00n + 2n * PAISE.beer650 + PAISE.beer330 + 100_00n - 30_00n;
      const { peakSession } = await queries.getCounterContext(fx.cashier);
      expect(peakSession).toMatchObject({ expectedDrawerCashPaise: expected });
      expect(peakSession?.runningExpectedPaise).toBe(2n * PAISE.beer650 + PAISE.beer330 + 100_00n + 50_00n - 30_00n);
      expect((await dayEnd.getDayEndSummary(fx.dayId)).blockers.runningPeakSession?.expectedDrawerCashPaise).toBe(expected);
    });

    it("resumes this cashier's newest open NORMAL bill, not another cashier's or a settled one", async () => {
      const { fx, queries, billing } = setup();
      const settled = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(settled.id, fx.sku.quarter, 1);
      await billing.settleNormalBill(settled.id, [{ mode: 'CASH', amount: PAISE.quarter }]);
      await billing.createBill('NORMAL', fx.manager);
      expect((await queries.getCounterContext(fx.cashier)).openBill).toBeNull();

      const older = await billing.createBill('NORMAL', fx.cashier);
      const newer = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(newer.id, fx.sku.full, 1);
      const { openBill } = await queries.getCounterContext(fx.cashier);
      expect(openBill?.bill.id).toBe(newer.id);
      expect(openBill?.bill.id).not.toBe(older.id);
      expect(openBill?.items).toHaveLength(1);
    });

    it("lists every open NORMAL counter bill of this cashier, oldest first, for held billing tabs", async () => {
      const { fx, queries, billing, peak } = setup();
      const first = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(first.id, fx.sku.full, 1);
      const settled = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(settled.id, fx.sku.quarter, 1);
      await billing.settleNormalBill(settled.id, [{ mode: 'CASH', amount: PAISE.quarter }]);
      await billing.createBill('NORMAL', fx.manager);
      const second = await billing.createBill('NORMAL', fx.cashier);
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      await billing.recordPeakSale(session.id, fx.sku.beer650, 1, fx.cashier);

      const { openBills, openBill } = await queries.getCounterContext(fx.cashier);
      expect(openBills.map((d) => d.bill.id)).toEqual([first.id, second.id]);
      expect(openBills[0]?.items).toHaveLength(1);
      expect(openBill?.bill.id).toBe(second.id);
    });

    it('reports a null business day when none is open', async () => {
      const { db, fx, queries } = setup();
      await db.query(`UPDATE business_days SET status = 'CLOSED', closed_at = now(), closed_by_staff_id = $1, counted_cash_paise = 0`, [fx.manager]);
      expect(await queries.getCounterContext(fx.cashier)).toMatchObject({ businessDay: null, peakSession: null, openBill: null, openBills: [] });
    });

    it('throws NotFoundError for an unknown cashier', async () => {
      const { queries } = setup();
      await expect(queries.getCounterContext(MISSING)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('lookupSku', () => {
    it('finds by barcode first, then by SKU code (case-insensitive), with stock on hand', async () => {
      const { db, fx, queries, billing } = setup();
      await db.query(`UPDATE skus SET barcode = '8901234567890' WHERE id = $1`, [fx.sku.full]);
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.full, 2);

      expect(await queries.lookupSku(' 8901234567890 ')).toEqual({
        id: fx.sku.full,
        skuCode: 'HRUM-F',
        barcode: '8901234567890',
        displayName: 'House Rum — Full',
        sizeCode: 'FULL',
        pricePaise: PAISE.full,
        purchasePricePaise: null,
        caseSize: 12,
        purchaseUnitName: 'Case',
        saleUnitName: 'Bottle',
        onHandQty: OPENING_QTY - 2,
        isActive: true,
        department: 'LIQUOR',
        departmentName: 'Liquor',
        tracksStock: true,
        itemCategory: { id: expect.any(String), name: 'FULL' },
      });
      expect((await queries.lookupSku('hlag-330'))?.id).toBe(fx.sku.beer330);
    });

    it('prefers a barcode match over a SKU code that happens to be equal', async () => {
      const { db, fx, queries } = setup();
      // HRUM-F's barcode equals HLAG-330's SKU code, and HLAG-330 sorts first: the barcode must still win.
      await db.query(`UPDATE skus SET barcode = 'HLAG-330' WHERE id = $1`, [fx.sku.full]);
      expect((await queries.lookupSku('HLAG-330'))?.id).toBe(fx.sku.full);
    });

    it('returns inactive SKUs flagged, and null for unknown or blank codes', async () => {
      const { db, fx, queries } = setup();
      await db.query(`UPDATE skus SET is_active = false WHERE id = $1`, [fx.sku.half]);
      expect(await queries.lookupSku('HRUM-H')).toMatchObject({ id: fx.sku.half, isActive: false });
      expect(await queries.lookupSku('NOPE')).toBeNull();
      expect(await queries.lookupSku('   ')).toBeNull();
    });
  });

  describe('searchMembers', () => {
    it('matches membership number prefix or name substring, exact number first, active only', async () => {
      const { db, queries } = setup();
      for (const [no, name, active] of [
        ['M-10', 'Zara Khan', true],
        ['M-100', 'Anil Kumar', true],
        ['M-200', 'Sunil M-10 Rao', true],
        ['M-300', 'Old Member', false],
      ] as const) {
        await db.query(`INSERT INTO members (membership_no, display_name, is_active) VALUES ($1, $2, $3)`, [no, name, active]);
      }
      expect((await queries.searchMembers('m-10')).map((m) => m.membershipNo)).toEqual(['M-10', 'M-100', 'M-200']);
      expect(await queries.searchMembers('anil')).toEqual([{ id: expect.any(String), membershipNo: 'M-100', displayName: 'Anil Kumar' }]);
      expect(await queries.searchMembers('old')).toEqual([]);
      expect(await queries.searchMembers('  ')).toEqual([]);
    });

    it('treats LIKE wildcards literally and honours the limit', async () => {
      const { db, queries } = setup();
      await db.query(`INSERT INTO members (membership_no, display_name) VALUES ('A1', 'Plain'), ('A2', '100% Club')`);
      expect((await queries.searchMembers('%')).map((m) => m.displayName)).toEqual(['100% Club']);
      expect(await queries.searchMembers('_')).toEqual([]);
      expect(await queries.searchMembers('A', 1)).toHaveLength(1);
    });
  });

  describe('listWaiters', () => {
    it('lists active waiters by code with trust, outstanding balance and credit limit', async () => {
      const { db, fx, queries, billing, waiters } = setup();
      await db.query(`INSERT INTO waiters (waiter_code, display_name, is_active) VALUES ('W99', 'Gone', false)`);
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.quarter, 1);
      await waiters.tagBillToWaiter(bill.id, fx.waiter.limited);
      await waiters.settleWaiterBill(bill.id, fx.waiter.limited, 'WAITER_CREDIT');

      expect(await queries.listWaiters()).toEqual([
        { id: fx.waiter.trusted, code: 'W01', displayName: 'Trusted', isTrusted: true, outstandingPaise: 0n, creditLimitPaise: null },
        { id: fx.waiter.untrusted, code: 'W02', displayName: 'Untrusted', isTrusted: false, outstandingPaise: 0n, creditLimitPaise: null },
        { id: fx.waiter.limited, code: 'W03', displayName: 'Limited', isTrusted: true, outstandingPaise: PAISE.quarter, creditLimitPaise: 1000_00n },
      ]);
    });
  });

  describe('getBillDetail', () => {
    it('returns lines with remaining quantities, tenders, member, waiter and amount due', async () => {
      const { db, fx, queries, billing, waiters } = setup();
      const member = await one<{ id: string }>(db, `INSERT INTO members (membership_no, display_name) VALUES ('M-7', 'Seven') RETURNING id`);
      const bill = await billing.createBill('NORMAL', fx.cashier, member.id);
      const { item: full } = await billing.addItemToBill(bill.id, fx.sku.full, 3);
      const { item: beer } = await billing.addItemToBill(bill.id, fx.sku.beer330, 1);
      await billing.cancelBillItem(bill.id, full.id, 1);
      await waiters.tagBillToWaiter(bill.id, fx.waiter.trusted);
      await waiters.settleWaiterBill(bill.id, fx.waiter.trusted, 'UPI', 500_00n);

      const detail = await queries.getBillDetail(bill.id);
      const total = 2n * PAISE.full + PAISE.beer330;
      expect(detail.bill).toMatchObject({ id: bill.id, totalPaise: total, status: 'OPEN' });
      expect(detail.items.map((i) => [i.lineNo, i.quantity, i.remainingQuantity])).toEqual([
        [1, 3, 2],
        [2, 1, 1],
        [3, -1, 0],
      ]);
      expect(detail.items[1]?.id).toBe(beer.id);
      expect(detail.payments).toEqual([expect.objectContaining({ tender: 'UPI', amountPaise: 500_00n })]);
      expect(detail.member).toEqual({ id: member.id, membershipNo: 'M-7', displayName: 'Seven' });
      expect(detail.waiter).toMatchObject({ id: fx.waiter.trusted, code: 'W01', isTrusted: true });
      expect(detail.tenderedPaise).toBe(500_00n);
      expect(detail.duePaise).toBe(total - 500_00n);
    });

    it('returns null member and waiter for a walk-in bill, and NotFoundError for a missing bill', async () => {
      const { fx, queries, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      expect(await queries.getBillDetail(bill.id)).toMatchObject({
        items: [],
        payments: [],
        member: null,
        waiter: null,
        tenderedPaise: 0n,
        duePaise: 0n,
      });
      await expect(queries.getBillDetail(MISSING)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('listCaptainOrders', () => {
    it('lists only OPEN WAITER_APP sale bills, oldest first, with full detail', async () => {
      const { db, fx, queries, billing, waiters } = setup();
      const captain = new CaptainService(db, silentPrinter);
      const order = (waiterId: string, skuId: string, quantity = 1) =>
        captain.placeOrder({ requestId: randomUUID(), deviceId: 'handset-01', waiterId, items: [{ skuId, quantity }] });

      const first = await order(fx.waiter.trusted, fx.sku.half, 2);
      const settled = await order(fx.waiter.trusted, fx.sku.quarter);
      await waiters.settleWaiterBill(settled.bill.id, fx.waiter.trusted, 'CASH');
      const counter = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(counter.id, fx.sku.full, 1);
      await waiters.tagBillToWaiter(counter.id, fx.waiter.limited);
      const second = await order(fx.waiter.untrusted, fx.sku.beer650, 3);

      const orders = await queries.listCaptainOrders();
      expect(orders.map((o) => o.bill.id)).toEqual([first.bill.id, second.bill.id]);
      expect(orders[0]).toMatchObject({
        bill: { source: 'WAITER_APP', status: 'OPEN', captainDeviceId: 'handset-01', totalPaise: 2n * PAISE.half },
        waiter: { id: fx.waiter.trusted, code: 'W01' },
        duePaise: 2n * PAISE.half,
      });
      expect(orders[1]?.items.map((i) => [i.quantity, i.remainingQuantity])).toEqual([[3, 3]]);
    });

    it('returns an empty list when no Captain order is open', async () => {
      const { queries } = setup();
      expect(await queries.listCaptainOrders()).toEqual([]);
    });
  });
});
