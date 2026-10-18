import { describe, expect, it } from 'vitest';
import { NotFoundError, PgErrorCode, PosErrorCode } from '../../src/db/errors.js';
import { DayEndService } from '../../src/services/index.js';
import { expectSqlError, useSeededDb } from '../support/db.js';
import { one } from '../support/pos.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

/** Phase 13: the Day End tally tool — Cash ⇄ UPI reclassification with revenue locked. */
describe('tender adjustments', () => {
  const ctx = useSeededDb();
  const setup = async () => {
    const { db, fx } = ctx();
    const services = { db, fx, dayEnd: new DayEndService(db), ...makeServices(db) };
    // ₹2,200 cash (Full) and ₹1,200 UPI (Half) on normal bills.
    const cash = await services.billing.createBill('NORMAL', fx.cashier);
    await services.billing.addItemToBill(cash.id, fx.sku.full, 1);
    await services.billing.settleNormalBill(cash.id, [{ mode: 'CASH', amount: PAISE.full }]);
    const upi = await services.billing.createBill('NORMAL', fx.cashier);
    await services.billing.addItemToBill(upi.id, fx.sku.half, 1);
    await services.billing.settleNormalBill(upi.id, [{ mode: 'UPI', amount: PAISE.half }]);
    return services;
  };

  it('moves revenue between Cash and UPI with the total locked, and expected cash follows', async () => {
    const { fx, dayEnd } = await setup();
    const before = await dayEnd.getDayEndSummary(fx.dayId);

    const adj = await dayEnd.adjustTenderSplit(fx.dayId, 500_00n, '  Bill keyed as UPI, paid in cash  ', fx.cashier);
    expect(adj).toMatchObject({
      businessDayId: fx.dayId,
      cashDeltaPaise: 500_00n,
      upiDeltaPaise: -500_00n,
      systemCashPaise: PAISE.full,
      systemUpiPaise: PAISE.half,
      reason: 'Bill keyed as UPI, paid in cash',
      reversesAdjustmentId: null,
      createdByStaffId: fx.cashier,
    });

    const after = await dayEnd.getDayEndSummary(fx.dayId);
    expect(after.sales.normal).toEqual({
      cashPaise: PAISE.full + 500_00n,
      upiPaise: PAISE.half - 500_00n,
      creditPaise: 0n,
      totalPaise: PAISE.full + PAISE.half,
      systemCashPaise: PAISE.full,
      systemUpiPaise: PAISE.half,
    });
    expect(after.sales.total.salesPaise).toBe(before.sales.total.salesPaise);
    expect(after.breakdown.tenderAdjustmentPaise).toBe(500_00n);
    expect(after.breakdown.expectedCashPaise).toBe(before.breakdown.expectedCashPaise + 500_00n);
    expect(after.breakdown.upiTotalPaise).toBe(before.breakdown.upiTotalPaise - 500_00n);
    expect(after.tenderAdjustments).toEqual([expect.objectContaining({ id: adj.id, voidedAt: null })]);
  });

  it('keeps total sales identical through any sequence of adjustments and voids', async () => {
    const { fx, dayEnd } = await setup();
    const base = await dayEnd.getDayEndSummary(fx.dayId);
    const ids: string[] = [];
    for (const delta of [300_00n, -1000_00n, 250_50n, -75_25n]) {
      ids.push((await dayEnd.adjustTenderSplit(fx.dayId, delta, 'tally', fx.cashier)).id);
      const s = await dayEnd.getDayEndSummary(fx.dayId);
      expect(s.sales.total.salesPaise).toBe(base.sales.total.salesPaise);
      expect(s.sales.normal.totalPaise).toBe(base.sales.normal.totalPaise);
      expect(s.sales.normal.cashPaise + s.sales.normal.upiPaise).toBe(base.sales.normal.cashPaise + base.sales.normal.upiPaise);
    }
    await dayEnd.voidTenderAdjustment(ids[1] as string, fx.cashier);
    const s = await dayEnd.getDayEndSummary(fx.dayId);
    expect(s.breakdown.tenderAdjustmentPaise).toBe(300_00n + 250_50n - 75_25n);
    expect(s.sales.total.salesPaise).toBe(base.sales.total.salesPaise);
  });

  it('enforces Δcash + ΔUPI = 0 and takes the system figures itself', async () => {
    const { db, fx } = await setup();
    await expectSqlError(
      db.query(
        `INSERT INTO tender_adjustments (business_day_id, cash_delta_paise, upi_delta_paise, system_cash_paise, system_upi_paise, reason, created_by_staff_id)
         VALUES ($1, 10000, -9000, 0, 0, 'x', $2)`,
        [fx.dayId, fx.cashier],
      ),
      PgErrorCode.CHECK_VIOLATION,
      /revenue_locked/,
    );
    const row = await one<{ system_cash_paise: string; system_upi_paise: string }>(
      db,
      `INSERT INTO tender_adjustments (business_day_id, cash_delta_paise, upi_delta_paise, system_cash_paise, system_upi_paise, reason, created_by_staff_id)
       VALUES ($1, 100, -100, 999999, 999999, 'x', $2) RETURNING system_cash_paise::text, system_upi_paise::text`,
      [fx.dayId, fx.cashier],
    );
    expect(row).toEqual({ system_cash_paise: String(PAISE.full), system_upi_paise: String(PAISE.half) });
  });

  it('refuses to take adjusted cash or UPI below ₹0, counting earlier adjustments', async () => {
    const { fx, dayEnd } = await setup();
    await expectPosError(dayEnd.adjustTenderSplit(fx.dayId, PAISE.half + 1n, 'too much', fx.cashier), PosErrorCode.ILLEGAL_TRANSITION, /out of UPI/);
    await expectPosError(dayEnd.adjustTenderSplit(fx.dayId, -(PAISE.full + 1n), 'too much', fx.cashier), PosErrorCode.ILLEGAL_TRANSITION, /out of cash/);
    await dayEnd.adjustTenderSplit(fx.dayId, PAISE.half, 'all UPI was cash', fx.cashier);
    await expectPosError(dayEnd.adjustTenderSplit(fx.dayId, 1n, 'one more paisa', fx.cashier), PosErrorCode.ILLEGAL_TRANSITION, /out of UPI/);
  });

  it('validates the input before touching the database', async () => {
    const { fx, dayEnd } = await setup();
    await expect(dayEnd.adjustTenderSplit(fx.dayId, 0n, 'zero', fx.cashier)).rejects.toBeInstanceOf(RangeError);
    await expect(dayEnd.adjustTenderSplit(fx.dayId, 100n, '   ', fx.cashier)).rejects.toBeInstanceOf(RangeError);
    await expect(dayEnd.adjustTenderSplit(fx.dayId, 100n, 'x'.repeat(201), fx.cashier)).rejects.toBeInstanceOf(RangeError);
  });

  it('voids by a negating row, once, and never a void', async () => {
    const { fx, dayEnd } = await setup();
    const adj = await dayEnd.adjustTenderSplit(fx.dayId, -400_00n, 'paid by GPay', fx.cashier);
    const v = await dayEnd.voidTenderAdjustment(adj.id, fx.cashier);
    expect(v).toMatchObject({ cashDeltaPaise: 400_00n, upiDeltaPaise: -400_00n, reversesAdjustmentId: adj.id, reason: 'paid by GPay' });

    const s = await dayEnd.getDayEndSummary(fx.dayId);
    expect(s.breakdown.tenderAdjustmentPaise).toBe(0n);
    expect(s.tenderAdjustments).toEqual([expect.objectContaining({ id: adj.id, voidedAt: expect.any(Date) })]);

    await expectPosError(dayEnd.voidTenderAdjustment(adj.id, fx.cashier), PosErrorCode.REVERSAL_RULE);
    await expectPosError(dayEnd.voidTenderAdjustment(v.id, fx.cashier), PosErrorCode.REVERSAL_RULE, /cannot itself be voided/);
    await expect(dayEnd.voidTenderAdjustment('00000000-0000-0000-0000-000000000000', fx.cashier)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('is append-only', async () => {
    const { db, fx, dayEnd } = await setup();
    const adj = await dayEnd.adjustTenderSplit(fx.dayId, 100_00n, 'x', fx.cashier);
    await expectSqlError(db.query(`UPDATE tender_adjustments SET reason = 'y' WHERE id = $1`, [adj.id]), PosErrorCode.APPEND_ONLY);
    await expectSqlError(db.query(`DELETE FROM tender_adjustments WHERE id = $1`, [adj.id]), PosErrorCode.APPEND_ONLY);
  });

  it('freezes the adjusted expected cash at close, and refuses adjustments on a closed day', async () => {
    const { fx, dayEnd } = await setup();
    await dayEnd.adjustTenderSplit(fx.dayId, 500_00n, 'keyed as UPI', fx.cashier);
    const counted = PAISE.full + 500_00n - 10_00n;
    const closed = await dayEnd.closeBusinessDay(fx.dayId, counted, fx.cashier);
    expect(closed.day).toMatchObject({ expectedCashPaise: PAISE.full + 500_00n, cashVariancePaise: -10_00n });
    expect(closed.breakdown.tenderAdjustmentPaise).toBe(500_00n);
    await expectPosError(dayEnd.adjustTenderSplit(fx.dayId, 100n, 'late', fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE);
  });

  it('exposes the running peak sales and in-window UPI for the end dialog', async () => {
    const { db, fx, billing, peak, waiters } = await setup();
    const open = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(open.id, fx.sku.quarter, 1);
    const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    await billing.recordPeakSale(session.id, fx.sku.beer650, 2, fx.cashier);
    await billing.settleNormalBill(open.id, [{ mode: 'UPI', amount: PAISE.quarter }]);
    const credit = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(credit.id, fx.sku.beer330, 1);
    await waiters.tagBillToWaiter(credit.id, fx.waiter.trusted);
    await waiters.settleWaiterBill(credit.id, fx.waiter.trusted, 'WAITER_CREDIT');
    await waiters.recordWaiterRepayment(fx.waiter.trusted, 100_00n, 'UPI', fx.cashier);

    const view = () =>
      one<{ s: string | null; u: string | null }>(db, `SELECT running_sales_paise::text s, running_in_window_upi_paise::text u FROM v_peak_sessions WHERE id = $1`, [session.id]);
    expect(await view()).toEqual({ s: String(2n * PAISE.beer650), u: String(PAISE.quarter + 100_00n) });

    await peak.endPeakSession(session.id, 2n * PAISE.beer650, PAISE.quarter + 100_00n, fx.cashier);
    expect(await view()).toEqual({ s: null, u: null });
  });
});
