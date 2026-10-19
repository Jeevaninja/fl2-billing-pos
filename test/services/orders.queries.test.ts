import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  asciiText,
  CaptainService,
  DayEndService,
  formatReceipt,
  type KotPrinter,
  OrdersQueries,
  type OrderSummary,
  receiptFor,
  receiptMoney,
} from '../../src/services/index.js';
import { useSeededDb } from '../support/db.js';
import { makeServices, PAISE } from '../support/services.js';

const silentPrinter: KotPrinter = { printKOT: async (t) => ({ station: t.station, printedAt: new Date(), text: '' }) };

describe('OrdersQueries (Phase 17)', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, orders: new OrdersQueries(db), dayEnd: new DayEndService(db), captain: new CaptainService(db, silentPrinter), ...makeServices(db) };
  };

  /** One business day with every kind of bill the Orders screen has to show. */
  async function busyDay(s: ReturnType<typeof setup>) {
    const { fx, billing, peak, waiters, captain } = s;
    // Peak #1: two scans, one undone, then the session ends (reconciled).
    const p1 = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    const peakKept = (await billing.recordPeakSale(p1.id, fx.sku.beer650, 2, fx.cashier)).bill;
    const peakUndone = (await billing.recordPeakSale(p1.id, fx.sku.beer330, 1, fx.cashier)).bill;
    await billing.undoLastPeakSale(fx.cashier);
    await peak.endPeakSession(p1.id, 2n * PAISE.beer650, 0n, fx.cashier);

    const open = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(open.id, fx.sku.quarter, 1);

    const cash = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(cash.id, fx.sku.full, 1);
    await billing.settleNormalBill(cash.id, [{ mode: 'CASH', amount: PAISE.full }]);

    const upi = await billing.createBill('NORMAL', fx.cashier);
    const line = await billing.addItemToBill(upi.id, fx.sku.quarter, 3);
    await billing.cancelBillItem(upi.id, line.item.id, 1); // 3 scanned, 1 taken off → 2 bottles
    await billing.settleNormalBill(upi.id, [{ mode: 'UPI', amount: 2n * PAISE.quarter }]);

    const cancelled = await billing.createBill('NORMAL', fx.cashier);
    const gone = await billing.addItemToBill(cancelled.id, fx.sku.half, 1);
    await billing.cancelBillItem(cancelled.id, gone.item.id, 1);
    await billing.closeEmptyBill(cancelled.id);

    const voided = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(voided.id, fx.sku.beer650, 1);
    await billing.settleNormalBill(voided.id, [{ mode: 'CASH', amount: PAISE.beer650 }]);
    await billing.reverseBill(voided.id, 'wrong bottle', fx.manager);

    // W01: a counter bill part-paid, then a Captain-app order; one lump sum settles both.
    const partPaid = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(partPaid.id, fx.sku.half, 1);
    await waiters.tagBillToWaiter(partPaid.id, fx.waiter.trusted);
    await waiters.settleWaiterBill(partPaid.id, fx.waiter.trusted, 'CASH', 200_00n);
    const app = await captain.placeOrder({ requestId: randomUUID(), deviceId: 'handset-01', waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.quarter, quantity: 1 }] });
    const lump = PAISE.half - 200_00n + PAISE.quarter;
    await waiters.receiveWaiterPayment(fx.waiter.trusted, lump, 'UPI', fx.cashier);

    // W03: a bill put on collect-later credit.
    const credit = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(credit.id, fx.sku.quarter, 1);
    await waiters.tagBillToWaiter(credit.id, fx.waiter.limited);
    await waiters.settleWaiterBill(credit.id, fx.waiter.limited, 'WAITER_CREDIT');

    // An open part-paid bill for W01 (still due).
    const owing = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(owing.id, fx.sku.beer330, 2);
    await waiters.tagBillToWaiter(owing.id, fx.waiter.trusted);
    await waiters.settleWaiterBill(owing.id, fx.waiter.trusted, 'CASH', 100_00n);

    // Peak #2 still running.
    const p2 = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    const peakPending = (await billing.recordPeakSale(p2.id, fx.sku.quarter, 1, fx.cashier)).bill;

    return { peakKept, peakUndone, open, cash, upi, cancelled, voided, partPaid, app: app.bill, lump, credit, owing, peakPending };
  }

  it('lists every sale bill of the day newest first, with a derived status and no REVERSAL rows', async () => {
    const s = setup();
    const b = await busyDay(s);
    const list = await s.orders.listOrders();
    const byId = new Map(list.map((o) => [o.billId, o]));
    const status = (id: string) => byId.get(id)?.status;

    expect(list).toHaveLength(12);
    expect(list.map((o) => o.createdAt.getTime())).toEqual([...list.map((o) => o.createdAt.getTime())].sort((x, y) => y - x));
    expect(status(b.peakKept.id)).toBe('PEAK_RECONCILED');
    expect(status(b.peakUndone.id)).toBe('VOIDED');
    expect(status(b.peakPending.id)).toBe('PEAK_PENDING');
    expect(status(b.open.id)).toBe('OPEN');
    expect(status(b.cash.id)).toBe('SETTLED');
    expect(status(b.upi.id)).toBe('SETTLED');
    expect(status(b.cancelled.id)).toBe('CANCELLED');
    expect(status(b.voided.id)).toBe('VOIDED');
    expect(status(b.partPaid.id)).toBe('SETTLED');
    expect(status(b.app.id)).toBe('SETTLED');
    expect(status(b.credit.id)).toBe('SETTLED');
    expect(status(b.owing.id)).toBe('OPEN');
  });

  it('sums tenders, due, lines and bottles per bill', async () => {
    const s = setup();
    const b = await busyDay(s);
    const byId = new Map((await s.orders.listOrders()).map((o) => [o.billId, o]));
    const get = (id: string) => byId.get(id) as OrderSummary;

    expect(get(b.upi.id)).toMatchObject({ lines: 1, bottles: 2, totalPaise: 2n * PAISE.quarter, upiPaise: 2n * PAISE.quarter, cashPaise: 0n, duePaise: 0n });
    expect(get(b.partPaid.id)).toMatchObject({ cashPaise: 200_00n, upiPaise: PAISE.half - 200_00n, waiter: { code: 'W01' } });
    expect(get(b.credit.id)).toMatchObject({ creditPaise: PAISE.quarter, waiter: { code: 'W03' } });
    expect(get(b.owing.id)).toMatchObject({ bottles: 2, cashPaise: 100_00n, duePaise: 2n * PAISE.beer330 - 100_00n });
    expect(get(b.cancelled.id)).toMatchObject({ lines: 0, bottles: 0, totalPaise: 0n });
    // A void keeps the bill's own lines and tenders; the refund lives on the reversal.
    expect(get(b.voided.id)).toMatchObject({ bottles: 1, cashPaise: PAISE.beer650, voidedAt: expect.any(Date) });
    expect(get(b.peakKept.id)).toMatchObject({ mode: 'PEAK', peakSessionNo: 1, bottles: 2, totalPaise: 2n * PAISE.beer650 });
    expect(get(b.peakPending.id)).toMatchObject({ peakSessionNo: 2 });
    expect(get(b.app.id)).toMatchObject({ source: 'WAITER_APP' });
  });

  it('tells each bill’s settlement story: counter, waiter (lump sum), peak, void', async () => {
    const s = setup();
    const b = await busyDay(s);

    const cash = await s.orders.getOrder(b.cash.id);
    expect(cash).toMatchObject({ settledVia: 'COUNTER', cashier: 'Counter 1', reversal: null, peakSession: null });
    expect(cash.payments).toEqual([expect.objectContaining({ tender: 'CASH', amountPaise: PAISE.full, receiptTotalPaise: null })]);

    const app = await s.orders.getOrder(b.app.id);
    expect(app.settledVia).toBe('WAITER');
    expect(app.payments).toEqual([expect.objectContaining({ tender: 'UPI', amountPaise: PAISE.quarter, receiptTotalPaise: b.lump })]);

    const peakKept = await s.orders.getOrder(b.peakKept.id);
    expect(peakKept).toMatchObject({ settledVia: 'PEAK', peakSession: { sessionNo: 1, endedAt: expect.any(Date) }, payments: [] });

    const voided = await s.orders.getOrder(b.voided.id);
    expect(voided.reversal).toMatchObject({ reason: 'wrong bottle', refunds: [{ tender: 'CASH', amountPaise: -PAISE.beer650 }] });
    expect(voided.detail.items).toHaveLength(1);

    expect((await s.orders.getOrder(b.open.id)).settledVia).toBeNull();
    await expect(s.orders.getOrder('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/bill/);
  });

  it('builds the reprint receipt from what was sold, noting a void', async () => {
    const s = setup();
    const b = await busyDay(s);
    const upi = receiptFor(await s.orders.getOrder(b.upi.id), new Date('2026-10-14T16:00:00Z'));
    expect(upi.lines).toEqual([{ displayName: 'House Rum — Quarter', sizeCode: 'QUARTER', quantity: 2, unitPricePaise: PAISE.quarter, amountPaise: 2n * PAISE.quarter }]);
    expect(upi.payments).toEqual([{ tender: 'UPI', amountPaise: 2n * PAISE.quarter }]);

    const voided = receiptFor(await s.orders.getOrder(b.voided.id), null);
    expect(voided.lines.map((l) => l.quantity)).toEqual([1]);
    expect(voided.note).toMatch(/^VOIDED \d\d:\d\d - wrong bottle$/);
    expect(receiptFor(await s.orders.getOrder(b.peakKept.id), null)).toMatchObject({ servedBy: 'Peak #1 - Counter 1', note: 'PEAK SALE - settled with the session count' });
  });

  it("returns only the open day's bills, and none with no open day", async () => {
    const s = setup();
    const { fx, billing, orders, dayEnd } = s;
    const yesterday = await billing.createBill('NORMAL', fx.cashier);
    await billing.addItemToBill(yesterday.id, fx.sku.quarter, 1);
    await billing.settleNormalBill(yesterday.id, [{ mode: 'CASH', amount: PAISE.quarter }]);
    const summary = await dayEnd.getDayEndSummary(fx.dayId);
    await dayEnd.closeBusinessDay(fx.dayId, summary.breakdown.expectedCashPaise, fx.manager);
    expect(await orders.listOrders()).toEqual([]);

    await dayEnd.openBusinessDay(0n, fx.manager, '2026-10-15');
    const today = await billing.createBill('NORMAL', fx.cashier);
    expect((await orders.listOrders()).map((o) => o.billId)).toEqual([today.id]);
    // A previous day's bill still opens by id (e.g. a reprint).
    expect((await orders.getOrder(yesterday.id)).summary.status).toBe('SETTLED');
  });
});

describe('formatReceipt', () => {
  it('prints a 48-column DUPLICATE receipt with Indian grouping and no tax lines', () => {
    const text = formatReceipt({
      billNo: 57,
      createdAt: new Date('2026-10-14T15:30:00Z'),
      servedBy: 'Waiter: W01 Suresh',
      member: { membershipNo: 'M-9', displayName: 'Nine' },
      lines: [
        { displayName: 'House Rum — Quarter', sizeCode: 'QUARTER', quantity: 2, unitPricePaise: 60_000n, amountPaise: 120_000n },
        { displayName: 'House Lager — 650', sizeCode: 'BEER_650', quantity: 1, unitPricePaise: 25_000n, amountPaise: 25_000n },
      ],
      totalPaise: 145_000n,
      payments: [
        { tender: 'CASH', amountPaise: 100_000n },
        { tender: 'WAITER_CREDIT', amountPaise: 45_000n },
      ],
      duePaise: 0n,
      note: null,
      reprintedAt: new Date('2026-10-14T16:05:00Z'),
    });
    expect(text).toBe(
      [
        '================================================',
        '                      FL2',
        '               *** DUPLICATE ***',
        '================================================',
        'Bill #57                       14/10/2026, 21:00',
        'Waiter: W01 Suresh',
        'Member: M-9 Nine',
        '------------------------------------------------',
        'QTY  ITEM                                 AMOUNT',
        '  2  House Rum - Quarter             Rs 1,200.00',
        '     @ Rs 600.00',
        '  1  House Lager - 650                 Rs 250.00',
        '------------------------------------------------',
        'TOTAL  (3 items)                     Rs 1,450.00',
        '  Cash                               Rs 1,000.00',
        '  Waiter credit                        Rs 450.00',
        '================================================',
        '          Reprinted 14/10/2026, 21:35',
        '                   Thank you',
      ].join('\n'),
    );
    expect(text).not.toMatch(/GST|tax/i);
    expect(text).toMatch(/^[\x20-\x7e\n]*$/); // ASCII only: printer code pages
  });

  it('folds names to ASCII for the printer', () => {
    expect(asciiText('House Whisky — Quarter')).toBe('House Whisky - Quarter');
    expect(asciiText('Café Añejo – 750')).toBe('Cafe Anejo - 750');
    expect(asciiText('Rum ★ Special')).toBe('Rum Special');
  });

  it('formats paise as ASCII rupees with Indian digit grouping', () => {
    expect(receiptMoney(0n)).toBe('Rs 0.00');
    expect(receiptMoney(5n)).toBe('Rs 0.05');
    expect(receiptMoney(99_999n)).toBe('Rs 999.99');
    expect(receiptMoney(12_345_678_90n)).toBe('Rs 1,23,45,678.90');
    expect(receiptMoney(-25_000n)).toBe('-Rs 250.00');
  });
});
