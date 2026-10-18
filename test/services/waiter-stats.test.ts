import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CaptainService, CounterQueries, DayEndService, type KotPrinter, type WaiterStats } from '../../src/services/index.js';
import { useSeededDb } from '../support/db.js';
import { makeServices, PAISE } from '../support/services.js';

const silentPrinter: KotPrinter = { printKOT: async (t) => ({ station: t.station, printedAt: new Date(), text: '' }) };
const ZERO = { openBills: 0, openDuePaise: 0n, closedBills: 0, settledPaise: 0n };

describe('CounterQueries.getWaiterStats', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, queries: new CounterQueries(db), dayEnd: new DayEndService(db), ...makeServices(db) };
  };
  const byCode = (rows: WaiterStats[]) => Object.fromEntries(rows.map((w) => [w.code, w]));

  it('lists every active waiter at zero on a fresh day', async () => {
    const { fx, queries } = setup();
    const report = await queries.getWaiterStats();
    expect(report.businessDayId).toBe(fx.dayId);
    expect(report.waiters.map((w) => w.code)).toEqual(['W01', 'W02', 'W03']);
    for (const w of report.waiters) expect(w).toMatchObject(ZERO);
    expect(report.totals).toEqual(ZERO);
  });

  it('counts open bills by what is still due, and closed bills by their total, across counter and Captain-app bills', async () => {
    const { db, fx, queries, billing, waiters } = setup();

    // W01 (trusted): a counter bill held open with a part-payment …
    const partial = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(partial.id, fx.sku.full, 2);
    await waiters.tagBillToWaiter(partial.id, fx.waiter.trusted);
    await waiters.settleWaiterBill(partial.id, fx.waiter.trusted, 'CASH', 100_00n);
    // … a bill settled in cash, and one put on waiter credit (closed, but owed).
    const cash = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(cash.id, fx.sku.quarter, 3);
    await waiters.tagBillToWaiter(cash.id, fx.waiter.trusted);
    await waiters.settleWaiterBill(cash.id, fx.waiter.trusted, 'UPI');
    const credit = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(credit.id, fx.sku.beer650, 1);
    await waiters.tagBillToWaiter(credit.id, fx.waiter.trusted);
    await waiters.settleWaiterBill(credit.id, fx.waiter.trusted, 'WAITER_CREDIT');

    // W02 (untrusted): an open Captain-app order.
    const order = await new CaptainService(db, silentPrinter).placeOrder({
      requestId: randomUUID(),
      deviceId: 'handset-01',
      waiterId: fx.waiter.untrusted,
      items: [{ skuId: fx.sku.half, quantity: 2 }],
    });

    // An untagged counter bill doesn't count.
    const untagged = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(untagged.id, fx.sku.full, 1);

    const report = await queries.getWaiterStats();
    const rows = byCode(report.waiters);
    expect(rows.W01).toMatchObject({
      openBills: 1,
      openDuePaise: 2n * PAISE.full - 100_00n,
      closedBills: 2,
      settledPaise: 3n * PAISE.quarter + PAISE.beer650,
      outstandingPaise: PAISE.beer650,
    });
    expect(rows.W02).toMatchObject({ openBills: 1, openDuePaise: 2n * PAISE.half, closedBills: 0, settledPaise: 0n });
    expect(order.bill.waiterId).toBe(fx.waiter.untrusted);
    expect(rows.W03).toMatchObject(ZERO);

    expect(report.totals).toEqual({
      openBills: 2,
      openDuePaise: 2n * PAISE.full - 100_00n + 2n * PAISE.half,
      closedBills: 2,
      settledPaise: 3n * PAISE.quarter + PAISE.beer650,
    });
  });

  it('keeps totals equal to the sum of the rows', async () => {
    const { fx, queries, billing, waiters } = setup();
    for (const [waiter, sku, qty] of [
      [fx.waiter.trusted, fx.sku.full, 1],
      [fx.waiter.untrusted, fx.sku.beer330, 4],
      [fx.waiter.limited, fx.sku.half, 2],
    ] as const) {
      const bill = await billing.createBill('NORMAL', fx.cashier);
      await billing.addItemToBill(bill.id, sku, qty);
      await waiters.tagBillToWaiter(bill.id, waiter);
      if (waiter !== fx.waiter.limited) await waiters.settleWaiterBill(bill.id, waiter, 'CASH');
    }
    const { waiters: rows, totals } = await queries.getWaiterStats();
    expect(totals.openBills).toBe(rows.reduce((n, w) => n + w.openBills, 0));
    expect(totals.openDuePaise).toBe(rows.reduce((n, w) => n + w.openDuePaise, 0n));
    expect(totals.closedBills).toBe(rows.reduce((n, w) => n + w.closedBills, 0));
    expect(totals.settledPaise).toBe(rows.reduce((n, w) => n + w.settledPaise, 0n));
    expect(totals).toEqual({ openBills: 1, openDuePaise: 2n * PAISE.half, closedBills: 2, settledPaise: PAISE.full + 4n * PAISE.beer330 });
  });

  it('drops a settled bill from the closed figures once it is reversed', async () => {
    const { fx, queries, billing, waiters } = setup();
    const kept = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(kept.id, fx.sku.quarter, 1);
    await waiters.tagBillToWaiter(kept.id, fx.waiter.trusted);
    await waiters.settleWaiterBill(kept.id, fx.waiter.trusted, 'CASH');
    const voided = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(voided.id, fx.sku.full, 1);
    await waiters.tagBillToWaiter(voided.id, fx.waiter.trusted);
    await waiters.settleWaiterBill(voided.id, fx.waiter.trusted, 'CASH');

    expect(byCode((await queries.getWaiterStats()).waiters).W01).toMatchObject({ closedBills: 2, settledPaise: PAISE.quarter + PAISE.full });
    await billing.reverseBill(voided.id, 'wrong bottle', fx.manager);
    expect(byCode((await queries.getWaiterStats()).waiters).W01).toMatchObject({ closedBills: 1, settledPaise: PAISE.quarter });
  });

  it("counts only the open day's bills, and inactive waiters drop out", async () => {
    const { db, fx, queries, billing, waiters, dayEnd } = setup();
    const bill = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(bill.id, fx.sku.full, 1);
    await waiters.tagBillToWaiter(bill.id, fx.waiter.trusted);
    await waiters.settleWaiterBill(bill.id, fx.waiter.trusted, 'UPI');

    const summary = await dayEnd.getDayEndSummary(fx.dayId);
    await dayEnd.closeBusinessDay(fx.dayId, summary.breakdown.expectedCashPaise, fx.manager);
    const closed = await queries.getWaiterStats();
    expect(closed.businessDayId).toBeNull();
    expect(closed.totals).toEqual(ZERO);

    const next = await dayEnd.openBusinessDay(0n, fx.manager, '2026-10-15');
    await db.query(`UPDATE waiters SET is_active = false WHERE id = $1`, [fx.waiter.limited]);
    const report = await queries.getWaiterStats();
    expect(report.businessDayId).toBe(next.id);
    expect(report.waiters.map((w) => w.code)).toEqual(['W01', 'W02']);
    expect(report.totals).toEqual(ZERO);
  });
});
