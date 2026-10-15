import { describe, expect, it } from 'vitest';
import { DayEndService } from '../../src/services/index.js';
import { MISSING, useApi } from '../support/api.js';
import { useSeededDb } from '../support/db.js';
import { OPENING_QTY, PRICE } from '../support/fixtures.js';

describe('local HTTP API: purchase (GRN)', () => {
  const ctx = useSeededDb();
  const start = useApi(ctx);

  it('searches SKUs with stock on hand', async () => {
    const { fx, call } = await start();
    const found = await call('GET', '/api/skus?q=house%20rum');
    expect(found.status).toBe(200);
    expect(found.body.map((s: { skuCode: string }) => s.skuCode)).toEqual(['HRUM-F', 'HRUM-H', 'HRUM-Q']);
    expect(found.body[0]).toMatchObject({ id: fx.sku.full, sizeCode: 'FULL', pricePaise: String(PRICE.full), onHandQty: OPENING_QTY });
    expect((await call('GET', '/api/skus?q=rum&limit=1')).body).toHaveLength(1);
    expect(await call('GET', '/api/skus?q=rum&limit=0')).toMatchObject({ status: 400 });
    expect(await call('GET', '/api/skus')).toMatchObject({ status: 200, body: [] });
  });

  it('inwards 10 bottles: lookup shows +10 at once, and a sale then takes one away', async () => {
    const { fx, call } = await start();
    const posted = await call('POST', '/api/purchases', {
      invoiceNo: 'INV-10',
      vendorName: 'Sri Balaji Distributors',
      lines: [{ skuId: fx.sku.full, quantity: 10, unitCost: '110000' }],
    });
    expect(posted.status).toBe(201);
    expect(posted.body.receipt).toMatchObject({ invoiceNo: 'INV-10', bottles: 10, lineCount: 1, totalCostPaise: '1100000', receivedBy: 'Counter 1' });
    expect(posted.body.lines).toEqual([expect.objectContaining({ skuCode: 'HRUM-F', quantity: 10, unitCostPaise: '110000', lineTotalPaise: '1100000' })]);

    expect((await call('GET', '/api/skus/lookup?code=HRUM-F')).body.onHandQty).toBe(OPENING_QTY + 10);

    const bill = await call('POST', '/api/bills', { mode: 'NORMAL' });
    await call('POST', `/api/bills/${bill.body.id}/items`, { skuId: fx.sku.full, quantity: 1 });
    expect((await call('GET', '/api/skus/lookup?code=HRUM-F')).body.onHandQty).toBe(OPENING_QTY + 9);
  });

  it("lists the open day's receipts and fetches one", async () => {
    const { fx, call } = await start();
    const a = await call('POST', '/api/purchases', { invoiceNo: 'A-1', lines: [{ skuId: fx.sku.half, quantity: 6, unitCost: '0' }] });
    const b = await call('POST', '/api/purchases', { invoiceNo: 'B-1', vendorName: null, lines: [{ skuId: fx.sku.beer650, quantity: 24, unitCost: '15000' }] });

    const list = await call('GET', '/api/purchases');
    expect(list.status).toBe(200);
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([b.body.receipt.id, a.body.receipt.id]);
    expect(list.body[1]).toMatchObject({ invoiceNo: 'A-1', vendorName: null, totalCostPaise: '0', bottles: 6 });

    expect(await call('GET', `/api/purchases/${a.body.receipt.id}`)).toMatchObject({ status: 200, body: a.body });
    expect(await call('GET', `/api/purchases/${MISSING}`)).toMatchObject({ status: 404 });
    expect(await call('GET', '/api/purchases/not-a-uuid')).toMatchObject({ status: 400 });
  });

  it('answers 409 PS011 for a duplicate invoice and 404 with no open day', async () => {
    const { db, fx, call } = await start();
    const body = { invoiceNo: 'INV-1', vendorName: 'Depot', lines: [{ skuId: fx.sku.full, quantity: 1, unitCost: '100' }] };
    expect((await call('POST', '/api/purchases', body)).status).toBe(201);
    expect(await call('POST', '/api/purchases', { ...body, invoiceNo: 'inv-1 ' })).toMatchObject({ status: 409, body: { error: { code: 'PS011' } } });

    await new DayEndService(db).closeBusinessDay(fx.dayId, 0n, fx.cashier);
    expect(await call('GET', '/api/purchases')).toMatchObject({ status: 404 });
    expect(await call('POST', '/api/purchases', { ...body, invoiceNo: 'INV-2' })).toMatchObject({ status: 409, body: { error: { code: 'PS007' } } });
  });

  it('rejects malformed bodies with 400 and unknown or inactive SKUs', async () => {
    const { db, fx, call } = await start();
    const line = { skuId: fx.sku.full, quantity: 1, unitCost: '100' };
    const bad = [
      { lines: [line] },
      { invoiceNo: 'X' },
      { invoiceNo: 'X', lines: [] },
      { invoiceNo: 'X', lines: [{ ...line, quantity: '1' }] },
      { invoiceNo: 'X', lines: [{ ...line, unitCost: 100 }] },
      { invoiceNo: 'X', lines: [{ ...line, unitCost: '-1' }] },
      { invoiceNo: 'X', lines: [{ ...line, skuId: 'nope' }] },
      { invoiceNo: 'X', lines: [line, line] },
      { invoiceNo: 'X', vendorName: 7, lines: [line] },
    ];
    for (const body of bad) expect((await call('POST', '/api/purchases', body)).status, JSON.stringify(body)).toBe(400);

    expect(await call('POST', '/api/purchases', { invoiceNo: 'X', lines: [{ ...line, skuId: MISSING }] })).toMatchObject({ status: 404 });
    await db.query(`UPDATE skus SET is_active = false WHERE id = $1`, [fx.sku.full]);
    expect(await call('POST', '/api/purchases', { invoiceNo: 'X', lines: [line] })).toMatchObject({ status: 400, body: { error: { code: 'INACTIVE' } } });
  });
});
