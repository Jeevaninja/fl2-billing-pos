import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { PosErrorCode } from '../../src/db/errors.js';
import { MIGRATIONS_DIR, runMigrations } from '../../src/db/migrate.js';
import {
  CatalogService,
  codeFromName,
  CounterQueries,
  DayEndService,
  DepartmentService,
  ExpenseCategoryService,
  ItemCategoryService,
  KotService,
  PurchaseService,
  RevenueCenterService,
  type KotTicket,
} from '../../src/services/index.js';
import { expectSqlError, useSeededDb } from '../support/db.js';
import { seed } from '../support/fixtures.js';
import { one } from '../support/pos.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

/** Phase 21 (0015): kitchen purchases, the Kitchen P&L, and the universal billing search. Phase 22 (0016): every revenue center. */

describe('revenue centers (0015 / 0016): the kitchen', () => {
  const ctx = useSeededDb();
  const setup = async () => {
    const { db, fx } = ctx();
    const categories = await new ItemCategoryService(db).listCategories();
    const cat = (name: string) => categories.find((c) => c.name === name)!.id;
    return { db, fx, cat, centers: new RevenueCenterService(db), dayEnd: new DayEndService(db), catalog: new CatalogService(db), queries: new CounterQueries(db), ...makeServices(db) };
  };
  const chicken = [{ description: ' Chicken ', quantity: '5 kg', amountPaise: 1200_00n }, { description: 'Oil', quantity: '2 L', amountPaise: 600_00n }];

  describe('purchases', () => {
    it('records lines that add up; a drawer purchase lowers expected cash, an outside one does not', async () => {
      const { fx, centers, dayEnd } = await setup();
      const drawer = await centers.recordPurchase({ department: 'KITCHEN', vendorName: ' Raju  Chicken ', paidFrom: 'DRAWER', lines: chicken }, fx.cashier);
      expect(drawer).toMatchObject({
        vendorName: 'Raju Chicken',
        paidFrom: 'DRAWER',
        amountPaise: 1800_00n,
        businessDayId: fx.dayId,
        lines: [
          { lineNo: 1, description: 'Chicken', quantity: '5 kg', amountPaise: 1200_00n },
          { lineNo: 2, description: 'Oil', quantity: '2 L', amountPaise: 600_00n },
        ],
      });
      await centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'OUTSIDE', note: 'Metro, owner card', lines: [{ description: 'Masala', amountPaise: 1400_00n }] }, fx.cashier);
      const summary = await dayEnd.getDayEndSummary(fx.dayId);
      expect(summary.breakdown).toMatchObject({ centerPurchasesPaise: 1800_00n, expectedCashPaise: -1800_00n });

      // A void negates it once, on the same day, and gives the cash back to the expected figure.
      const voided = await centers.voidPurchase(drawer.id, fx.cashier);
      expect(voided).toMatchObject({ amountPaise: -1800_00n, paidFrom: 'DRAWER', reversesPurchaseId: drawer.id, lines: [] });
      await expectPosError(centers.voidPurchase(drawer.id, fx.cashier), PosErrorCode.REVERSAL_RULE);
      await expectPosError(centers.voidPurchase(voided.id, fx.cashier), PosErrorCode.REVERSAL_RULE);
      expect((await dayEnd.getDayEndSummary(fx.dayId)).breakdown.expectedCashPaise).toBe(0n);
      const list = await centers.listPurchases(fx.dayId);
      expect(list.map((p) => [p.amountPaise, p.voidedAt !== null])).toEqual([
        [1400_00n, false],
        [1800_00n, true],
      ]);
    });

    it('refuses a drawer purchase while a peak runs (outside is fine), and closes with zero variance', async () => {
      const { fx, centers, dayEnd, peak, billing } = await setup();
      const sale = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(sale.id, fx.sku.full, 1);
      await billing.settleNormalBill(sale.id, [{ mode: 'CASH', amount: PAISE.full }]);
      const session = await peak.startPeakSession(fx.dayId, 5000_00n, 0n, fx.cashier);
      await expectPosError(centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'DRAWER', lines: chicken }, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /peak/);
      await centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'OUTSIDE', lines: chicken }, fx.cashier);
      await peak.endPeakSession(session.id, 5000_00n, 0n, fx.cashier);
      await centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'DRAWER', lines: [{ description: 'Ice cubes', amountPaise: 300_00n }] }, fx.cashier);
      // ₹2,200 taken, ₹300 paid out of the drawer: ₹1,900 counted is exact.
      const closed = await dayEnd.closeBusinessDay(fx.dayId, PAISE.full - 300_00n, fx.manager);
      expect(closed.day).toMatchObject({ status: 'CLOSED', expectedCashPaise: PAISE.full - 300_00n, cashVariancePaise: 0n });
      expect(closed.breakdown.centerPurchasesPaise).toBe(300_00n);
    });

    it('validates input, keeps lines fixed and the ledger append-only', async () => {
      const { db, fx, centers } = await setup();
      await expect(centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'DRAWER', lines: [] }, fx.cashier)).rejects.toThrow(RangeError);
      await expect(centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'CARD' as never, lines: chicken }, fx.cashier)).rejects.toThrow(RangeError);
      await expect(centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'DRAWER', lines: [{ description: '  ', amountPaise: 1n }] }, fx.cashier)).rejects.toThrow(RangeError);
      await expect(centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'DRAWER', lines: [{ description: 'x', quantity: 'q'.repeat(21), amountPaise: 1n }] }, fx.cashier)).rejects.toThrow(RangeError);
      await expect(centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'DRAWER', lines: [{ description: 'x', amountPaise: 0n }] }, fx.cashier)).rejects.toThrow(RangeError);

      // The database checks the total at commit, and refuses lines added later.
      await expectSqlError(
        db.transaction(async (tx) => {
          const { id } = (await tx.query<{ id: string }>(`INSERT INTO revenue_center_purchases (department, paid_from, amount_paise, created_by_staff_id) VALUES ('KITCHEN', 'OUTSIDE', 500, $1) RETURNING id`, [fx.cashier])).rows[0]!;
          await tx.query(`INSERT INTO revenue_center_purchase_lines (purchase_id, line_no, description, amount_paise) VALUES ($1, 1, 'Veg', 400)`, [id]);
        }),
        'PS005',
      );
      const saved = await centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'OUTSIDE', lines: chicken }, fx.cashier);
      await expectSqlError(db.query(`INSERT INTO revenue_center_purchase_lines (purchase_id, line_no, description, amount_paise) VALUES ($1, 3, 'Extra', 100)`, [saved.id]), 'PS001');
      await expectSqlError(db.query(`UPDATE revenue_center_purchases SET amount_paise = 1 WHERE id = $1`, [saved.id]), 'PS001');
      await expectSqlError(db.query(`DELETE FROM revenue_center_purchase_lines`), 'PS001');
      const outbox = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM sync_outbox WHERE aggregate_type IN ('revenue_center_purchases', 'revenue_center_purchase_lines')`);
      expect(outbox.n).toBe(3);
    });
  });

  describe('Kitchen P&L', () => {
    it('routes a typed, barcode-less food item to Kitchen sales only, and nets Kitchen expenses and purchases', async () => {
      const { fx, cat, centers, dayEnd, catalog, queries, billing } = await setup();
      // A dish created with no barcode, then found by typing part of its name.
      const dish = await catalog.createItem({ categoryId: cat('FOOD'), name: 'Chicken 65', sizeCode: 'HALF', salePricePaise: 180_00n }, fx.cashier);
      expect(dish).toMatchObject({ barcode: null, department: 'KITCHEN' });
      const [found] = await queries.searchSkus('chi 65', 8, { activeOnly: true });
      expect(found?.id).toBe(dish.id);

      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, found!.id, 2);
      await billing.addItemToBill(bill.id, fx.sku.full, 1);
      await billing.settleNormalBill(bill.id, [{ mode: 'CASH', amount: 360_00n + PAISE.full }]);
      const tab = await billing.createBill('NORMAL', fx.cashier); // still open: not sales yet
      await billing.addItemToBill(tab.id, dish.id, 1);

      const veg = await new ExpenseCategoryService(ctx().db).createCategory({ name: 'Vegetables', department: 'KITCHEN' });
      await dayEnd.recordCashExpense(120_00n, null, fx.cashier, veg.id);
      await dayEnd.recordCashExpense(80_00n, null, fx.cashier, fx.expenseCategory.TRANSPORT); // Shared: stays out
      const voidedVeg = await dayEnd.recordCashExpense(50_00n, null, fx.cashier, veg.id);
      await dayEnd.voidCashExpense(voidedVeg.id, fx.cashier);
      await centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'DRAWER', lines: [{ description: 'Chicken', amountPaise: 150_00n }] }, fx.cashier);
      await centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'OUTSIDE', lines: [{ description: 'Oil', amountPaise: 40_00n }] }, fx.cashier);

      const summary = await centers.getSummary(fx.dayId, 'KITCHEN');
      expect(summary).toMatchObject({
        day: { id: fx.dayId, status: 'OPEN' },
        salesPaise: 360_00n,
        openTabsPaise: 180_00n,
        expensesPaise: 120_00n,
        purchasesPaise: 190_00n,
        stockPurchasesPaise: 0n,
        supplyPurchasesPaise: 190_00n,
        supplyDrawerPaise: 150_00n,
        grossPaise: 360_00n - 120_00n - 190_00n,
        itemsSold: [{ skuId: dish.id, displayName: 'Chicken 65 — Half', quantity: 2, amountPaise: 360_00n }],
      });
      expect(summary.expenses.map((e) => [e.category.name, e.amountPaise, e.voidedAt !== null])).toEqual([
        ['Vegetables', 50_00n, true],
        ['Vegetables', 120_00n, false],
      ]);
      // The liquor never lands in Kitchen; Day End agrees.
      const dayEndSummary = await dayEnd.getDayEndSummary(fx.dayId);
      expect(dayEndSummary.sales.byDepartment.map((d) => [d.code, d.salesPaise])).toEqual([
        ['LIQUOR', PAISE.full],
        ['KITCHEN', 360_00n],
      ]);
      // One drawer: the sale's cash, less both expenses and the drawer purchase.
      expect(dayEndSummary.breakdown.expectedCashPaise).toBe(360_00n + PAISE.full - 120_00n - 80_00n - 150_00n);
    });
  });

  describe('universal search', () => {
    it('matches every typed word, ranks exact codes and name starts first, and can leave out inactive items', async () => {
      const { fx, cat, catalog, queries } = await setup();
      await catalog.createItem({ categoryId: cat('FOOD'), name: 'Chicken 65', sizeCode: 'HALF', salePricePaise: 180_00n }, fx.cashier);
      await catalog.createItem({ categoryId: cat('FOOD'), name: 'Chilli Chicken', salePricePaise: 220_00n }, fx.cashier);
      const chivas = await catalog.createItem({ categoryId: cat('FULL'), name: 'Chivas Regal', salePricePaise: 5200_00n }, fx.cashier);
      expect((await queries.searchSkus('chi', 8)).map((s) => s.displayName)).toEqual(['Chicken 65 — Half', 'Chilli Chicken', 'Chivas Regal — Full']);
      expect((await queries.searchSkus('65 chick', 8)).map((s) => s.displayName)).toEqual(['Chicken 65 — Half']);
      expect((await queries.searchSkus('chicken', 8)).map((s) => s.displayName)).toEqual(['Chicken 65 — Half', 'Chilli Chicken']);
      expect((await queries.searchSkus('hrum-q', 8))[0]?.skuCode).toBe('HRUM-Q');
      await catalog.updateItem(chivas.id, { isActive: false });
      expect((await queries.searchSkus('chivas', 8)).map((s) => s.id)).toEqual([chivas.id]);
      expect(await queries.searchSkus('chivas', 8, { activeOnly: true })).toEqual([]);
    });
  });
});

describe('revenue centers (0016): managed departments and per-center P&L', () => {
  const ctx = useSeededDb();
  const setup = async () => {
    const { db, fx } = ctx();
    const categories = await new ItemCategoryService(db).listCategories();
    const cat = (name: string) => categories.find((c) => c.name === name)!.id;
    return {
      db,
      fx,
      cat,
      departments: new DepartmentService(db),
      centers: new RevenueCenterService(db),
      dayEnd: new DayEndService(db),
      catalog: new CatalogService(db),
      ...makeServices(db),
    };
  };

  it('lets the manager add, rename, reorder and disable centers; Liquor and stock rules hold', async () => {
    const { fx, departments, catalog, cat } = await setup();
    expect(codeFromName('Cool Drinks')).toBe('COOL_DRINKS');
    expect(codeFromName('7 Up stall')).toBe('C_7_UP_STALL');
    const paan = await departments.createDepartment({ name: '  Paan   shop ', kotStation: 'BAR', tracksStock: true });
    expect(paan).toMatchObject({ code: 'PAAN_SHOP', name: 'Paan shop', sortOrder: 8, isActive: true, itemCount: 0 });
    expect((await departments.createDepartment({ name: 'Paan-shop', kotStation: 'NONE', tracksStock: false })).code).toBe('PAAN_SHOP_2');
    await expectPosError(departments.createDepartment({ name: 'paan SHOP', kotStation: 'BAR', tracksStock: true }), PosErrorCode.DUPLICATE_CATALOG_ENTRY);
    await expect(departments.createDepartment({ name: 'x', kotStation: 'COUNTER' as never, tracksStock: true })).rejects.toThrow(RangeError);

    expect(await departments.updateDepartment('PAAN_SHOP', { name: 'Paan Corner', move: 'up' })).toMatchObject({ code: 'PAAN_SHOP', name: 'Paan Corner', sortOrder: 7 });
    await expectPosError(departments.updateDepartment('LIQUOR', { isActive: false }), PosErrorCode.ILLEGAL_TRANSITION, /core business/);
    await expectPosError(departments.updateDepartment('LIQUOR', { kotStation: 'KITCHEN' }), PosErrorCode.ILLEGAL_TRANSITION);
    expect(await departments.updateDepartment('LIQUOR', { name: 'Liquor (FL2)' })).toMatchObject({ name: 'Liquor (FL2)' });

    // A center with an active item can't be disabled; one holding stock can't stop tracking it.
    const pan = await catalog.createItem({ categoryId: cat('OTHERS'), name: 'Meetha Paan', department: 'PAAN_SHOP', salePricePaise: 30_00n, openingQty: 5 }, fx.cashier);
    expect(pan).toMatchObject({ department: 'PAAN_SHOP', departmentName: 'Paan Corner', tracksStock: true });
    await expectPosError(departments.updateDepartment('PAAN_SHOP', { isActive: false }), PosErrorCode.ILLEGAL_TRANSITION, /active items/);
    await expectPosError(departments.updateDepartment('PAAN_SHOP', { tracksStock: false }), PosErrorCode.ILLEGAL_TRANSITION, /stock on hand/);
    await catalog.updateItem(pan.id, { isActive: false });
    expect(await departments.updateDepartment('PAAN_SHOP', { isActive: false })).toMatchObject({ isActive: false });
    expect((await departments.listDepartments()).map((d) => d.code)).not.toContain('PAAN_SHOP');
    // A disabled center can't take new brands.
    await expectPosError(
      catalog.createItem({ categoryId: cat('OTHERS'), name: 'Saada Paan', department: 'PAAN_SHOP', salePricePaise: 20_00n }, fx.cashier),
      PosErrorCode.ILLEGAL_TRANSITION,
      /disabled/,
    );
  });

  it('computes each center from its own lines, expenses, GRN stock and supplies; the overview adds up', async () => {
    const { db, fx, cat, catalog, centers, dayEnd, billing } = await setup();
    const goldFlake = await catalog.createItem({ categoryId: cat('OTHERS'), name: 'Gold Flake', department: 'CIGARETTES', salePricePaise: 180_00n }, fx.cashier);
    const dish = await catalog.createItem({ categoryId: cat('FOOD'), name: 'Chicken 65', salePricePaise: 320_00n }, fx.cashier);
    const ac = await catalog.createItem({ categoryId: cat('OTHERS'), name: 'AC Charge', department: 'AC_CHARGES', salePricePaise: 100_00n }, fx.cashier);
    expect([goldFlake.productCategory, dish.department, ac.tracksStock]).toEqual(['TOBACCO', 'KITCHEN', false]);

    // Cartons come in through the GRN (stock), lighters as a Cigarettes supply purchase.
    await new PurchaseService(db).recordReceipt({ invoiceNo: 'ITC-1', vendorName: 'ITC', lines: [{ skuId: goldFlake.id, quantity: 20, unitCostPaise: 150_00n }] }, fx.cashier);
    await centers.recordPurchase({ department: 'CIGARETTES', paidFrom: 'OUTSIDE', lines: [{ description: 'Lighters', quantity: '10', amountPaise: 100_00n }] }, fx.cashier);
    const smoke = await new ExpenseCategoryService(db).createCategory({ name: 'Smoking area cleaning', department: 'CIGARETTES' });
    await dayEnd.recordCashExpense(50_00n, null, fx.cashier, smoke.id);

    const bill = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(bill.id, goldFlake.id, 2);
    await billing.addItemToBill(bill.id, dish.id, 1);
    await billing.addItemToBill(bill.id, ac.id, 1);
    await billing.addItemToBill(bill.id, fx.sku.quarter, 1);
    await billing.settleNormalBill(bill.id, [{ mode: 'CASH', amount: 360_00n + 320_00n + 100_00n + PAISE.quarter }]);

    const cigs = await centers.getSummary(fx.dayId, 'CIGARETTES');
    expect(cigs).toMatchObject({
      center: { code: 'CIGARETTES', name: 'Cigarettes', tracksStock: true, kotStation: 'BAR' },
      salesPaise: 360_00n,
      expensesPaise: 50_00n,
      stockPurchasesPaise: 3000_00n,
      supplyPurchasesPaise: 100_00n,
      supplyDrawerPaise: 0n,
      purchasesPaise: 3100_00n,
      grossPaise: 360_00n - 50_00n - 3100_00n,
      itemsSold: [{ skuId: goldFlake.id, quantity: 2, amountPaise: 360_00n }],
    });
    expect((await centers.getSummary(fx.dayId, 'KITCHEN')).salesPaise).toBe(320_00n);
    expect((await centers.getSummary(fx.dayId, 'AC_CHARGES'))).toMatchObject({ salesPaise: 100_00n, purchasesPaise: 0n });

    const overview = await centers.getOverview(fx.dayId);
    expect(overview.centers.map((c) => [c.code, c.salesPaise])).toEqual([
      ['KITCHEN', 320_00n],
      ['CIGARETTES', 360_00n],
      ['COOL_DRINKS', 0n],
      ['WATER', 0n],
      ['AC_CHARGES', 100_00n],
      ['ANCILLARY', 0n],
    ]);
    expect(overview.total).toEqual({
      salesPaise: 780_00n,
      expensesPaise: 50_00n,
      purchasesPaise: 3100_00n,
      grossPaise: overview.centers.reduce((sum, c) => sum + c.grossPaise, 0n),
    });
    const dayEndSplit = (await dayEnd.getDayEndSummary(fx.dayId)).sales.byDepartment.map((d) => [d.code, d.salesPaise]);
    expect(dayEndSplit).toEqual([
      ['LIQUOR', PAISE.quarter],
      ['KITCHEN', 320_00n],
      ['CIGARETTES', 360_00n],
      ['AC_CHARGES', 100_00n],
    ]);

    // Purchases belong to an active, non-liquor center.
    await expectPosError(centers.recordPurchase({ department: 'LIQUOR', paidFrom: 'OUTSIDE', lines: [{ description: 'x', amountPaise: 1n }] }, fx.cashier), PosErrorCode.ILLEGAL_TRANSITION);
    await expect(centers.recordPurchase({ department: 'NOPE', paidFrom: 'OUTSIDE', lines: [{ description: 'x', amountPaise: 1n }] }, fx.cashier)).rejects.toThrow(/not found/i);
    expect((await centers.listPurchases(fx.dayId)).map((p) => p.department)).toEqual(['CIGARETTES']);
  });

  it('prints a center at its station: cigarettes at the bar, AC charges never', async () => {
    const { db, fx, cat, catalog, billing } = await setup();
    const goldFlake = await catalog.createItem({ categoryId: cat('OTHERS'), name: 'Gold Flake', department: 'CIGARETTES', salePricePaise: 180_00n, openingQty: 10 }, fx.cashier);
    const ac = await catalog.createItem({ categoryId: cat('OTHERS'), name: 'AC Charge', department: 'AC_CHARGES', salePricePaise: 100_00n }, fx.cashier);
    const bill = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(bill.id, goldFlake.id, 1);
    await billing.addItemToBill(bill.id, ac.id, 1);
    const tickets: KotTicket[] = [];
    const kot = new KotService(db, { printKOT: async (t) => (tickets.push(t), { station: t.station, printedAt: new Date(), text: '' }) });
    expect(await kot.sendPending(bill.id, { staffId: fx.cashier }, { stations: ['BAR', 'KITCHEN'] })).toMatchObject([{ station: 'BAR', sentQuantity: 1 }]);
    expect(tickets.map((t) => t.lines.map((l) => l.skuCode))).toEqual([['GOFL-U']]);
    const detail = await new CounterQueries(db).getBillDetail(bill.id);
    expect(detail.items.map((i) => i.kotStation)).toEqual(['BAR', 'NONE']);
  });
});

describe('upgrading a 0015 database with kitchen purchases to 0016', () => {
  it('renames the ledger, tags old purchases Kitchen, and keeps expected cash', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fl2-mig-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (/^00(0\d|1[0-5])_.*\.sql$/.test(f)) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const db = new PGlite();
    await runMigrations(db, dir);
    await rm(dir, { recursive: true, force: true });
    const fx = await seed(db);
    await db.transaction(async (tx) => {
      const { id } = (await tx.query<{ id: string }>(`INSERT INTO kitchen_purchases (paid_from, amount_paise, created_by_staff_id) VALUES ('DRAWER', 70000, $1) RETURNING id`, [fx.cashier])).rows[0]!;
      await tx.query(`INSERT INTO kitchen_purchase_lines (purchase_id, line_no, description, amount_paise) VALUES ($1, 1, 'Chicken', 70000)`, [id]);
    });
    const before = await one<{ expected: string }>(db, `SELECT pos_day_expected_cash($1)::text AS expected`, [fx.dayId]);

    expect((await runMigrations(db))[0]).toBe('0016_revenue_centers');
    const after = await one<{ expected: string }>(db, `SELECT pos_day_expected_cash($1)::text AS expected`, [fx.dayId]);
    expect(after).toEqual(before);
    const { rows } = await db.query<{ department: string; amount_paise: string }>(`SELECT department, amount_paise::text FROM revenue_center_purchases`);
    expect(rows).toEqual([{ department: 'KITCHEN', amount_paise: '70000' }]);
    expect((await new RevenueCenterService(db).getSummary(fx.dayId, 'KITCHEN')).supplyDrawerPaise).toBe(700_00n);
    // The renamed ledger keeps its rules.
    await expectSqlError(db.query(`DELETE FROM revenue_center_purchases`), 'PS001');
    expect((await db.query(`SELECT * FROM v_invariant_violations`)).rows).toEqual([]);
    await db.close();
  });
});
