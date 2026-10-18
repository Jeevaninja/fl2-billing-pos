import { describe, expect, it } from 'vitest';
import { MISSING, useApi } from '../support/api.js';
import { useSeededDb } from '../support/db.js';
import { OPENING_QTY, PRICE } from '../support/fixtures.js';

describe('local HTTP API', () => {
  const ctx = useSeededDb();
  const start = useApi(ctx);

  it('reports health and the counter context with money as strings and dates as ISO', async () => {
    const { fx, call } = await start();
    expect(await call('GET', '/api/health')).toMatchObject({ status: 200, body: { ok: true } });

    const started = await call('POST', '/api/peak/sessions', { businessDayId: fx.dayId, declaredCash: '50000', declaredUpi: '0' });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ startCashPaise: '50000', startUpiPaise: '0', endCashPaise: null });

    const { status, body } = await call('GET', '/api/context');
    expect(status).toBe(200);
    expect(body.cashier).toEqual({ id: fx.cashier, displayName: 'Counter 1', role: 'CASHIER' });
    expect(body.businessDay).toMatchObject({ id: fx.dayId, businessDate: '2026-10-14' });
    expect(body.businessDay.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(body.peakSession).toMatchObject({ id: started.body.id, runningExpectedPaise: '0' });
    expect(body.openBill).toBeNull();
    expect(body.openBills).toEqual([]);
  });

  it('lists today\'s orders, opens one, and reprints a DUPLICATE receipt to the printer', async () => {
    const { fx, call } = await start({ printer: { printReceipt: async (t) => ({ printedAt: new Date(), text: `DUPLICATE #${t.billNo}` }) } });
    const bill = await call('POST', '/api/bills', { mode: 'NORMAL' });
    await call('POST', `/api/bills/${bill.body.id}/items`, { skuId: fx.sku.quarter, quantity: 2 });
    await call('POST', `/api/bills/${bill.body.id}/settle`, { payments: [{ mode: 'UPI', amount: String(2 * PRICE.quarter) }] });

    const list = await call('GET', '/api/orders');
    expect(list).toMatchObject({ status: 200, body: [{ billId: bill.body.id, status: 'SETTLED', bottles: 2, upiPaise: String(2 * PRICE.quarter), cashPaise: '0' }] });

    const detail = await call('GET', `/api/orders/${bill.body.id}`);
    expect(detail.body).toMatchObject({ settledVia: 'COUNTER', summary: { billNo: bill.body.billNo }, payments: [{ tender: 'UPI', receiptTotalPaise: null }] });
    expect((await call('GET', `/api/orders/${MISSING}`)).status).toBe(404);

    const reprint = await call('POST', `/api/orders/${bill.body.id}/reprint`, {});
    expect(reprint).toMatchObject({ status: 201, body: { text: `DUPLICATE #${bill.body.billNo}` } });
  });

  it('runs the waiter ledger: list, detail, lump sum, settle selected', async () => {
    const { fx, call } = await start();
    const bills: string[] = [];
    for (const skuId of [fx.sku.half, fx.sku.quarter]) {
      const bill = await call('POST', '/api/bills', { mode: 'NORMAL' });
      await call('POST', `/api/bills/${bill.body.id}/items`, { skuId, quantity: 1 });
      await call('PUT', `/api/bills/${bill.body.id}/waiter`, { waiterId: fx.waiter.trusted });
      bills.push(bill.body.id);
    }

    const list = await call('GET', '/api/waiter-ledger');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject([{ code: 'W01', billedPaise: String(PRICE.half + PRICE.quarter), paidPaise: '0', openBills: 2 }]);

    const lump = await call('POST', `/api/waiters/${fx.waiter.trusted}/receive`, { amount: String(PRICE.half), tender: 'CASH' });
    expect(lump).toMatchObject({ status: 201, body: { amountPaise: String(PRICE.half), balancePaise: String(PRICE.quarter), allocations: [{ kind: 'BILL', settled: true }] } });

    const over = await call('POST', `/api/waiters/${fx.waiter.trusted}/receive`, { amount: String(PRICE.full), tender: 'CASH' });
    expect(over).toMatchObject({ status: 409, body: { error: { code: 'PS008' } } });
    expect((await call('POST', `/api/waiters/${fx.waiter.trusted}/settle-bills`, { billIds: 'x', tender: 'CASH' })).status).toBe(400);

    const settled = await call('POST', `/api/waiters/${fx.waiter.trusted}/settle-bills`, { billIds: [bills[1]], tender: 'UPI' });
    expect(settled).toMatchObject({ status: 201, body: { totalPaise: String(PRICE.quarter), balancePaise: '0' } });

    const detail = await call('GET', `/api/waiter-ledger/${fx.waiter.trusted}`);
    expect(detail.body).toMatchObject({ creditPaise: '0', openBills: [], waiter: { balancePaise: '0' } });
    expect(detail.body.receipts.map((r: { tender: string }) => r.tender)).toEqual(['UPI', 'CASH']);
  });

  it("reports today's waiter figures with money as strings, and every held bill in the context", async () => {
    const { fx, call } = await start();
    const held = await call('POST', '/api/bills', { mode: 'NORMAL' });
    await call('POST', `/api/bills/${held.body.id}/items`, { skuId: fx.sku.full, quantity: 1 });
    await call('PUT', `/api/bills/${held.body.id}/waiter`, { waiterId: fx.waiter.trusted });
    const next = await call('POST', '/api/bills', { mode: 'NORMAL' });

    const context = await call('GET', '/api/context');
    expect(context.body.openBills.map((d: { bill: { id: string } }) => d.bill.id)).toEqual([held.body.id, next.body.id]);
    expect(context.body.openBill.bill.id).toBe(next.body.id);

    const stats = await call('GET', '/api/waiters/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.businessDayId).toBe(fx.dayId);
    expect(stats.body.waiters[0]).toMatchObject({
      code: 'W01',
      openBills: 1,
      openDuePaise: String(PRICE.full),
      closedBills: 0,
      settledPaise: '0',
      outstandingPaise: '0',
    });
    expect(stats.body.totals).toEqual({ openBills: 1, openDuePaise: String(PRICE.full), closedBills: 0, settledPaise: '0' });
  });

  it('runs a NORMAL bill end to end: lookup, create, add, cancel, member, settle', async () => {
    const { db, fx, call } = await start();
    await db.query(`UPDATE skus SET barcode = '8901234567890' WHERE id = $1`, [fx.sku.full]);
    const member = await db.query<{ id: string }>(`INSERT INTO members (membership_no, display_name) VALUES ('M-9', 'Nine') RETURNING id`);
    const memberId = member.rows[0]!.id;

    const sku = await call('GET', '/api/skus/lookup?code=8901234567890');
    expect(sku).toMatchObject({ status: 200, body: { id: fx.sku.full, pricePaise: String(PRICE.full), onHandQty: OPENING_QTY } });

    const bill = await call('POST', '/api/bills', { mode: 'NORMAL' });
    expect(bill).toMatchObject({ status: 201, body: { mode: 'NORMAL', status: 'OPEN', totalPaise: '0', memberId: null } });
    const billId: string = bill.body.id;

    const added = await call('POST', `/api/bills/${billId}/items`, { skuId: fx.sku.full, quantity: 2 });
    expect(added).toMatchObject({ status: 201, body: { bill: { totalPaise: String(2 * PRICE.full) }, item: { quantity: 2 } } });

    const cancelled = await call('POST', `/api/bills/${billId}/items/${added.body.item.id}/cancel`, { quantity: 1 });
    expect(cancelled).toMatchObject({ status: 201, body: { bill: { totalPaise: String(PRICE.full) }, item: { quantity: -1 } } });

    expect(await call('PUT', `/api/bills/${billId}/member`, { memberId })).toMatchObject({ status: 200, body: { memberId } });

    const resumed = await call('GET', '/api/context');
    expect(resumed.body.openBill).toMatchObject({ bill: { id: billId }, member: { membershipNo: 'M-9' }, duePaise: String(PRICE.full) });

    const half = String(PRICE.full / 2);
    const settled = await call('POST', `/api/bills/${billId}/settle`, {
      payments: [
        { mode: 'CASH', amount: half },
        { mode: 'UPI', amount: half },
      ],
    });
    expect(settled).toMatchObject({ status: 200, body: { bill: { status: 'SETTLED' } } });
    expect(settled.body.payments.map((p: { tender: string; amountPaise: string }) => [p.tender, p.amountPaise])).toEqual([
      ['CASH', half],
      ['UPI', half],
    ]);

    const detail = await call('GET', `/api/bills/${billId}`);
    expect(detail.body).toMatchObject({ tenderedPaise: String(PRICE.full), duePaise: '0' });
    expect(detail.body.items.map((i: { remainingQuantity: number }) => i.remainingQuantity)).toEqual([1, 0]);

    expect(await call('PUT', `/api/bills/${billId}/member`, { memberId: null })).toMatchObject({
      status: 409,
      body: { error: { code: 'PS001' } },
    });
  });

  it('settles trusted-waiter bills partially and on credit; untrusted credit is a 409 PS004', async () => {
    const { fx, call } = await start();
    const bill = (await call('POST', '/api/bills', { mode: 'NORMAL' })).body;
    await call('POST', `/api/bills/${bill.id}/items`, { skuId: fx.sku.half, quantity: 1 });
    expect((await call('PUT', `/api/bills/${bill.id}/waiter`, { waiterId: fx.waiter.trusted })).body).toMatchObject({
      waiterId: fx.waiter.trusted,
      waiterTrustedAtBilling: true,
    });

    const part = await call('POST', `/api/bills/${bill.id}/settle-waiter`, { waiterId: fx.waiter.trusted, tender: 'UPI', amount: '20000' });
    expect(part).toMatchObject({ status: 200, body: { bill: { status: 'OPEN' }, remainingDuePaise: String(PRICE.half - 20000) } });
    const rest = await call('POST', `/api/bills/${bill.id}/settle-waiter`, { waiterId: fx.waiter.trusted, tender: 'WAITER_CREDIT' });
    expect(rest).toMatchObject({ status: 200, body: { bill: { status: 'SETTLED' }, remainingDuePaise: '0' } });

    const repaid = await call('POST', `/api/waiters/${fx.waiter.trusted}/repayments`, { amount: '10000', tender: 'CASH' });
    expect(repaid).toMatchObject({ status: 201, body: { outstandingPaise: String(PRICE.half - 20000 - 10000) } });
    const waiters = await call('GET', '/api/waiters');
    expect(waiters.body[0]).toMatchObject({ code: 'W01', outstandingPaise: String(PRICE.half - 30000), creditLimitPaise: null });

    const strict = (await call('POST', '/api/bills', { mode: 'NORMAL' })).body;
    await call('POST', `/api/bills/${strict.id}/items`, { skuId: fx.sku.quarter, quantity: 1 });
    await call('PUT', `/api/bills/${strict.id}/waiter`, { waiterId: fx.waiter.untrusted });
    expect(
      await call('POST', `/api/bills/${strict.id}/settle-waiter`, { waiterId: fx.waiter.untrusted, tender: 'WAITER_CREDIT' }),
    ).toMatchObject({ status: 409, body: { error: { code: 'PS004' } } });
  });

  it('records peak scans as one bill each, undoes with a reversal, and ends the session', async () => {
    const { fx, call } = await start();
    const session = (await call('POST', '/api/peak/sessions', { businessDayId: fx.dayId, declaredCash: '0', declaredUpi: '0' })).body;

    const first = await call('POST', '/api/peak/sales', { sessionId: session.id, skuId: fx.sku.beer650, quantity: 1 });
    const second = await call('POST', '/api/peak/sales', { sessionId: session.id, skuId: fx.sku.beer650, quantity: 1 });
    expect(first).toMatchObject({ status: 201, body: { bill: { mode: 'PEAK', status: 'PEAK_UNSETTLED' } } });
    expect(second.body.bill.billNo).toBe(first.body.bill.billNo + 1);

    const undo = await call('POST', `/api/bills/${second.body.bill.id}/reverse`, { reason: 'Undo scan' });
    expect(undo).toMatchObject({ status: 201, body: { reversal: { kind: 'REVERSAL', reversesBillId: second.body.bill.id }, refunds: [] } });
    expect((await call('GET', '/api/context')).body.peakSession.runningExpectedPaise).toBe(String(PRICE.beer650));

    const ended = await call('POST', `/api/peak/sessions/${session.id}/end`, { countedCash: String(PRICE.beer650), countedUpi: '0' });
    expect(ended).toMatchObject({ status: 200, body: { breakdown: { expectedPaise: String(PRICE.beer650), variancePaise: '0' } } });
    expect((await call('GET', '/api/context')).body.peakSession).toBeNull();
  });

  it('runs Day End: checklist, expense, blocked close, repayment, lock, then a new day with a float', async () => {
    const { fx, call } = await start();
    const bill = (await call('POST', '/api/bills', { mode: 'NORMAL' })).body;
    await call('POST', `/api/bills/${bill.id}/items`, { skuId: fx.sku.quarter, quantity: 1 });
    await call('PUT', `/api/bills/${bill.id}/waiter`, { waiterId: fx.waiter.trusted });
    await call('POST', `/api/bills/${bill.id}/settle-waiter`, { waiterId: fx.waiter.trusted, tender: 'WAITER_CREDIT' });
    expect(await call('POST', '/api/expenses', { amount: '5000', description: 'Ice' })).toMatchObject({
      status: 201,
      body: { amountPaise: '5000', description: 'Ice', businessDayId: fx.dayId },
    });
    expect(await call('POST', '/api/expenses', { amount: '5000', description: '  ' })).toMatchObject({ status: 400 });

    const summary = await call('GET', '/api/day-end');
    expect(summary).toMatchObject({
      status: 200,
      body: {
        day: { id: fx.dayId, status: 'OPEN', openingFloatPaise: '0', countedCashPaise: null },
        canClose: false,
        blockers: {
          openBills: [],
          runningPeakSession: null,
          waitersOwing: [{ code: 'W01', outstandingPaise: String(PRICE.quarter) }],
          waiterBalance: { totalPaise: String(PRICE.quarter), openBillsPaise: '0', creditPaise: String(PRICE.quarter), waiters: 1 },
        },
        breakdown: { cashExpensesPaise: '5000', expectedCashPaise: '-5000' },
      },
    });

    const blocked = await call('POST', `/api/days/${fx.dayId}/close`, { countedCash: '0' });
    expect(blocked).toMatchObject({ status: 409, body: { error: { code: 'PS007' } } });
    await call('POST', `/api/waiters/${fx.waiter.trusted}/repayments`, { amount: String(PRICE.quarter), tender: 'CASH' });
    expect(await call('POST', `/api/days/${fx.dayId}/close`, { countedCash: 3 })).toMatchObject({ status: 400 });

    const closed = await call('POST', `/api/days/${fx.dayId}/close`, { countedCash: String(PRICE.quarter - 5000 - 100) });
    expect(closed).toMatchObject({
      status: 200,
      body: { day: { status: 'CLOSED', expectedCashPaise: String(PRICE.quarter - 5000), cashVariancePaise: '-100' }, canClose: false },
    });
    expect((await call('GET', '/api/day-end')).body.day).toMatchObject({ id: fx.dayId, status: 'CLOSED' });
    expect((await call('GET', '/api/context')).body.businessDay).toBeNull();
    expect(await call('POST', '/api/bills', { mode: 'NORMAL' })).toMatchObject({ status: 409, body: { error: { code: 'PS007' } } });

    const opened = await call('POST', '/api/days', { openingFloat: '200000' });
    expect(opened).toMatchObject({ status: 201, body: { status: 'OPEN', openingFloatPaise: '200000' } });
    expect(opened.body.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await call('GET', '/api/day-end')).body).toMatchObject({ day: { id: opened.body.id }, canClose: true, breakdown: { expectedCashPaise: '200000' } });
    expect(await call('POST', '/api/days', { openingFloat: '0' })).toMatchObject({ status: 409, body: { error: { code: 'PS007' } } });
  });

  it('undoes the till\'s last peak scan with POST /api/peak/undo-last', async () => {
    const { fx, call } = await start();
    expect(await call('POST', '/api/peak/undo-last', {})).toMatchObject({ status: 409, body: { error: { code: 'PS007' } } });
    const session = (await call('POST', '/api/peak/sessions', { businessDayId: fx.dayId, declaredCash: '0', declaredUpi: '0' })).body;
    const sale = (await call('POST', '/api/peak/sales', { sessionId: session.id, skuId: fx.sku.quarter, quantity: 1 })).body;

    expect(await call('POST', '/api/peak/undo-last', {})).toMatchObject({
      status: 201,
      body: {
        reversal: { kind: 'REVERSAL', reversesBillId: sale.bill.id, totalPaise: String(-PRICE.quarter) },
        undone: { billId: sale.bill.id, billNo: sale.bill.billNo, sessionNo: 1, sizeCode: 'QUARTER', quantity: 1, totalPaise: String(PRICE.quarter) },
      },
    });
    expect((await call('GET', '/api/context')).body.peakSession.runningExpectedPaise).toBe('0');
    expect(await call('POST', '/api/peak/undo-last', {})).toMatchObject({ status: 404 });
  });

  it('records and voids a Cash ⇄ UPI tally adjustment; only the cash delta is accepted', async () => {
    const { fx, call } = await start();
    const bill = (await call('POST', '/api/bills', { mode: 'NORMAL' })).body;
    await call('POST', `/api/bills/${bill.id}/items`, { skuId: fx.sku.half, quantity: 1 });
    await call('POST', `/api/bills/${bill.id}/settle`, { payments: [{ mode: 'UPI', amount: String(PRICE.half) }] });

    const path = `/api/days/${fx.dayId}/tender-adjustments`;
    expect(await call('POST', path, { cashDelta: '0', reason: 'x' })).toMatchObject({ status: 400 });
    expect(await call('POST', path, { cashDelta: '100' })).toMatchObject({ status: 400 });
    expect(await call('POST', path, { cashDelta: 100, reason: 'x' })).toMatchObject({ status: 400 });
    expect(await call('POST', path, { cashDelta: String(PRICE.half + 1), reason: 'x' })).toMatchObject({ status: 409, body: { error: { code: 'PS002' } } });

    const adj = await call('POST', path, { cashDelta: '50000', upiDelta: '-1', reason: 'paid cash' });
    expect(adj).toMatchObject({ status: 201, body: { cashDeltaPaise: '50000', upiDeltaPaise: '-50000', systemUpiPaise: String(PRICE.half) } });
    const summary = (await call('GET', '/api/day-end')).body;
    expect(summary.breakdown).toMatchObject({ tenderAdjustmentPaise: '50000', expectedCashPaise: '50000' });
    expect(summary.sales.normal).toMatchObject({ cashPaise: '50000', upiPaise: String(PRICE.half - 50000), totalPaise: String(PRICE.half) });
    expect(summary.tenderAdjustments).toEqual([expect.objectContaining({ id: adj.body.id, reason: 'paid cash', voidedAt: null })]);

    expect(await call('POST', `/api/tender-adjustments/${adj.body.id}/void`, {})).toMatchObject({ status: 201, body: { cashDeltaPaise: '-50000' } });
    expect(await call('POST', `/api/tender-adjustments/${adj.body.id}/void`, {})).toMatchObject({ status: 409, body: { error: { code: 'PS006' } } });
    expect((await call('GET', '/api/day-end')).body.breakdown.tenderAdjustmentPaise).toBe('0');
  });

  it('records, lists and voids a bank deposit; it lowers expected cash, not sales', async () => {
    const { fx, call } = await start();
    const bill = (await call('POST', '/api/bills', { mode: 'NORMAL' })).body;
    await call('POST', `/api/bills/${bill.id}/items`, { skuId: fx.sku.full, quantity: 1 });
    await call('POST', `/api/bills/${bill.id}/settle`, { payments: [{ mode: 'CASH', amount: String(PRICE.full) }] });
    const before = (await call('GET', '/api/day-end')).body;

    expect(await call('POST', '/api/bank-deposits', { amount: '0' })).toMatchObject({ status: 400 });
    expect(await call('POST', '/api/bank-deposits', { amount: 1000 })).toMatchObject({ status: 400 });
    const deposit = await call('POST', '/api/bank-deposits', { amount: '100000', reference: 'RTGS to Sri Balaji' });
    expect(deposit).toMatchObject({ status: 201, body: { amountPaise: '100000', reference: 'RTGS to Sri Balaji', reversesDepositId: null } });
    expect(await call('POST', '/api/bank-deposits', { amount: '500' })).toMatchObject({ status: 201, body: { reference: null } });

    const listed = await call('GET', '/api/bank-deposits');
    expect(listed.body).toHaveLength(2);
    const after = (await call('GET', '/api/day-end')).body;
    expect(after.breakdown).toMatchObject({
      bankDepositsPaise: '100500',
      expectedCashPaise: String(BigInt(before.breakdown.expectedCashPaise) - 100500n),
    });
    expect(after.sales).toEqual(before.sales);

    expect(await call('POST', `/api/bank-deposits/${deposit.body.id}/void`, {})).toMatchObject({ status: 201, body: { amountPaise: '-100000' } });
    expect(await call('POST', `/api/bank-deposits/${deposit.body.id}/void`, {})).toMatchObject({ status: 409, body: { error: { code: 'PS006' } } });
    expect((await call('GET', '/api/day-end')).body.breakdown.bankDepositsPaise).toBe('500');

    await call('POST', `/api/days/${fx.dayId}/close`, { countedCash: String(BigInt(after.breakdown.expectedCashPaise) + 100000n) });
    expect(await call('GET', '/api/bank-deposits')).toMatchObject({ status: 404 });
    expect(await call('POST', '/api/bank-deposits', { amount: '100' })).toMatchObject({ status: 409, body: { error: { code: 'PS007' } } });
  });

  it('serves the peak start baseline for the open day and the sales breakdown on Day End', async () => {
    const { fx, call } = await start();
    const bill = (await call('POST', '/api/bills', { mode: 'NORMAL' })).body;
    await call('POST', `/api/bills/${bill.id}/items`, { skuId: fx.sku.half, quantity: 1 });
    await call('POST', `/api/bills/${bill.id}/settle`, { payments: [{ mode: 'UPI', amount: String(PRICE.half) }] });

    expect(await call('GET', '/api/peak/baseline')).toMatchObject({
      status: 200,
      body: { businessDayId: fx.dayId, expectedCashPaise: '0', billUpiPaise: String(PRICE.half), expectedUpiPaise: String(PRICE.half) },
    });
    expect((await call('GET', '/api/day-end')).body.sales).toEqual({
      normal: { cashPaise: '0', upiPaise: String(PRICE.half), creditPaise: '0', totalPaise: String(PRICE.half), systemCashPaise: '0', systemUpiPaise: String(PRICE.half) },
      peak: { salesPaise: '0', cashPaise: '0', upiPaise: '0', sessionCount: 0, runningSessionNo: null },
      waiterRepayments: { cashPaise: '0', upiPaise: '0' },
      total: { cashPaise: '0', upiPaise: String(PRICE.half), creditPaise: '0', salesPaise: String(PRICE.half) },
    });

    await call('POST', `/api/days/${fx.dayId}/close`, { countedCash: '0' });
    expect(await call('GET', '/api/peak/baseline')).toMatchObject({ status: 404 });
  });

  it('records, lists and voids categorised expenses', async () => {
    const { fx, call } = await start();
    const ice = await call('POST', '/api/expenses', { amount: '15000', category: 'ICE' });
    expect(ice).toMatchObject({ status: 201, body: { category: 'ICE', description: null, amountPaise: '15000' } });
    await call('POST', '/api/expenses', { amount: '4000', category: 'OTHER', description: 'Tea' });
    expect(await call('POST', '/api/expenses', { amount: '4000', category: 'OTHER' })).toMatchObject({ status: 400 });
    expect(await call('POST', '/api/expenses', { amount: '4000', category: 'PARTY', description: 'x' })).toMatchObject({ status: 400 });

    const voided = await call('POST', `/api/expenses/${ice.body.id}/void`, {});
    expect(voided).toMatchObject({ status: 201, body: { amountPaise: '-15000', reversesExpenseId: ice.body.id, category: 'ICE' } });
    expect(await call('POST', `/api/expenses/${ice.body.id}/void`, {})).toMatchObject({ status: 409, body: { error: { code: 'PS006' } } });

    const list = await call('GET', '/api/expenses');
    expect(list.status).toBe(200);
    expect(list.body.map((e: { description: string | null; voidedAt: string | null }) => [e.description, e.voidedAt === null])).toEqual([
      ['Tea', true],
      [null, false],
    ]);

    await call('POST', `/api/days/${fx.dayId}/close`, { countedCash: '0' });
    expect(await call('GET', '/api/expenses')).toMatchObject({ status: 404 });
  });

  it('searches members and returns 404 for unknown SKUs and bills', async () => {
    const { db, call } = await start();
    await db.query(`INSERT INTO members (membership_no, display_name) VALUES ('M-1', 'Asha'), ('M-2', 'Ravi')`);
    expect((await call('GET', '/api/members?q=ash')).body).toEqual([{ id: expect.any(String), membershipNo: 'M-1', displayName: 'Asha' }]);
    expect((await call('GET', '/api/members?q=M-&limit=1')).body).toHaveLength(1);
    expect((await call('GET', '/api/members?q=M-&limit=0')).status).toBe(400);

    expect(await call('GET', '/api/skus/lookup?code=NOPE')).toMatchObject({
      status: 404,
      body: { error: { code: 'NOT_FOUND', entity: 'sku', id: 'NOPE' } },
    });
    expect(await call('GET', `/api/bills/${MISSING}`)).toMatchObject({ status: 404, body: { error: { entity: 'bill' } } });
  });

  it('maps business-rule violations to 409 with the PS code', async () => {
    const { fx, call } = await start();
    const bill = (await call('POST', '/api/bills', { mode: 'NORMAL' })).body;
    expect(await call('POST', `/api/bills/${bill.id}/items`, { skuId: fx.sku.full, quantity: OPENING_QTY + 1 })).toMatchObject({
      status: 409,
      body: { error: { code: 'PS003', message: expect.stringMatching(/insufficient stock/) } },
    });
    expect(await call('POST', `/api/bills/${bill.id}/settle`, { payments: [{ mode: 'CASH', amount: '1' }] })).toMatchObject({
      status: 409,
      body: { error: { code: 'PS005' } },
    });
    expect(await call('POST', '/api/bills', { mode: 'PEAK' })).toMatchObject({ status: 409, body: { error: { code: 'PS007' } } });
  });

  it.each([
    ['money as a JSON number', '/settle', { payments: [{ mode: 'CASH', amount: 100 }] }],
    ['money with decimals', '/settle', { payments: [{ mode: 'CASH', amount: '10.50' }] }],
    ['negative money', '/settle', { payments: [{ mode: 'CASH', amount: '-100' }] }],
    ['an unknown tender', '/settle', { payments: [{ mode: 'CARD', amount: '100' }] }],
    ['a non-UUID SKU id', '/items', { skuId: 'abc', quantity: 1 }],
    ['a fractional quantity', '/items', { quantity: 1.5 }],
    ['a zero quantity', '/items', { quantity: 0 }],
    ['a missing memberId', '/member', {}],
  ])('rejects %s with 400', async (_label, suffix, body) => {
    const { fx, call } = await start();
    const bill = (await call('POST', '/api/bills', { mode: 'NORMAL' })).body;
    const payload = suffix === '/items' && !('skuId' in body) ? { skuId: fx.sku.full, ...body } : body;
    const method = suffix === '/member' ? 'PUT' : 'POST';
    expect(await call(method, `/api/bills/${bill.id}${suffix}`, payload)).toMatchObject({
      status: 400,
      body: { error: { code: 'BAD_REQUEST' } },
    });
  });

  it('guards the transport: unknown route, wrong method, bad JSON, non-JSON, foreign Host, oversized body', async () => {
    const { call } = await start();
    expect((await call('GET', '/api/nope')).status).toBe(404);
    expect(await call('DELETE', '/api/bills')).toMatchObject({ status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } });
    expect(await call('POST', '/api/bills', '{"mode":')).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    expect(await call('POST', '/api/bills', '{"mode":"NORMAL"}', { 'content-type': 'text/plain' })).toMatchObject({
      status: 415,
    });
    expect(await call('GET', '/api/health', undefined, { host: 'evil.example:4310' })).toMatchObject({
      status: 403,
      body: { error: { code: 'FORBIDDEN' } },
    });
    expect((await call('GET', '/api/health', undefined, { host: 'localhost:5173' })).status).toBe(200);
    expect((await call('POST', '/api/bills', JSON.stringify({ pad: 'x'.repeat(70_000) }))).status).toBe(413);
  });
});
