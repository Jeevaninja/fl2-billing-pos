import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { PosErrorCode } from '../../src/db/errors.js';
import { MIGRATIONS_DIR, runMigrations } from '../../src/db/migrate.js';
import {
  CatalogService,
  CounterQueries,
  DayEndService,
  ItemCategoryService,
  PurchaseService,
  ReportService,
  RevenueCenterService,
} from '../../src/services/index.js';
import { useSeededDb } from '../support/db.js';
import { seed } from '../support/fixtures.js';
import { one } from '../support/pos.js';
import { expectPosError, makeServices } from '../support/services.js';

/** Phase 26 (0019): buy in Cases / Packets from a revenue center, stock and sell single units. */

describe('center stock purchases (0019): bulk-to-unit', () => {
  const ctx = useSeededDb();
  const setup = async () => {
    const { db, fx } = ctx();
    const categories = await new ItemCategoryService(db).listCategories();
    const others = categories.find((c) => c.name === 'OTHERS')!.id;
    const catalog = new CatalogService(db);
    const goldFlake = await catalog.createItem(
      { categoryId: others, name: 'Gold Flake', department: 'CIGARETTES', salePricePaise: 18_00n, purchaseUnitName: 'Packet', caseSize: 10, saleUnitName: 'Stick' },
      fx.cashier,
    );
    const coke = await catalog.createItem({ categoryId: others, name: 'Coca-Cola 300ml', department: 'COOL_DRINKS', salePricePaise: 40_00n, caseSize: 24 }, fx.cashier);
    const thumsUp = await catalog.createItem({ categoryId: others, name: 'Thums Up 300ml', department: 'COOL_DRINKS', salePricePaise: 40_00n, caseSize: 24 }, fx.cashier);
    const onHand = async (skuId: string) => (await one<{ q: number }>(db, `SELECT on_hand_qty AS q FROM sku_stock WHERE sku_id = $1`, [skuId])).q;
    const receipts = async () => (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM stock_receipts`)).n;
    return {
      db,
      fx,
      others,
      catalog,
      goldFlake,
      coke,
      thumsUp,
      onHand,
      receipts,
      centers: new RevenueCenterService(db),
      dayEnd: new DayEndService(db),
      ...makeServices(db),
    };
  };

  it('inwards 2 packets of 10 as exactly 20 sellable sticks', async () => {
    const { db, fx, goldFlake, centers, onHand, billing } = await setup();
    expect(goldFlake).toMatchObject({ purchaseUnitName: 'Packet', saleUnitName: 'Stick', caseSize: 10, onHandQty: 0 });

    const detail = await centers.recordStockPurchase(
      { department: 'CIGARETTES', paidFrom: 'OUTSIDE', lines: [{ skuId: goldFlake.id, cases: 2, looseUnits: 0, caseSize: 10, unitCostPaise: 15_00n }] },
      fx.cashier,
    );
    expect(await onHand(goldFlake.id)).toBe(20);
    expect(detail.receipt).toMatchObject({ department: 'CIGARETTES', paidFrom: 'OUTSIDE', invoiceNo: 'CIGARETTES-20261014-01', vendorName: null, bottles: 20, totalCostPaise: 300_00n });
    expect(detail.lines).toEqual([
      expect.objectContaining({ skuId: goldFlake.id, quantity: 20, cases: 2, caseSize: 10, looseBottles: 0, purchaseUnitName: 'Packet', unitCostPaise: 15_00n, lineTotalPaise: 300_00n }),
    ]);
    const { rows: movements } = await db.query(`SELECT movement_type, qty_delta FROM stock_movements WHERE sku_id = $1 ORDER BY created_at`, [goldFlake.id]);
    expect(movements).toEqual([{ movement_type: 'PURCHASE_RECEIPT', qty_delta: 20 }]);

    // The till sells single sticks out of it.
    const bill = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(bill.id, goldFlake.id, 1);
    expect(await onHand(goldFlake.id)).toBe(19);

    // A second purchase the same day gets the next number.
    const again = await centers.recordStockPurchase(
      { department: 'CIGARETTES', paidFrom: 'OUTSIDE', lines: [{ skuId: goldFlake.id, cases: 0, looseUnits: 5, caseSize: 10, unitCostPaise: 15_00n }] },
      fx.cashier,
    );
    expect(again.receipt.invoiceNo).toBe('CIGARETTES-20261014-02');
    expect(await onHand(goldFlake.id)).toBe(24);
  });

  it('converts cases and loose bottles per item, and a drawer purchase lowers expected cash', async () => {
    const { fx, coke, thumsUp, centers, dayEnd, onHand } = await setup();
    const detail = await centers.recordStockPurchase(
      {
        department: 'COOL_DRINKS',
        invoiceNo: ' RA/221 ',
        vendorName: ' Ravi  Agencies ',
        paidFrom: 'DRAWER',
        lines: [
          { skuId: coke.id, cases: 2, looseUnits: 0, caseSize: 24, unitCostPaise: 15_00n },
          { skuId: thumsUp.id, cases: 1, looseUnits: 6, caseSize: 24, unitCostPaise: 15_00n },
        ],
      },
      fx.cashier,
    );
    expect([await onHand(coke.id), await onHand(thumsUp.id)]).toEqual([48, 30]);
    expect(detail.receipt).toMatchObject({ invoiceNo: 'RA/221', vendorName: 'Ravi Agencies', paidFrom: 'DRAWER', bottles: 78, totalCostPaise: 1170_00n });
    expect(detail.lines.map((l) => [l.cases, l.looseBottles, l.quantity, l.purchaseUnitName])).toEqual([
      [2, 0, 48, 'Case'],
      [1, 6, 30, 'Case'],
    ]);

    const summary = await dayEnd.getDayEndSummary(fx.dayId);
    expect(summary.breakdown).toMatchObject({ stockPurchasesDrawerPaise: 1170_00n, centerPurchasesPaise: 0n, expectedCashPaise: -1170_00n });

    const center = await centers.getSummary(fx.dayId, 'COOL_DRINKS');
    expect(center).toMatchObject({ stockPurchasesPaise: 1170_00n, stockDrawerPaise: 1170_00n, supplyPurchasesPaise: 0n, purchasesPaise: 1170_00n });
    expect(center.stockReceipts.map((r) => [r.receipt.invoiceNo, r.lines.length])).toEqual([['RA/221', 2]]);
    expect((await centers.getSummary(fx.dayId, 'CIGARETTES')).stockReceipts).toEqual([]);

    // The Reports cash book still balances to the paisa and shows the drawer stock purchase.
    const report = await new ReportService(ctx().db).getFullReport({ startDate: '2026-10-14', endDate: '2026-10-14' });
    expect(report.cash).toMatchObject({ drawerPurchasesPaise: 1170_00n, closingBalancePaise: -1170_00n });
  });

  it('refuses another center’s item, a non-stock center, a stale case size and a full case of loose units — writing nothing', async () => {
    const { fx, goldFlake, coke, centers, onHand, receipts } = await setup();
    const line = (skuId: string, extra: object = {}) => ({ skuId, cases: 1, looseUnits: 0, caseSize: 10, unitCostPaise: 15_00n, ...extra });

    await expectPosError(
      centers.recordStockPurchase({ department: 'COOL_DRINKS', paidFrom: 'OUTSIDE', lines: [line(coke.id, { caseSize: 24 }), line(goldFlake.id)] }, fx.cashier),
      PosErrorCode.ILLEGAL_TRANSITION,
      /Gold Flake.*not a Cool Drinks item/,
    );
    await expectPosError(centers.recordStockPurchase({ department: 'LIQUOR', paidFrom: 'OUTSIDE', lines: [line(fx.sku.full, { caseSize: 12 })] }, fx.cashier), PosErrorCode.ILLEGAL_TRANSITION);
    await expectPosError(centers.recordStockPurchase({ department: 'KITCHEN', paidFrom: 'OUTSIDE', lines: [line(goldFlake.id)] }, fx.cashier), PosErrorCode.ILLEGAL_TRANSITION, /stock-tracked/);
    await expectPosError(centers.recordStockPurchase({ department: 'CIGARETTES', paidFrom: 'OUTSIDE', lines: [line(goldFlake.id, { caseSize: 20 })] }, fx.cashier), PosErrorCode.ILLEGAL_TRANSITION, /case size/);
    await expect(centers.recordStockPurchase({ department: 'CIGARETTES', paidFrom: 'OUTSIDE', lines: [line(goldFlake.id, { looseUnits: 10 })] }, fx.cashier)).rejects.toThrow(RangeError);
    await expect(centers.recordStockPurchase({ department: 'CIGARETTES', paidFrom: 'CARD' as never, lines: [line(goldFlake.id)] }, fx.cashier)).rejects.toThrow(RangeError);
    await expect(centers.recordStockPurchase({ department: 'NOPE', paidFrom: 'OUTSIDE', lines: [line(goldFlake.id)] }, fx.cashier)).rejects.toThrow(/not found/i);

    expect([await onHand(goldFlake.id), await onHand(coke.id), await receipts()]).toEqual([0, 0, 0]);
  });

  it('refuses a drawer stock purchase while a peak runs (outside is fine)', async () => {
    const { fx, goldFlake, centers, peak, onHand } = await setup();
    const input = (paidFrom: 'DRAWER' | 'OUTSIDE') => ({ department: 'CIGARETTES', paidFrom, lines: [{ skuId: goldFlake.id, cases: 1, looseUnits: 0, caseSize: 10, unitCostPaise: 15_00n }] });
    await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    await expectPosError(centers.recordStockPurchase(input('DRAWER'), fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /peak/);
    await centers.recordStockPurchase(input('OUTSIDE'), fx.cashier);
    expect(await onHand(goldFlake.id)).toBe(10);
  });

  it('keeps unit names: defaults by center, copied to a new size, trimmed on edit, snapshotted on the GRN line', async () => {
    const { db, fx, others, catalog, goldFlake, coke, centers } = await setup();
    expect(coke).toMatchObject({ purchaseUnitName: 'Case', saleUnitName: 'Bottle' });
    const paan = await catalog.createItem({ categoryId: others, name: 'Meetha Paan', department: 'ANCILLARY', salePricePaise: 30_00n }, fx.cashier);
    expect(paan).toMatchObject({ purchaseUnitName: 'Case', saleUnitName: 'Unit' });
    // The seeded liquor (inserted by SQL) is bought by the Case and sold by the Bottle.
    expect(await new CounterQueries(db).lookupSku('HRUM-F')).toMatchObject({ purchaseUnitName: 'Case', saleUnitName: 'Bottle' });

    await centers.recordStockPurchase(
      { department: 'CIGARETTES', paidFrom: 'OUTSIDE', lines: [{ skuId: goldFlake.id, cases: 1, looseUnits: 2, caseSize: 10, unitCostPaise: 15_00n }] },
      fx.cashier,
    );
    expect(await catalog.updateItem(goldFlake.id, { purchaseUnitName: '  Carton ', caseSize: 200 })).toMatchObject({ purchaseUnitName: 'Carton', caseSize: 200 });
    await expect(catalog.updateItem(goldFlake.id, { saleUnitName: '   ' })).rejects.toThrow(RangeError);
    await expect(catalog.updateItem(goldFlake.id, { purchaseUnitName: 'x'.repeat(21) })).rejects.toThrow(RangeError);
    const { rows } = await db.query(`SELECT cases, case_size, purchase_unit_name FROM stock_receipt_lines`);
    expect(rows).toEqual([{ cases: 1, case_size: 10, purchase_unit_name: 'Packet' }]);

    // A loose-only GRN line names no purchase unit.
    await new PurchaseService(db).recordReceipt({ invoiceNo: 'ITC-9', lines: [{ skuId: goldFlake.id, quantity: 3, unitCostPaise: 15_00n }] }, fx.cashier);
    expect((await db.query(`SELECT purchase_unit_name FROM stock_receipt_lines ORDER BY id DESC LIMIT 1`)).rows).toEqual([{ purchase_unit_name: null }]);

    // Another size of the same brand takes the brand's names unless given.
    const product = await catalog.addSku(goldFlake.productId, { sizeCode: 'FULL', salePricePaise: 350_00n, caseSize: 10 });
    expect(product.skus.find((s) => s.sizeCode === 'FULL')).toMatchObject({ purchaseUnitName: 'Carton', saleUnitName: 'Stick' });
  });
});

describe('upgrading a 0018 database to 0019', () => {
  it('names units by center and keeps expected cash and old GRN lines', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fl2-mig-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (/^00(0\d|1[0-8])_.*\.sql$/.test(f)) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const db = new PGlite();
    await runMigrations(db, dir);
    await rm(dir, { recursive: true, force: true });
    const fx = await seed(db);
    await db.transaction(async (tx) => {
      const { id } = (await tx.query<{ id: string }>(`INSERT INTO stock_receipts (invoice_no, received_by_staff_id) VALUES ('OLD-1', $1) RETURNING id`, [fx.cashier])).rows[0]!;
      await tx.query(`INSERT INTO stock_receipt_lines (receipt_id, line_no, sku_id, qty, cases, case_size, unit_cost_paise) VALUES ($1, 1, $2, 12, 1, 12, 100000)`, [id, fx.sku.full]);
    });
    const before = await one<{ expected: string }>(db, `SELECT pos_day_expected_cash($1)::text AS expected`, [fx.dayId]);

    expect((await runMigrations(db))[0]).toBe('0019_purchase_units');
    expect(await one<{ expected: string }>(db, `SELECT pos_day_expected_cash($1)::text AS expected`, [fx.dayId])).toEqual(before);
    const { rows: units } = await db.query(`SELECT DISTINCT purchase_unit_name, sale_unit_name FROM skus`);
    expect(units).toEqual([{ purchase_unit_name: 'Case', sale_unit_name: 'Bottle' }]);
    const { rows: receipts } = await db.query(`SELECT r.paid_from, r.department, l.purchase_unit_name FROM stock_receipts r JOIN stock_receipt_lines l ON l.receipt_id = r.id`);
    expect(receipts).toEqual([{ paid_from: 'OUTSIDE', department: null, purchase_unit_name: null }]);
    expect((await db.query(`SELECT * FROM v_invariant_violations`)).rows).toEqual([]);
    await db.close();
  });
});
