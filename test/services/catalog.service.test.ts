import { describe, expect, it } from 'vitest';
import { InactiveError, NotFoundError, PgErrorCode, PosErrorCode } from '../../src/db/errors.js';
import { CatalogService, CounterQueries, type NewProductInput, PurchaseService } from '../../src/services/index.js';
import { expectSqlError, useSeededDb } from '../support/db.js';
import { CASE_SIZE, OPENING_QTY } from '../support/fixtures.js';
import { onHand } from '../support/pos.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

const MISSING = '00000000-0000-0000-0000-000000000000';

const whisky = (overrides: Partial<NewProductInput> = {}): NewProductInput => ({
  name: '  Royal   Stag ',
  category: 'WHISKY',
  codePrefix: 'rstg',
  skus: [
    { sizeCode: 'QUARTER', salePricePaise: 260_00n, purchasePricePaise: 180_00n, caseSize: 64, barcode: '8901111000018' },
    { sizeCode: 'FULL', salePricePaise: 1_000_00n, caseSize: 12 },
    { sizeCode: 'HALF', salePricePaise: 520_00n, purchasePricePaise: 0n, caseSize: 32, barcode: '  ' },
  ],
  ...overrides,
});

describe('CatalogService', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, catalog: new CatalogService(db), queries: new CounterQueries(db), purchases: new PurchaseService(db), ...makeServices(db) };
  };

  describe('migration 0009', () => {
    it('gives every existing SKU a case size by size and no default purchase price', async () => {
      const { db } = setup();
      const { rows } = await db.query<{ size_code: string; case_size: number; purchase_price_paise: unknown }>(
        `SELECT size_code, case_size, purchase_price_paise FROM skus ORDER BY size_code`,
      );
      expect(rows).toEqual([
        { size_code: 'BEER_330', case_size: CASE_SIZE.beer330, purchase_price_paise: null },
        { size_code: 'BEER_650', case_size: CASE_SIZE.beer650, purchase_price_paise: null },
        { size_code: 'FULL', case_size: CASE_SIZE.full, purchase_price_paise: null },
        { size_code: 'HALF', case_size: CASE_SIZE.half, purchase_price_paise: null },
        { size_code: 'QUARTER', case_size: CASE_SIZE.quarter, purchase_price_paise: null },
      ]);
    });

    it('requires a case size of 1–1000 and a purchase price of ₹0 or more', async () => {
      const { db, fx } = setup();
      await expectSqlError(db.query(`UPDATE skus SET case_size = NULL WHERE id = $1`, [fx.sku.full]), PgErrorCode.NOT_NULL_VIOLATION);
      await expectSqlError(db.query(`UPDATE skus SET case_size = 0 WHERE id = $1`, [fx.sku.full]), PgErrorCode.CHECK_VIOLATION);
      await expectSqlError(db.query(`UPDATE skus SET case_size = 1001 WHERE id = $1`, [fx.sku.full]), PgErrorCode.CHECK_VIOLATION);
      await expectSqlError(db.query(`UPDATE skus SET purchase_price_paise = -1 WHERE id = $1`, [fx.sku.full]), PgErrorCode.CHECK_VIOLATION);
    });
  });

  describe('createProduct', () => {
    it('creates a liquor with its sizes, deriving codes and names, at zero stock', async () => {
      const { db, catalog } = setup();
      const product = await catalog.createProduct(whisky());

      expect(product).toMatchObject({ name: 'Royal Stag', category: 'WHISKY', isActive: true });
      expect(product.skus).toEqual([
        expect.objectContaining({ skuCode: 'RSTG-F', displayName: 'Royal Stag — Full', sizeCode: 'FULL', pricePaise: 1_000_00n, purchasePricePaise: null, caseSize: 12, barcode: null }),
        expect.objectContaining({ skuCode: 'RSTG-H', displayName: 'Royal Stag — Half', sizeCode: 'HALF', purchasePricePaise: 0n, caseSize: 32, barcode: null }),
        expect.objectContaining({ skuCode: 'RSTG-Q', displayName: 'Royal Stag — Quarter', pricePaise: 260_00n, purchasePricePaise: 180_00n, caseSize: 64, barcode: '8901111000018' }),
      ]);
      for (const sku of product.skus) {
        expect(sku).toMatchObject({ productId: product.id, onHandQty: 0, isActive: true });
        expect(await onHand(db, sku.id)).toBe(0);
      }
    });

    it('makes the new SKUs available to search, GRN (with the catalog cost) and billing', async () => {
      const { db, fx, catalog, queries, purchases, billing } = setup();
      const product = await catalog.createProduct(whisky());
      const quarter = product.skus.find((s) => s.sizeCode === 'QUARTER')!;

      const [found] = await queries.searchSkus('8901111000018');
      expect(found).toMatchObject({ id: quarter.id, caseSize: 64, purchasePricePaise: 180_00n, onHandQty: 0 });

      await purchases.recordReceipt(
        { invoiceNo: 'RS-1', lines: [{ skuId: quarter.id, cases: 2, looseBottles: 3, caseSize: 64, unitCostPaise: found!.purchasePricePaise! }] },
        fx.cashier,
      );
      expect(await onHand(db, quarter.id)).toBe(131);

      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, quarter.id, 1);
      expect(await onHand(db, quarter.id)).toBe(130);
    });

    it('refuses duplicates as PS012: name (any case), code prefix, barcode', async () => {
      const { catalog } = setup();
      await catalog.createProduct(whisky());

      await expectPosError(catalog.createProduct(whisky({ codePrefix: 'RS2' , name: 'ROYAL STAG' })), PosErrorCode.DUPLICATE_CATALOG_ENTRY);
      await expectPosError(
        catalog.createProduct(whisky({ name: 'House Rum Gold', codePrefix: 'HRUM' })),
        PosErrorCode.DUPLICATE_CATALOG_ENTRY,
        /sku_code/,
      );
      await expectPosError(
        catalog.createProduct(whisky({ name: 'Other', codePrefix: 'OTH', skus: [{ sizeCode: 'FULL', salePricePaise: 100n, caseSize: 12, barcode: '8901111000018' }] })),
        PosErrorCode.DUPLICATE_CATALOG_ENTRY,
        /barcode/,
      );
    });

    it('is atomic: a failing size writes no product', async () => {
      const { db, catalog } = setup();
      await expectPosError(
        catalog.createProduct(whisky({ name: 'Half Done', codePrefix: 'HD', skus: [{ sizeCode: 'FULL', salePricePaise: 100n, caseSize: 12, barcode: '777' }, { sizeCode: 'HALF', salePricePaise: 100n, caseSize: 32, barcode: '777' }] })),
        PosErrorCode.DUPLICATE_CATALOG_ENTRY,
      );
      expect((await db.query(`SELECT 1 FROM products WHERE name = 'Half Done'`)).rows).toHaveLength(0);
      expect((await db.query(`SELECT 1 FROM skus WHERE sku_code = 'HD-F'`)).rows).toHaveLength(0);
    });

    it('validates before touching the database', async () => {
      const { catalog } = setup();
      const bad = (o: Partial<NewProductInput>) => catalog.createProduct(whisky(o));
      await expect(bad({ name: '   ' })).rejects.toThrow(/name is required/);
      await expect(bad({ name: 'x'.repeat(81) })).rejects.toThrow(/at most 80/);
      await expect(bad({ category: 'CIDER' as never })).rejects.toThrow(/category/);
      await expect(bad({ codePrefix: 'A' })).rejects.toThrow(/codePrefix/);
      await expect(bad({ codePrefix: 'HW-1' })).rejects.toThrow(/codePrefix/);
      await expect(bad({ skus: [] })).rejects.toThrow(/at least one size/);
      const full = { sizeCode: 'FULL' as const, salePricePaise: 100n, caseSize: 12 };
      await expect(bad({ skus: [full, full] })).rejects.toThrow(/only once/);
      await expect(bad({ skus: [{ ...full, sizeCode: 'PEG_30' as never }] })).rejects.toThrow(/sizeCode/);
      await expect(bad({ skus: [{ ...full, salePricePaise: 0n }] })).rejects.toThrow(/salePricePaise/);
      await expect(bad({ skus: [{ ...full, purchasePricePaise: -1n }] })).rejects.toThrow(/purchasePricePaise/);
      await expect(bad({ skus: [{ ...full, caseSize: 0 }] })).rejects.toThrow(/caseSize/);
      await expect(bad({ skus: [{ ...full, caseSize: 12.5 }] })).rejects.toThrow(/caseSize/);
      await expect(bad({ skus: [{ ...full, barcode: '890 111' }] })).rejects.toThrow(/barcode/);
    });
  });

  describe('updateProduct', () => {
    it('renames a liquor and re-derives every size name; bill lines keep their snapshot', async () => {
      const { db, fx, catalog, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.full, 1);
      const productId = (await catalog.getProduct((await db.query<{ product_id: string }>(`SELECT product_id FROM skus WHERE id = $1`, [fx.sku.full])).rows[0]!.product_id)).id;

      const renamed = await catalog.updateProduct(productId, { name: 'Old Monk', category: 'RUM' });
      expect(renamed.name).toBe('Old Monk');
      expect(renamed.skus.map((s) => s.displayName)).toEqual(['Old Monk — Full', 'Old Monk — Half', 'Old Monk — Quarter']);
      expect(renamed.skus.map((s) => s.skuCode)).toEqual(['HRUM-F', 'HRUM-H', 'HRUM-Q']);
      const { rows } = await db.query<{ display_name_snapshot: string }>(`SELECT display_name_snapshot FROM bill_items WHERE bill_id = $1`, [bill.id]);
      expect(rows).toEqual([{ display_name_snapshot: 'House Rum — Full' }]);
    });

    it('deactivating a liquor deactivates its sizes; reactivating leaves them for the operator', async () => {
      const { catalog } = setup();
      const product = await catalog.createProduct(whisky());

      const off = await catalog.updateProduct(product.id, { isActive: false });
      expect(off.isActive).toBe(false);
      expect(off.skus.every((s) => !s.isActive)).toBe(true);
      await expect(catalog.updateSku(off.skus[0]!.id, { isActive: true })).rejects.toBeInstanceOf(InactiveError);
      await expect(catalog.addSku(product.id, { sizeCode: 'BEER_650', salePricePaise: 100n, caseSize: 12 })).rejects.toBeInstanceOf(InactiveError);

      const on = await catalog.updateProduct(product.id, { isActive: true });
      expect(on.isActive).toBe(true);
      expect(on.skus.every((s) => !s.isActive)).toBe(true);
      expect((await catalog.updateSku(on.skus[0]!.id, { isActive: true })).skus[0]!.isActive).toBe(true);
    });

    it('refuses a name another liquor already has (PS012) and an unknown product', async () => {
      const { catalog } = setup();
      const product = await catalog.createProduct(whisky());
      await expectPosError(catalog.updateProduct(product.id, { name: 'house lager' }), PosErrorCode.DUPLICATE_CATALOG_ENTRY);
      await expect(catalog.updateProduct(MISSING, { name: 'X' })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('addSku / updateSku', () => {
    it('adds a missing size, taking the code prefix from an existing one', async () => {
      const { catalog } = setup();
      const product = await catalog.createProduct(whisky({ skus: [{ sizeCode: 'FULL', salePricePaise: 1_000_00n, caseSize: 12 }] }));
      const grown = await catalog.addSku(product.id, { sizeCode: 'QUARTER', salePricePaise: 260_00n, caseSize: 48 });
      expect(grown.skus.map((s) => [s.skuCode, s.displayName, s.caseSize])).toEqual([
        ['RSTG-F', 'Royal Stag — Full', 12],
        ['RSTG-Q', 'Royal Stag — Quarter', 48],
      ]);
      await expectPosError(catalog.addSku(product.id, { sizeCode: 'FULL', salePricePaise: 100n, caseSize: 12 }), PosErrorCode.DUPLICATE_CATALOG_ENTRY);
      await expect(catalog.addSku(MISSING, { sizeCode: 'FULL', salePricePaise: 100n, caseSize: 12 })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('edits prices, case size and barcode; a price edit never changes a line already billed', async () => {
      const { db, fx, catalog, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.full, 1);

      const product = await catalog.updateSku(fx.sku.full, {
        salePricePaise: 2_500_00n,
        purchasePricePaise: 1_400_00n,
        caseSize: 6,
        barcode: ' 8909999000001 ',
      });
      expect(product.skus[0]).toMatchObject({ id: fx.sku.full, pricePaise: 2_500_00n, purchasePricePaise: 1_400_00n, caseSize: 6, barcode: '8909999000001' });

      await billing.addItemToBill(bill.id, fx.sku.full, 1);
      const { rows } = await db.query<{ unit_price_paise: number }>(`SELECT unit_price_paise FROM bill_items WHERE bill_id = $1 ORDER BY line_no`, [bill.id]);
      expect(rows.map((r) => BigInt(r.unit_price_paise))).toEqual([PAISE.full, 2_500_00n]);

      const cleared = await catalog.updateSku(fx.sku.full, { purchasePricePaise: null, barcode: null });
      expect(cleared.skus[0]).toMatchObject({ purchasePricePaise: null, barcode: null, caseSize: 6 });
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY - 2);
    });

    it('validates the patch, refuses a taken barcode (PS012) and an unknown SKU', async () => {
      const { db, fx, catalog } = setup();
      await db.query(`UPDATE skus SET barcode = '8901234567890' WHERE id = $1`, [fx.sku.half]);
      await expect(catalog.updateSku(fx.sku.full, { salePricePaise: 0n })).rejects.toThrow(/salePricePaise/);
      await expect(catalog.updateSku(fx.sku.full, { purchasePricePaise: -5n })).rejects.toThrow(/purchasePricePaise/);
      await expect(catalog.updateSku(fx.sku.full, { caseSize: 1001 })).rejects.toThrow(/caseSize/);
      await expectPosError(catalog.updateSku(fx.sku.full, { barcode: '8901234567890' }), PosErrorCode.DUPLICATE_CATALOG_ENTRY);
      await expect(catalog.updateSku(MISSING, { caseSize: 6 })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a deactivated size drops out of the default list and can no longer be received', async () => {
      const { fx, catalog, purchases } = setup();
      await catalog.updateSku(fx.sku.half, { isActive: false });
      const active = await catalog.listCatalog();
      expect(active.flatMap((p) => p.skus.map((s) => s.skuCode))).not.toContain('HRUM-H');
      const all = await catalog.listCatalog({ includeInactive: true });
      expect(all.flatMap((p) => p.skus.map((s) => s.skuCode))).toContain('HRUM-H');
      await expect(
        purchases.recordReceipt({ invoiceNo: 'X', lines: [{ skuId: fx.sku.half, quantity: 1, unitCostPaise: 0n }] }, fx.cashier),
      ).rejects.toBeInstanceOf(InactiveError);
    });
  });

  describe('listCatalog', () => {
    it('lists liquors by name with sizes FULL → 330 and stock on hand', async () => {
      const { catalog } = setup();
      await catalog.createProduct(whisky());
      const list = await catalog.listCatalog();
      expect(list.map((p) => p.name)).toEqual(['House Lager', 'House Rum', 'Royal Stag']);
      expect(list[0]!.skus.map((s) => s.sizeCode)).toEqual(['BEER_650', 'BEER_330']);
      expect(list[1]!.skus.map((s) => [s.sizeCode, s.onHandQty])).toEqual([
        ['FULL', OPENING_QTY],
        ['HALF', OPENING_QTY],
        ['QUARTER', OPENING_QTY],
      ]);
    });

    it('filters by name, code prefix or exact barcode, returning whole liquors', async () => {
      const { catalog } = setup();
      await catalog.createProduct(whisky());
      expect((await catalog.listCatalog({ q: 'stag' })).map((p) => p.name)).toEqual(['Royal Stag']);
      expect((await catalog.listCatalog({ q: 'hlag-3' })).map((p) => [p.name, p.skus.length])).toEqual([['House Lager', 2]]);
      expect((await catalog.listCatalog({ q: '8901111000018' })).map((p) => p.name)).toEqual(['Royal Stag']);
      expect(await catalog.listCatalog({ q: '%' })).toEqual([]);
    });

    it('records catalog edits in the sync outbox', async () => {
      const { db, fx, catalog } = setup();
      const before = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sync_outbox WHERE event_type = 'skus.update'`)).rows[0]!.n;
      await catalog.updateSku(fx.sku.full, { caseSize: 6 });
      const after = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sync_outbox WHERE event_type = 'skus.update'`)).rows[0]!.n;
      expect(after).toBe(before + 1);
    });
  });
});
