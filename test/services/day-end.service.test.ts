import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NotFoundError, PosErrorCode } from '../../src/db/errors.js';
import { CaptainService, DayEndService, type KotPrinter } from '../../src/services/index.js';
import { expectSqlError, useSeededDb } from '../support/db.js';
import { one } from '../support/pos.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

const silentPrinter: KotPrinter = { printKOT: async (t) => ({ station: t.station, printedAt: new Date(), text: '' }) };
const MISSING = '00000000-0000-0000-0000-000000000000';

describe('DayEndService', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, dayEnd: new DayEndService(db), captain: new CaptainService(db, silentPrinter), ...makeServices(db) };
  };

  describe('closeBusinessDay blockers', () => {
    it('refuses while a counter bill is OPEN, lists it, and closes once it is settled', async () => {
      const { fx, dayEnd, billing } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.half, 1);

      const summary = await dayEnd.getDayEndSummary(fx.dayId);
      expect(summary.canClose).toBe(false);
      expect(summary.blockers.openBills).toEqual([
        expect.objectContaining({ billId: bill.id, billNo: bill.billNo, source: 'COUNTER', status: 'OPEN', duePaise: PAISE.half, waiter: null }),
      ]);
      await expectPosError(dayEnd.closeBusinessDay(fx.dayId, PAISE.half, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /bill\(s\) still open/);

      await billing.settleNormalBill(bill.id, [{ mode: 'CASH', amount: PAISE.half }]);
      expect((await dayEnd.getDayEndSummary(fx.dayId)).canClose).toBe(true);
      const closed = await dayEnd.closeBusinessDay(fx.dayId, PAISE.half, fx.cashier);
      expect(closed.day).toMatchObject({ status: 'CLOSED', countedCashPaise: PAISE.half, expectedCashPaise: PAISE.half, cashVariancePaise: 0n });
    });

    it('refuses while a Captain order is OPEN', async () => {
      const { fx, dayEnd, captain, waiters } = setup();
      const order = await captain.placeOrder({
        requestId: randomUUID(),
        deviceId: 'handset-01',
        waiterId: fx.waiter.untrusted,
        items: [{ skuId: fx.sku.quarter, quantity: 1 }],
      });
      const { blockers } = await dayEnd.getDayEndSummary(fx.dayId);
      expect(blockers.openBills).toEqual([
        expect.objectContaining({ billId: order.bill.id, source: 'WAITER_APP', waiter: expect.objectContaining({ code: 'W02' }) }),
      ]);
      await expectPosError(dayEnd.closeBusinessDay(fx.dayId, 0n, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE);

      await waiters.settleWaiterBill(order.bill.id, fx.waiter.untrusted, 'CASH');
      await expect(dayEnd.closeBusinessDay(fx.dayId, PAISE.quarter, fx.cashier)).resolves.toMatchObject({ day: { status: 'CLOSED' } });
    });

    it('refuses while a peak session runs (its bills are PEAK_UNSETTLED)', async () => {
      const { fx, dayEnd, peak, billing } = setup();
      const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
      await billing.recordPeakSale(session.id, fx.sku.beer650, 1, fx.cashier);

      const { blockers } = await dayEnd.getDayEndSummary(fx.dayId);
      expect(blockers.runningPeakSession).toMatchObject({ id: session.id, sessionNo: 1, runningExpectedPaise: PAISE.beer650 });
      expect(blockers.openBills).toEqual([expect.objectContaining({ status: 'PEAK_UNSETTLED' })]);
      await expectPosError(dayEnd.closeBusinessDay(fx.dayId, 0n, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /peak session/);

      await peak.endPeakSession(session.id, PAISE.beer650, 0n, fx.cashier);
      await expect(dayEnd.closeBusinessDay(fx.dayId, PAISE.beer650, fx.cashier)).resolves.toMatchObject({ day: { status: 'CLOSED' } });
    });

    it('refuses while any waiter owes money, inactive waiters included, until it is repaid', async () => {
      const { db, fx, dayEnd, billing, waiters } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.quarter, 1);
      await waiters.tagBillToWaiter(bill.id, fx.waiter.trusted);
      await waiters.settleWaiterBill(bill.id, fx.waiter.trusted, 'WAITER_CREDIT');
      await db.query(`UPDATE waiters SET is_active = false WHERE id = $1`, [fx.waiter.trusted]);

      const summary = await dayEnd.getDayEndSummary(fx.dayId);
      expect(summary.blockers.openBills).toEqual([]);
      expect(summary.blockers.waitersOwing).toEqual([
        expect.objectContaining({ id: fx.waiter.trusted, code: 'W01', outstandingPaise: PAISE.quarter, isActive: false }),
      ]);
      expect(summary.canClose).toBe(false);
      await expectPosError(dayEnd.closeBusinessDay(fx.dayId, 0n, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /waiter\(s\) still owe/);

      await waiters.recordWaiterRepayment(fx.waiter.trusted, PAISE.quarter - 1n, 'CASH', fx.cashier);
      await expectPosError(dayEnd.closeBusinessDay(fx.dayId, 0n, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE);
      await waiters.recordWaiterRepayment(fx.waiter.trusted, 1n, 'UPI', fx.cashier);
      await expect(dayEnd.closeBusinessDay(fx.dayId, PAISE.quarter - 1n, fx.cashier)).resolves.toMatchObject({
        day: { status: 'CLOSED', cashVariancePaise: 0n },
      });
    });

    it('enforces the blockers in the database, so a raw UPDATE cannot skip them', async () => {
      const { db, fx, billing, waiters } = setup();
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, fx.sku.quarter, 1);
      await waiters.tagBillToWaiter(bill.id, fx.waiter.trusted);
      await waiters.settleWaiterBill(bill.id, fx.waiter.trusted, 'WAITER_CREDIT');
      await expectSqlError(
        db.query(`UPDATE business_days SET status = 'CLOSED', closed_by_staff_id = $2, counted_cash_paise = 0 WHERE id = $1`, [fx.dayId, fx.manager]),
        PosErrorCode.DAY_OR_PEAK_RULE,
        /waiter\(s\) still owe/,
      );
      expect((await one<{ status: string }>(db, `SELECT status FROM business_days WHERE id = $1`, [fx.dayId])).status).toBe('OPEN');
    });
  });

  describe('expected cash and variance', () => {
    it('adds float, cash outside peak windows, counted peak cash and waiter cash, minus expenses', async () => {
      const { db, fx, dayEnd, billing, peak, waiters } = setup();

      // Outside any peak window.
      const a = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(a.id, fx.sku.full, 1);
      await billing.settleNormalBill(a.id, [{ mode: 'CASH', amount: PAISE.full }]); // +2,200 cash
      const b = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(b.id, fx.sku.half, 1);
      await billing.settleNormalBill(b.id, [
        { mode: 'CASH', amount: 500_00n },
        { mode: 'UPI', amount: PAISE.half - 500_00n },
      ]);
      await billing.reverseBill(b.id, 'wrong brand', fx.manager); // refunds −500 cash, −700 UPI
      const c = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(c.id, fx.sku.quarter, 1);
      await waiters.tagBillToWaiter(c.id, fx.waiter.trusted);
      await waiters.settleWaiterBill(c.id, fx.waiter.trusted, 'WAITER_CREDIT'); // credit, no cash
      await waiters.recordWaiterRepayment(fx.waiter.trusted, 200_00n, 'CASH', fx.cashier); // +200 cash
      await waiters.recordWaiterRepayment(fx.waiter.trusted, 100_00n, 'UPI', fx.cashier); // UPI only
      await dayEnd.recordCashExpense(150_00n, 'Ice', fx.cashier); // −150 cash
      const tea = await dayEnd.recordCashExpense(40_00n, 'Tea', fx.cashier);
      await db.query(
        `INSERT INTO cash_expenses (amount_paise, reverses_expense_id, description, created_by_staff_id) VALUES (-4000, $1, 'Tea entered twice', $2)`,
        [tea.id, fx.cashier],
      );

      // Opened before the peak, paid in cash during it.
      const d = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(d.id, fx.sku.beer330, 1);

      // Inside a peak window: only the counted drawer delta counts.
      const session = await peak.startPeakSession(fx.dayId, 1000_00n, 0n, fx.cashier);
      await billing.settleNormalBill(d.id, [{ mode: 'CASH', amount: PAISE.beer330 }]);
      await billing.recordPeakSale(session.id, fx.sku.beer650, 2, fx.cashier); // ₹500, taken as 300 cash + 200 UPI
      await waiters.recordWaiterRepayment(fx.waiter.trusted, 300_00n, 'CASH', fx.cashier);
      const iceDuringPeak = await dayEnd.recordCashExpense(50_00n, 'Ice (rush)', fx.cashier);
      expect(iceDuringPeak.peakSessionId).toBe(session.id);
      // Drawer: 1,000 + 150 bill D + 300 peak cash + 300 waiter cash − 50 expense = 1,700; UPI 200.
      const ended = await peak.endPeakSession(session.id, 1700_00n, 200_00n, fx.cashier);
      expect(ended.breakdown).toMatchObject({ billCashPaise: PAISE.beer330, cashExpensesPaise: 50_00n, expectedPaise: 900_00n, variancePaise: 0n });

      const summary = await dayEnd.getDayEndSummary(fx.dayId);
      expect(summary.blockers).toEqual({ openBills: [], runningPeakSession: null, waitersOwing: [] });
      expect(summary.breakdown).toEqual({
        openingFloatPaise: 0n,
        normalCashPaise: PAISE.full, // 2,200 + 500 − 500; bill D's cash was taken inside the peak
        peakCashPaise: 700_00n,
        waiterCashPaise: 200_00n,
        cashExpensesPaise: 150_00n, // 150 + 40 − 40; the in-peak 50 is inside the counted delta
        tenderAdjustmentPaise: 0n,
        bankDepositsPaise: 0n,
        expectedCashPaise: PAISE.full + 700_00n + 200_00n - 150_00n,
        upiTotalPaise: 100_00n + 200_00n, // 700 − 700 + waiter 100 + peak delta 200
      });
      expect(summary.peakSessions).toEqual([
        expect.objectContaining({ sessionNo: 1, cashDeltaPaise: 700_00n, upiDeltaPaise: 200_00n, variancePaise: 0n }),
      ]);

      const expected = summary.breakdown.expectedCashPaise;
      const closed = await dayEnd.closeBusinessDay(fx.dayId, expected - 5_00n, fx.cashier);
      expect(closed.day).toMatchObject({
        status: 'CLOSED',
        countedCashPaise: expected - 5_00n,
        expectedCashPaise: expected,
        cashVariancePaise: -5_00n,
        closedAt: expect.any(Date),
      });
      expect(closed.breakdown).toEqual(summary.breakdown);
    });

    it('computes expected cash itself: client-supplied expected and variance are overwritten', async () => {
      const { db, fx } = setup();
      const row = await one<{ expected_cash_paise: string; cash_variance_paise: string }>(
        db,
        `UPDATE business_days
            SET status = 'CLOSED', closed_by_staff_id = $2, counted_cash_paise = 1000, expected_cash_paise = 1000, cash_variance_paise = 0
          WHERE id = $1
        RETURNING expected_cash_paise::text, cash_variance_paise::text`,
        [fx.dayId, fx.manager],
      );
      expect(row).toEqual({ expected_cash_paise: '0', cash_variance_paise: '1000' });
    });

    it('requires a counted cash figure, and keeps the close columns empty while the day is open', async () => {
      const { db, fx, dayEnd } = setup();
      await expectSqlError(
        db.query(`UPDATE business_days SET status = 'CLOSED', closed_by_staff_id = $2 WHERE id = $1`, [fx.dayId, fx.manager]),
        PosErrorCode.ILLEGAL_TRANSITION,
        /counted cash/,
      );
      await expectSqlError(
        db.query(`UPDATE business_days SET counted_cash_paise = 5 WHERE id = $1`, [fx.dayId]),
        PosErrorCode.ILLEGAL_TRANSITION,
      );
      await expect(dayEnd.closeBusinessDay(fx.dayId, -1n, fx.cashier)).rejects.toBeInstanceOf(RangeError);
      await expect(dayEnd.closeBusinessDay(MISSING, 0n, fx.cashier)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('a closed day is locked', () => {
    it('rejects edits to the day and every new posting', async () => {
      const { db, fx, dayEnd, billing, peak, waiters } = setup();
      await dayEnd.closeBusinessDay(fx.dayId, 0n, fx.cashier);

      await expectSqlError(db.query(`UPDATE business_days SET counted_cash_paise = 1 WHERE id = $1`, [fx.dayId]), PosErrorCode.APPEND_ONLY);
      await expectPosError(dayEnd.closeBusinessDay(fx.dayId, 0n, fx.cashier), PosErrorCode.APPEND_ONLY);
      await expectPosError(billing.createBill('NORMAL', fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE);
      await expectPosError(peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE);
      await expectPosError(waiters.recordWaiterRepayment(fx.waiter.trusted, 1n, 'CASH', fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE);
      await expectPosError(dayEnd.recordCashExpense(1n, 'Ice', fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE);
    });
  });

  describe('openBusinessDay', () => {
    it('opens the next day with its float, which then seeds expected cash', async () => {
      const { fx, dayEnd, billing } = setup();
      await expectPosError(dayEnd.openBusinessDay(2000_00n, fx.cashier, '2026-10-15'), PosErrorCode.DAY_OR_PEAK_RULE, /already open/);

      await dayEnd.closeBusinessDay(fx.dayId, 0n, fx.cashier);
      const day = await dayEnd.openBusinessDay(2000_00n, fx.cashier, '2026-10-15');
      expect(day).toMatchObject({ businessDate: '2026-10-15', status: 'OPEN', openingFloatPaise: 2000_00n, closedAt: null });

      const bill = await billing.createBill('NORMAL', fx.cashier);
      expect(bill).toMatchObject({ businessDayId: day.id, billNo: 1 });
      await billing.addItemToBill(bill.id, fx.sku.quarter, 1);
      await billing.settleNormalBill(bill.id, [{ mode: 'CASH', amount: PAISE.quarter }]);
      expect((await dayEnd.getDayEndSummary(day.id)).breakdown.expectedCashPaise).toBe(2000_00n + PAISE.quarter);
    });

    it('refuses a business date that already traded, a negative float, and editing the float later', async () => {
      const { db, fx, dayEnd } = setup();
      await dayEnd.closeBusinessDay(fx.dayId, 0n, fx.cashier);
      await expectPosError(dayEnd.openBusinessDay(0n, fx.cashier, '2026-10-14'), PosErrorCode.DAY_OR_PEAK_RULE, /already traded/);
      await expect(dayEnd.openBusinessDay(-1n, fx.cashier, '2026-10-15')).rejects.toBeInstanceOf(RangeError);

      const day = await dayEnd.openBusinessDay(0n, fx.cashier, '2026-10-15');
      await expectSqlError(db.query(`UPDATE business_days SET opening_float_paise = 100 WHERE id = $1`, [day.id]), PosErrorCode.APPEND_ONLY);
    });

    it('reports the most recent day: the open one, else the last closed one', async () => {
      const { fx, dayEnd } = setup();
      expect((await dayEnd.getCurrentDayId())).toBe(fx.dayId);
      await dayEnd.closeBusinessDay(fx.dayId, 0n, fx.cashier);
      expect((await dayEnd.getCurrentDayId())).toBe(fx.dayId);
      const next = await dayEnd.openBusinessDay(0n, fx.cashier, '2026-10-15');
      expect((await dayEnd.getCurrentDayId())).toBe(next.id);
    });
  });

  describe('recordCashExpense', () => {
    it('records an expense on the open day and refuses blank descriptions or non-positive amounts', async () => {
      const { fx, dayEnd } = setup();
      const expense = await dayEnd.recordCashExpense(120_00n, '  Ice  ', fx.cashier);
      expect(expense).toMatchObject({ businessDayId: fx.dayId, peakSessionId: null, amountPaise: 120_00n, description: 'Ice' });
      await expect(dayEnd.recordCashExpense(10n, '   ', fx.cashier)).rejects.toBeInstanceOf(RangeError);
      await expect(dayEnd.recordCashExpense(0n, 'Ice', fx.cashier)).rejects.toBeInstanceOf(RangeError);
    });
  });
});
