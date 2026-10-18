import { describe, expect, it } from 'vitest';
import { NotFoundError, PosErrorCode } from '../../src/db/errors.js';
import { DayEndService } from '../../src/services/index.js';
import { expectSqlError, useSeededDb } from '../support/db.js';
import { expectPosError, makeServices } from '../support/services.js';

const MISSING = '00000000-0000-0000-0000-000000000000';

describe('cash expenses: categories, list and void', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, dayEnd: new DayEndService(db), ...makeServices(db) };
  };

  describe('recordCashExpense with a category', () => {
    it('files the expense under its category; the note is optional unless the category requires one', async () => {
      const { fx, dayEnd } = setup();
      expect(await dayEnd.recordCashExpense(150_00n, 'Bags for the bar', fx.cashier, fx.expenseCategory.ICE)).toMatchObject({
        category: { id: fx.expenseCategory.ICE, name: 'Ice' },
        description: 'Bags for the bar',
      });
      expect(await dayEnd.recordCashExpense(80_00n, null, fx.cashier, fx.expenseCategory.TRANSPORT)).toMatchObject({ category: { name: 'Transport' }, description: null });
      expect(await dayEnd.recordCashExpense(80_00n, '   ', fx.cashier, fx.expenseCategory.CLEANING)).toMatchObject({ description: null });
      expect(await dayEnd.recordCashExpense(500_00n, null, fx.cashier, fx.expenseCategory.BATA)).toMatchObject({ category: { name: 'Bata / Daily Wages' } });
      expect(await dayEnd.recordCashExpense(40_00n, 'Tea', fx.cashier, fx.expenseCategory.OTHER)).toMatchObject({ category: { name: 'Other' }, description: 'Tea' });

      await expectPosError(dayEnd.recordCashExpense(40_00n, null, fx.cashier, fx.expenseCategory.OTHER), PosErrorCode.ILLEGAL_TRANSITION, /Other expense needs a note/);
      await expect(dayEnd.recordCashExpense(40_00n, 'x', fx.cashier, MISSING)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('enforces managed categories in the database: no legacy codes on new rows, no bare rows', async () => {
      const { db, fx } = setup();
      await expectSqlError(
        db.query(`INSERT INTO cash_expenses (amount_paise, category, description, created_by_staff_id) VALUES (100, 'ICE', 'x', $1)`, [fx.cashier]),
        'PS002',
      );
      await expectSqlError(db.query(`INSERT INTO cash_expenses (amount_paise, description, created_by_staff_id) VALUES (100, 'x', $1)`, [fx.cashier]), 'PS002');
      await expectSqlError(
        db.query(`INSERT INTO cash_expenses (amount_paise, category, category_id, created_by_staff_id) VALUES (100, 'ICE', $2, $1)`, [fx.cashier, fx.expenseCategory.ICE]),
        'PS002',
      );
    });
  });

  describe('listCashExpenses', () => {
    it("lists the day's expenses newest first, flags voided ones and peak ones, and hides the void rows", async () => {
      const { fx, dayEnd, peak } = setup();
      const ice = await dayEnd.recordCashExpense(150_00n, null, fx.cashier, fx.expenseCategory.ICE);
      const tea = await dayEnd.recordCashExpense(40_00n, 'Tea', fx.cashier, fx.expenseCategory.OTHER);
      await dayEnd.voidCashExpense(tea.id, fx.cashier);
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      const rush = await dayEnd.recordCashExpense(60_00n, 'Staff lunch', fx.cashier, fx.expenseCategory.STAFF_FOOD);

      const list = await dayEnd.listCashExpenses(fx.dayId);
      expect(list.map((e) => e.id)).toEqual([rush.id, tea.id, ice.id]);
      expect(list[0]).toMatchObject({ peakSessionId: session.id, voidedAt: null });
      expect(list[1]).toMatchObject({ amountPaise: 40_00n, voidedAt: expect.any(Date) });
      expect(list[2]).toMatchObject({ category: { name: 'Ice' }, voidedAt: null, peakSessionId: null });
    });
  });

  describe('voidCashExpense', () => {
    it('appends a negating row with the same category, which restores expected cash', async () => {
      const { db, fx, dayEnd } = setup();
      const before = (await dayEnd.getDayEndSummary(fx.dayId)).breakdown.expectedCashPaise;
      const ice = await dayEnd.recordCashExpense(150_00n, 'Bags', fx.cashier, fx.expenseCategory.ICE);
      expect((await dayEnd.getDayEndSummary(fx.dayId)).breakdown.expectedCashPaise).toBe(before - 150_00n);

      const voided = await dayEnd.voidCashExpense(ice.id, fx.cashier);
      expect(voided).toMatchObject({ amountPaise: -150_00n, reversesExpenseId: ice.id, category: { id: fx.expenseCategory.ICE }, businessDayId: fx.dayId });
      expect((await dayEnd.getDayEndSummary(fx.dayId)).breakdown.expectedCashPaise).toBe(before);
      const { rows } = await db.query(`SELECT 1 FROM cash_expenses WHERE id = $1`, [ice.id]);
      expect(rows).toHaveLength(1); // the original stays
    });

    it('refuses a double void, voiding a void, and unknown expenses', async () => {
      const { fx, dayEnd } = setup();
      const ice = await dayEnd.recordCashExpense(150_00n, null, fx.cashier, fx.expenseCategory.ICE);
      const voided = await dayEnd.voidCashExpense(ice.id, fx.cashier);
      await expectPosError(dayEnd.voidCashExpense(ice.id, fx.cashier), PosErrorCode.REVERSAL_RULE);
      await expectPosError(dayEnd.voidCashExpense(voided.id, fx.cashier), PosErrorCode.REVERSAL_RULE);
      await expect(dayEnd.voidCashExpense(MISSING, fx.cashier)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses to void an expense from a day that is already closed (its cash was counted)", async () => {
      const { fx, dayEnd } = setup();
      const ice = await dayEnd.recordCashExpense(150_00n, null, fx.cashier, fx.expenseCategory.ICE);
      await dayEnd.closeBusinessDay(fx.dayId, 0n, fx.cashier);
      await dayEnd.openBusinessDay(0n, fx.cashier, '2026-10-15');
      await expectPosError(dayEnd.voidCashExpense(ice.id, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /closed day/);
    });
  });
});
