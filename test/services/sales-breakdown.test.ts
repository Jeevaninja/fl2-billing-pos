import { describe, expect, it } from 'vitest';
import { DayEndService } from '../../src/services/index.js';
import { useSeededDb } from '../support/db.js';
import { one } from '../support/pos.js';
import { makeServices, PAISE } from '../support/services.js';

/** Phase 11: the peak start baseline and the Day End sales breakdown. */
describe('peak start baseline and sales breakdown', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, dayEnd: new DayEndService(db), ...makeServices(db) };
  };

  it('derives peak cash / UPI that balance against sales, the drawer and the UPI readings', async () => {
    const { db, fx, dayEnd, billing, peak, waiters } = setup();

    // ── Before any peak ──
    const a = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(a.id, fx.sku.full, 1);
    await billing.settleNormalBill(a.id, [{ mode: 'CASH', amount: PAISE.full }]); // 2,200 cash
    const b = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(b.id, fx.sku.half, 1);
    await billing.settleNormalBill(b.id, [{ mode: 'UPI', amount: PAISE.half }]); // 1,200 UPI
    const c = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(c.id, fx.sku.quarter, 1);
    await waiters.tagBillToWaiter(c.id, fx.waiter.trusted);
    await waiters.settleWaiterBill(c.id, fx.waiter.trusted, 'WAITER_CREDIT'); // 600 credit
    await waiters.recordWaiterRepayment(fx.waiter.trusted, 200_00n, 'CASH', fx.cashier);
    await waiters.recordWaiterRepayment(fx.waiter.trusted, 100_00n, 'UPI', fx.cashier);
    await dayEnd.recordCashExpense(150_00n, 'Ice', fx.cashier);
    const d = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(d.id, fx.sku.beer330, 1); // paid by UPI during peak 1

    const first = await peak.getStartBaseline(fx.dayId);
    expect(first).toEqual({
      businessDayId: fx.dayId,
      openingFloatPaise: 0n,
      normalCashPaise: 2200_00n,
      waiterCashPaise: 200_00n,
      peakCashPaise: 0n,
      cashExpensesPaise: 150_00n,
      tenderAdjustmentPaise: 0n,
      bankDepositsPaise: 0n,
      expectedCashPaise: 2250_00n,
      billUpiPaise: 1200_00n,
      waiterUpiPaise: 100_00n,
      peakUpiPaise: 0n,
      expectedUpiPaise: 1300_00n,
    });

    // ── Peak 1: started on the baseline; ₹20 short at the end ──
    const p1 = await peak.startPeakSession(fx.dayId, first.expectedCashPaise, first.expectedUpiPaise, fx.cashier);
    await billing.settleNormalBill(d.id, [{ mode: 'UPI', amount: PAISE.beer330 }]); // in-window UPI on a normal bill
    await billing.recordPeakSale(p1.id, fx.sku.beer650, 1, fx.cashier);
    const undone = await billing.recordPeakSale(p1.id, fx.sku.beer650, 1, fx.cashier);
    await billing.recordPeakSale(p1.id, fx.sku.full, 1, fx.cashier);
    await billing.reverseBill(undone.bill.id, 'double scan', fx.manager); // in-session reversal: −250
    await waiters.recordWaiterRepayment(fx.waiter.trusted, 100_00n, 'CASH', fx.cashier);
    await dayEnd.recordCashExpense(50_00n, 'Ice (rush)', fx.cashier);
    // Peak sales 2,450: customers paid 800 by UPI and 1,650 in cash; the drawer is ₹20 short.
    const end1Cash = 2250_00n + 1650_00n + 100_00n - 50_00n - 20_00n;
    const end1Upi = 1300_00n + 150_00n + 800_00n;
    const r1 = await peak.endPeakSession(p1.id, end1Cash, end1Upi, fx.cashier);
    expect(r1.breakdown.variancePaise).toBe(-20_00n);

    // The second baseline matches what was actually counted / read at the end of peak 1.
    const second = await peak.getStartBaseline(fx.dayId);
    expect(second).toMatchObject({ peakCashPaise: 1680_00n, peakUpiPaise: 800_00n, billUpiPaise: 1350_00n, waiterCashPaise: 200_00n });
    expect(second.expectedCashPaise).toBe(end1Cash);
    expect(second.expectedUpiPaise).toBe(end1Upi);

    // ── Peak 2: one quarter, paid by UPI, exact ──
    const p2 = await peak.startPeakSession(fx.dayId, end1Cash, end1Upi, fx.cashier);
    await billing.recordPeakSale(p2.id, fx.sku.quarter, 1, fx.cashier);
    await peak.endPeakSession(p2.id, end1Cash, end1Upi + PAISE.quarter, fx.cashier);

    const summary = await dayEnd.getDayEndSummary(fx.dayId);
    expect(summary.sales).toEqual({
      normal: { cashPaise: 2200_00n, upiPaise: 1350_00n, creditPaise: 600_00n, totalPaise: 4150_00n, systemCashPaise: 2200_00n, systemUpiPaise: 1350_00n },
      peak: { salesPaise: 3050_00n, cashPaise: 1650_00n, upiPaise: 1400_00n, sessionCount: 2, runningSessionNo: null },
      waiterRepayments: { cashPaise: 300_00n, upiPaise: 100_00n },
      total: { cashPaise: 3850_00n, upiPaise: 2750_00n, creditPaise: 600_00n, salesPaise: 7200_00n },
    });
    expect(summary.peakSessions).toEqual([
      expect.objectContaining({
        sessionNo: 1,
        salesPaise: 2450_00n,
        cashDeltaPaise: 1680_00n,
        upiDeltaPaise: 950_00n,
        inWindowUpiPaise: 150_00n,
        peakUpiPaise: 800_00n,
        peakCashPaise: 1650_00n,
        variancePaise: -20_00n,
      }),
      expect.objectContaining({ sessionNo: 2, salesPaise: PAISE.quarter, peakUpiPaise: PAISE.quarter, peakCashPaise: 0n, variancePaise: 0n }),
    ]);

    // 1. Per session, peak cash + peak UPI = peak sales.
    for (const s of summary.peakSessions) expect(s.peakCashPaise + s.peakUpiPaise).toBe(s.salesPaise);
    // 3. The card's UPI agrees with the cash count's "UPI today" line.
    expect(summary.sales.total.upiPaise + summary.sales.waiterRepayments.upiPaise).toBe(summary.breakdown.upiTotalPaise);
    // 4. Every bill is settled or reconciled, so total sales = Σ the day's bill totals.
    const billed = await one<{ total: string }>(db, `SELECT sum(total_paise)::text AS total FROM bills WHERE business_day_id = $1`, [fx.dayId]);
    expect(summary.sales.total.salesPaise).toBe(BigInt(billed.total));
    // The cash count itself is unchanged by the split.
    expect(summary.breakdown.expectedCashPaise).toBe(end1Cash);
  });

  it('leaves a running session out until it ends, tenders taken inside it included', async () => {
    const { fx, dayEnd, billing, peak } = setup();
    const bill = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(bill.id, fx.sku.half, 1);

    const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    await billing.settleNormalBill(bill.id, [{ mode: 'UPI', amount: PAISE.half }]);
    await billing.recordPeakSale(session.id, fx.sku.beer650, 1, fx.cashier);

    const running = await dayEnd.getDayEndSummary(fx.dayId);
    expect(running.sales).toEqual({
      normal: { cashPaise: 0n, upiPaise: 0n, creditPaise: 0n, totalPaise: 0n, systemCashPaise: 0n, systemUpiPaise: 0n },
      peak: { salesPaise: 0n, cashPaise: 0n, upiPaise: 0n, sessionCount: 0, runningSessionNo: 1 },
      waiterRepayments: { cashPaise: 0n, upiPaise: 0n },
      total: { cashPaise: 0n, upiPaise: 0n, creditPaise: 0n, salesPaise: 0n },
    });

    await peak.endPeakSession(session.id, PAISE.beer650, PAISE.half, fx.cashier);
    const ended = await dayEnd.getDayEndSummary(fx.dayId);
    expect(ended.sales.normal).toMatchObject({ upiPaise: PAISE.half, totalPaise: PAISE.half });
    expect(ended.sales.peak).toEqual({ salesPaise: PAISE.beer650, cashPaise: PAISE.beer650, upiPaise: 0n, sessionCount: 1, runningSessionNo: null });
  });

  it('reports a negative derived peak cash when the UPI readings exceed the sales', async () => {
    const { fx, dayEnd, billing, peak } = setup();
    const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    await billing.recordPeakSale(session.id, fx.sku.beer650, 1, fx.cashier);
    await peak.endPeakSession(session.id, 0n, 400_00n, fx.cashier); // UPI mis-keyed: +150 over

    const { sales, peakSessions } = await dayEnd.getDayEndSummary(fx.dayId);
    expect(peakSessions[0]).toMatchObject({ salesPaise: 250_00n, peakUpiPaise: 400_00n, peakCashPaise: -150_00n, variancePaise: 150_00n });
    expect(sales.peak).toMatchObject({ cashPaise: -150_00n, upiPaise: 400_00n, salesPaise: 250_00n });
  });

  it('is all zeros on a day with no sales, and the baseline starts from the float', async () => {
    const { fx, dayEnd, peak } = setup();
    const { sales } = await dayEnd.getDayEndSummary(fx.dayId);
    expect(sales.total).toEqual({ cashPaise: 0n, upiPaise: 0n, creditPaise: 0n, salesPaise: 0n });

    await dayEnd.closeBusinessDay(fx.dayId, 0n, fx.cashier);
    const next = await dayEnd.openBusinessDay(1500_00n, fx.cashier, '2026-10-15');
    expect(await peak.getStartBaseline(next.id)).toMatchObject({ expectedCashPaise: 1500_00n, expectedUpiPaise: 0n });
  });
});
