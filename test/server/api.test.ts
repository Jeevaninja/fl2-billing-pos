import { describe, expect, it } from 'vitest';
import { MISSING, useApi } from '../support/api.js';
import { useSeededDb } from '../support/db.js';
import { OPENING_QTY, PRICE } from '../support/fixtures.js';

describe('local HTTP API', () => {
  const ctx = useSeededDb();
  const start = useApi(ctx);

  it('reports health and the counter context with money as strings and dates as ISO', async () => {
    const { fx, call } = await start();
    expect(await call('GET', '/api/health')).toEqual({ status: 200, body: { ok: true } });

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
