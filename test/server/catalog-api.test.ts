import { describe, expect, it } from 'vitest';
import { MISSING, useApi } from '../support/api.js';
import { useSeededDb } from '../support/db.js';
import { OPENING_QTY } from '../support/fixtures.js';

const ROYAL_STAG = {
  name: 'Royal Stag',
  category: 'WHISKY',
  codePrefix: 'RSTG',
  skus: [
    { sizeCode: 'FULL', salePrice: '100000', purchasePrice: '70000', caseSize: 12, barcode: '8901111000001' },
    { sizeCode: 'QUARTER', salePrice: '26000', caseSize: 64 },
  ],
};

describe('local HTTP API: inventory catalog', () => {
  const ctx = useSeededDb();
  const start = useApi(ctx);

  it('creates a liquor (201) and lists it with paise as strings', async () => {
    const { call } = await start();
    const made = await call('POST', '/api/catalog/products', ROYAL_STAG);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Royal Stag', category: 'WHISKY', isActive: true });
    expect(made.body.skus).toEqual([
      expect.objectContaining({ skuCode: 'RSTG-F', pricePaise: '100000', purchasePricePaise: '70000', caseSize: 12, onHandQty: 0 }),
      expect.objectContaining({ skuCode: 'RSTG-Q', pricePaise: '26000', purchasePricePaise: null, caseSize: 64 }),
    ]);

    const list = await call('GET', '/api/catalog');
    expect(list.status).toBe(200);
    expect(list.body.map((p: { name: string }) => p.name)).toEqual(['House Lager', 'House Rum', 'Royal Stag']);
    expect((await call('GET', '/api/catalog?q=rstg')).body).toHaveLength(1);
  });

  it('answers 400 on a bad body and 409 PS012 on a duplicate', async () => {
    const { call } = await start();
    expect((await call('POST', '/api/catalog/products', ROYAL_STAG)).status).toBe(201);
    expect(await call('POST', '/api/catalog/products', { ...ROYAL_STAG, codePrefix: 'RS2' })).toMatchObject({
      status: 409,
      body: { error: { code: 'PS012', constraint: 'products_name_unique' } },
    });
    expect(await call('POST', '/api/catalog/products', { ...ROYAL_STAG, skus: 'none' })).toMatchObject({ status: 400 });
    expect(await call('POST', '/api/catalog/products', { ...ROYAL_STAG, name: 'X', skus: [{ ...ROYAL_STAG.skus[0], salePrice: 1000 }] })).toMatchObject({ status: 400 });
    expect(await call('POST', '/api/catalog/products', { ...ROYAL_STAG, name: 'X', skus: [{ ...ROYAL_STAG.skus[0], sizeCode: 'PEG' }] })).toMatchObject({ status: 400 });
    expect(await call('POST', '/api/catalog/products', { ...ROYAL_STAG, name: 'X', skus: [{ ...ROYAL_STAG.skus[0], caseSize: 0 }] })).toMatchObject({ status: 400 });
    expect(await call('POST', '/api/catalog/products', { ...ROYAL_STAG, category: 'CIDER' })).toMatchObject({ status: 400 });
  });

  it('edits a liquor and its sizes, adds a size, and hides inactive ones by default', async () => {
    const { call } = await start();
    const made = (await call('POST', '/api/catalog/products', ROYAL_STAG)).body;
    const [full, quarter] = made.skus;

    const renamed = await call('PATCH', `/api/catalog/products/${made.id}`, { name: 'Royal Stag Barrel' });
    expect(renamed).toMatchObject({ status: 200, body: { name: 'Royal Stag Barrel' } });
    expect(renamed.body.skus[0].displayName).toBe('Royal Stag Barrel — Full');

    const edited = await call('PATCH', `/api/catalog/skus/${full.id}`, { salePrice: '110000', purchasePrice: null, caseSize: 6, barcode: null });
    expect(edited.status).toBe(200);
    expect(edited.body.skus[0]).toMatchObject({ pricePaise: '110000', purchasePricePaise: null, caseSize: 6, barcode: null });

    const grown = await call('POST', `/api/catalog/products/${made.id}/skus`, { sizeCode: 'HALF', salePrice: '52000', caseSize: 32 });
    expect(grown.status).toBe(201);
    expect(grown.body.skus.map((s: { skuCode: string }) => s.skuCode)).toEqual(['RSTG-F', 'RSTG-H', 'RSTG-Q']);

    expect((await call('PATCH', `/api/catalog/skus/${quarter.id}`, { isActive: false })).status).toBe(200);
    const visible = (await call('GET', '/api/catalog?q=rstg')).body[0].skus.map((s: { skuCode: string }) => s.skuCode);
    expect(visible).toEqual(['RSTG-F', 'RSTG-H']);
    const all = (await call('GET', '/api/catalog?q=rstg&includeInactive=true')).body[0].skus;
    expect(all.map((s: { isActive: boolean }) => s.isActive)).toEqual([true, true, false]);

    expect(await call('PATCH', `/api/catalog/skus/${full.id}`, { caseSize: 'six' })).toMatchObject({ status: 400 });
    expect(await call('PATCH', `/api/catalog/skus/${MISSING}`, { caseSize: 6 })).toMatchObject({ status: 404 });
    expect(await call('PATCH', `/api/catalog/products/${MISSING}`, { name: 'X' })).toMatchObject({ status: 404 });
    expect(await call('PATCH', '/api/catalog/products/not-a-uuid', { name: 'X' })).toMatchObject({ status: 400 });
  });

  it('lifecycle: create a liquor, GRN 1 case + 5 loose at the catalog cost, then sell one', async () => {
    const { call } = await start();
    const made = (await call('POST', '/api/catalog/products', ROYAL_STAG)).body;
    const full = made.skus[0];

    const found = (await call('GET', '/api/skus?q=8901111000001')).body[0];
    expect(found).toMatchObject({ id: full.id, caseSize: 12, purchasePricePaise: '70000' });

    const posted = await call('POST', '/api/purchases', {
      invoiceNo: 'RS-1',
      lines: [{ skuId: full.id, cases: 1, looseBottles: 5, caseSize: found.caseSize, unitCost: found.purchasePricePaise }],
    });
    expect(posted.status).toBe(201);
    expect(posted.body.lines[0]).toMatchObject({ quantity: 17, cases: 1, caseSize: 12, looseBottles: 5, lineTotalPaise: String(17 * 70000) });
    expect((await call('GET', '/api/skus/lookup?code=RSTG-F')).body.onHandQty).toBe(17);

    const bill = await call('POST', '/api/bills', { mode: 'NORMAL' });
    await call('POST', `/api/bills/${bill.body.id}/items`, { skuId: full.id, quantity: 1 });
    expect((await call('GET', '/api/skus/lookup?code=RSTG-F')).body.onHandQty).toBe(16);
  });

  it('GRN: 409 PS002 for a stale case size, 400 for a bad case line', async () => {
    const { fx, call } = await start();
    const line = { skuId: fx.sku.quarter, cases: 2, looseBottles: 3, caseSize: 48, unitCost: '100' };
    expect(await call('POST', '/api/purchases', { invoiceNo: 'S-1', lines: [line] })).toMatchObject({
      status: 409,
      body: { error: { code: 'PS002' } },
    });
    expect(await call('POST', '/api/purchases', { invoiceNo: 'S-1', lines: [{ ...line, caseSize: 64, looseBottles: 64 }] })).toMatchObject({ status: 400 });
    expect(await call('POST', '/api/purchases', { invoiceNo: 'S-1', lines: [{ ...line, caseSize: undefined }] })).toMatchObject({ status: 400 });
    expect((await call('GET', '/api/skus/lookup?code=HRUM-Q')).body.onHandQty).toBe(OPENING_QTY);

    const ok = await call('POST', '/api/purchases', { invoiceNo: 'S-1', lines: [{ ...line, caseSize: 64 }] });
    expect(ok.status).toBe(201);
    expect((await call('GET', '/api/skus/lookup?code=HRUM-Q')).body.onHandQty).toBe(OPENING_QTY + 131);
  });
});
