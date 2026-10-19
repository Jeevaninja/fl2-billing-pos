import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { SqlClient } from '../../src/db/client.js';
import { PosErrorCode } from '../../src/db/errors.js';
import { MIGRATIONS_DIR, runMigrations } from '../../src/db/migrate.js';
import {
  CatalogService,
  CounterQueries,
  DayEndService,
  formatReceipt,
  ItemCategoryService,
  KotService,
  OrdersQueries,
  receiptFor,
  type KotTicket,
} from '../../src/services/index.js';
import { expectSqlError, useSeededDb } from '../support/db.js';
import { seed } from '../support/fixtures.js';
import { one, sell } from '../support/pos.js';
import { expectPosError, makeServices } from '../support/services.js';

/** Phase 20 (0014): item categories, the flat item API, and billing on items created that way. */

const orderReceiptText = async (db: SqlClient, billId: string) => formatReceipt(receiptFor(await new OrdersQueries(db).getOrder(billId), null));

const onHand = async (db: SqlClient, skuId: string) => (await one<{ q: number }>(db, `SELECT on_hand_qty AS q FROM sku_stock WHERE sku_id = $1`, [skuId])).q;

describe('item categories (0014)', () => {
  const ctx = useSeededDb();
  const setup = async () => {
    const { db, fx } = ctx();
    const categories = new ItemCategoryService(db);
    const list = await categories.listCategories({ includeInactive: true });
    const cat = (name: string) => list.find((c) => c.name === name)!.id;
    return { db, fx, categories, cat, catalog: new CatalogService(db), queries: new CounterQueries(db), ...makeServices(db) };
  };

  describe('categories', () => {
    it('seeds seven categories in report order and files every existing SKU by size', async () => {
      const { db, fx, categories } = await setup();
      const list = await categories.listCategories();
      expect(list.map((c) => [c.name, c.defaultSizeCode, c.defaultDepartment, c.itemCount])).toEqual([
        ['FULL', 'FULL', 'LIQUOR', 1],
        ['HALF', 'HALF', 'LIQUOR', 1],
        ['QUARTER', 'QUARTER', 'LIQUOR', 1],
        ['BEER', 'BEER_650', 'LIQUOR', 2],
        ['WINE', 'FULL', 'LIQUOR', 0],
        ['FOOD', 'UNIT', 'KITCHEN', 0],
        ['OTHERS', 'UNIT', 'ANCILLARY', 0],
      ]);
      expect(list[0]?.onHandQty).toBe(50);
      const beer = await one<{ name: string }>(db, `SELECT c.name FROM skus k JOIN item_categories c ON c.id = k.item_category_id WHERE k.id = $1`, [fx.sku.beer330]);
      expect(beer.name).toBe('BEER');
    });

    it('creates, renames, reorders and disables categories; never deletes one', async () => {
      const { db, categories, cat } = await setup();
      const cig = await categories.createCategory({ name: '  Cigarettes  pack ', defaultSizeCode: 'UNIT', defaultDepartment: 'ANCILLARY' });
      expect(cig).toMatchObject({ name: 'Cigarettes pack', sortOrder: 8, defaultSizeCode: 'UNIT', defaultDepartment: 'ANCILLARY', systemKey: null, itemCount: 0 });
      await expectPosError(categories.createCategory({ name: 'cigarettes PACK' }), PosErrorCode.DUPLICATE_CATALOG_ENTRY);
      await expect(categories.createCategory({ name: 'x'.repeat(31) })).rejects.toThrow(RangeError);

      const moved = await categories.updateCategory(cig.id, { move: 'up', name: 'CIGARETTES', defaultSizeCode: null });
      expect(moved).toMatchObject({ name: 'CIGARETTES', sortOrder: 7, defaultSizeCode: null });
      expect(await categories.updateCategory(cig.id, { isActive: false })).toMatchObject({ isActive: false });
      expect((await categories.listCategories()).map((c) => c.name)).not.toContain('CIGARETTES');

      // FULL still has an active item: disabling it would hide something on sale.
      await expectPosError(categories.updateCategory(cat('FULL'), { isActive: false }), PosErrorCode.ILLEGAL_TRANSITION, /active items/);
      await expectSqlError(db.query(`DELETE FROM item_categories WHERE id = $1`, [cig.id]), 'PS001');
      await expectSqlError(db.query(`UPDATE item_categories SET system_key = 'WINE' WHERE id = $1`, [cig.id]), 'PS001');
    });
  });

  describe('flat items', () => {
    it('creates "1848" in QUARTER, then in FULL: one brand, two items, codes and names derived', async () => {
      const { fx, catalog, cat, db } = await setup();
      const quarter = await catalog.createItem({ categoryId: cat('QUARTER'), name: '1848', salePricePaise: 390_00n, purchasePricePaise: 240_00n, openingQty: 64 }, fx.cashier);
      expect(quarter).toMatchObject({
        skuCode: '1848-Q',
        displayName: '1848 — Quarter',
        brandName: '1848',
        sizeCode: 'QUARTER',
        caseSize: 64,
        onHandQty: 64,
        department: 'LIQUOR',
        itemCategory: { id: cat('QUARTER'), name: 'QUARTER' },
      });
      const opening = await one<{ movement_type: string; qty_delta: number; business_day_id: string; created_by_staff_id: string }>(
        db,
        `SELECT movement_type, qty_delta, business_day_id, created_by_staff_id FROM stock_movements WHERE sku_id = $1`,
        [quarter.id],
      );
      expect(opening).toEqual({ movement_type: 'OPENING', qty_delta: 64, business_day_id: fx.dayId, created_by_staff_id: fx.cashier });

      const full = await catalog.createItem({ categoryId: cat('FULL'), name: '1848 ', salePricePaise: 1450_00n }, fx.cashier);
      expect(full).toMatchObject({ skuCode: '1848-F', displayName: '1848 — Full', productId: quarter.productId, onHandQty: 0 });
      // The same brand can't have two Quarters.
      await expectPosError(catalog.createItem({ categoryId: cat('QUARTER'), name: '1848', salePricePaise: 400_00n }, fx.cashier), PosErrorCode.DUPLICATE_CATALOG_ENTRY);
      // A beer picks its size inside BEER; WINE's default is Full.
      expect(await catalog.createItem({ categoryId: cat('BEER'), name: 'Kingfisher', sizeCode: 'BEER_330', salePricePaise: 160_00n }, fx.cashier)).toMatchObject({
        skuCode: 'KING-330',
        caseSize: 24,
        productCategory: 'BEER',
      });
    });

    it('takes Kitchen defaults from FOOD, and refuses opening stock for it', async () => {
      const { fx, catalog, cat } = await setup();
      await expect(catalog.createItem({ categoryId: cat('FOOD'), name: 'Chilli Paneer', salePricePaise: 240_00n, openingQty: 5 }, fx.cashier)).rejects.toThrow(/Kitchen/);
      const dish = await catalog.createItem({ categoryId: cat('FOOD'), name: 'Chilli Paneer', salePricePaise: 240_00n }, fx.cashier);
      expect(dish).toMatchObject({ displayName: 'Chilli Paneer', sizeCode: 'UNIT', department: 'KITCHEN', tracksStock: false, caseSize: 1, productCategory: 'FOOD' });
      // A category with no default size needs one.
      const plain = await new ItemCategoryService(ctx().db).createCategory({ name: 'Specials' });
      await expect(catalog.createItem({ categoryId: plain.id, name: 'Combo', salePricePaise: 100_00n }, fx.cashier)).rejects.toThrow(/choose a size/);
    });

    it('renames one item onto another brand, moves it between categories, and keeps bills untouched', async () => {
      const { fx, catalog, cat, billing, db } = await setup();
      const q = await catalog.createItem({ categoryId: cat('QUARTER'), name: 'Magic Moments', salePricePaise: 300_00n }, fx.cashier);
      const h = await catalog.createItem({ categoryId: cat('HALF'), name: 'Magic Moments', salePricePaise: 550_00n, codePrefix: 'MAMO' }, fx.cashier);
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await expectPosError(billing.addItemToBill(bill.id, q.id, 1), PosErrorCode.INSUFFICIENT_STOCK); // no stock yet

      const renamed = await catalog.updateItem(q.id, { name: 'Magic Moments Green', categoryId: cat('OTHERS') });
      expect(renamed).toMatchObject({ brandName: 'Magic Moments Green', displayName: 'Magic Moments Green — Quarter', skuCode: 'MAMO-Q', itemCategory: { name: 'OTHERS' } });
      expect(renamed.productId).not.toBe(h.productId);
      expect((await catalog.getItem(h.id)).displayName).toBe('Magic Moments — Half'); // the other size stays

      // A case-only rename fixes the brand itself (every size).
      await catalog.updateItem(h.id, { name: 'MAGIC MOMENTS' });
      expect((await catalog.getItem(h.id)).displayName).toBe('MAGIC MOMENTS — Half');
      // Renaming onto a brand that already has the size is PS012, and nothing is applied.
      const stag = await catalog.createItem({ categoryId: cat('HALF'), name: 'Royal Stag', salePricePaise: 600_00n }, fx.cashier);
      await expectPosError(catalog.updateItem(stag.id, { name: 'magic moments', salePricePaise: 1n }), PosErrorCode.DUPLICATE_CATALOG_ENTRY);
      expect(await catalog.getItem(stag.id)).toMatchObject({ brandName: 'Royal Stag', pricePaise: 600_00n });

      // Moving a stocked item onto a Kitchen brand would strand its stock.
      await db.query(`INSERT INTO stock_movements (sku_id, movement_type, qty_delta) VALUES ($1, 'OPENING', 3)`, [h.id]);
      await catalog.createItem({ categoryId: cat('FOOD'), name: 'Momos', salePricePaise: 150_00n }, fx.cashier);
      await expectPosError(catalog.updateItem(h.id, { name: 'Momos' }), PosErrorCode.ILLEGAL_TRANSITION, /Kitchen/);
    });

    it('lists items in report order and searches across every category', async () => {
      const { fx, catalog, cat } = await setup();
      await catalog.createItem({ categoryId: cat('QUARTER'), name: '1848', salePricePaise: 390_00n }, fx.cashier);
      await catalog.createItem({ categoryId: cat('FULL'), name: '1848', salePricePaise: 1450_00n }, fx.cashier);
      const all = await catalog.listItems();
      expect(all.map((i) => [i.itemCategory.name, i.skuCode])).toEqual([
        ['FULL', '1848-F'],
        ['FULL', 'HRUM-F'],
        ['HALF', 'HRUM-H'],
        ['QUARTER', '1848-Q'],
        ['QUARTER', 'HRUM-Q'],
        ['BEER', 'HLAG-650'],
        ['BEER', 'HLAG-330'],
      ]);
      expect((await catalog.listItems({ q: '1848' })).map((i) => i.skuCode)).toEqual(['1848-F', '1848-Q']);
      expect((await catalog.listItems({ q: 'hlag-6' })).map((i) => i.skuCode)).toEqual(['HLAG-650']);
      await catalog.updateItem(all[1]!.id, { isActive: false });
      expect((await catalog.listItems()).map((i) => i.skuCode)).not.toContain('HRUM-F');
      expect((await catalog.listItems({ includeInactive: true })).map((i) => i.skuCode)).toContain('HRUM-F');
    });
  });

  describe('billing on a flat item', () => {
    it('is found by barcode, SKU code and name, sells, prints on a KOT and a receipt', async () => {
      const { db, fx, catalog, cat, queries, billing } = await setup();
      const item = await catalog.createItem({ categoryId: cat('QUARTER'), name: '1848', salePricePaise: 390_00n, barcode: '8901848000180', openingQty: 10 }, fx.cashier);
      expect((await queries.lookupSku('8901848000180'))?.id).toBe(item.id);
      expect((await queries.lookupSku('1848-q'))?.id).toBe(item.id);
      expect((await queries.searchSkus('184')).map((s) => s.id)).toContain(item.id);

      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, item.id, 2);
      await billing.settleNormalBill(bill.id, [{ mode: 'CASH', amount: 780_00n }]);
      expect(await onHand(db, item.id)).toBe(8);
      expect(await orderReceiptText(db, bill.id)).toContain('1848 - Quarter');

      // A Captain-style BAR ticket carries it with its size.
      const tickets: KotTicket[] = [];
      const kot = new KotService(db, { printKOT: async (t) => (tickets.push(t), { station: t.station, printedAt: new Date(), text: '' }) });
      const waiterBill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(waiterBill.id, item.id, 1);
      await kot.sendPending(waiterBill.id, { staffId: fx.cashier }, { stations: ['BAR'] });
      expect(tickets[0]?.lines).toEqual([{ skuCode: '1848-Q', displayName: '1848 — Quarter', sizeCode: 'QUARTER', quantity: 1 }]);
    });
  });
});

describe('upgrading a 0013 database to 0014', () => {
  it('files every SKU by the back-fill rule and changes no bill, stock or expected cash', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fl2-mig-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (/^00(0\d|1[0-3])_.*\.sql$/.test(f)) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const db = new PGlite();
    await runMigrations(db, dir);
    await rm(dir, { recursive: true, force: true });
    const fx = await seed(db);
    // A wine brand and two single-size items (Kitchen and Ancillary), as Phase 19 created them.
    const product = async (name: string, category: string, department: string) =>
      (await one<{ id: string }>(db, `INSERT INTO products (name, category, department) VALUES ($1, $2, $3) RETURNING id`, [name, category, department])).id;
    const sku = async (productId: string, code: string, size: string) =>
      (await one<{ id: string }>(db, `INSERT INTO skus (product_id, sku_code, size_code, display_name, price_paise, case_size) VALUES ($1, $2, $3, $2, 10000, 12) RETURNING id`, [productId, code, size])).id;
    const wine = await sku(await product('Sula', 'WINE', 'LIQUOR'), 'SULA-F', 'FULL');
    const momos = await product('Momos', 'FOOD', 'KITCHEN');
    const dish = await sku(momos, 'MOMO-U', 'UNIT');
    const plate = await sku(momos, 'MOMO-F', 'FULL'); // a Full plate is food, not a 750 ml bottle
    const soda = await sku(await product('Soda', 'BEVERAGE', 'ANCILLARY'), 'SODA-U', 'UNIT');
    await sell(db, { staffId: fx.cashier, lines: [[fx.sku.full, 1]], tenders: [['CASH', 2200_00]] });
    const before = await one<{ expected: string; stock: string }>(
      db,
      `SELECT pos_day_expected_cash($1)::text AS expected, (SELECT string_agg(on_hand_qty::text, ',' ORDER BY sku_id) FROM sku_stock) AS stock`,
      [fx.dayId],
    );

    expect((await runMigrations(db))[0]).toBe('0014_item_categories');
    const { rows } = await db.query<{ id: string; name: string }>(`SELECT k.id, c.name FROM skus k JOIN item_categories c ON c.id = k.item_category_id`);
    const nameOf = (id: string) => rows.find((r) => r.id === id)?.name;
    expect([nameOf(fx.sku.full), nameOf(fx.sku.half), nameOf(fx.sku.quarter), nameOf(fx.sku.beer650), nameOf(fx.sku.beer330)]).toEqual(['FULL', 'HALF', 'QUARTER', 'BEER', 'BEER']);
    expect([nameOf(wine), nameOf(dish), nameOf(plate), nameOf(soda)]).toEqual(['WINE', 'FOOD', 'FOOD', 'OTHERS']);
    const after = await one<{ expected: string; stock: string }>(
      db,
      `SELECT pos_day_expected_cash($1)::text AS expected, (SELECT string_agg(on_hand_qty::text, ',' ORDER BY sku_id) FROM sku_stock) AS stock`,
      [fx.dayId],
    );
    expect(after).toEqual(before);
    expect((await new DayEndService(db).getDayEndSummary(fx.dayId)).sales.total.salesPaise).toBe(2200_00n);
    await db.close();
  });
});
