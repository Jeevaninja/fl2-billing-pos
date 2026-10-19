import { describe, expect, it } from 'vitest';
import { PosErrorCode } from '../../src/db/errors.js';
import { CatalogService, CounterQueries, DayEndService, ExpenseCategoryService, ItemCategoryService, KitchenService } from '../../src/services/index.js';
import { expectSqlError, useSeededDb } from '../support/db.js';
import { one } from '../support/pos.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

/** Phase 21 (0015): kitchen purchases, the Kitchen P&L, and the universal billing search. */

describe('kitchen kiosk (0015)', () => {
  const ctx = useSeededDb();
  const setup = async () => {
    const { db, fx } = ctx();
    const categories = await new ItemCategoryService(db).listCategories();
    const cat = (name: string) => categories.find((c) => c.name === name)!.id;
    return { db, fx, cat, kitchen: new KitchenService(db), dayEnd: new DayEndService(db), catalog: new CatalogService(db), queries: new CounterQueries(db), ...makeServices(db) };
  };
  const chicken = [{ description: ' Chicken ', quantity: '5 kg', amountPaise: 1200_00n }, { description: 'Oil', quantity: '2 L', amountPaise: 600_00n }];

  describe('purchases', () => {
    it('records lines that add up; a drawer purchase lowers expected cash, an outside one does not', async () => {
      const { fx, kitchen, dayEnd } = await setup();
      const drawer = await kitchen.recordPurchase({ vendorName: ' Raju  Chicken ', paidFrom: 'DRAWER', lines: chicken }, fx.cashier);
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
      await kitchen.recordPurchase({ paidFrom: 'OUTSIDE', note: 'Metro, owner card', lines: [{ description: 'Masala', amountPaise: 1400_00n }] }, fx.cashier);
      const summary = await dayEnd.getDayEndSummary(fx.dayId);
      expect(summary.breakdown).toMatchObject({ kitchenPurchasesPaise: 1800_00n, expectedCashPaise: -1800_00n });

      // A void negates it once, on the same day, and gives the cash back to the expected figure.
      const voided = await kitchen.voidPurchase(drawer.id, fx.cashier);
      expect(voided).toMatchObject({ amountPaise: -1800_00n, paidFrom: 'DRAWER', reversesPurchaseId: drawer.id, lines: [] });
      await expectPosError(kitchen.voidPurchase(drawer.id, fx.cashier), PosErrorCode.REVERSAL_RULE);
      await expectPosError(kitchen.voidPurchase(voided.id, fx.cashier), PosErrorCode.REVERSAL_RULE);
      expect((await dayEnd.getDayEndSummary(fx.dayId)).breakdown.expectedCashPaise).toBe(0n);
      const list = await kitchen.listPurchases(fx.dayId);
      expect(list.map((p) => [p.amountPaise, p.voidedAt !== null])).toEqual([
        [1400_00n, false],
        [1800_00n, true],
      ]);
    });

    it('refuses a drawer purchase while a peak runs (outside is fine), and closes with zero variance', async () => {
      const { fx, kitchen, dayEnd, peak, billing } = await setup();
      const sale = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(sale.id, fx.sku.full, 1);
      await billing.settleNormalBill(sale.id, [{ mode: 'CASH', amount: PAISE.full }]);
      const session = await peak.startPeakSession(fx.dayId, 5000_00n, 0n, fx.cashier);
      await expectPosError(kitchen.recordPurchase({ paidFrom: 'DRAWER', lines: chicken }, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /peak/);
      await kitchen.recordPurchase({ paidFrom: 'OUTSIDE', lines: chicken }, fx.cashier);
      await peak.endPeakSession(session.id, 5000_00n, 0n, fx.cashier);
      await kitchen.recordPurchase({ paidFrom: 'DRAWER', lines: [{ description: 'Ice cubes', amountPaise: 300_00n }] }, fx.cashier);
      // ₹2,200 taken, ₹300 paid out of the drawer: ₹1,900 counted is exact.
      const closed = await dayEnd.closeBusinessDay(fx.dayId, PAISE.full - 300_00n, fx.manager);
      expect(closed.day).toMatchObject({ status: 'CLOSED', expectedCashPaise: PAISE.full - 300_00n, cashVariancePaise: 0n });
      expect(closed.breakdown.kitchenPurchasesPaise).toBe(300_00n);
    });

    it('validates input, keeps lines fixed and the ledger append-only', async () => {
      const { db, fx, kitchen } = await setup();
      await expect(kitchen.recordPurchase({ paidFrom: 'DRAWER', lines: [] }, fx.cashier)).rejects.toThrow(RangeError);
      await expect(kitchen.recordPurchase({ paidFrom: 'CARD' as never, lines: chicken }, fx.cashier)).rejects.toThrow(RangeError);
      await expect(kitchen.recordPurchase({ paidFrom: 'DRAWER', lines: [{ description: '  ', amountPaise: 1n }] }, fx.cashier)).rejects.toThrow(RangeError);
      await expect(kitchen.recordPurchase({ paidFrom: 'DRAWER', lines: [{ description: 'x', quantity: 'q'.repeat(21), amountPaise: 1n }] }, fx.cashier)).rejects.toThrow(RangeError);
      await expect(kitchen.recordPurchase({ paidFrom: 'DRAWER', lines: [{ description: 'x', amountPaise: 0n }] }, fx.cashier)).rejects.toThrow(RangeError);

      // The database checks the total at commit, and refuses lines added later.
      await expectSqlError(
        db.transaction(async (tx) => {
          const { id } = (await tx.query<{ id: string }>(`INSERT INTO kitchen_purchases (paid_from, amount_paise, created_by_staff_id) VALUES ('OUTSIDE', 500, $1) RETURNING id`, [fx.cashier])).rows[0]!;
          await tx.query(`INSERT INTO kitchen_purchase_lines (purchase_id, line_no, description, amount_paise) VALUES ($1, 1, 'Veg', 400)`, [id]);
        }),
        'PS005',
      );
      const saved = await kitchen.recordPurchase({ paidFrom: 'OUTSIDE', lines: chicken }, fx.cashier);
      await expectSqlError(db.query(`INSERT INTO kitchen_purchase_lines (purchase_id, line_no, description, amount_paise) VALUES ($1, 3, 'Extra', 100)`, [saved.id]), 'PS001');
      await expectSqlError(db.query(`UPDATE kitchen_purchases SET amount_paise = 1 WHERE id = $1`, [saved.id]), 'PS001');
      await expectSqlError(db.query(`DELETE FROM kitchen_purchase_lines`), 'PS001');
      const outbox = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM sync_outbox WHERE aggregate_type IN ('kitchen_purchases', 'kitchen_purchase_lines')`);
      expect(outbox.n).toBe(3);
    });
  });

  describe('Kitchen P&L', () => {
    it('routes a typed, barcode-less food item to Kitchen sales only, and nets Kitchen expenses and purchases', async () => {
      const { fx, cat, kitchen, dayEnd, catalog, queries, billing } = await setup();
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
      await kitchen.recordPurchase({ paidFrom: 'DRAWER', lines: [{ description: 'Chicken', amountPaise: 150_00n }] }, fx.cashier);
      await kitchen.recordPurchase({ paidFrom: 'OUTSIDE', lines: [{ description: 'Oil', amountPaise: 40_00n }] }, fx.cashier);

      const summary = await kitchen.getKitchenSummary(fx.dayId);
      expect(summary).toMatchObject({
        day: { id: fx.dayId, status: 'OPEN' },
        salesPaise: 360_00n,
        openTabsPaise: 180_00n,
        expensesPaise: 120_00n,
        purchasesPaise: 190_00n,
        purchasesDrawerPaise: 150_00n,
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
        ['ANCILLARY', 0n],
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
