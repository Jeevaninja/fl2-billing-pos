import { describe, expect, it } from 'vitest';
import { PgErrorCode, PosErrorCode } from '../src/db/errors.js';
import { expectSqlError, useSeededDb } from './support/db.js';
import { PRICE } from './support/fixtures.js';
import { addItem, getBill, one, openBill, pay, sell, settle, waiterBalance, waiterRepay } from './support/pos.js';

describe('Waiter payments', () => {
  const ctx = useSeededDb();

  describe('trusted waiter: collect-later & partial payments', () => {
    it('settles a bill part cash, part collect-later, and tracks the balance through partial repayments', async () => {
      const { db, fx } = ctx();

      // ₹2,400.00 bill: ₹1,500.00 cash now, ₹900.00 collect later.
      const bill = await sell(db, {
        waiterId: fx.waiter.trusted,
        lines: [[fx.sku.half, 2]],
        tenders: [
          ['CASH', 150_000],
          ['WAITER_CREDIT', 90_000],
        ],
      });
      expect(bill).toMatchObject({ status: 'SETTLED', total_paise: 240_000, waiter_trusted_at_billing: true });
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(90_000);

      // Repaid in two instalments.
      await waiterRepay(db, fx.waiter.trusted, 'CASH', 50_000, fx.cashier);
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(40_000);
      await waiterRepay(db, fx.waiter.trusted, 'UPI', 40_000, fx.cashier);
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(0);

      const { rows: ledger } = await db.query<{ entry_type: string; amount_paise: number; balance_after_paise: number }>(
        `SELECT entry_type, amount_paise, balance_after_paise FROM waiter_ledger_entries
          WHERE waiter_id = $1 ORDER BY created_at, id`,
        [fx.waiter.trusted],
      );
      expect(ledger).toEqual([
        { entry_type: 'BILL_CREDIT', amount_paise: 90_000, balance_after_paise: 90_000 },
        { entry_type: 'PAYMENT', amount_paise: -50_000, balance_after_paise: 40_000 },
        { entry_type: 'PAYMENT', amount_paise: -40_000, balance_after_paise: 0 },
      ]);
    });

    it('allows a bill to go entirely on collect-later credit', async () => {
      const { db, fx } = ctx();
      const bill = await sell(db, {
        waiterId: fx.waiter.trusted,
        lines: [[fx.sku.full, 1]],
        tenders: [['WAITER_CREDIT', PRICE.full]],
      });
      expect(bill.status).toBe('SETTLED');
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(PRICE.full);
    });

    it('accumulates credit across several bills on one running account', async () => {
      const { db, fx } = ctx();
      await sell(db, { waiterId: fx.waiter.trusted, lines: [[fx.sku.half, 1]], tenders: [['WAITER_CREDIT', PRICE.half]] });
      await sell(db, { waiterId: fx.waiter.trusted, lines: [[fx.sku.quarter, 1]], tenders: [['WAITER_CREDIT', PRICE.quarter]] });
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(PRICE.half + PRICE.quarter);
    });

    it('enforces the credit limit when one is set', async () => {
      const { db, fx } = ctx();
      // Limit ₹1,000.00; a ₹1,200.00 credit breaches it.
      const bill = await openBill(db, { waiterId: fx.waiter.limited });
      await addItem(db, bill.id, fx.sku.half, 1);
      await expectSqlError(pay(db, bill.id, 'WAITER_CREDIT', PRICE.half), PosErrorCode.CREDIT_NOT_ALLOWED, /credit limit/);
      // Within the limit is fine.
      await pay(db, bill.id, 'WAITER_CREDIT', 100_000);
      await pay(db, bill.id, 'CASH', 20_000);
      await settle(db, bill.id);
      expect(await waiterBalance(db, fx.waiter.limited)).toBe(100_000);
    });

    it('rejects a repayment larger than the outstanding balance', async () => {
      const { db, fx } = ctx();
      await sell(db, { waiterId: fx.waiter.trusted, lines: [[fx.sku.quarter, 1]], tenders: [['WAITER_CREDIT', PRICE.quarter]] });
      await expectSqlError(
        waiterRepay(db, fx.waiter.trusted, 'CASH', PRICE.quarter + 1, fx.cashier),
        PosErrorCode.WAITER_BALANCE,
        /cannot go negative/,
      );
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(PRICE.quarter);
    });

    it('reverses a mis-keyed repayment with an append-only negative record', async () => {
      const { db, fx } = ctx();
      await sell(db, { waiterId: fx.waiter.trusted, lines: [[fx.sku.full, 1]], tenders: [['WAITER_CREDIT', PRICE.full]] });
      const repayment = await waiterRepay(db, fx.waiter.trusted, 'CASH', 100_000, fx.cashier);
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(120_000);

      await expectSqlError(
        waiterRepay(db, fx.waiter.trusted, 'CASH', -99_999, fx.cashier, repayment.id),
        PosErrorCode.REVERSAL_RULE,
      );
      await waiterRepay(db, fx.waiter.trusted, 'CASH', -100_000, fx.cashier, repayment.id);
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(PRICE.full);
      await expectSqlError(
        waiterRepay(db, fx.waiter.trusted, 'CASH', -100_000, fx.cashier, repayment.id),
        PgErrorCode.UNIQUE_VIOLATION,
      );
    });
  });

  describe('untrusted waiter: strict bill-on-bill', () => {
    it('cannot put any part of a bill on collect-later credit', async () => {
      const { db, fx } = ctx();
      const bill = await openBill(db, { waiterId: fx.waiter.untrusted });
      await addItem(db, bill.id, fx.sku.half, 2);
      await expectSqlError(pay(db, bill.id, 'WAITER_CREDIT', 90_000), PosErrorCode.CREDIT_NOT_ALLOWED, /not trusted/);
      expect(await waiterBalance(db, fx.waiter.untrusted)).toBe(0);
      expect((await getBill(db, bill.id)).waiter_trusted_at_billing).toBe(false);
    });

    it('cannot close a bill until the exact amount is collected (split cash + UPI allowed)', async () => {
      const { db, fx } = ctx();
      const bill = await openBill(db, { waiterId: fx.waiter.untrusted });
      await addItem(db, bill.id, fx.sku.half, 2); // 240,000

      await pay(db, bill.id, 'CASH', 100_000);
      await expectSqlError(settle(db, bill.id), PosErrorCode.TENDER_MISMATCH, /tendered 100000 paise, total 240000 paise/);
      expect((await getBill(db, bill.id)).status).toBe('OPEN');

      await pay(db, bill.id, 'UPI', 140_000);
      expect((await settle(db, bill.id)).status).toBe('SETTLED');
    });
  });

  describe('trust changes', () => {
    it('blocks new credit after a downgrade but keeps (and lets the waiter clear) the existing balance', async () => {
      const { db, fx } = ctx();
      await sell(db, { waiterId: fx.waiter.trusted, lines: [[fx.sku.half, 1]], tenders: [['WAITER_CREDIT', PRICE.half]] });
      await db.query(`UPDATE waiters SET is_trusted = false WHERE id = $1`, [fx.waiter.trusted]);

      const bill = await openBill(db, { waiterId: fx.waiter.trusted });
      await addItem(db, bill.id, fx.sku.quarter, 1);
      expect((await getBill(db, bill.id)).waiter_trusted_at_billing).toBe(false);
      await expectSqlError(pay(db, bill.id, 'WAITER_CREDIT', PRICE.quarter), PosErrorCode.CREDIT_NOT_ALLOWED);

      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(PRICE.half);
      await waiterRepay(db, fx.waiter.trusted, 'CASH', PRICE.half, fx.cashier);
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(0);
    });
  });

  describe('tender guards', () => {
    it('rejects over-tendering a bill', async () => {
      const { db, fx } = ctx();
      const bill = await openBill(db, { waiterId: fx.waiter.trusted });
      await addItem(db, bill.id, fx.sku.half, 1);
      await pay(db, bill.id, 'CASH', 100_000);
      await expectSqlError(pay(db, bill.id, 'UPI', 20_001), PosErrorCode.TENDER_MISMATCH, /exceeds 20000 paise due/);
    });

    it('rejects collect-later credit on a counter bill with no waiter', async () => {
      const { db, fx } = ctx();
      const bill = await openBill(db);
      await addItem(db, bill.id, fx.sku.half, 1);
      await expectSqlError(pay(db, bill.id, 'WAITER_CREDIT', PRICE.half), PosErrorCode.CREDIT_NOT_ALLOWED, /requires a waiter/);
    });

    it('rejects tenders on a settled bill', async () => {
      const { db, fx } = ctx();
      const bill = await sell(db, { lines: [[fx.sku.half, 1]], tenders: [['CASH', PRICE.half]] });
      await expectSqlError(pay(db, bill.id, 'CASH', 1), PosErrorCode.APPEND_ONLY);
    });
  });

  describe('derived balance protection', () => {
    it('rejects writing outstanding_balance directly', async () => {
      const { db, fx } = ctx();
      await expectSqlError(
        db.query(`UPDATE waiters SET outstanding_balance = 500 WHERE id = $1`, [fx.waiter.trusted]),
        PosErrorCode.DERIVED_COLUMN,
      );
    });

    it('rejects hand-written BILL_CREDIT / PAYMENT ledger entries', async () => {
      const { db, fx } = ctx();
      await expectSqlError(
        db.query(
          `INSERT INTO waiter_ledger_entries (waiter_id, entry_type, amount_paise, balance_after_paise)
           VALUES ($1, 'PAYMENT', -100, 0)`,
          [fx.waiter.trusted],
        ),
        PosErrorCode.DERIVED_COLUMN,
      );
    });

    it('allows a manager write-off via MANUAL_ADJUSTMENT, which requires a reason', async () => {
      const { db, fx } = ctx();
      await sell(db, { waiterId: fx.waiter.trusted, lines: [[fx.sku.half, 1]], tenders: [['WAITER_CREDIT', PRICE.half]] });

      const insert = (reason: string | null) =>
        db.query(
          `INSERT INTO waiter_ledger_entries (waiter_id, entry_type, amount_paise, balance_after_paise, reason, created_by_staff_id)
           VALUES ($1, 'MANUAL_ADJUSTMENT', $2, 0, $3, $4)`,
          [fx.waiter.trusted, -PRICE.half, reason, fx.manager],
        );
      await expectSqlError(insert(null), PgErrorCode.CHECK_VIOLATION);
      await insert('bottle broken by guest, house absorbs');
      expect(await waiterBalance(db, fx.waiter.trusted)).toBe(0);

      const entry = await one<{ balance_after_paise: number }>(
        db,
        `SELECT balance_after_paise FROM waiter_ledger_entries WHERE entry_type = 'MANUAL_ADJUSTMENT'`,
      );
      expect(entry.balance_after_paise).toBe(0);
    });
  });
});
