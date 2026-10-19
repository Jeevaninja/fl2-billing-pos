import { describe, expect, it } from 'vitest';
import {
  CatalogService,
  DayEndService,
  ItemCategoryService,
  PurchaseService,
  ReportService,
  RevenueCenterService,
  type SalesBreakdown,
} from '../../src/services/index.js';
import { useSeededDb } from '../support/db.js';
import { OPENING_QTY } from '../support/fixtures.js';
import { one } from '../support/pos.js';
import { makeServices, PAISE } from '../support/services.js';

/** Phase 23: date-ranged reports by business date (ledger, sales register, stock register, payments). */

const DAY1 = '2026-10-14';
const DAY2 = '2026-10-15';
const range = (startDate: string, endDate = startDate) => ({ startDate, endDate });

describe('reports (Phase 23)', () => {
  const ctx = useSeededDb();

  /**
   * Day 1 (closed): cash, UPI and split bills, a cigarette sale, a waiter-credit bill repaid in cash,
   * an empty bill, a peak session with a shortage, two reversals (one not restocked), a tally
   * adjustment, liquor and cigarette GRNs, a Kitchen supply purchase, expenses (one voided) and a bank
   * deposit. Between days an item is created with an opening count. Day 2 (open): a cash sale, a
   * waiter-credit bill still owed, and an open tab.
   */
  async function twoDays() {
    const { db, fx } = ctx();
    const { billing, peak, waiters } = makeServices(db);
    const dayEnd = new DayEndService(db);
    const catalog = new CatalogService(db);
    const reports = new ReportService(db);
    const categories = await new ItemCategoryService(db).listCategories();
    const cat = (name: string) => categories.find((c) => c.name === name)!.id;

    const goldFlake = await catalog.createItem(
      { categoryId: cat('OTHERS'), name: 'Gold Flake', department: 'CIGARETTES', salePricePaise: 20_00n, openingQty: 10 },
      fx.cashier,
    );
    const dish = await catalog.createItem({ categoryId: cat('FOOD'), name: 'Chicken 65', salePricePaise: 180_00n }, fx.cashier);
    await new PurchaseService(db).recordReceipt(
      {
        invoiceNo: 'INV-1',
        vendorName: 'KSBCL',
        lines: [
          { skuId: fx.sku.full, quantity: 12, unitCostPaise: 1500_00n },
          { skuId: goldFlake.id, quantity: 100, unitCostPaise: 15_00n },
        ],
      },
      fx.cashier,
    );

    // A peak session first (no open bills around): two beers, ₹10 short.
    const session = await peak.startPeakSession(fx.dayId, 1000_00n, 0n, fx.cashier);
    await billing.recordPeakSale(session.id, fx.sku.beer650, 1, fx.cashier);
    await billing.recordPeakSale(session.id, fx.sku.beer650, 1, fx.cashier);
    await peak.endPeakSession(session.id, 1240_00n, 250_00n, fx.cashier);

    const sell = async (lines: Array<[string, number]>) => {
      const bill = await billing.createBill('NORMAL', fx.cashier);
      for (const [sku, qty] of lines) await billing.addItemToBill(bill.id, sku, qty);
      return bill;
    };
    const a = await sell([[fx.sku.full, 1]]);
    await billing.settleNormalBill(a.id, [{ mode: 'CASH', amount: PAISE.full }]);
    const b = await sell([
      [fx.sku.quarter, 2],
      [goldFlake.id, 3],
      [dish.id, 1],
    ]);
    await billing.settleNormalBill(b.id, [{ mode: 'UPI', amount: 2n * PAISE.quarter + 60_00n + 180_00n }]);
    const c = await sell([[fx.sku.half, 1]]);
    await billing.settleNormalBill(c.id, [
      { mode: 'CASH', amount: 600_00n },
      { mode: 'UPI', amount: PAISE.half - 600_00n },
    ]);
    const d = await sell([[fx.sku.quarter, 1]]);
    await waiters.tagBillToWaiter(d.id, fx.waiter.trusted);
    await waiters.settleWaiterBill(d.id, fx.waiter.trusted, 'WAITER_CREDIT');
    await waiters.recordWaiterRepayment(fx.waiter.trusted, PAISE.quarter, 'CASH', fx.cashier);
    const empty = await billing.createBill('NORMAL', fx.cashier);
    await billing.closeEmptyBill(empty.id);
    await billing.reverseBill(a.id, 'bottle broken at the table', fx.manager, { restock: false });
    await billing.reverseBill(c.id, 'wrong size', fx.manager);

    await dayEnd.adjustTenderSplit(fx.dayId, 100_00n, 'UPI scanned twice, paid cash', fx.manager);
    await dayEnd.recordCashExpense(150_00n, null, fx.cashier, fx.expenseCategory.ICE);
    const taxi = await dayEnd.recordCashExpense(80_00n, null, fx.cashier, fx.expenseCategory.TRANSPORT);
    await dayEnd.voidCashExpense(taxi.id, fx.cashier);
    await dayEnd.recordBankDeposit(500_00n, 'RTGS', fx.cashier);
    await new RevenueCenterService(db).recordPurchase({ department: 'KITCHEN', paidFrom: 'OUTSIDE', lines: [{ description: 'Chicken', amountPaise: 300_00n }] }, fx.cashier);

    const before = await dayEnd.getDayEndSummary(fx.dayId);
    await dayEnd.closeBusinessDay(fx.dayId, before.breakdown.expectedCashPaise, fx.manager);

    // Between days: a new item with an opening count (no business day to stamp it with).
    const soda = await catalog.createItem({ categoryId: cat('OTHERS'), name: 'Club Soda', department: 'COOL_DRINKS', salePricePaise: 40_00n, openingQty: 24 }, fx.cashier);

    const day2 = await dayEnd.openBusinessDay(0n, fx.manager, DAY2);
    const e = await sell([[fx.sku.full, 2]]);
    await billing.settleNormalBill(e.id, [{ mode: 'CASH', amount: 2n * PAISE.full }]);
    const f = await sell([[soda.id, 2]]);
    await waiters.tagBillToWaiter(f.id, fx.waiter.trusted);
    await waiters.settleWaiterBill(f.id, fx.waiter.trusted, 'WAITER_CREDIT');
    await sell([[fx.sku.quarter, 1]]); // an open tab

    return { db, fx, reports, dayEnd, goldFlake, dish, soda, day2Id: day2.id };
  }

  const sumSales = (list: SalesBreakdown[], pick: (s: SalesBreakdown) => bigint) => list.reduce((t, s) => t + pick(s), 0n);

  it('payments equal the sum of the Day End figures, and add up to sales', async () => {
    const { fx, reports, dayEnd, day2Id } = await twoDays();
    const day1 = (await dayEnd.getDayEndSummary(fx.dayId)).sales;
    const day2 = (await dayEnd.getDayEndSummary(day2Id)).sales;

    const closed = await reports.getPayments(range(DAY1));
    expect(closed.provisional).toBe(false);
    expect(closed.days).toEqual([{ id: fx.dayId, businessDate: DAY1, status: 'CLOSED' }]);
    expect(closed.revenue).toEqual({
      cashPaise: day1.total.cashPaise,
      upiPaise: day1.total.upiPaise,
      waiterCreditPaise: day1.total.creditPaise,
      totalSalesPaise: day1.total.salesPaise,
    });
    expect(closed.revenue.waiterCreditPaise).toBe(PAISE.quarter);
    // Day End can't close with a waiter balance: over closed days, credit given = repaid.
    expect(closed.waiterLedger).toEqual({ creditGivenPaise: PAISE.quarter, repaidCashPaise: PAISE.quarter, repaidUpiPaise: 0n, outstandingChangePaise: 0n });
    expect(closed.received.cashPaise).toBe(day1.total.cashPaise + PAISE.quarter);
    expect(closed.split.peak).toEqual({ cashPaise: day1.peak.cashPaise, upiPaise: 250_00n, sessionCount: 1 });
    expect(closed.split.normal.cashPaise).toBe(day1.normal.cashPaise); // tally adjustment included

    const both = await reports.getPayments(range(DAY1, DAY2));
    expect(both.provisional).toBe(true);
    expect(both.revenue.totalSalesPaise).toBe(sumSales([day1, day2], (s) => s.total.salesPaise));
    expect(both.revenue.cashPaise).toBe(sumSales([day1, day2], (s) => s.total.cashPaise));
    expect(both.waiterLedger.outstandingChangePaise).toBe(80_00n); // two sodas still owed
    expect(both.byDay.map((d) => [d.businessDate, d.status, d.totalSalesPaise])).toEqual([
      [DAY1, 'CLOSED', day1.total.salesPaise],
      [DAY2, 'OPEN', day2.total.salesPaise],
    ]);
  });

  it('ledger: sales by center, liquor GRN vs center purchases, expenses by category, contra', async () => {
    const { reports } = await twoDays();
    const ledger = await reports.getLedger(range(DAY1));
    const payments = await reports.getPayments(range(DAY1));

    expect(ledger.sales.byCenter.map((c) => [c.code, c.salesPaise])).toEqual([
      ['LIQUOR', 2n * PAISE.beer650 + 3n * PAISE.quarter], // peak beers + 2 quarters + the waiter's quarter; A and C voided
      ['KITCHEN', 180_00n],
      ['CIGARETTES', 60_00n],
    ]);
    expect(ledger.sales.unallocatedPaise).toBe(0n);
    expect(ledger.sales.totalPaise).toBe(payments.revenue.totalSalesPaise);

    expect(ledger.purchases.liquorGrnPaise).toBe(12n * 1500_00n);
    expect(ledger.purchases.byCenter).toEqual([
      { code: 'KITCHEN', name: 'Kitchen', grnPaise: 0n, suppliesPaise: 300_00n, suppliesDrawerPaise: 0n, totalPaise: 300_00n },
      { code: 'CIGARETTES', name: 'Cigarettes', grnPaise: 1500_00n, suppliesPaise: 0n, suppliesDrawerPaise: 0n, totalPaise: 1500_00n },
    ]);
    expect(ledger.purchases.totalPaise).toBe(12n * 1500_00n + 1800_00n);

    // The voided taxi nets to zero and drops out; Ice maps to Liquor.
    expect(ledger.expenses).toEqual({ byCategory: [{ categoryId: expect.any(String), name: 'Ice', centerName: 'Liquor', amountPaise: 150_00n, count: 1 }], totalPaise: 150_00n });
    expect(ledger.contra.bankDepositsPaise).toBe(500_00n);
  });

  it('ledger on the open day shows part-paid tabs as unallocated', async () => {
    const { db, fx, reports } = await twoDays();
    const { billing } = makeServices(db);
    const tab = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(tab.id, fx.sku.half, 1);
    await makeServices(db).waiters.tagBillToWaiter(tab.id, fx.waiter.trusted);
    await makeServices(db).waiters.settleWaiterBill(tab.id, fx.waiter.trusted, 'CASH', 500_00n);
    const ledger = await reports.getLedger(range(DAY2));
    expect(ledger.provisional).toBe(true);
    expect(ledger.sales.unallocatedPaise).toBe(500_00n);
    expect(ledger.sales.totalPaise).toBe((await reports.getPayments(range(DAY2))).revenue.totalSalesPaise);
  });

  it('sales register: chronological, reversals and the empty bill listed, open tabs left out', async () => {
    const { reports } = await twoDays();
    const day1 = await reports.getSalesRegister(range(DAY1));
    expect(day1.rows.map((r) => r.billNo)).toEqual([...day1.rows.map((r) => r.billNo)].sort((x, y) => x - y));
    expect(day1.rows.map((r) => r.billNo)).toEqual(Array.from({ length: day1.rows.length }, (_, i) => i + 1)); // no gaps
    expect(day1.rows.map((r) => [r.kind, r.mode, r.totalPaise])).toEqual([
      ['SALE', 'PEAK', PAISE.beer650],
      ['SALE', 'PEAK', PAISE.beer650],
      ['SALE', 'NORMAL', PAISE.full],
      ['SALE', 'NORMAL', 2n * PAISE.quarter + 240_00n],
      ['SALE', 'NORMAL', PAISE.half],
      ['SALE', 'NORMAL', PAISE.quarter],
      ['SALE', 'NORMAL', 0n],
      ['REVERSAL', 'NORMAL', -PAISE.full],
      ['REVERSAL', 'NORMAL', -PAISE.half],
    ]);
    const [, , a, b, c, d] = day1.rows;
    expect(a!.voidedBy).toEqual({ billNo: 8, businessDate: DAY1 });
    expect(day1.rows[7]!.reverses).toEqual({ billNo: a!.billNo, businessDate: DAY1 });
    expect(b!.items.map((i) => [i.name, i.qty])).toEqual([
      ['House Rum — Quarter', 2],
      ['Gold Flake', 3],
      ['Chicken 65', 1],
    ]);
    expect([c!.cashPaise, c!.upiPaise]).toEqual([600_00n, PAISE.half - 600_00n]);
    expect([d!.creditPaise, d!.waiterName]).toEqual([PAISE.quarter, 'Trusted']);
    expect(day1.rows[8]!.items).toEqual([{ name: 'House Rum — Half', sizeCode: 'HALF', qty: -1, lineTotalPaise: -PAISE.half }]);
    expect(day1.totals).toMatchObject({ billCount: 7, reversalCount: 2, reversalsPaise: -(PAISE.full + PAISE.half) });
    expect(day1.totals.netPaise).toBe((await reports.getLedger(range(DAY1))).sales.totalPaise);
    expect(day1.openBillCount).toBe(0);

    const day2 = await reports.getSalesRegister(range(DAY2));
    expect(day2.rows.map((r) => r.billNo)).toEqual([1, 2]);
    expect(day2.openBillCount).toBe(1);
  });

  it('stock register: opening for any start date, closing on the shelf count, the between-days opening dated forward', async () => {
    const { db, fx, reports, goldFlake, dish, soda } = await twoDays();
    const row = (rows: Awaited<ReturnType<ReportService['getStockRegister']>>['rows'], skuId: string) => rows.find((r) => r.skuId === skuId);

    const day1 = await reports.getStockRegister(range(DAY1));
    // The fixture's opening counts were posted before day 1 opened, so they land on day 1 as "other".
    expect(row(day1.rows, fx.sku.full)).toMatchObject({ openingQty: 0, otherQty: OPENING_QTY, inwardQty: 12, salesQty: 1, closingQty: OPENING_QTY + 11 });
    expect(row(day1.rows, fx.sku.half)).toMatchObject({ salesQty: 0, closingQty: OPENING_QTY }); // sold, then voided with restock
    expect(row(day1.rows, fx.sku.beer650)).toMatchObject({ salesQty: 2, closingQty: OPENING_QTY - 2 });
    expect(row(day1.rows, goldFlake.id)).toMatchObject({ centerName: 'Cigarettes', otherQty: 10, inwardQty: 100, salesQty: 3, closingQty: 107 });
    expect(row(day1.rows, soda.id)).toMatchObject({ openingQty: 0, otherQty: 0, closingQty: 0 });
    expect(row(day1.rows, dish.id)).toBeUndefined(); // Kitchen isn't stock-tracked

    const day2 = await reports.getStockRegister(range(DAY2));
    for (const r of day2.rows) expect(r.openingQty, r.skuCode).toBe(row(day1.rows, r.skuId)?.closingQty ?? 0);
    expect(row(day2.rows, soda.id)).toMatchObject({ openingQty: 0, otherQty: 24, salesQty: 2, closingQty: 22 });
    expect(row(day2.rows, fx.sku.full)).toMatchObject({ openingQty: OPENING_QTY + 11, salesQty: 2, closingQty: OPENING_QTY + 9 });

    const both = await reports.getStockRegister(range(DAY1, DAY2));
    for (const r of both.rows) {
      const stock = await one<{ on_hand: number }>(db, `SELECT on_hand_qty AS on_hand FROM sku_stock WHERE sku_id = $1`, [r.skuId]);
      expect(r.closingQty, r.skuCode).toBe(Number(stock.on_hand));
    }
    // Before any trading day: everything is zero, the rows are still listed.
    const earlier = await reports.getStockRegister(range('2026-10-01', '2026-10-13'));
    expect(earlier.days).toEqual([]);
    expect(earlier.rows.every((r) => r.openingQty === 0 && r.closingQty === 0)).toBe(true);
  });

  it('validates the range and answers an empty one with zeros', async () => {
    const { reports } = await twoDays();
    await expect(reports.getLedger(range('2026-10-1', DAY1))).rejects.toThrow(RangeError);
    await expect(reports.getLedger(range('2026-02-30', '2026-03-01'))).rejects.toThrow(/real date/);
    await expect(reports.getSalesRegister(range(DAY2, DAY1))).rejects.toThrow(/on or before/);
    await expect(reports.getPayments(range('2025-10-13', DAY1))).rejects.toThrow(/at most 366 days/);
    await expect(reports.getPayments(range('2025-10-14', DAY1))).resolves.toBeDefined(); // exactly 366

    const empty = await reports.getPayments(range('2025-01-01', '2025-01-31'));
    expect(empty).toMatchObject({ days: [], provisional: false, revenue: { totalSalesPaise: 0n }, byDay: [] });
    const ledger = await reports.getLedger(range('2025-01-01', '2025-01-31'));
    expect(ledger.sales).toEqual({ byCenter: [{ code: 'LIQUOR', name: 'Liquor', salesPaise: 0n }], unallocatedPaise: 0n, totalPaise: 0n });
    expect(ledger.purchases.totalPaise).toBe(0n);
  });

  it('anchors the presets on the open business day', async () => {
    const { reports } = await twoDays();
    expect(await reports.getRangeAnchor()).toEqual({ currentBusinessDate: DAY2, firstBusinessDate: DAY1 });
  });
});
