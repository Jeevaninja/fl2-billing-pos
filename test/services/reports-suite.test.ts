import { describe, expect, it } from 'vitest';
import {
  CatalogService,
  DayEndService,
  ItemCategoryService,
  KotService,
  PurchaseService,
  ReportService,
  RevenueCenterService,
} from '../../src/services/index.js';
import { useSeededDb } from '../support/db.js';
import { one } from '../support/pos.js';
import { makeServices, PAISE } from '../support/services.js';

/** Phase 24: the eight-module reporting suite and the TN FL2 statutory stock register (Revision 1). */

const DAY1 = '2026-10-14';
const DAY2 = '2026-10-15';
const range = (startDate: string, endDate = startDate) => ({ startDate, endDate });

describe('reporting suite (Phase 24)', () => {
  const ctx = useSeededDb();

  /**
   * Day 1 (closed ₹20 short): two GRNs (the later one at a higher cost, a ₹0 scheme line), a peak
   * session ₹10 short with an expense inside it, member bills (one with a counter cancel, one KOT'd to
   * the kitchen), a walk-in bill, a member bill voided without restock, expenses (one voided), bank
   * deposits (one voided), kitchen purchases from outside and from the drawer.
   * Day 2 (open, float ₹1,000): a walk-in and a member sale, a GRN at a newer cost.
   */
  async function scenario() {
    const { db, fx } = ctx();
    const { billing, peak } = makeServices(db);
    const dayEnd = new DayEndService(db);
    const catalog = new CatalogService(db);
    const purchases = new PurchaseService(db);
    const reports = new ReportService(db);
    const kot = new KotService(db, { printKOT: async (t) => ({ station: t.station, printedAt: new Date(), text: '' }) });
    const categories = await new ItemCategoryService(db).listCategories();
    const cat = (name: string) => categories.find((c) => c.name === name)!.id;

    const goldFlake = await catalog.createItem(
      { categoryId: cat('OTHERS'), name: 'Gold Flake', department: 'CIGARETTES', salePricePaise: 20_00n, openingQty: 10 },
      fx.cashier,
    );
    const dish = await catalog.createItem({ categoryId: cat('FOOD'), name: 'Chicken 65', salePricePaise: 180_00n }, fx.cashier);
    const wine = await catalog.createItem({ categoryId: cat('WINE'), name: 'Sula', sizeCode: 'FULL', salePricePaise: 900_00n, openingQty: 6 }, fx.cashier);
    await catalog.updateItem(fx.sku.half, { purchasePricePaise: 900_00n });

    await purchases.recordReceipt(
      {
        invoiceNo: 'INV-1',
        vendorName: 'TASMAC',
        lines: [
          { skuId: fx.sku.full, quantity: 12, unitCostPaise: 1500_00n },
          { skuId: fx.sku.beer650, quantity: 24, unitCostPaise: 150_00n },
          { skuId: goldFlake.id, quantity: 100, unitCostPaise: 15_00n },
        ],
      },
      fx.cashier,
    );
    await purchases.recordReceipt(
      {
        invoiceNo: 'INV-2',
        vendorName: 'TASMAC',
        lines: [
          { skuId: fx.sku.full, quantity: 6, unitCostPaise: 1600_00n },
          { skuId: fx.sku.quarter, quantity: 10, unitCostPaise: 0n }, // scheme bottles
        ],
      },
      fx.cashier,
    );

    const m1 = (await one<{ id: string }>(db, `INSERT INTO members (membership_no, display_name) VALUES ('M001', 'Asha') RETURNING id`)).id;
    const m2 = (await one<{ id: string }>(db, `INSERT INTO members (membership_no, display_name) VALUES ('M002', 'Ravi') RETURNING id`)).id;

    // Peak: two beers (₹250 cash, ₹250 UPI), ₹50 staff food paid from the drawer inside the window, ₹10 short.
    const session = await peak.startPeakSession(fx.dayId, 1000_00n, 0n, fx.cashier);
    await billing.recordPeakSale(session.id, fx.sku.beer650, 1, fx.cashier);
    await billing.recordPeakSale(session.id, fx.sku.beer650, 1, fx.cashier);
    await dayEnd.recordCashExpense(50_00n, null, fx.cashier, fx.expenseCategory.STAFF_FOOD);
    await peak.endPeakSession(session.id, 1190_00n, 250_00n, fx.cashier);

    const a = await billing.createBill('NORMAL', fx.cashier, m1);
    await billing.addItemToBill(a.id, fx.sku.full, 1);
    const quarters = await billing.addItemToBill(a.id, fx.sku.quarter, 2);
    await billing.cancelBillItem(a.id, quarters.item.id, 1);
    await billing.settleNormalBill(a.id, [{ mode: 'CASH', amount: PAISE.full + PAISE.quarter }]);

    const b = await billing.createBill('NORMAL', fx.cashier, m1);
    await billing.addItemToBill(b.id, fx.sku.full, 1);
    await billing.addItemToBill(b.id, dish.id, 1);
    await kot.sendPending(b.id, { staffId: fx.cashier }, { stations: ['KITCHEN'] });
    await billing.settleNormalBill(b.id, [{ mode: 'UPI', amount: PAISE.full + 180_00n }]);

    const c = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(c.id, fx.sku.half, 1);
    await billing.settleNormalBill(c.id, [{ mode: 'CASH', amount: PAISE.half }]);

    const d = await billing.createBill('NORMAL', fx.cashier, m2);
    await billing.addItemToBill(d.id, fx.sku.quarter, 1);
    await billing.settleNormalBill(d.id, [{ mode: 'UPI', amount: PAISE.quarter }]);
    await billing.reverseBill(d.id, 'bottle dropped', fx.manager, { restock: false });

    await dayEnd.recordCashExpense(150_00n, null, fx.cashier, fx.expenseCategory.ICE);
    const taxi = await dayEnd.recordCashExpense(80_00n, null, fx.cashier, fx.expenseCategory.TRANSPORT);
    await dayEnd.voidCashExpense(taxi.id, fx.cashier);
    await dayEnd.recordBankDeposit(500_00n, 'RTGS-1', fx.cashier);
    const wrong = await dayEnd.recordBankDeposit(200_00n, 'CHQ-9', fx.cashier);
    await dayEnd.voidBankDeposit(wrong.id, fx.manager);
    const centers = new RevenueCenterService(db);
    await centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'OUTSIDE', lines: [{ description: 'Chicken', amountPaise: 300_00n }] }, fx.cashier);
    await centers.recordPurchase({ department: 'KITCHEN', paidFrom: 'DRAWER', vendorName: 'Ravi Stores', lines: [{ description: 'Oil', quantity: '1 L', amountPaise: 120_00n }] }, fx.cashier);

    const day1 = await dayEnd.getDayEndSummary(fx.dayId);
    await dayEnd.closeBusinessDay(fx.dayId, day1.breakdown.expectedCashPaise - 20_00n, fx.manager);

    const day2 = await dayEnd.openBusinessDay(1000_00n, fx.manager, DAY2);
    const e = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(e.id, fx.sku.full, 2);
    await billing.settleNormalBill(e.id, [{ mode: 'CASH', amount: 2n * PAISE.full }]);
    const f = await billing.createBill('NORMAL', fx.cashier, m2);
    await billing.addItemToBill(f.id, fx.sku.beer650, 1);
    await billing.settleNormalBill(f.id, [{ mode: 'CASH', amount: PAISE.beer650 }]);
    await purchases.recordReceipt({ invoiceNo: 'INV-3', vendorName: 'TASMAC', lines: [{ skuId: fx.sku.full, quantity: 6, unitCostPaise: 1700_00n }] }, fx.cashier);

    return { db, fx, reports, dayEnd, catalog, goldFlake, dish, wine, day1, day2Id: day2.id, bills: { a, b, c, d } };
  }

  const DAY1_SALES = 2n * PAISE.full + PAISE.half + PAISE.quarter + 2n * PAISE.beer650 + 180_00n;

  it('sales summary: one row per SKU (never per bill line), centers and items agree with the ledger', async () => {
    const { fx, reports, dish } = await scenario();
    const summary = await reports.getSalesSummary(range(DAY1));
    const row = (skuId: string) => summary.rows.filter((r) => r.skuId === skuId);

    expect(row(fx.sku.full)).toEqual([expect.objectContaining({ qty: 2, sRatePaise: PAISE.full, amountPaise: 2n * PAISE.full })]);
    // 2 on A, 1 cancelled; 1 on D, voided: net one quarter.
    expect(row(fx.sku.quarter)).toEqual([expect.objectContaining({ qty: 1, sRatePaise: PAISE.quarter, amountPaise: PAISE.quarter })]);
    expect(row(fx.sku.beer650)).toEqual([expect.objectContaining({ qty: 2, amountPaise: 2n * PAISE.beer650 })]);
    expect(row(dish.id)).toEqual([expect.objectContaining({ centerCode: 'KITCHEN', qty: 1, amountPaise: 180_00n })]);
    expect(new Set(summary.rows.map((r) => r.skuId)).size).toBe(summary.rows.length);

    expect(summary.byCenter.map((c) => [c.code, c.amountPaise])).toEqual([
      ['LIQUOR', DAY1_SALES - 180_00n],
      ['KITCHEN', 180_00n],
    ]);
    expect(summary.totalPaise).toBe(DAY1_SALES);
    expect(summary.totalPaise).toBe((await reports.getLedger(range(DAY1))).sales.totalPaise);
    expect(summary.totalPaise).toBe((await reports.getOrderSummary(range(DAY1))).totals.netPaise);
    expect(summary.ml).toEqual((await reports.getStockSummary(range(DAY1))).ml);
  });

  it('sales summary shows "Mixed" when the price changed inside the range, with the exact billed amount', async () => {
    const { db, fx, reports, catalog } = await scenario();
    await catalog.updateItem(fx.sku.half, { salePricePaise: 1300_00n });
    const { billing } = makeServices(db);
    const g = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(g.id, fx.sku.half, 1);
    await billing.settleNormalBill(g.id, [{ mode: 'CASH', amount: 1300_00n }]);
    const both = await reports.getSalesSummary(range(DAY1, DAY2));
    expect(both.rows.find((r) => r.skuId === fx.sku.half)).toMatchObject({ qty: 2, sRatePaise: null, amountPaise: PAISE.half + 1300_00n });
  });

  it('member-wise sales: tagged bills per visit, untagged on their own line, totals reconcile', async () => {
    const { reports, bills } = await scenario();
    const report = await reports.getMemberSales(range(DAY1));
    expect(report.members.map((m) => [m.membershipNo, m.name, m.totalPaise])).toEqual([
      ['M001', 'Asha', 2n * PAISE.full + PAISE.quarter + 180_00n],
      ['M002', 'Ravi', 0n], // the void inherits the member and nets out
    ]);
    const [asha, ravi] = report.members;
    expect(asha!.visits).toHaveLength(1);
    expect(asha!.visits[0]).toMatchObject({ businessDate: DAY1, billNos: [bills.a.billNo, bills.b.billNo] });
    expect(asha!.visits[0]!.firstBillAt.getTime()).toBeLessThanOrEqual(asha!.visits[0]!.lastBillAt.getTime());
    expect(asha!.visits[0]!.items.map((i) => [i.name, i.qty])).toEqual([
      ['House Rum — Full', 2],
      ['House Rum — Quarter', 1],
      ['Chicken 65', 1],
    ]);
    expect(asha!.totalQty).toBe(4);
    expect(ravi!.visits[0]!.billNos).toHaveLength(2); // the sale and its reversal
    expect(ravi!.visits[0]!.items).toEqual([]);

    // Two peak beers and the walk-in half: never assigned to a member.
    expect(report.untagged).toEqual({ billCount: 3, qty: 3, totalPaise: 2n * PAISE.beer650 + PAISE.half });
    expect(report.totalPaise).toBe((await reports.getSalesSummary(range(DAY1))).totalPaise);

    const both = await reports.getMemberSales(range(DAY1, DAY2));
    expect(both.members.find((m) => m.membershipNo === 'M002')!.visits.map((v) => v.businessDate)).toEqual([DAY1, DAY2]);
  });

  it('order summary: cashier, peak session, KOTs and CANCEL / VOID tags on the bill-wise register', async () => {
    const { reports, bills } = await scenario();
    const orders = await reports.getOrderSummary(range(DAY1));
    const byNo = (n: number) => orders.rows.find((r) => r.billNo === n && r.kind === 'SALE')!;

    expect(orders.rows.slice(0, 2).map((r) => [r.mode, r.peakSessionNo])).toEqual([
      ['PEAK', 1],
      ['PEAK', 1],
    ]);
    expect(byNo(bills.a.billNo)).toMatchObject({ cashierName: 'Counter 1', source: 'COUNTER', cancelledQty: 1, peakSessionNo: null, kots: [] });
    expect(byNo(bills.b.billNo).kots).toEqual([{ station: 'KITCHEN', ticketNo: 1 }]);
    expect(byNo(bills.d.billNo).voidedBy).not.toBeNull();
    const reversal = orders.rows.find((r) => r.kind === 'REVERSAL')!;
    expect(reversal).toMatchObject({ reverses: { billNo: bills.d.billNo, businessDate: DAY1 }, totalPaise: -PAISE.quarter, cashierName: 'Manager' });
    expect(orders.totals).toMatchObject({ billCount: 6, reversalCount: 1, cancelledQty: 1, netPaise: DAY1_SALES });
  });

  it('stock summary: TN FL2 columns, valuation rate as of the date, ₹0 scheme lines skipped, unrated counted', async () => {
    const { fx, reports, goldFlake, wine } = await scenario();
    const day1 = await reports.getStockSummary(range(DAY1));
    const rows = day1.groups.flatMap((g) => g.rows);
    const row = (skuId: string) => rows.find((r) => r.skuId === skuId)!;

    // The fixture's opening counts land on day 1 (posted before it opened): they are Op.Stk.
    expect(row(fx.sku.full)).toMatchObject({
      opStk: 50,
      purch: 18,
      total: 68,
      sale: 2,
      adj: 0,
      closing: 66,
      pRatePaise: 1600_00n, // the later GRN of the day
      pRateSource: 'GRN',
      sRatePaise: PAISE.full,
      cloPurchValPaise: 66n * 1600_00n,
      cloSalesValPaise: 66n * PAISE.full,
      salesTotalPaise: 2n * PAISE.full,
    });
    expect(row(fx.sku.half)).toMatchObject({ sale: 1, closing: 49, pRatePaise: 900_00n, pRateSource: 'CATALOG', cloPurchValPaise: 49n * 900_00n });
    // A's cancelled quarter went back on the shelf; D's void without restock stays out.
    expect(row(fx.sku.quarter)).toMatchObject({ opStk: 50, purch: 10, total: 60, sale: 2, closing: 58, pRatePaise: null, cloPurchValPaise: null });
    expect(row(fx.sku.beer650)).toMatchObject({ purch: 24, sale: 2, closing: 72, pRatePaise: 150_00n });
    expect(row(goldFlake.id)).toMatchObject({ centerCode: 'CIGARETTES', opStk: 10, purch: 100, closing: 110, pRatePaise: 15_00n });
    expect(row(wine.id)).toMatchObject({ opStk: 6, closing: 6, pRatePaise: null });
    for (const r of rows) expect(r.total - r.sale + r.adj, r.skuCode).toBe(r.closing);

    expect(day1.hasAdjustments).toBe(false);
    expect(day1.totals.unratedCount).toBe(3); // quarter (₹0 GRN only), lager 330, wine
    expect(day1.totals.cloPurchValPaise).toBe(rows.reduce((t, r) => t + (r.cloPurchValPaise ?? 0n), 0n));
    expect(day1.groups.map((g) => g.categoryName)).toEqual(['FULL', 'HALF', 'QUARTER', 'BEER', 'WINE', 'OTHERS']);
    for (const g of day1.groups) expect(g.totals.closing).toBe(g.rows.reduce((n, r) => n + r.closing, 0));

    // Day 2: a newer GRN revalues the closing, while the opening keeps day 1's rate.
    const day2 = await reports.getStockSummary(range(DAY2));
    const full2 = day2.groups.flatMap((g) => g.rows).find((r) => r.skuId === fx.sku.full)!;
    expect(full2).toMatchObject({ opStk: 66, purch: 6, sale: 2, closing: 70, pRatePaise: 1700_00n, openingValPaise: 66n * 1600_00n });
    expect(day2.totals.openingValPaise).toBe(day1.totals.cloPurchValPaise);
  });

  it('stock summary shows Adj. only when an adjustment exists, and the row still adds up', async () => {
    const { db, fx, reports } = await scenario();
    await db.query(`INSERT INTO stock_movements (sku_id, business_day_id, movement_type, qty_delta, reason, created_by_staff_id) VALUES ($1, $2, 'ADJUSTMENT', -1, 'breakage', $3)`, [
      fx.sku.full,
      (await one<{ id: string }>(db, `SELECT id FROM business_days WHERE status = 'OPEN'`)).id,
      fx.manager,
    ]);
    const day2 = await reports.getStockSummary(range(DAY2));
    expect(day2.hasAdjustments).toBe(true);
    expect(day2.groups.flatMap((g) => g.rows).find((r) => r.skuId === fx.sku.full)).toMatchObject({ total: 72, sale: 2, adj: -1, closing: 69 });
  });

  it('ML / unit details: bottles × nominal volume by excise group, from the stock ledger', async () => {
    const { db, fx, reports, catalog } = await scenario();
    const { ml } = await reports.getStockSummary(range(DAY1));
    expect(ml.groups.map((g) => [g.label, g.bySize.map((s) => [s.volumeMl, s.saleUnits, s.saleMl, s.closingUnits, s.closingMl])])).toEqual([
      [
        'LIQUOR',
        [
          [750, 2, 1500, 66, 49_500],
          [375, 1, 375, 49, 18_375],
          [180, 2, 360, 58, 10_440],
        ],
      ],
      ['BEER', [[650, 2, 1300, 72, 46_800]]],
      ['TIN BEER', [[330, 0, 0, 50, 16_500]]],
      ['WINE', [[750, 0, 0, 6, 4500]]],
    ]);
    expect(ml.groups[0]).toMatchObject({ saleUnits: 5, saleMl: 2235, closingUnits: 173, closingMl: 78_315 });
    expect(ml.total).toEqual({ saleUnits: 7, saleMl: 3535, closingUnits: 301, closingMl: 146_115 });
    expect(ml.missing).toEqual([]);

    // Defaults come from the size code; a manager can correct one (a 500 ml tin).
    const sku = await one<{ volume_ml: number; excise_group: string }>(db, `SELECT volume_ml, excise_group FROM skus WHERE id = $1`, [fx.sku.beer330]);
    expect(sku).toEqual({ volume_ml: 330, excise_group: 'TIN_BEER' });
    expect(await catalog.updateItem(fx.sku.beer330, { volumeMl: 500 })).toMatchObject({ volumeMl: 500, exciseGroup: 'TIN_BEER' });
    const after = await reports.getStockSummary(range(DAY1));
    expect(after.ml.groups.find((g) => g.group === 'TIN_BEER')!.bySize).toEqual([{ volumeMl: 500, saleUnits: 0, saleMl: 0, closingUnits: 50, closingMl: 25_000 }]);

    await expect(catalog.updateItem(fx.sku.beer330, { volumeMl: 0 })).rejects.toThrow(RangeError);
    await expect(catalog.updateItem(fx.sku.beer330, { volumeMl: 0.5 })).rejects.toThrow(RangeError);
    await catalog.updateItem(fx.sku.beer330, { volumeMl: null });
    expect((await reports.getStockSummary(range(DAY1))).ml.missing).toEqual(['HLAG-330']);
  });

  it('expenses: itemised by category, voids listed and netted, center filters add up', async () => {
    const { reports } = await scenario();
    const all = await reports.getExpenseSummary(range(DAY1));
    expect(all.totalPaise).toBe(200_00n);
    expect(all.totalPaise).toBe((await reports.getLedger(range(DAY1))).expenses.totalPaise);
    const transport = all.byCategory.find((g) => g.name === 'Transport')!;
    expect(transport.entries.map((e) => [e.amountPaise, e.isVoid, e.voided])).toEqual([
      [80_00n, false, true],
      [-80_00n, true, false],
    ]);
    expect(transport).toMatchObject({ amountPaise: 0n, count: 0, centerName: null });

    const liquor = await reports.getExpenseSummary(range(DAY1), 'LIQUOR');
    expect(liquor.byCategory.map((g) => [g.name, g.amountPaise])).toEqual([['Ice', 150_00n]]);
    const shared = await reports.getExpenseSummary(range(DAY1), 'SHARED');
    expect(shared.byCenter).toEqual([{ code: 'SHARED', name: 'Shared', amountPaise: 50_00n }]);
    expect(liquor.totalPaise + shared.totalPaise).toBe(all.totalPaise);
    await expect(reports.getExpenseSummary(range(DAY1), 'bad code')).rejects.toThrow(RangeError);
  });

  it('purchases: GRN split by the brand center, center supplies with voids, totals equal the ledger', async () => {
    const { reports } = await scenario();
    const report = await reports.getPurchaseSummary(range(DAY1));
    expect(report.centers.map((c) => [c.code, c.grnPaise, c.suppliesPaise, c.suppliesDrawerPaise])).toEqual([
      ['LIQUOR', 12n * 1500_00n + 24n * 150_00n + 6n * 1600_00n, 0n, 0n],
      ['KITCHEN', 0n, 420_00n, 120_00n],
      ['CIGARETTES', 15n * 100_00n, 0n, 0n],
    ]);
    const liquor = report.centers[0]!;
    expect(liquor.grn.map((g) => [g.invoiceNo, g.lines.length])).toEqual([
      ['INV-1', 2],
      ['INV-2', 2],
    ]);
    expect(liquor.grn[1]!.lines.find((l) => l.unitCostPaise === 0n)).toMatchObject({ qty: 10, amountPaise: 0n });
    expect(report.centers[1]!.supplies.map((s) => [s.paidFrom, s.vendorName, s.lines.map((l) => l.description)])).toEqual([
      ['OUTSIDE', null, ['Chicken']],
      ['DRAWER', 'Ravi Stores', ['Oil']],
    ]);
    expect(report.totalPaise).toBe((await reports.getLedger(range(DAY1))).purchases.totalPaise);

    const kitchen = await reports.getPurchaseSummary(range(DAY1), 'KITCHEN');
    expect(kitchen.centers.map((c) => c.code)).toEqual(['KITCHEN']);
    await expect(reports.getPurchaseSummary(range(DAY1), 'SHARED')).rejects.toThrow(RangeError);
  });

  it('bank deposits: chronological contra log with voids, net equals the ledger contra', async () => {
    const { reports } = await scenario();
    const log = await reports.getBankDeposits(range(DAY1));
    expect(log.rows.map((r) => [r.amountPaise, r.reference, r.depositorName, r.isVoid, r.voided])).toEqual([
      [500_00n, 'RTGS-1', 'Counter 1', false, false],
      [200_00n, 'CHQ-9', 'Counter 1', false, true],
      [-200_00n, 'CHQ-9', 'Manager', true, false],
    ]);
    expect(log.totalPaise).toBe((await reports.getLedger(range(DAY1))).contra.bankDepositsPaise);
  });

  it('day end log: each row is that day’s Z report, with variance and who closed it', async () => {
    const { fx, reports, dayEnd, day1, day2Id } = await scenario();
    const log = await reports.getDayEndLog(range(DAY1, DAY2));
    const closed = await dayEnd.getDayEndSummary(fx.dayId);
    const open = await dayEnd.getDayEndSummary(day2Id);
    expect(log.rows[0]).toMatchObject({
      businessDate: DAY1,
      status: 'CLOSED',
      openingFloatPaise: 0n,
      expectedCashPaise: day1.breakdown.expectedCashPaise,
      countedCashPaise: day1.breakdown.expectedCashPaise - 20_00n,
      variancePaise: -20_00n,
      peakVariancePaise: -10_00n,
      upiPaise: closed.breakdown.upiTotalPaise,
      totalSalesPaise: DAY1_SALES,
      closedByName: 'Manager',
      closedByRole: 'MANAGER',
    });
    expect(log.rows[1]).toMatchObject({ status: 'OPEN', openingFloatPaise: 1000_00n, expectedCashPaise: open.breakdown.expectedCashPaise, countedCashPaise: null, variancePaise: null, closedByName: null });
    expect(log.totals.variancePaise).toBe(-20_00n);
    expect(log.totals.totalSalesPaise).toBe(closed.sales.total.salesPaise + open.sales.total.salesPaise);
  });

  it('full report: the cash book balances to the paisa over one and two days; sections equal their modules', async () => {
    const { fx, reports, day1, day2Id, dayEnd } = await scenario();
    const one1 = await reports.getFullReport(range(DAY1));
    expect(one1.cash).toMatchObject({
      openingBalancePaise: 0n,
      cashExpensesPaise: 200_00n, // Ice + staff food inside the peak; the taxi voided
      drawerPurchasesPaise: 120_00n,
      bankDepositsPaise: 500_00n,
      peakVariancePaise: -10_00n,
      unreconciledPaise: 0n,
      dayEndVariancePaise: -20_00n,
      betweenDaysPaise: 0n,
      closingBalancePaise: day1.breakdown.expectedCashPaise - 20_00n,
      runningPeakExpensesPaise: 0n,
    });
    const d1 = (await dayEnd.getDayEndSummary(fx.dayId)).sales;
    expect(one1.cash.cashSalesPaise).toBe(d1.total.cashPaise);
    expect(one1.sales.totalPaise).toBe(DAY1_SALES);
    expect(one1.payments.cashPaise + one1.payments.upiPaise + one1.payments.waiterCreditPaise).toBe(DAY1_SALES);
    expect(one1.expenses.totalPaise).toBe((await reports.getExpenseSummary(range(DAY1))).totalPaise);
    expect(one1.purchases.totalPaise).toBe((await reports.getPurchaseSummary(range(DAY1))).totalPaise);
    const stock = await reports.getStockSummary(range(DAY1));
    expect(one1.stock).toEqual({ openingValuePaise: stock.totals.openingValPaise, closingValuePaise: stock.totals.cloPurchValPaise, unratedCount: 3 });

    const both = await reports.getFullReport(range(DAY1, DAY2));
    const counted1 = day1.breakdown.expectedCashPaise - 20_00n;
    expect(both.provisional).toBe(true);
    expect(both.cash.betweenDaysPaise).toBe(counted1 - 1000_00n);
    expect(both.cash.closingBalancePaise).toBe((await dayEnd.getDayEndSummary(day2Id)).breakdown.expectedCashPaise);
    const c = both.cash;
    expect(
      c.openingBalancePaise +
        c.cashSalesPaise +
        c.waiterCashRepaidPaise -
        c.cashExpensesPaise -
        c.drawerPurchasesPaise -
        c.bankDepositsPaise +
        c.peakVariancePaise +
        c.unreconciledPaise +
        c.dayEndVariancePaise -
        c.betweenDaysPaise,
    ).toBe(c.closingBalancePaise);
  });

  it('every Phase 24 report answers an empty range with zeros and rejects a bad one', async () => {
    const { reports } = await scenario();
    const empty = range('2025-01-01', '2025-01-31');
    expect(await reports.getFullReport(empty)).toMatchObject({ days: [], cash: { openingBalancePaise: 0n, closingBalancePaise: 0n }, sales: { totalPaise: 0n } });
    expect((await reports.getSalesSummary(empty)).rows).toEqual([]);
    expect((await reports.getMemberSales(empty)).members).toEqual([]);
    expect((await reports.getDayEndLog(empty)).rows).toEqual([]);
    expect((await reports.getBankDeposits(empty)).rows).toEqual([]);
    await expect(reports.getOrderSummary(range(DAY2, DAY1))).rejects.toThrow(/on or before/);
    await expect(reports.getStockSummary(range('2026-10-1', DAY1))).rejects.toThrow(RangeError);
  });
});
