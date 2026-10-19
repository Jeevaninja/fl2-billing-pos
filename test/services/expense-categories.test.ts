import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../src/db/migrate.js';
import { NotFoundError, PosErrorCode } from '../../src/db/errors.js';
import { BillingService, DayEndService, ExpenseCategoryService, PeakSessionService } from '../../src/services/index.js';
import { expectSqlError, useSeededDb } from '../support/db.js';
import { seed } from '../support/fixtures.js';
import { expectPosError, PAISE } from '../support/services.js';

describe('ExpenseCategoryService (Phase 18)', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, categories: new ExpenseCategoryService(db), dayEnd: new DayEndService(db) };
  };

  it('seeds the six 0006 categories (Repairs reads "Repairs & Maintenance") plus Bata, in picker order', async () => {
    const { categories } = setup();
    expect((await categories.listCategories()).map((c) => [c.name, c.legacyCode, c.noteRequired, c.sortOrder])).toEqual([
      ['Ice', 'ICE', false, 1],
      ['Staff food', 'STAFF_FOOD', false, 2],
      ['Transport', 'TRANSPORT', false, 3],
      ['Cleaning', 'CLEANING', false, 4],
      ['Repairs & Maintenance', 'REPAIRS', false, 5],
      ['Bata / Daily Wages', null, false, 6],
      ['Other', 'OTHER', true, 7],
    ]);
  });

  it('creates at the end of the order, tidies the name, and refuses a duplicate in any case or spacing', async () => {
    const { categories } = setup();
    expect(await categories.createCategory({ name: '  Soda   Water ' })).toMatchObject({ name: 'Soda Water', sortOrder: 8, isActive: true, noteRequired: false, legacyCode: null });
    await expectPosError(categories.createCategory({ name: 'soda water' }), PosErrorCode.DUPLICATE_CATALOG_ENTRY);
    await expectPosError(categories.createCategory({ name: 'ICE' }), PosErrorCode.DUPLICATE_CATALOG_ENTRY);
    await expect(categories.createCategory({ name: '   ' })).rejects.toBeInstanceOf(RangeError);
    await expect(categories.createCategory({ name: 'x'.repeat(41) })).rejects.toBeInstanceOf(RangeError);
  });

  it('renames (relabelling history), flips the note rule, and moves one place at a time', async () => {
    const { fx, categories, dayEnd } = setup();
    await dayEnd.recordCashExpense(100_00n, null, fx.cashier, fx.expenseCategory.CLEANING);
    const renamed = await categories.updateCategory(fx.expenseCategory.CLEANING, { name: 'Housekeeping', noteRequired: true });
    expect(renamed).toMatchObject({ name: 'Housekeeping', noteRequired: true, usedCount: 1 });
    expect((await dayEnd.listCashExpenses(fx.dayId))[0]?.category.name).toBe('Housekeeping');
    await expectPosError(dayEnd.recordCashExpense(1n, null, fx.cashier, fx.expenseCategory.CLEANING), PosErrorCode.ILLEGAL_TRANSITION, /needs a note/);

    await categories.updateCategory(fx.expenseCategory.OTHER, { move: 'up' });
    await categories.updateCategory(fx.expenseCategory.ICE, { move: 'up' }); // already first: no change
    expect((await categories.listCategories()).map((c) => c.name).slice(-2)).toEqual(['Other', 'Bata / Daily Wages']);
    expect((await categories.listCategories())[0]?.name).toBe('Ice');
    await expect(categories.updateCategory('00000000-0000-0000-0000-000000000000', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('disables (hidden from new expenses, kept on old ones) but never the last active category, and never deletes', async () => {
    const { db, fx, categories, dayEnd } = setup();
    const ice = await dayEnd.recordCashExpense(150_00n, null, fx.cashier, fx.expenseCategory.ICE);
    await categories.updateCategory(fx.expenseCategory.ICE, { isActive: false });
    expect((await categories.listCategories()).some((c) => c.name === 'Ice')).toBe(false);
    expect((await categories.listCategories({ includeInactive: true })).find((c) => c.name === 'Ice')).toMatchObject({ isActive: false, usedCount: 1 });
    await expectPosError(dayEnd.recordCashExpense(1n, null, fx.cashier, fx.expenseCategory.ICE), PosErrorCode.ILLEGAL_TRANSITION, /disabled/);
    // A void of an expense in a now-disabled category still goes through, with the same category.
    expect((await dayEnd.voidCashExpense(ice.id, fx.cashier)).category.name).toBe('Ice');

    for (const key of ['STAFF_FOOD', 'TRANSPORT', 'CLEANING', 'REPAIRS', 'BATA'] as const) {
      await categories.updateCategory(fx.expenseCategory[key], { isActive: false });
    }
    await expectPosError(categories.updateCategory(fx.expenseCategory.OTHER, { isActive: false }), PosErrorCode.ILLEGAL_TRANSITION, /last active/);
    expect(await categories.updateCategory(fx.expenseCategory.ICE, { isActive: true })).toMatchObject({ isActive: true });

    await expectSqlError(db.query(`DELETE FROM expense_categories WHERE id = $1`, [fx.expenseCategory.BATA]), 'PS001');
    await expectSqlError(db.query(`UPDATE expense_categories SET legacy_code = 'ICE' WHERE id = $1`, [fx.expenseCategory.BATA]), 'PS001');
  });
});

describe('upgrading a day with pre-0012 expenses', () => {
  /** A database migrated only up to 0011, seeded, so expenses can be written the Phase 17 way. */
  async function phase17Database() {
    const dir = await mkdtemp(path.join(tmpdir(), 'fl2-mig-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (/^00(0\d|1[01])_.*\.sql$/.test(f)) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const db = new PGlite();
    await runMigrations(db, dir);
    await rm(dir, { recursive: true, force: true });
    const fx = await seed(db);
    return { db, fx };
  }

  it('keeps old rows untouched, resolves them by legacy code, and Day End math still adds up', async () => {
    const { db, fx: before } = await phase17Database();
    expect(before.expenseCategory).toEqual({});
    const legacy = async (amount: number, category: string, description: string | null) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO cash_expenses (amount_paise, category, description, created_by_staff_id) VALUES ($1, $2, $3, $4) RETURNING id`,
          [amount, category, description, before.cashier],
        )
      ).rows[0]!.id;
    const iceOld = await legacy(150_00, 'ICE', null);
    const teaOld = await legacy(40_00, 'OTHER', 'Tea');

    // Phase 18 (and every later migration) arrives mid-day.
    expect((await runMigrations(db))[0]).toBe('0012_expense_categories');
    const billing = new BillingService(db);
    const sale = await billing.createBill('NORMAL', before.cashier);
    await billing.addItemToBill(sale.id, before.sku.full, 1);
    await billing.settleNormalBill(sale.id, [{ mode: 'CASH', amount: PAISE.full }]);
    const { rows: untouched } = await db.query<{ category: string; category_id: string | null }>(`SELECT category, category_id FROM cash_expenses WHERE id = $1`, [iceOld]);
    expect(untouched).toEqual([{ category: 'ICE', category_id: null }]);

    const { rows: cats } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM expense_categories`);
    const cat = (name: string) => cats.find((c) => c.name === name)!.id;
    const dayEnd = new DayEndService(db);
    const peak = new PeakSessionService(db);

    await dayEnd.voidCashExpense(teaOld, before.cashier); // a legacy row voided after the upgrade
    await dayEnd.recordCashExpense(500_00n, null, before.cashier, cat('Bata / Daily Wages'));
    const session = await peak.startPeakSession(before.dayId, 1000_00n, 0n, before.cashier);
    await dayEnd.recordCashExpense(50_00n, 'Ice (rush)', before.cashier, cat('Ice')); // in-peak: the peak's count holds it
    const ended = await peak.endPeakSession(session.id, 950_00n, 0n, before.cashier);
    expect(ended.breakdown.variancePaise).toBe(0n);

    const list = await dayEnd.listCashExpenses(before.dayId);
    expect(list.map((e) => [e.category.name, e.amountPaise, e.voidedAt !== null])).toEqual([
      ['Ice', 50_00n, false],
      ['Bata / Daily Wages', 500_00n, false],
      ['Other', 40_00n, true],
      ['Ice', 150_00n, false],
    ]);
    expect(list[3]?.category.id).toBe(cat('Ice')); // the legacy row and the new one share the category

    // Expected cash: ₹2,200 sale − ₹150 legacy ice − ₹500 bata (tea voided) + peak delta −₹50 = ₹1,500.
    const summary = await dayEnd.getDayEndSummary(before.dayId);
    expect(summary.breakdown).toMatchObject({ normalCashPaise: PAISE.full, cashExpensesPaise: 650_00n, peakCashPaise: -50_00n, expectedCashPaise: 1500_00n });
    const closed = await dayEnd.closeBusinessDay(before.dayId, 1500_00n, before.manager);
    expect(closed.day).toMatchObject({ status: 'CLOSED', expectedCashPaise: 1500_00n, cashVariancePaise: 0n });
    await db.close();
  });
});
