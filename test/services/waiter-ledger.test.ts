import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PosErrorCode } from '../../src/db/errors.js';
import { CaptainService, CounterQueries, DayEndService, type KotPrinter } from '../../src/services/index.js';
import { useSeededDb } from '../support/db.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

const silentPrinter: KotPrinter = { printKOT: async (t) => ({ station: t.station, printedAt: new Date(), text: '' }) };

describe('Waiter ledger (Phase 16)', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, queries: new CounterQueries(db), dayEnd: new DayEndService(db), captain: new CaptainService(db, silentPrinter), ...makeServices(db) };
  };

  /** A counter bill tagged to `waiterId` with `qty` × `sku`, left OPEN. */
  async function counterBill(s: ReturnType<typeof setup>, waiterId: string, sku: string, qty: number) {
    const bill = await s.billing.createBill('NORMAL', s.fx.cashier);
    await s.billing.addItemToBill(bill.id, sku, qty);
    await s.waiters.tagBillToWaiter(bill.id, waiterId);
    return bill;
  }

  it('3 bills → ₹2,000 lump sum → Day End blocked → settle the rest → Day End closes', async () => {
    const s = setup();
    const { fx, queries, dayEnd, waiters, captain } = s;
    const b1 = await counterBill(s, fx.waiter.trusted, fx.sku.half, 1); // ₹1,200
    const b2 = await counterBill(s, fx.waiter.trusted, fx.sku.quarter, 2); // ₹1,200
    const order = await captain.placeOrder({
      requestId: randomUUID(),
      deviceId: 'handset-01',
      waiterId: fx.waiter.trusted,
      items: [{ skuId: fx.sku.beer650, quantity: 1 }], // ₹250, from the Captain app
    });
    const billed = PAISE.half + 2n * PAISE.quarter + PAISE.beer650;

    let summary = await dayEnd.getDayEndSummary(fx.dayId);
    expect(summary.blockers.waiterBalance).toEqual({ totalPaise: billed, openBillsPaise: billed, creditPaise: 0n, waiters: 1 });
    expect(summary.canClose).toBe(false);

    // Mode B: the waiter hands over ₹2,000. Oldest bill first: #1 settled, #2 part-paid, the app order untouched.
    const receipt = await waiters.receiveWaiterPayment(fx.waiter.trusted, 2000_00n, 'CASH', fx.cashier);
    expect(receipt.allocations).toEqual([
      { kind: 'BILL', billId: b1.id, billNo: b1.billNo, amountPaise: PAISE.half, settled: true, remainingDuePaise: 0n },
      { kind: 'BILL', billId: b2.id, billNo: b2.billNo, amountPaise: 800_00n, settled: false, remainingDuePaise: 400_00n },
    ]);
    expect(receipt.balancePaise).toBe(billed - 2000_00n);

    let ledger = await queries.getWaiterLedger(fx.waiter.trusted);
    expect(ledger.waiter).toMatchObject({ billedPaise: billed, paidPaise: 2000_00n, balancePaise: billed - 2000_00n, openBills: 2 });
    expect(ledger.waiter.billedPaise - ledger.waiter.paidPaise).toBe(ledger.waiter.balancePaise);
    expect(ledger.openBills.map((d) => d.bill.id)).toEqual([b2.id, order.bill.id]);
    expect(ledger.receipts).toHaveLength(1);
    expect(ledger.receipts[0]).toMatchObject({
      tender: 'CASH',
      amountPaise: 2000_00n,
      allocations: [
        { kind: 'BILL', billNo: b1.billNo, amountPaise: PAISE.half, settled: true },
        { kind: 'BILL', billNo: b2.billNo, amountPaise: 800_00n, settled: false, remainingDuePaise: 400_00n },
      ],
    });

    // Still blocked: ₹650 left on open bills.
    summary = await dayEnd.getDayEndSummary(fx.dayId);
    expect(summary.blockers.waiterBalance).toMatchObject({ totalPaise: 650_00n, openBillsPaise: 650_00n });
    expect(summary.canClose).toBe(false);
    await expectPosError(dayEnd.closeBusinessDay(fx.dayId, summary.breakdown.expectedCashPaise, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE);

    // Mode A: settle the two remaining bills exactly, by UPI.
    const settled = await waiters.settleWaiterBills(fx.waiter.trusted, [order.bill.id, b2.id], 'UPI', fx.cashier);
    expect(settled.totalPaise).toBe(650_00n);
    expect(settled.balancePaise).toBe(0n);
    expect(settled.bills.map((b) => [b.billNo, b.status])).toEqual([
      [b2.billNo, 'SETTLED'],
      [order.bill.billNo, 'SETTLED'],
    ]);

    ledger = await queries.getWaiterLedger(fx.waiter.trusted);
    expect(ledger.waiter).toMatchObject({ billedPaise: billed, paidPaise: billed, balancePaise: 0n, openBills: 0 });
    expect(ledger.receipts.map((r) => [r.tender, r.amountPaise])).toEqual([
      ['UPI', 650_00n],
      ['CASH', 2000_00n],
    ]);

    summary = await dayEnd.getDayEndSummary(fx.dayId);
    expect(summary.blockers.waiterBalance.totalPaise).toBe(0n);
    expect(summary.canClose).toBe(true);
    expect(summary.breakdown.normalCashPaise).toBe(2000_00n);
    const closed = await dayEnd.closeBusinessDay(fx.dayId, summary.breakdown.expectedCashPaise, fx.cashier);
    expect(closed.day).toMatchObject({ status: 'CLOSED', cashVariancePaise: 0n });
  });

  it('spills a lump sum past the open bills onto the credit balance', async () => {
    const s = setup();
    const { fx, queries, dayEnd, waiters } = s;
    const onCredit = await counterBill(s, fx.waiter.trusted, fx.sku.quarter, 1);
    await waiters.settleWaiterBill(onCredit.id, fx.waiter.trusted, 'WAITER_CREDIT');
    const open = await counterBill(s, fx.waiter.trusted, fx.sku.beer650, 1);

    expect((await dayEnd.getDayEndSummary(fx.dayId)).blockers.waiterBalance).toEqual({
      totalPaise: PAISE.quarter + PAISE.beer650,
      openBillsPaise: PAISE.beer650,
      creditPaise: PAISE.quarter,
      waiters: 1,
    });

    const receipt = await waiters.receiveWaiterPayment(fx.waiter.trusted, PAISE.beer650 + 100_00n, 'UPI', fx.cashier);
    expect(receipt.allocations).toEqual([
      { kind: 'BILL', billId: open.id, billNo: open.billNo, amountPaise: PAISE.beer650, settled: true, remainingDuePaise: 0n },
      { kind: 'CREDIT', amountPaise: 100_00n },
    ]);
    const ledger = await queries.getWaiterLedger(fx.waiter.trusted);
    expect(ledger).toMatchObject({ creditPaise: PAISE.quarter - 100_00n, waiter: { balancePaise: PAISE.quarter - 100_00n } });
    expect(ledger.waiter.billedPaise - ledger.waiter.paidPaise).toBe(ledger.waiter.balancePaise);
    expect(ledger.receipts[0]?.allocations.map((a) => a.kind)).toEqual(['BILL', 'CREDIT']);

    await waiters.receiveWaiterPayment(fx.waiter.trusted, PAISE.quarter - 100_00n, 'CASH', fx.cashier);
    expect((await dayEnd.getDayEndSummary(fx.dayId)).canClose).toBe(true);
  });

  it('refuses a lump sum over what the waiter owes, or from an untrusted waiter', async () => {
    const s = setup();
    const { fx, waiters } = s;
    await counterBill(s, fx.waiter.trusted, fx.sku.quarter, 1);
    await expectPosError(waiters.receiveWaiterPayment(fx.waiter.trusted, PAISE.quarter + 1n, 'CASH', fx.cashier), PosErrorCode.WAITER_BALANCE, /owes only/);

    await counterBill(s, fx.waiter.untrusted, fx.sku.quarter, 1);
    await expectPosError(waiters.receiveWaiterPayment(fx.waiter.untrusted, 100_00n, 'CASH', fx.cashier), PosErrorCode.CREDIT_NOT_ALLOWED, /bill-on-bill/);
    await expect(waiters.receiveWaiterPayment(fx.waiter.trusted, 0n, 'CASH', fx.cashier)).rejects.toBeInstanceOf(RangeError);
  });

  it('settles whole bills for an untrusted waiter, but never on credit', async () => {
    const s = setup();
    const { fx, waiters, queries } = s;
    const a = await counterBill(s, fx.waiter.untrusted, fx.sku.quarter, 1);
    const b = await counterBill(s, fx.waiter.untrusted, fx.sku.beer330, 2);
    await expectPosError(waiters.settleWaiterBills(fx.waiter.untrusted, [a.id], 'WAITER_CREDIT', fx.cashier), PosErrorCode.CREDIT_NOT_ALLOWED);

    const result = await waiters.settleWaiterBills(fx.waiter.untrusted, [a.id, b.id], 'CASH', fx.cashier);
    expect(result).toMatchObject({ totalPaise: PAISE.quarter + 2n * PAISE.beer330, balancePaise: 0n });
    expect((await queries.getWaiterLedger(fx.waiter.untrusted)).receipts).toEqual([
      expect.objectContaining({ tender: 'CASH', amountPaise: PAISE.quarter + 2n * PAISE.beer330, allocations: [expect.objectContaining({ billNo: a.billNo, settled: true }), expect.objectContaining({ billNo: b.billNo, settled: true })] }),
    ]);
  });

  it('settles selected bills all or nothing', async () => {
    const s = setup();
    const { db, fx, waiters } = s;
    const mine = await counterBill(s, fx.waiter.trusted, fx.sku.quarter, 1);
    const theirs = await counterBill(s, fx.waiter.limited, fx.sku.quarter, 1);
    await expectPosError(waiters.settleWaiterBills(fx.waiter.trusted, [mine.id, theirs.id], 'CASH', fx.cashier), PosErrorCode.ILLEGAL_TRANSITION, /not tagged/);
    const { rows } = await db.query<{ status: string; n: number }>(
      `SELECT b.status, (SELECT count(*)::int FROM bill_payments p WHERE p.bill_id = b.id) AS n FROM bills b WHERE b.id = $1`,
      [mine.id],
    );
    expect(rows[0]).toEqual({ status: 'OPEN', n: 0 });

    await waiters.settleWaiterBills(fx.waiter.trusted, [mine.id], 'CASH', fx.cashier);
    await expectPosError(waiters.settleWaiterBills(fx.waiter.trusted, [mine.id], 'CASH', fx.cashier), PosErrorCode.APPEND_ONLY, /SETTLED/);
    await expect(waiters.settleWaiterBills(fx.waiter.trusted, [], 'CASH', fx.cashier)).rejects.toBeInstanceOf(RangeError);
  });

  it('puts a lump sum taken during a peak inside the peak window', async () => {
    const s = setup();
    const { db, fx, peak, waiters } = s;
    const bill = await counterBill(s, fx.waiter.trusted, fx.sku.quarter, 1);
    const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    await waiters.receiveWaiterPayment(fx.waiter.trusted, PAISE.quarter, 'CASH', fx.cashier);
    const { rows } = await db.query<{ peak_session_id: string | null }>(`SELECT peak_session_id FROM bill_payments WHERE bill_id = $1`, [bill.id]);
    expect(rows).toEqual([{ peak_session_id: session.id }]);
  });

  it('lists waiters with activity or a balance, biggest balance first', async () => {
    const s = setup();
    const { fx, queries, waiters } = s;
    expect(await queries.listWaiterLedger()).toEqual([]);

    const paid = await counterBill(s, fx.waiter.untrusted, fx.sku.beer330, 1);
    await waiters.settleWaiterBills(fx.waiter.untrusted, [paid.id], 'CASH', fx.cashier);
    await counterBill(s, fx.waiter.trusted, fx.sku.quarter, 1);
    await counterBill(s, fx.waiter.limited, fx.sku.half, 1);

    const rows = await queries.listWaiterLedger();
    expect(rows.map((r) => [r.code, r.balancePaise])).toEqual([
      ['W03', PAISE.half],
      ['W01', PAISE.quarter],
      ['W02', 0n],
    ]);
    expect(rows[2]).toMatchObject({ billedPaise: PAISE.beer330, paidPaise: PAISE.beer330, openBills: 0, newestOpenAt: null });
    expect(rows[0]?.newestOpenAt).toBeInstanceOf(Date);
    for (const r of rows) expect(r.billedPaise - r.paidPaise).toBe(r.balancePaise);
  });
});
