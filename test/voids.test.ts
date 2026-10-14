import { describe, expect, it } from 'vitest';
import { PgErrorCode, PosErrorCode } from '../src/db/errors.js';
import { expectSqlError, useSeededDb } from './support/db.js';
import { OPENING_QTY, PRICE } from './support/fixtures.js';
import {
  addItem,
  cancelItem,
  endPeak,
  getBill,
  inTransaction,
  one,
  onHand,
  openBill,
  type PaymentRow,
  reverseBill,
  sell,
  startPeak,
  waiterBalance,
  waiterRepay,
} from './support/pos.js';

describe('Voids & corrections (append-only reversing records)', () => {
  const ctx = useSeededDb();

  it('voids a settled cash bill with a REVERSAL bill and leaves the original untouched', async () => {
    const { db, fx } = ctx();
    const original = await sell(db, { lines: [[fx.sku.half, 2]], tenders: [['CASH', 240_000]] });
    expect(await onHand(db, fx.sku.half)).toBe(OPENING_QTY - 2);

    const reversal = await reverseBill(db, original.id, { reason: 'wrong brand', staffId: fx.manager });

    expect(reversal).toMatchObject({
      bill_kind: 'REVERSAL',
      billing_mode: 'NORMAL',
      status: 'SETTLED',
      reverses_bill_id: original.id,
      total_paise: -240_000,
    });
    expect(reversal.bill_no).toBe(original.bill_no + 1);
    expect(await getBill(db, original.id)).toEqual(original);

    const lines = await db.query<{ qty: number; line_total_paise: number }>(
      `SELECT qty, line_total_paise FROM bill_items WHERE bill_id = $1`,
      [reversal.id],
    );
    expect(lines.rows).toEqual([{ qty: -2, line_total_paise: -240_000 }]);
    const refunds = await db.query<{ tender_type: string; amount_paise: number }>(
      `SELECT tender_type, amount_paise FROM bill_payments WHERE bill_id = $1`,
      [reversal.id],
    );
    expect(refunds.rows).toEqual([{ tender_type: 'CASH', amount_paise: -240_000 }]);

    expect(await onHand(db, fx.sku.half)).toBe(OPENING_QTY);
    const effective = await db.query(`SELECT id FROM v_bills_effective WHERE id = $1`, [original.id]);
    expect(effective.rows).toEqual([]);
  });

  it('corrects a bill: reversal first, then a replacement bill linked by replaces_bill_id', async () => {
    const { db, fx } = ctx();
    const original = await sell(db, { lines: [[fx.sku.half, 2]], tenders: [['CASH', 240_000]] });

    // Replacing before reversing is rejected.
    await expectSqlError(openBill(db, { replacesBillId: original.id }), PosErrorCode.REVERSAL_RULE, /after it has been reversed/);

    await reverseBill(db, original.id, { reason: 'customer kept one bottle only' });
    const replacement = await sell(db, {
      replacesBillId: original.id,
      lines: [[fx.sku.half, 1]],
      tenders: [['CASH', PRICE.half]],
    });
    expect(replacement).toMatchObject({ replaces_bill_id: original.id, status: 'SETTLED', total_paise: PRICE.half });

    // Only one replacement per original.
    await expectSqlError(openBill(db, { replacesBillId: original.id }), PgErrorCode.UNIQUE_VIOLATION);

    const effective = await db.query<{ id: string }>(`SELECT id FROM v_bills_effective`);
    expect(effective.rows.map((r) => r.id)).toEqual([replacement.id]);
  });

  it('reverses a bill at most once, and never reverses a reversal', async () => {
    const { db, fx } = ctx();
    const original = await sell(db, { lines: [[fx.sku.quarter, 1]], tenders: [['UPI', PRICE.quarter]] });
    const reversal = await reverseBill(db, original.id, { reason: 'duplicate scan' });

    await expectSqlError(reverseBill(db, original.id, { reason: 'again' }), PgErrorCode.UNIQUE_VIOLATION);
    await expectSqlError(reverseBill(db, reversal.id, { reason: 'undo the void' }), PosErrorCode.REVERSAL_RULE, /cannot itself be reversed/);
  });

  it('rejects an incomplete reversal at COMMIT (partial voids are reversal + replacement)', async () => {
    const { db, fx } = ctx();
    const original = await sell(db, { lines: [[fx.sku.half, 2]], tenders: [['CASH', 240_000]] });
    const line = await one<{ id: string }>(db, `SELECT id FROM bill_items WHERE bill_id = $1`, [original.id]);

    await expectSqlError(
      inTransaction(db, async () => {
        const reversal = await one<{ id: string }>(
          db,
          `INSERT INTO bills (bill_kind, billing_mode, status, source, reverses_bill_id, reversal_reason)
           VALUES ('REVERSAL', 'NORMAL', 'OPEN', 'COUNTER', $1, 'partial') RETURNING id`,
          [original.id],
        );
        await db.query(`INSERT INTO bill_items (bill_id, reverses_item_id, qty) VALUES ($1, $2, -1)`, [reversal.id, line.id]);
      }),
      PosErrorCode.REVERSAL_RULE,
      /unreversed/,
    );
    const { rows } = await db.query(`SELECT 1 FROM bills WHERE reverses_bill_id = $1`, [original.id]);
    expect(rows).toEqual([]);
  });

  it('refunds must mirror the original tenders exactly', async () => {
    const { db, fx } = ctx();
    const original = await sell(db, { lines: [[fx.sku.half, 1]], tenders: [['CASH', PRICE.half]] });
    const cash = await one<PaymentRow>(db, `SELECT * FROM bill_payments WHERE bill_id = $1`, [original.id]);

    await expectSqlError(
      inTransaction(db, async () => {
        const reversal = await one<{ id: string }>(
          db,
          `INSERT INTO bills (bill_kind, billing_mode, status, source, reverses_bill_id, reversal_reason)
           VALUES ('REVERSAL', 'NORMAL', 'OPEN', 'COUNTER', $1, 'void') RETURNING id`,
          [original.id],
        );
        await db.query(`INSERT INTO bill_payments (bill_id, tender_type, amount_paise, reverses_payment_id) VALUES ($1, 'CASH', -1, $2)`, [
          reversal.id,
          cash.id,
        ]);
      }),
      PosErrorCode.REVERSAL_RULE,
      /exactly negate/,
    );
  });

  describe('open bills are corrected with line cancellations, never deletes', () => {
    it('appends a negative line, restocks, and lowers the total', async () => {
      const { db, fx } = ctx();
      const bill = await openBill(db, { waiterId: fx.waiter.trusted });
      const line = await addItem(db, bill.id, fx.sku.full, 3);
      await cancelItem(db, bill.id, line.id, 1);

      expect((await getBill(db, bill.id)).total_paise).toBe(2 * PRICE.full);
      expect(await onHand(db, fx.sku.full)).toBe(OPENING_QTY - 2);

      await expectSqlError(cancelItem(db, bill.id, line.id, 3), PosErrorCode.REVERSAL_RULE, /only 2 remain/);
      await expectSqlError(reverseBill(db, bill.id, { reason: 'open' }), PosErrorCode.REVERSAL_RULE, /line cancellations/);
    });

    it('does not restock a cancelled bottle that was already opened', async () => {
      const { db, fx } = ctx();
      const bill = await openBill(db);
      const line = await addItem(db, bill.id, fx.sku.beer650, 2);
      await cancelItem(db, bill.id, line.id, 1, false);
      expect(await onHand(db, fx.sku.beer650)).toBe(OPENING_QTY - 2);
    });
  });

  describe('voids involving waiter credit', () => {
    it('reverses the collect-later portion back off the waiter account', async () => {
      const { db, fx } = ctx();
      const original = await sell(db, {
        waiterId: fx.waiter.trusted,
        lines: [[fx.sku.half, 2]],
        tenders: [
          ['CASH', 150_000],
          ['WAITER_CREDIT', 90_000],
        ],
      });
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(90_000);

      const reversal = await reverseBill(db, original.id, { reason: 'table walked out before serving' });
      expect(reversal.waiter_id).toBe(fx.waiter.trusted);
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(0);

      const ledger = await db.query<{ entry_type: string; amount_paise: number }>(
        `SELECT entry_type, amount_paise FROM waiter_ledger_entries WHERE waiter_id = $1 ORDER BY created_at, id`,
        [fx.waiter.trusted],
      );
      expect(ledger.rows).toEqual([
        { entry_type: 'BILL_CREDIT', amount_paise: 90_000 },
        { entry_type: 'BILL_CREDIT_REVERSAL', amount_paise: -90_000 },
      ]);
    });

    it('refunds already-repaid credit in cash, since the account cannot go negative', async () => {
      const { db, fx } = ctx();
      const original = await sell(db, {
        waiterId: fx.waiter.trusted,
        lines: [[fx.sku.half, 2]],
        tenders: [
          ['CASH', 150_000],
          ['WAITER_CREDIT', 90_000],
        ],
      });
      await waiterRepay(db, fx.waiter.trusted, 'UPI', 90_000, fx.cashier);

      await expectSqlError(reverseBill(db, original.id, { reason: 'void' }), PosErrorCode.WAITER_BALANCE);
      const { rows: none } = await db.query(`SELECT 1 FROM bills WHERE reverses_bill_id = $1`, [original.id]);
      expect(none).toEqual([]);

      const credit = await one<PaymentRow>(
        db,
        `SELECT * FROM bill_payments WHERE bill_id = $1 AND tender_type = 'WAITER_CREDIT'`,
        [original.id],
      );
      const reversal = await reverseBill(db, original.id, { reason: 'void', refundAs: { [credit.id]: 'CASH' } });
      expect(reversal.status).toBe('SETTLED');
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(0);
    });
  });

  describe('voids of peak bills', () => {
    it('refunds a reconciled peak bill as a plain cash outflow in NORMAL mode', async () => {
      const { db, fx } = ctx();
      const session = await startPeak(db, 0, 0, fx.cashier);
      const peakBill = await sell(db, { mode: 'PEAK', lines: [[fx.sku.full, 1]] });
      await endPeak(db, session.id, PRICE.full, 0, fx.cashier);

      const reversal = await reverseBill(db, peakBill.id, { reason: 'bottle was counterfeit-sealed' });
      expect(reversal).toMatchObject({ billing_mode: 'NORMAL', status: 'SETTLED', total_paise: -PRICE.full });
      expect((await getBill(db, peakBill.id)).status).toBe('PEAK_RECONCILED');
    });

    it('requires an unsettled peak bill to be reversed inside its running session', async () => {
      const { db, fx } = ctx();
      await startPeak(db, 0, 0, fx.cashier);
      const peakBill = await sell(db, { mode: 'PEAK', lines: [[fx.sku.full, 1]] });
      await expectSqlError(
        db.query(
          `INSERT INTO bills (bill_kind, billing_mode, status, source, reverses_bill_id, reversal_reason)
           VALUES ('REVERSAL', 'NORMAL', 'OPEN', 'COUNTER', $1, 'void')`,
          [peakBill.id],
        ),
        PosErrorCode.REVERSAL_RULE,
        /inside its running peak session/,
      );
    });
  });

  describe('append-only enforcement', () => {
    it('freezes settled bills', async () => {
      const { db, fx } = ctx();
      const bill = await sell(db, { lines: [[fx.sku.half, 1]], tenders: [['CASH', PRICE.half]] });
      await expectSqlError(db.query(`UPDATE bills SET source = 'WAITER_APP' WHERE id = $1`, [bill.id]), PosErrorCode.APPEND_ONLY, /frozen/);
      await expectSqlError(db.query(`UPDATE bills SET status = 'OPEN' WHERE id = $1`, [bill.id]), PosErrorCode.APPEND_ONLY);
      await expectSqlError(addItem(db, bill.id, fx.sku.half, 1), PosErrorCode.APPEND_ONLY);
    });

    it('forbids DELETE and TRUNCATE on transactional tables', async () => {
      const { db, fx } = ctx();
      const bill = await sell(db, { lines: [[fx.sku.half, 1]], tenders: [['CASH', PRICE.half]] });
      for (const table of ['bill_payments', 'bill_items', 'stock_movements']) {
        await expectSqlError(db.query(`DELETE FROM ${table}`), PosErrorCode.APPEND_ONLY, /append-only/);
      }
      await expectSqlError(db.query(`DELETE FROM bills WHERE id = $1`, [bill.id]), PosErrorCode.APPEND_ONLY);
      await expectSqlError(db.query(`TRUNCATE bills CASCADE`), PosErrorCode.APPEND_ONLY);
    });

    it('forbids UPDATE on ledger rows', async () => {
      const { db, fx } = ctx();
      const bill = await sell(db, { lines: [[fx.sku.half, 1]], tenders: [['CASH', PRICE.half]] });
      await expectSqlError(db.query(`UPDATE bill_items SET qty = 5 WHERE bill_id = $1`, [bill.id]), PosErrorCode.APPEND_ONLY);
      await expectSqlError(db.query(`UPDATE bill_payments SET amount_paise = 1 WHERE bill_id = $1`, [bill.id]), PosErrorCode.APPEND_ONLY);
    });

    it('rejects writing bill totals directly', async () => {
      const { db, fx } = ctx();
      const bill = await openBill(db);
      await addItem(db, bill.id, fx.sku.half, 1);
      await expectSqlError(db.query(`UPDATE bills SET total_paise = 1 WHERE id = $1`, [bill.id]), PosErrorCode.DERIVED_COLUMN);
    });
  });
});
