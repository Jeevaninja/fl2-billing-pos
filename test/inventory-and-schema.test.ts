import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { PgErrorCode, PosErrorCode } from '../src/db/errors.js';
import { expectSqlError, useSeededDb } from './support/db.js';
import { OPENING_QTY, PRICE } from './support/fixtures.js';
import { addItem, getBill, one, onHand, openBill, sell } from './support/pos.js';

describe('Inventory (whole sealed bottles)', () => {
  const ctx = useSeededDb();

  it('decrements stock per bottle sold and never lets it go negative', async () => {
    const { db, fx } = ctx();
    await sell(db, { lines: [[fx.sku.quarter, OPENING_QTY - 1]], tenders: [['CASH', (OPENING_QTY - 1) * PRICE.quarter]] });
    expect(await onHand(db, fx.sku.quarter)).toBe(1);

    const bill = await openBill(db);
    await expectSqlError(addItem(db, bill.id, fx.sku.quarter, 2), PosErrorCode.INSUFFICIENT_STOCK, /1 bottle\(s\) on hand, 2 requested/);
    expect(await onHand(db, fx.sku.quarter)).toBe(1);
    expect((await getBill(db, bill.id)).total_paise).toBe(0);

    await addItem(db, bill.id, fx.sku.quarter, 1);
    expect(await onHand(db, fx.sku.quarter)).toBe(0);
  });

  it('rejects a write-off adjustment below zero, and requires a reason', async () => {
    const { db, fx } = ctx();
    const adjust = (qty: number, reason: string | null) =>
      db.query(
        `INSERT INTO stock_movements (sku_id, movement_type, qty_delta, reason, created_by_staff_id)
         VALUES ($1, 'ADJUSTMENT', $2, $3, $4)`,
        [fx.sku.full, qty, reason, fx.manager],
      );
    await expectSqlError(adjust(-1, null), PgErrorCode.CHECK_VIOLATION);
    await expectSqlError(adjust(-(OPENING_QTY + 1), 'count'), PosErrorCode.INSUFFICIENT_STOCK);
    await adjust(-2, 'breakage in storeroom');
    expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY - 2);
  });

  it('only lets bill_items post SALE movements, and keeps sku_stock derived', async () => {
    const { db, fx } = ctx();
    await expectSqlError(
      db.query(`INSERT INTO stock_movements (sku_id, movement_type, qty_delta) VALUES ($1, 'SALE', -1)`, [fx.sku.full]),
      PosErrorCode.DERIVED_COLUMN,
    );
    await expectSqlError(
      db.query(`UPDATE sku_stock SET on_hand_qty = 999 WHERE sku_id = $1`, [fx.sku.full]),
      PosErrorCode.DERIVED_COLUMN,
    );
  });

  it('supports Full / Half / Quarter / Beer 650 / Beer 330 as distinct SKUs and nothing else', async () => {
    const { db, fx } = ctx();
    const { rows } = await db.query<{ size_code: string }>(`SELECT size_code FROM skus ORDER BY size_code`);
    expect(rows.map((r) => r.size_code)).toEqual(['BEER_330', 'BEER_650', 'FULL', 'HALF', 'QUARTER']);

    const product = await one<{ product_id: string }>(db, `SELECT product_id FROM skus WHERE id = $1`, [fx.sku.full]);
    for (const size of ['PEG_30', '750ML', 'OPEN_BOTTLE']) {
      await expectSqlError(
        db.query(
          `INSERT INTO skus (product_id, sku_code, size_code, display_name, price_paise, case_size) VALUES ($1, $2, $3, 'x', 100, 12)`,
          [product.product_id, `X-${size}`, size],
        ),
        PgErrorCode.CHECK_VIOLATION,
      );
    }
    // One SKU per size per product.
    await expectSqlError(
      db.query(
        `INSERT INTO skus (product_id, sku_code, size_code, display_name, price_paise, case_size) VALUES ($1, 'DUP', 'FULL', 'x', 100, 12)`,
        [product.product_id],
      ),
      PgErrorCode.UNIQUE_VIOLATION,
    );
  });

  it('snapshots the SKU price on the line and rejects a client-supplied price', async () => {
    const { db, fx } = ctx();
    const bill = await openBill(db);
    const line = await addItem(db, bill.id, fx.sku.full, 1);
    await db.query(`UPDATE skus SET price_paise = 250000 WHERE id = $1`, [fx.sku.full]);
    expect(line.unit_price_paise).toBe(PRICE.full);
    expect((await getBill(db, bill.id)).total_paise).toBe(PRICE.full);

    await expectSqlError(
      db.query(`INSERT INTO bill_items (bill_id, sku_id, qty, unit_price_paise) VALUES ($1, $2, 1, 1)`, [bill.id, fx.sku.full]),
      PosErrorCode.ILLEGAL_TRANSITION,
      /current SKU price/,
    );
  });
});

describe('Business day', () => {
  const ctx = useSeededDb();

  it('numbers bills sequentially per day', async () => {
    const { db } = ctx();
    const a = await openBill(db);
    const b = await openBill(db);
    expect(b.bill_no).toBe(a.bill_no + 1);
    await expectSqlError(db.query(`UPDATE business_days SET next_bill_no = 1`), PosErrorCode.DERIVED_COLUMN);
  });

  it('cannot close while bills are open; once closed it is frozen and takes no postings', async () => {
    const { db, fx } = ctx();
    const close = () =>
      db.query(`UPDATE business_days SET status = 'CLOSED', closed_by_staff_id = $2, counted_cash_paise = 0 WHERE id = $1`, [fx.dayId, fx.manager]);

    const open = await openBill(db);
    await addItem(db, open.id, fx.sku.half, 1);
    await expectSqlError(close(), PosErrorCode.DAY_OR_PEAK_RULE, /1 bill\(s\) still open/);

    await db.query(`INSERT INTO bill_payments (bill_id, tender_type, amount_paise) VALUES ($1, 'CASH', $2)`, [open.id, PRICE.half]);
    await db.query(`UPDATE bills SET status = 'SETTLED' WHERE id = $1`, [open.id]);
    await close();

    await expectSqlError(db.query(`UPDATE business_days SET closed_at = now() WHERE id = $1`, [fx.dayId]), PosErrorCode.APPEND_ONLY);
    await expectSqlError(openBill(db), PosErrorCode.DAY_OR_PEAK_RULE, /open business day/);
  });

  it('allows only one open day', async () => {
    const { db, fx } = ctx();
    await expectSqlError(
      db.query(`INSERT INTO business_days (business_date, opened_by_staff_id) VALUES ('2026-10-15', $1)`, [fx.manager]),
      PgErrorCode.UNIQUE_VIOLATION,
    );
  });
});

describe('Sync outbox', () => {
  const ctx = useSeededDb();

  it('records every domain write in the same transaction, skipping derived-only updates', async () => {
    const { db, fx } = ctx();
    const before = (await one<{ seq: number }>(db, `SELECT coalesce(max(seq), 0)::int AS seq FROM sync_outbox`)).seq;

    await sell(db, { waiterId: fx.waiter.trusted, lines: [[fx.sku.half, 1]], tenders: [['WAITER_CREDIT', PRICE.half]] });

    const { rows } = await db.query<{ event_type: string }>(`SELECT event_type FROM sync_outbox WHERE seq > $1 ORDER BY seq`, [before]);
    expect(rows.map((r) => r.event_type)).toEqual([
      'bills.insert',
      'stock_movements.insert',
      'bill_items.insert',
      'waiter_ledger_entries.insert',
      'bill_payments.insert',
      'bills.update',
    ]);
  });

  it('never ships PIN hashes and keeps events immutable', async () => {
    const { db } = ctx();
    await db.query(`INSERT INTO staff (display_name, role, pin_hash) VALUES ('Night cashier', 'CASHIER', 'argon2:secret')`);
    const event = await one<{ seq: number; payload: Record<string, unknown> }>(
      db,
      `SELECT seq, payload FROM sync_outbox WHERE event_type = 'staff.insert' ORDER BY seq DESC LIMIT 1`,
    );
    expect(event.payload).not.toHaveProperty('pin_hash');
    expect(event.payload).toHaveProperty('display_name', 'Night cashier');

    await db.query(`UPDATE sync_outbox SET synced_at = now(), attempts = 1 WHERE seq = $1`, [event.seq]);
    await expectSqlError(db.query(`UPDATE sync_outbox SET payload = '{}' WHERE seq = $1`, [event.seq]), PosErrorCode.APPEND_ONLY);
    await expectSqlError(db.query(`DELETE FROM sync_outbox WHERE seq = $1`, [event.seq]), PosErrorCode.APPEND_ONLY);
  });
});

describe('Schema guardrails (CLAUDE.md negative constraints)', () => {
  const ctx = useSeededDb();

  it('has no floating-point or NUMERIC columns', async () => {
    const { db } = ctx();
    const { rows } = await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('real', 'double precision', 'numeric', 'money')`,
    );
    expect(rows).toEqual([]);
  });

  it('stores every money column as BIGINT paise and every quantity as INTEGER', async () => {
    const { db } = ctx();
    const { rows } = await db.query<{ column_name: string; data_type: string }>(
      `SELECT table_name || '.' || column_name AS column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name LIKE '%\\_paise' OR column_name LIKE 'peak\\_%\\_cash' OR column_name LIKE 'peak\\_%\\_upi'
               OR column_name = 'outstanding_balance' OR column_name IN ('qty', 'qty_delta', 'on_hand_qty'))`,
    );
    expect(rows.length).toBeGreaterThan(15);
    for (const row of rows) {
      const expected = /qty/.test(row.column_name) ? 'integer' : 'bigint';
      expect(row, row.column_name).toMatchObject({ data_type: expected });
    }
  });

  it('has no milliliter / peg / open-bottle / tax / table-layout columns', async () => {
    const { db } = ctx();
    const { rows } = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name ~* '(^|_)(ml|millilit|litre|liter|volume|peg|pegs|open_bottle|tax|gst|vat|table_no|table_id)(_|$)'`,
    );
    // The one exception (0017, Phase 24 R2): a sealed bottle's nominal volume as a static integer label on
    // the SKU, for the excise ML summary. Stock, bills and movements still carry whole bottles only.
    expect(rows).toEqual([{ table_name: 'skus', column_name: 'volume_ml', data_type: 'integer' }]);
  });

  it('re-running migrations is a no-op', async () => {
    const { db } = ctx();
    expect(await runMigrations(db)).toEqual([]);
  });
});
