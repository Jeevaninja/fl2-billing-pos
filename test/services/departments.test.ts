import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { SqlClient } from '../../src/db/client.js';
import { MIGRATIONS_DIR, runMigrations } from '../../src/db/migrate.js';
import { PosErrorCode } from '../../src/db/errors.js';
import {
  CaptainService,
  CatalogService,
  CounterQueries,
  DayEndService,
  ExpenseCategoryService,
  KotService,
  PurchaseService,
  type KotPrinter,
  type KotTicket,
} from '../../src/services/index.js';
import { useSeededDb, expectSqlError } from '../support/db.js';
import { seed } from '../support/fixtures.js';
import { one, sell } from '../support/pos.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

/** Phase 19 (0013): departments, untracked kitchen stock, KOT routing and the Day End split. */

function fakePrinter() {
  const tickets: KotTicket[] = [];
  const state = { failing: false };
  const printer: KotPrinter = {
    async printKOT(ticket) {
      if (state.failing) throw new Error('kitchen printer offline');
      tickets.push(ticket);
      return { station: ticket.station, printedAt: new Date(), text: '' };
    },
  };
  return { tickets, printer, state };
}

const onHand = async (db: SqlClient, skuId: string) =>
  (await one<{ q: number }>(db, `SELECT on_hand_qty AS q FROM sku_stock WHERE sku_id = $1`, [skuId])).q;

describe('departments (0013)', () => {
  const ctx = useSeededDb();

  /** Seeded liquor plus a Kitchen dish (Half / Full), a Kitchen single-size item and an Ancillary soda with stock. */
  async function setup() {
    const { db, fx } = ctx();
    const catalog = new CatalogService(db);
    const chicken = await catalog.createProduct({
      name: 'Chicken 65',
      category: 'FOOD',
      department: 'KITCHEN',
      codePrefix: 'CH65',
      skus: [
        { sizeCode: 'HALF', salePricePaise: 180_00n, caseSize: 1 },
        { sizeCode: 'FULL', salePricePaise: 320_00n, caseSize: 1 },
      ],
    });
    const peanuts = await catalog.createProduct({
      name: 'Masala Peanuts',
      category: 'FOOD',
      department: 'KITCHEN',
      codePrefix: 'MPNT',
      skus: [{ sizeCode: 'UNIT', salePricePaise: 120_00n, caseSize: 1 }],
    });
    const soda = await catalog.createProduct({
      name: 'Soda',
      category: 'BEVERAGE',
      department: 'ANCILLARY',
      codePrefix: 'SODA',
      skus: [{ sizeCode: 'UNIT', salePricePaise: 40_00n, caseSize: 24 }],
    });
    const sku = {
      chickenHalf: chicken.skus.find((k) => k.sizeCode === 'HALF')!.id,
      chickenFull: chicken.skus.find((k) => k.sizeCode === 'FULL')!.id,
      peanuts: peanuts.skus[0]!.id,
      soda: soda.skus[0]!.id,
    };
    await db.query(`INSERT INTO stock_movements (sku_id, movement_type, qty_delta) VALUES ($1, 'OPENING', 10)`, [sku.soda]);
    const printer = fakePrinter();
    return {
      db,
      fx,
      sku,
      products: { chicken, peanuts, soda },
      catalog,
      printer,
      kot: new KotService(db, printer.printer),
      dayEnd: new DayEndService(db),
      queries: new CounterQueries(db),
      ...makeServices(db),
    };
  }

  describe('schema and catalog', () => {
    it('seeds three read-only departments; existing products, lines and Ice are Liquor', async () => {
      const { db, fx, catalog } = await setup();
      expect(await catalog.listDepartments()).toEqual([
        { code: 'LIQUOR', name: 'Liquor', kotStation: 'BAR', tracksStock: true },
        { code: 'KITCHEN', name: 'Kitchen', kotStation: 'KITCHEN', tracksStock: false },
        { code: 'ANCILLARY', name: 'Ancillary', kotStation: 'BAR', tracksStock: true },
      ]);
      await expectSqlError(db.query(`UPDATE departments SET tracks_stock = true WHERE code = 'KITCHEN'`), 'PS001');
      await expectSqlError(db.query(`DELETE FROM departments WHERE code = 'ANCILLARY'`), 'PS001');
      await expectSqlError(db.query(`INSERT INTO departments VALUES ('BAKERY', 'Bakery', 'KITCHEN', false, 4)`), '23514');

      const rum = await one<{ department: string }>(db, `SELECT p.department FROM products p JOIN skus k ON k.product_id = p.id WHERE k.id = $1`, [fx.sku.full]);
      expect(rum.department).toBe('LIQUOR');
      const { rows: cats } = await db.query<{ name: string; department: string | null }>(`SELECT name, department FROM expense_categories ORDER BY sort_order`);
      expect(cats.filter((c) => c.department !== null)).toEqual([{ name: 'Ice', department: 'LIQUOR' }]);
    });

    it('creates Kitchen and Ancillary items: UNIT names are the product name, Full / Half plates reuse sizes', async () => {
      const { products, queries, sku } = await setup();
      expect(products.chicken).toMatchObject({ category: 'FOOD', department: 'KITCHEN' });
      expect(products.chicken.skus.map((s) => [s.skuCode, s.displayName, s.tracksStock])).toEqual([
        ['CH65-F', 'Chicken 65 — Full', false],
        ['CH65-H', 'Chicken 65 — Half', false],
      ]);
      expect(products.peanuts.skus[0]).toMatchObject({ skuCode: 'MPNT-U', displayName: 'Masala Peanuts', sizeCode: 'UNIT', department: 'KITCHEN' });
      expect(await queries.lookupSku('soda-u')).toMatchObject({ id: sku.soda, department: 'ANCILLARY', tracksStock: true, onHandQty: 10 });
    });

    it('moves a product between departments, but never strands stock in an untracked one', async () => {
      const { db, fx, catalog, products } = await setup();
      const rumProduct = (await one<{ product_id: string }>(db, `SELECT product_id FROM skus WHERE id = $1`, [fx.sku.full])).product_id;
      await expectPosError(catalog.updateProduct(rumProduct, { department: 'KITCHEN' }), PosErrorCode.ILLEGAL_TRANSITION, /stock on hand/);
      expect(await catalog.updateProduct(rumProduct, { department: 'ANCILLARY' })).toMatchObject({ department: 'ANCILLARY' });
      // Kitchen → Ancillary starts counting from zero; back to Kitchen is fine while nothing is on hand.
      expect(await catalog.updateProduct(products.peanuts.id, { department: 'ANCILLARY' })).toMatchObject({ department: 'ANCILLARY' });
      expect(await catalog.updateProduct(products.peanuts.id, { department: 'KITCHEN' })).toMatchObject({ department: 'KITCHEN' });
      await expect(catalog.updateProduct(products.peanuts.id, { department: 'BAR' as never })).rejects.toThrow(RangeError);
    });
  });

  describe('bill lines and stock', () => {
    it('sells Kitchen items with no stock and no movement; Ancillary items are counted like bottles', async () => {
      const { db, fx, sku, billing } = await setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const dish = await billing.addItemToBill(bill.id, sku.chickenFull, 3);
      const rum = await billing.addItemToBill(bill.id, fx.sku.full, 1);
      const soda = await billing.addItemToBill(bill.id, sku.soda, 4);
      expect([dish.item.department, rum.item.department, soda.item.department]).toEqual(['KITCHEN', 'LIQUOR', 'ANCILLARY']);
      expect(await onHand(db, sku.chickenFull)).toBe(0);
      expect(await onHand(db, sku.soda)).toBe(6);
      const moves = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM stock_movements WHERE sku_id = $1`, [sku.chickenFull]);
      expect(moves.n).toBe(0);

      // A cancelled dish never restocks; the cancellation copies the department.
      const cancel = await billing.cancelBillItem(bill.id, dish.item.id, 1);
      expect(cancel.item.department).toBe('KITCHEN');
      expect(await onHand(db, sku.chickenFull)).toBe(0);

      await expectPosError(billing.addItemToBill(bill.id, sku.soda, 7), PosErrorCode.INSUFFICIENT_STOCK);
    });

    it('keeps the department billed even after the product moves', async () => {
      const { db, fx, sku, billing, catalog, products } = await setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const line = await billing.addItemToBill(bill.id, sku.peanuts, 1);
      await billing.settleNormalBill(bill.id, [{ mode: 'CASH', amount: 120_00n }]);
      await catalog.updateProduct(products.peanuts.id, { department: 'ANCILLARY' });
      const { reversal } = await billing.reverseBill(bill.id, 'wrong item', fx.cashier);
      const rows = (await db.query<{ bill_id: string; department: string }>(`SELECT bill_id, department FROM bill_items WHERE sku_id = $1 ORDER BY created_at`, [sku.peanuts])).rows;
      expect(rows).toEqual([
        { bill_id: bill.id, department: 'KITCHEN' },
        { bill_id: reversal.id, department: 'KITCHEN' },
      ]);
      expect(line.item.department).toBe('KITCHEN');
    });

    it('refuses to inward or adjust Kitchen stock', async () => {
      const { db, fx, sku } = await setup();
      await expectPosError(
        new PurchaseService(db).recordReceipt({ invoiceNo: 'INV-1', lines: [{ skuId: sku.chickenHalf, quantity: 5, unitCostPaise: 50_00n }] }, fx.cashier),
        PosErrorCode.ILLEGAL_TRANSITION,
        /not stock-tracked/,
      );
      await expectSqlError(db.query(`INSERT INTO stock_movements (sku_id, movement_type, qty_delta) VALUES ($1, 'OPENING', 5)`, [sku.peanuts]), 'PS002');
      // Ancillary items are received like liquor.
      await new PurchaseService(db).recordReceipt({ invoiceNo: 'INV-2', lines: [{ skuId: sku.soda, quantity: 24, unitCostPaise: 20_00n }] }, fx.cashier);
      expect(await onHand(db, sku.soda)).toBe(34);
    });
  });

  describe('KOT routing', () => {
    it('sends only pending Kitchen lines from the counter, once, and a CANCEL for a dish cancelled after sending', async () => {
      const { db, fx, sku, billing, kot, printer, queries } = await setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const dish = await billing.addItemToBill(bill.id, sku.chickenHalf, 2);
      await billing.addItemToBill(bill.id, fx.sku.full, 1);
      await billing.addItemToBill(bill.id, sku.peanuts, 1);

      const first = await kot.sendPending(bill.id, { staffId: fx.cashier });
      expect(first).toEqual([
        { station: 'KITCHEN', ticketNo: 1, printed: true, printedAt: expect.any(Date), sentQuantity: 3, cancelledQuantity: 0, error: null },
      ]);
      expect(printer.tickets).toHaveLength(1);
      expect(printer.tickets[0]).toMatchObject({
        kotNo: bill.billNo,
        ticketNo: 1,
        station: 'KITCHEN',
        waiter: null,
        lines: [
          { skuCode: 'CH65-H', quantity: 2 },
          { skuCode: 'MPNT-U', quantity: 1 },
        ],
      });
      expect(await kot.sendPending(bill.id, { staffId: fx.cashier })).toEqual([]);

      const detail = await queries.getBillDetail(bill.id);
      expect(detail.items.map((i) => [i.skuCode, i.kotStation, i.kotSentQuantity])).toEqual([
        ['CH65-H', 'KITCHEN', 2],
        ['HRUM-F', 'BAR', 0],
        ['MPNT-U', 'KITCHEN', 1],
      ]);

      await billing.cancelBillItem(bill.id, dish.item.id, 1);
      await billing.addItemToBill(bill.id, sku.chickenFull, 1);
      expect(await kot.sendPending(bill.id, { staffId: fx.cashier })).toMatchObject([{ ticketNo: 2, sentQuantity: 1, cancelledQuantity: 1 }]);
      expect(printer.tickets[1]?.lines).toEqual([
        { skuCode: 'CH65-H', displayName: 'Chicken 65 — Half', sizeCode: 'HALF', quantity: -1 },
        { skuCode: 'CH65-F', displayName: 'Chicken 65 — Full', sizeCode: 'FULL', quantity: 1 },
      ]);
      const sent = await one<{ n: number }>(db, `SELECT coalesce(sum(qty), 0)::int AS n FROM kot_ticket_lines WHERE bill_item_id = $1`, [dish.item.id]);
      expect(sent.n).toBe(1);
    });

    it('keeps lines pending when the printer fails, and the retry prints them exactly once', async () => {
      const { db, fx, sku, billing, kot, printer } = await setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, sku.peanuts, 1);
      await billing.addItemToBill(bill.id, sku.peanuts, 1); // two scans, one printed line
      printer.state.failing = true;
      expect(await kot.sendPending(bill.id, { staffId: fx.cashier })).toEqual([
        { station: 'KITCHEN', ticketNo: null, printed: false, printedAt: null, sentQuantity: 2, cancelledQuantity: 0, error: 'kitchen printer offline' },
      ]);
      expect((await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM kot_tickets`)).n).toBe(0);

      printer.state.failing = false;
      expect(await kot.sendPending(bill.id, { staffId: fx.cashier })).toMatchObject([{ ticketNo: 1, printed: true, sentQuantity: 2 }]);
      expect(await kot.sendPending(bill.id, { staffId: fx.cashier })).toEqual([]);
      expect(printer.tickets).toHaveLength(1);
      expect(printer.tickets[0]?.lines).toEqual([{ skuCode: 'MPNT-U', displayName: 'Masala Peanuts', sizeCode: 'UNIT', quantity: 2 }]);
      expect((await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM kot_ticket_lines`)).n).toBe(2); // the ledger keeps each bill line
    });

    it('splits a Captain order into a BAR and a KITCHEN ticket; a replay prints nothing', async () => {
      const { fx, sku, printer } = await setup();
      const captain = new CaptainService(ctx().db, printer.printer);
      const request = {
        requestId: randomUUID(),
        deviceId: 'handset-01',
        waiterId: fx.waiter.trusted,
        items: [
          { skuId: fx.sku.full, quantity: 1 },
          { skuId: sku.chickenFull, quantity: 2 },
          { skuId: sku.soda, quantity: 3 },
        ],
      };
      const order = await captain.placeOrder(request);
      expect(order.kots.map((k) => [k.station, k.ticketNo, k.sentQuantity])).toEqual([
        ['BAR', 1, 4],
        ['KITCHEN', 1, 2],
      ]);
      expect(order.kot).toMatchObject({ station: 'BAR', printed: true });
      expect(printer.tickets.map((t) => [t.station, t.waiter?.code, t.lines.map((l) => l.skuCode)])).toEqual([
        ['BAR', 'W01', ['HRUM-F', 'SODA-U']],
        ['KITCHEN', 'W01', ['CH65-F']],
      ]);
      expect(await captain.placeOrder(request)).toMatchObject({ replayed: true, kots: [], kot: null });
      expect(printer.tickets).toHaveLength(2);
    });

    it('cancels an undone peak scan at the kitchen, but never on a refund reversal', async () => {
      const { db, fx, sku, billing, peak, kot, printer } = await setup();
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      const scan = await billing.recordPeakSale(session.id, sku.peanuts, 1, fx.cashier);
      await kot.sendPending(scan.bill.id, { staffId: fx.cashier });
      await billing.undoLastPeakSale(fx.cashier);
      expect(await kot.sendPending(scan.bill.id, { staffId: fx.cashier })).toEqual([]); // a reversal alone is not a cancel
      expect(await kot.sendPending(scan.bill.id, { staffId: fx.cashier }, { includeReversals: true })).toMatchObject([
        { station: 'KITCHEN', ticketNo: 2, sentQuantity: 0, cancelledQuantity: 1 },
      ]);
      expect(printer.tickets[1]?.lines).toMatchObject([{ skuCode: 'MPNT-U', quantity: -1 }]);
      await expectSqlError(db.query(`UPDATE kot_tickets SET station = 'BAR'`), 'PS001');
      await expectSqlError(db.query(`DELETE FROM kot_ticket_lines`), 'PS001');
    });

    it('refuses a KOT line at the wrong station or from another bill', async () => {
      const { db, fx, sku, billing } = await setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      const rum = await billing.addItemToBill(bill.id, fx.sku.full, 1);
      const dish = await billing.addItemToBill(bill.id, sku.peanuts, 1);
      const other = await billing.createBill('NORMAL', fx.cashier);
      const ticket = await one<{ id: string }>(db, `INSERT INTO kot_tickets (bill_id, station, ticket_no) VALUES ($1, 'KITCHEN', 1) RETURNING id`, [bill.id]);
      await expectSqlError(db.query(`INSERT INTO kot_ticket_lines (ticket_id, bill_item_id, qty) VALUES ($1, $2, 1)`, [ticket.id, rum.item.id]), 'PS002');
      const elsewhere = await one<{ id: string }>(db, `INSERT INTO kot_tickets (bill_id, station, ticket_no) VALUES ($1, 'KITCHEN', 1) RETURNING id`, [other.id]);
      await expectSqlError(db.query(`INSERT INTO kot_ticket_lines (ticket_id, bill_item_id, qty) VALUES ($1, $2, 1)`, [elsewhere.id, dish.item.id]), 'PS002');
    });
  });

  describe('expense categories', () => {
    it('assign a department (or Shared), and expenses follow their category, legacy rows included', async () => {
      const { db, fx, dayEnd } = await setup();
      const categories = new ExpenseCategoryService(db);
      const veg = await categories.createCategory({ name: 'Vegetables', department: 'KITCHEN' });
      expect(veg).toMatchObject({ department: 'KITCHEN' });
      expect(await categories.createCategory({ name: 'Rent' })).toMatchObject({ department: null });

      await dayEnd.recordCashExpense(300_00n, null, fx.cashier, veg.id);
      await dayEnd.recordCashExpense(80_00n, null, fx.cashier, fx.expenseCategory.TRANSPORT);
      expect((await dayEnd.listCashExpenses(fx.dayId)).map((e) => [e.category.name, e.category.department])).toEqual([
        ['Transport', null],
        ['Vegetables', 'KITCHEN'],
      ]);

      expect(await categories.updateCategory(veg.id, { department: null })).toMatchObject({ department: null });
      expect(await categories.updateCategory(fx.expenseCategory.TRANSPORT, { department: 'ANCILLARY' })).toMatchObject({ department: 'ANCILLARY' });
      expect(await categories.updateCategory(fx.expenseCategory.TRANSPORT, { name: 'Transport & fuel' })).toMatchObject({ department: 'ANCILLARY' });
      expect((await dayEnd.listCashExpenses(fx.dayId)).map((e) => e.category.department)).toEqual(['ANCILLARY', null]);
      await expect(categories.createCategory({ name: 'Bad', department: 'BAR' as never })).rejects.toThrow(RangeError);
    });
  });

  describe('Day End', () => {
    it('splits the day by department, keeps one Expected cash, and closes fully split with zero variance', async () => {
      const { fx, sku, billing, peak, waiters, dayEnd } = await setup();

      // A: rum + a full plate, cash.
      const a = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(a.id, fx.sku.full, 1);
      await billing.addItemToBill(a.id, sku.chickenFull, 1);
      await billing.settleNormalBill(a.id, [{ mode: 'CASH', amount: PAISE.full + 320_00n }]);
      // B: sodas + a quarter on waiter credit.
      const b = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(b.id, sku.soda, 2);
      await billing.addItemToBill(b.id, fx.sku.quarter, 1);
      await waiters.tagBillToWaiter(b.id, fx.waiter.trusted);
      await waiters.settleWaiterBill(b.id, fx.waiter.trusted, 'WAITER_CREDIT');
      // C: a half plate paid by UPI, then refunded.
      const c = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(c.id, sku.chickenHalf, 1);
      await billing.settleNormalBill(c.id, [{ mode: 'UPI', amount: 180_00n }]);
      await billing.reverseBill(c.id, 'customer left', fx.cashier, { creditRefundTender: 'UPI' });
      // A peak with peanuts and a beer, counted exactly.
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      await billing.recordPeakSale(session.id, sku.peanuts, 1, fx.cashier);
      await billing.recordPeakSale(session.id, fx.sku.beer650, 1, fx.cashier);
      await peak.endPeakSession(session.id, 120_00n + PAISE.beer650, 0n, fx.cashier);
      // D: an open waiter bill, part-paid.
      const d = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(d.id, fx.sku.half, 1);
      await billing.addItemToBill(d.id, sku.peanuts, 1);
      await waiters.tagBillToWaiter(d.id, fx.waiter.trusted);
      await waiters.settleWaiterBill(d.id, fx.waiter.trusted, 'CASH', 500_00n);

      const midDay = await dayEnd.getDayEndSummary(fx.dayId);
      expect(midDay.sales.byDepartment.map((x) => [x.code, x.salesPaise])).toEqual([
        ['LIQUOR', PAISE.full + PAISE.quarter + PAISE.beer650],
        ['KITCHEN', 320_00n + 120_00n],
        ['ANCILLARY', 80_00n],
      ]);
      expect(midDay.sales.unallocatedPaise).toBe(500_00n);
      expect(midDay.sales.total.salesPaise).toBe(PAISE.full + 320_00n + 80_00n + PAISE.quarter + 120_00n + PAISE.beer650 + 500_00n);
      // One drawer: A's cash, D's part-payment and the peak's counted delta.
      expect(midDay.breakdown.expectedCashPaise).toBe(PAISE.full + 320_00n + 500_00n + 120_00n + PAISE.beer650);

      await waiters.settleWaiterBill(d.id, fx.waiter.trusted, 'CASH');
      await waiters.recordWaiterRepayment(fx.waiter.trusted, PAISE.quarter + 80_00n, 'CASH', fx.cashier);
      const ready = await dayEnd.getDayEndSummary(fx.dayId);
      expect(ready.sales.unallocatedPaise).toBe(0n);
      expect(ready.sales.byDepartment.map((x) => x.salesPaise)).toEqual([PAISE.full + PAISE.quarter + PAISE.beer650 + PAISE.half, 560_00n, 80_00n]);
      const expected = ready.breakdown.expectedCashPaise;
      expect(expected).toBe(PAISE.full + 320_00n + PAISE.half + 120_00n + 120_00n + PAISE.beer650 + PAISE.quarter + 80_00n);

      const closed = await dayEnd.closeBusinessDay(fx.dayId, expected, fx.manager);
      expect(closed.day).toMatchObject({ status: 'CLOSED', cashVariancePaise: 0n });
      expect(closed.sales.unallocatedPaise).toBe(0n);
    });
  });
});

describe('upgrading a 0012 database with bills to 0013', () => {
  it('labels every existing line Liquor and changes no total or expected cash', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fl2-mig-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (/^00(0\d|1[012])_.*\.sql$/.test(f)) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const db = new PGlite();
    await runMigrations(db, dir);
    await rm(dir, { recursive: true, force: true });
    const fx = await seed(db);

    // Phase 18 data, written the way that code wrote it.
    await sell(db, { staffId: fx.cashier, lines: [[fx.sku.full, 1], [fx.sku.beer330, 2]], tenders: [['CASH', 2500_00]] });
    await sell(db, { staffId: fx.cashier, waiterId: fx.waiter.trusted, lines: [[fx.sku.half, 1]] });
    const before = await one<{ expected: string; totals: string }>(
      db,
      `SELECT pos_day_expected_cash($1)::text AS expected, (SELECT string_agg(total_paise::text, ',' ORDER BY bill_no) FROM bills) AS totals`,
      [fx.dayId],
    );

    expect(await runMigrations(db)).toEqual(['0013_departments']);
    const { rows } = await db.query<{ department: string }>(`SELECT DISTINCT department FROM bill_items`);
    expect(rows).toEqual([{ department: 'LIQUOR' }]);
    const after = await one<{ expected: string; totals: string }>(
      db,
      `SELECT pos_day_expected_cash($1)::text AS expected, (SELECT string_agg(total_paise::text, ',' ORDER BY bill_no) FROM bills) AS totals`,
      [fx.dayId],
    );
    expect(after).toEqual(before);
    const summary = await new DayEndService(db).getDayEndSummary(fx.dayId);
    expect(summary.sales.byDepartment[0]).toMatchObject({ code: 'LIQUOR', salesPaise: 2500_00n });
    expect(summary.sales.unallocatedPaise).toBe(0n);
    expect((await db.query(`SELECT * FROM v_invariant_violations`)).rows).toEqual([]);
    await db.close();
  });
});
