import { describe, expect, it } from 'vitest';
import { InactiveError, NotFoundError, PgErrorCode, PosErrorCode } from '../../src/db/errors.js';
import { CounterQueries, DayEndService, PurchaseService, type ReceiptInput } from '../../src/services/index.js';
import { expectSqlError, useSeededDb } from '../support/db.js';
import { OPENING_QTY } from '../support/fixtures.js';
import { onHand } from '../support/pos.js';
import { expectPosError, makeServices } from '../support/services.js';

const MISSING = '00000000-0000-0000-0000-000000000000';

describe('PurchaseService: stock receipts (GRN)', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, purchases: new PurchaseService(db), queries: new CounterQueries(db), dayEnd: new DayEndService(db), ...makeServices(db) };
  };

  const invoice = (fx: { sku: Record<'full' | 'quarter' | 'beer650', string> }, overrides: Partial<ReceiptInput> = {}): ReceiptInput => ({
    invoiceNo: 'INV-4471',
    vendorName: 'Sri Balaji Distributors',
    lines: [
      { skuId: fx.sku.full, quantity: 12, unitCostPaise: 1_100_00n },
      { skuId: fx.sku.quarter, quantity: 48, unitCostPaise: 210_00n },
    ],
    ...overrides,
  });

  describe('recordReceipt', () => {
    it('raises on-hand stock by each line and returns the receipt with its totals', async () => {
      const { db, fx, purchases } = setup();
      const detail = await purchases.recordReceipt(invoice(fx), fx.cashier);

      expect(detail.receipt).toMatchObject({
        businessDayId: fx.dayId,
        invoiceNo: 'INV-4471',
        vendorName: 'Sri Balaji Distributors',
        receivedByStaffId: fx.cashier,
        receivedBy: 'Counter 1',
        lineCount: 2,
        bottles: 60,
        totalCostPaise: 12n * 1_100_00n + 48n * 210_00n,
      });
      expect(detail.lines).toEqual([
        expect.objectContaining({ lineNo: 1, skuId: fx.sku.full, skuCode: 'HRUM-F', sizeCode: 'FULL', quantity: 12, unitCostPaise: 1_100_00n, lineTotalPaise: 13_200_00n }),
        expect.objectContaining({ lineNo: 2, skuId: fx.sku.quarter, skuCode: 'HRUM-Q', sizeCode: 'QUARTER', quantity: 48, lineTotalPaise: 10_080_00n }),
      ]);
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY + 12);
      expect(await onHand(db, fx.sku.quarter)).toBe(OPENING_QTY + 48);
      expect(await onHand(db, fx.sku.half)).toBe(OPENING_QTY);
    });

    it('logs one PURCHASE_RECEIPT movement per line that traces back to the invoice', async () => {
      const { db, fx, purchases } = setup();
      const { receipt, lines } = await purchases.recordReceipt(invoice(fx), fx.cashier);

      const { rows } = await db.query<{ sku_id: string; qty_delta: number; business_day_id: string; created_by_staff_id: string; invoice_no: string; vendor_name: string; line_id: string }>(
        `SELECT m.sku_id, m.qty_delta, m.business_day_id, m.created_by_staff_id, r.invoice_no, r.vendor_name, l.id AS line_id
           FROM stock_movements m
           JOIN stock_receipt_lines l ON l.id = m.receipt_line_id
           JOIN stock_receipts r ON r.id = l.receipt_id
          WHERE m.movement_type = 'PURCHASE_RECEIPT'
          ORDER BY l.line_no`,
      );
      expect(rows).toEqual([
        { sku_id: fx.sku.full, qty_delta: 12, business_day_id: fx.dayId, created_by_staff_id: fx.cashier, invoice_no: 'INV-4471', vendor_name: 'Sri Balaji Distributors', line_id: lines[0]!.id },
        { sku_id: fx.sku.quarter, qty_delta: 48, business_day_id: fx.dayId, created_by_staff_id: fx.cashier, invoice_no: 'INV-4471', vendor_name: 'Sri Balaji Distributors', line_id: lines[1]!.id },
      ]);
      expect(receipt.businessDayId).toBe(fx.dayId);
    });

    it('trims the invoice and vendor, allows no vendor, and allows ₹0 scheme bottles', async () => {
      const { db, fx, purchases } = setup();
      const { receipt, lines } = await purchases.recordReceipt(
        { invoiceNo: '  INV-9  ', vendorName: '   ', lines: [{ skuId: fx.sku.beer650, quantity: 24, unitCostPaise: 0n }] },
        fx.cashier,
      );
      expect(receipt).toMatchObject({ invoiceNo: 'INV-9', vendorName: null, totalCostPaise: 0n, bottles: 24 });
      expect(lines[0]).toMatchObject({ unitCostPaise: 0n, lineTotalPaise: 0n });
      expect(await onHand(db, fx.sku.beer650)).toBe(OPENING_QTY + 24);
    });

    it('is atomic: a bad line leaves no header, no lines and no stock change', async () => {
      const { db, fx, purchases } = setup();
      await db.query(`UPDATE skus SET is_active = false WHERE id = $1`, [fx.sku.half]);
      const lines = [...invoice(fx).lines, { skuId: fx.sku.half, quantity: 6, unitCostPaise: 600_00n }];

      await expect(purchases.recordReceipt(invoice(fx, { lines }), fx.cashier)).rejects.toBeInstanceOf(InactiveError);
      const missing = [...invoice(fx).lines, { skuId: MISSING, quantity: 1, unitCostPaise: 1n }];
      await expect(purchases.recordReceipt(invoice(fx, { lines: missing }), fx.cashier)).rejects.toBeInstanceOf(NotFoundError);

      const counts = await db.query<{ receipts: number; lines: number; movements: number }>(
        `SELECT (SELECT count(*)::int FROM stock_receipts) AS receipts,
                (SELECT count(*)::int FROM stock_receipt_lines) AS lines,
                (SELECT count(*)::int FROM stock_movements WHERE movement_type = 'PURCHASE_RECEIPT') AS movements`,
      );
      expect(counts.rows[0]).toEqual({ receipts: 0, lines: 0, movements: 0 });
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY);
    });

    it('refuses the same invoice from the same vendor twice (case- and space-insensitive), PS011', async () => {
      const { db, fx, purchases } = setup();
      await purchases.recordReceipt(invoice(fx), fx.cashier);
      await expectPosError(
        purchases.recordReceipt(invoice(fx, { invoiceNo: ' inv-4471', vendorName: 'SRI BALAJI DISTRIBUTORS ' }), fx.cashier),
        PosErrorCode.DUPLICATE_RECEIPT,
      );
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY + 12);

      // Same number from another vendor, or with no vendor, is a different invoice.
      await purchases.recordReceipt(invoice(fx, { vendorName: 'Another Depot' }), fx.cashier);
      await purchases.recordReceipt(invoice(fx, { vendorName: null }), fx.cashier);
      await expectPosError(purchases.recordReceipt(invoice(fx, { vendorName: undefined }), fx.cashier), PosErrorCode.DUPLICATE_RECEIPT);
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY + 36);
    });

    it('needs an open business day (PS007)', async () => {
      const { fx, purchases, dayEnd } = setup();
      await dayEnd.closeBusinessDay(fx.dayId, 0n, fx.cashier);
      await expectPosError(purchases.recordReceipt(invoice(fx), fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /no business day is open/);
    });

    it('can be recorded during a peak session (no drawer cash involved)', async () => {
      const { db, fx, purchases, peak } = setup();
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      await purchases.recordReceipt(invoice(fx), fx.cashier);
      const result = await peak.endPeakSession(session.id, 0n, 0n, fx.cashier);
      expect(result.breakdown.variancePaise).toBe(0n);
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY + 12);
    });

    it('validates the input before touching the database', async () => {
      const { fx, purchases } = setup();
      const line = { skuId: fx.sku.full, quantity: 1, unitCostPaise: 100n };
      const bad: ReceiptInput[] = [
        { invoiceNo: '  ', lines: [line] },
        { invoiceNo: 'X'.repeat(61), lines: [line] },
        { invoiceNo: 'A', vendorName: 'V'.repeat(101), lines: [line] },
        { invoiceNo: 'A', lines: [] },
        { invoiceNo: 'A', lines: [{ ...line, quantity: 0 }] },
        { invoiceNo: 'A', lines: [{ ...line, quantity: -2 }] },
        { invoiceNo: 'A', lines: [{ ...line, quantity: 1.5 }] },
        { invoiceNo: 'A', lines: [{ ...line, quantity: 100_001 }] },
        { invoiceNo: 'A', lines: [{ ...line, unitCostPaise: -1n }] },
        { invoiceNo: 'A', lines: [line, { ...line, quantity: 2 }] },
      ];
      for (const input of bad) {
        await expect(purchases.recordReceipt(input, fx.cashier), JSON.stringify(input, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))).rejects.toBeInstanceOf(RangeError);
      }
    });

    it('feeds billing: received bottles can be sold straight away', async () => {
      const { fx, purchases, billing, queries } = setup();
      const before = await queries.lookupSku('HRUM-F');
      await purchases.recordReceipt({ invoiceNo: 'INV-10', lines: [{ skuId: fx.sku.full, quantity: 10, unitCostPaise: 1_100_00n }] }, fx.cashier);
      expect((await queries.lookupSku('HRUM-F'))?.onHandQty).toBe(before!.onHandQty + 10);

      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.full, OPENING_QTY + 10);
      expect((await queries.lookupSku('HRUM-F'))?.onHandQty).toBe(0);
    });
  });

  describe('case-based lines (Phase 10)', () => {
    it('posts cases × case size + loose bottles: 2 cases + 3 of a 64-quarter is 131 bottles', async () => {
      const { db, fx, purchases } = setup();
      const { receipt, lines } = await purchases.recordReceipt(
        {
          invoiceNo: 'INV-131',
          lines: [
            { skuId: fx.sku.quarter, cases: 2, looseBottles: 3, caseSize: 64, unitCostPaise: 210_00n },
            { skuId: fx.sku.full, cases: 1, looseBottles: 0, caseSize: 12, unitCostPaise: 1_100_00n },
            { skuId: fx.sku.half, quantity: 5, unitCostPaise: 560_00n },
          ],
        },
        fx.cashier,
      );

      expect(lines).toEqual([
        expect.objectContaining({ skuId: fx.sku.quarter, quantity: 131, cases: 2, caseSize: 64, looseBottles: 3, lineTotalPaise: 131n * 210_00n }),
        expect.objectContaining({ skuId: fx.sku.full, quantity: 12, cases: 1, caseSize: 12, looseBottles: 0 }),
        expect.objectContaining({ skuId: fx.sku.half, quantity: 5, cases: 0, caseSize: null, looseBottles: 5 }),
      ]);
      expect(receipt).toMatchObject({ bottles: 148, lineCount: 3 });
      expect(await onHand(db, fx.sku.quarter)).toBe(OPENING_QTY + 131);
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY + 12);

      const { rows } = await db.query<{ qty_delta: number }>(
        `SELECT m.qty_delta FROM stock_movements m JOIN stock_receipt_lines l ON l.id = m.receipt_line_id WHERE l.sku_id = $1`,
        [fx.sku.quarter],
      );
      expect(rows).toEqual([{ qty_delta: 131 }]);
    });

    it('refuses a line counted at a case size the catalog no longer has (PS002) and writes nothing', async () => {
      const { db, fx, purchases } = setup();
      await db.query(`UPDATE skus SET case_size = 48 WHERE id = $1`, [fx.sku.quarter]);
      await expectPosError(
        purchases.recordReceipt(
          {
            invoiceNo: 'INV-STALE',
            lines: [
              { skuId: fx.sku.full, quantity: 1, unitCostPaise: 100n },
              { skuId: fx.sku.quarter, cases: 2, looseBottles: 3, caseSize: 64, unitCostPaise: 100n },
            ],
          },
          fx.cashier,
        ),
        PosErrorCode.ILLEGAL_TRANSITION,
        /case size for HRUM-Q is now 48/,
      );
      expect((await db.query(`SELECT 1 FROM stock_receipts`)).rows).toHaveLength(0);
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY);
      expect(await onHand(db, fx.sku.quarter)).toBe(OPENING_QTY);
    });

    it('validates cases, loose bottles and case size before touching the database', async () => {
      const { fx, purchases } = setup();
      const post = (line: { cases: number; looseBottles: number; caseSize: number }) =>
        purchases.recordReceipt({ invoiceNo: 'V', lines: [{ skuId: fx.sku.quarter, unitCostPaise: 100n, ...line }] }, fx.cashier);

      await expect(post({ cases: 0, looseBottles: 0, caseSize: 64 })).rejects.toThrow(/at least one case or bottle/);
      await expect(post({ cases: 1, looseBottles: 64, caseSize: 64 })).rejects.toThrow(/full case of 64/);
      await expect(post({ cases: -1, looseBottles: 3, caseSize: 64 })).rejects.toThrow(RangeError);
      await expect(post({ cases: 1.5, looseBottles: 3, caseSize: 64 })).rejects.toThrow(RangeError);
      await expect(post({ cases: 1, looseBottles: 0, caseSize: 0 })).rejects.toThrow(/caseSize/);
      await expect(post({ cases: 2000, looseBottles: 0, caseSize: 64 })).rejects.toThrow(/at most 100000/);
    });

    it('enforces the case shape in the database', async () => {
      const { db, fx, purchases } = setup();
      const { receipt } = await purchases.recordReceipt(invoice(fx), fx.cashier);
      const addLine = (qty: number, cases: number, caseSize: number | null) =>
        db.query(
          `INSERT INTO stock_receipt_lines (receipt_id, line_no, sku_id, qty, cases, case_size, unit_cost_paise) VALUES ($1, 3, $2, $3, $4, $5, 0)`,
          [receipt.id, fx.sku.half, qty, cases, caseSize],
        );
      await expectSqlError(addLine(60, 2, 32), PgErrorCode.CHECK_VIOLATION); // 2 × 32 > 60
      await expectSqlError(addLine(32, 1, null), PgErrorCode.CHECK_VIOLATION); // cases without a case size
      await expectSqlError(addLine(32, 1, 24), PosErrorCode.ILLEGAL_TRANSITION, /case size/);
      await addLine(70, 2, 32);
      expect(await onHand(db, fx.sku.half)).toBe(OPENING_QTY + 70);
    });
  });

  describe('database rules', () => {
    it('posts PURCHASE_RECEIPT movements only from receipt lines (PS009)', async () => {
      const { db, fx } = setup();
      await expectSqlError(
        db.query(`INSERT INTO stock_movements (sku_id, movement_type, qty_delta, created_by_staff_id) VALUES ($1, 'PURCHASE_RECEIPT', 5, $2)`, [fx.sku.full, fx.cashier]),
        PosErrorCode.DERIVED_COLUMN,
      );
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY);
    });

    it('keeps receipts and lines append-only (PS001) and enforces the line checks', async () => {
      const { db, fx, purchases } = setup();
      const { receipt, lines } = await purchases.recordReceipt(invoice(fx), fx.cashier);

      await expectSqlError(db.query(`UPDATE stock_receipts SET invoice_no = 'X' WHERE id = $1`, [receipt.id]), PosErrorCode.APPEND_ONLY);
      await expectSqlError(db.query(`DELETE FROM stock_receipts WHERE id = $1`, [receipt.id]), PosErrorCode.APPEND_ONLY);
      await expectSqlError(db.query(`UPDATE stock_receipt_lines SET qty = 99 WHERE id = $1`, [lines[0]!.id]), PosErrorCode.APPEND_ONLY);
      await expectSqlError(db.query(`DELETE FROM stock_receipt_lines WHERE id = $1`, [lines[0]!.id]), PosErrorCode.APPEND_ONLY);

      const addLine = (skuId: string, qty: number, cost: number, lineNo = 3) =>
        db.query(`INSERT INTO stock_receipt_lines (receipt_id, line_no, sku_id, qty, unit_cost_paise) VALUES ($1, $2, $3, $4, $5)`, [
          receipt.id,
          lineNo,
          skuId,
          qty,
          cost,
        ]);
      await expectSqlError(addLine(fx.sku.half, 0, 100), PgErrorCode.CHECK_VIOLATION);
      await expectSqlError(addLine(fx.sku.half, 1, -1), PgErrorCode.CHECK_VIOLATION);
      await expectSqlError(addLine(fx.sku.full, 1, 100), PgErrorCode.UNIQUE_VIOLATION);
      await expectSqlError(addLine(fx.sku.half, 1, 100, 1), PgErrorCode.UNIQUE_VIOLATION);
      await db.query(`UPDATE skus SET is_active = false WHERE id = $1`, [fx.sku.half]);
      await expectSqlError(addLine(fx.sku.half, 1, 100), PosErrorCode.ILLEGAL_TRANSITION, /inactive/);
    });

    it('writes outbox events for the receipt, its lines and their movements', async () => {
      const { db, fx, purchases } = setup();
      await purchases.recordReceipt(invoice(fx), fx.cashier);
      const { rows } = await db.query<{ event_type: string; n: number }>(
        `SELECT event_type, count(*)::int AS n FROM sync_outbox
          WHERE event_type IN ('stock_receipts.insert', 'stock_receipt_lines.insert', 'stock_movements.insert')
            AND created_at >= (SELECT created_at FROM stock_receipts LIMIT 1)
          GROUP BY event_type ORDER BY event_type`,
      );
      expect(rows).toEqual([
        { event_type: 'stock_movements.insert', n: 2 },
        { event_type: 'stock_receipt_lines.insert', n: 2 },
        { event_type: 'stock_receipts.insert', n: 1 },
      ]);
    });
  });

  describe('listReceipts / getReceipt', () => {
    it("lists the day's receipts newest first with their totals, and fetches one with its lines", async () => {
      const { fx, purchases } = setup();
      const first = await purchases.recordReceipt(invoice(fx), fx.cashier);
      const second = await purchases.recordReceipt(
        { invoiceNo: 'INV-0912', lines: [{ skuId: fx.sku.beer650, quantity: 24, unitCostPaise: 150_00n }] },
        fx.cashier,
      );

      const list = await purchases.listReceipts(fx.dayId);
      expect(list.map((r) => r.id)).toEqual([second.receipt.id, first.receipt.id]);
      expect(list[0]).toMatchObject({ invoiceNo: 'INV-0912', vendorName: null, lineCount: 1, bottles: 24, totalCostPaise: 3_600_00n });
      expect(list[1]).toEqual(first.receipt);

      expect(await purchases.getReceipt(first.receipt.id)).toEqual(first);
      await expect(purchases.getReceipt(MISSING)).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('CounterQueries.searchSkus', () => {
  const ctx = useSeededDb();

  it('finds by exact barcode, code prefix or name, with stock on hand, sizes in FULL → QUARTER order', async () => {
    const { db, fx } = ctx();
    const queries = new CounterQueries(db);
    await db.query(`UPDATE skus SET barcode = '8901234567890' WHERE id = $1`, [fx.sku.half]);

    const byName = await queries.searchSkus('house rum');
    expect(byName.map((s) => s.skuCode)).toEqual(['HRUM-F', 'HRUM-H', 'HRUM-Q']);
    expect(byName[0]).toMatchObject({ id: fx.sku.full, sizeCode: 'FULL', onHandQty: OPENING_QTY, isActive: true });

    expect((await queries.searchSkus('8901234567890')).map((s) => s.id)).toEqual([fx.sku.half]);
    expect((await queries.searchSkus('hlag')).map((s) => s.skuCode)).toEqual(['HLAG-650', 'HLAG-330']);
    expect((await queries.searchSkus('rum', 2)).length).toBe(2);
    expect(await queries.searchSkus('   ')).toEqual([]);
    expect(await queries.searchSkus('%')).toEqual([]);
  });

  it('lists inactive SKUs last so they can be seen but not picked by mistake', async () => {
    const { db, fx } = ctx();
    const queries = new CounterQueries(db);
    await db.query(`UPDATE skus SET is_active = false WHERE id = $1`, [fx.sku.full]);
    const found = await queries.searchSkus('house rum');
    expect(found.map((s) => [s.skuCode, s.isActive])).toEqual([
      ['HRUM-H', true],
      ['HRUM-Q', true],
      ['HRUM-F', false],
    ]);
  });
});
