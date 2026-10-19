import { describe, expect, it } from 'vitest';
import { useApi } from '../support/api.js';
import { useSeededDb } from '../support/db.js';
import { PRICE } from '../support/fixtures.js';

describe('reports API (Phase 23)', () => {
  const ctx = useSeededDb();
  const start = useApi(ctx);
  const q = '?startDate=2026-10-14&endDate=2026-10-14';

  it('serves the four reports for a date range with money as strings', async () => {
    const { fx, call } = await start();
    const bill = await call('POST', '/api/bills', { mode: 'NORMAL' });
    await call('POST', `/api/bills/${bill.body.id}/items`, { skuId: fx.sku.quarter, quantity: 2 });
    await call('POST', `/api/bills/${bill.body.id}/settle`, { payments: [{ mode: 'UPI', amount: String(2 * PRICE.quarter) }] });

    expect(await call('GET', '/api/reports/range-presets')).toMatchObject({ status: 200, body: { currentBusinessDate: '2026-10-14', firstBusinessDate: '2026-10-14' } });

    const ledger = await call('GET', `/api/reports/ledger${q}`);
    expect(ledger).toMatchObject({ status: 200, body: { provisional: true, sales: { byCenter: [{ code: 'LIQUOR', salesPaise: String(2 * PRICE.quarter) }], totalPaise: String(2 * PRICE.quarter) } } });

    const sales = await call('GET', `/api/reports/sales${q}`);
    expect(sales.body.rows).toMatchObject([{ billNo: bill.body.billNo, upiPaise: String(2 * PRICE.quarter), items: [{ qty: 2 }] }]);
    expect(sales.body.rows[0].createdAt).toMatch(/Z$/);

    const stock = await call('GET', `/api/reports/stock${q}`);
    expect(stock.body.rows.find((r: { skuId: string }) => r.skuId === fx.sku.quarter)).toMatchObject({ salesQty: 2 });

    const payments = await call('GET', `/api/reports/payments${q}`);
    expect(payments.body.revenue).toEqual({ cashPaise: '0', upiPaise: String(2 * PRICE.quarter), waiterCreditPaise: '0', totalSalesPaise: String(2 * PRICE.quarter) });
  });

  it('answers a bad range with 400', async () => {
    const { call } = await start();
    for (const path of ['/api/reports/ledger', '/api/reports/sales?startDate=2026-10-14', '/api/reports/stock?startDate=2026-10-15&endDate=2026-10-14', '/api/reports/payments?startDate=2024-01-01&endDate=2026-10-14']) {
      expect((await call('GET', path)).status, path).toBe(400);
    }
  });

  it('serves the eight Phase 24 modules, with center filters and catalog volume edits', async () => {
    const { fx, call } = await start();
    const bill = await call('POST', '/api/bills', { mode: 'NORMAL' });
    await call('POST', `/api/bills/${bill.body.id}/items`, { skuId: fx.sku.full, quantity: 3 });
    await call('POST', `/api/bills/${bill.body.id}/settle`, { payments: [{ mode: 'CASH', amount: String(3 * PRICE.full) }] });

    const summary = await call('GET', `/api/reports/sales-summary${q}`);
    expect(summary).toMatchObject({ status: 200, body: { rows: [{ skuId: fx.sku.full, qty: 3, sRatePaise: String(PRICE.full), amountPaise: String(3 * PRICE.full) }] } });
    expect(summary.body.ml.groups[0]).toMatchObject({ label: 'LIQUOR', saleUnits: 3, saleMl: 2250 });

    const stock = await call('GET', `/api/reports/stock-summary${q}`);
    const full = stock.body.groups.flatMap((g: { rows: Array<{ skuId: string }> }) => g.rows).find((r: { skuId: string }) => r.skuId === fx.sku.full);
    expect(full).toMatchObject({ opStk: 50, sale: 3, closing: 47, pRatePaise: null, salesTotalPaise: String(3 * PRICE.full) });

    for (const path of ['member-sales', 'orders', 'expenses?center=SHARED&', 'purchases?center=LIQUOR&', 'bank-deposits', 'day-end', 'full']) {
      const url = path.includes('?') ? `/api/reports/${path}${q.slice(1)}` : `/api/reports/${path}${q}`;
      expect((await call('GET', url)).status, url).toBe(200);
    }
    expect((await call('GET', `/api/reports/full${q}`)).body.sales.totalPaise).toBe(String(3 * PRICE.full));
    expect((await call('GET', `/api/reports/purchases${q}&center=SHARED`)).status).toBe(400);
    expect((await call('GET', `/api/reports/expenses${q}&center=no%20such`)).status).toBe(400);

    const patched = await call('PATCH', `/api/catalog/items/${fx.sku.beer330}`, { volumeMl: 500, exciseGroup: 'TIN_BEER' });
    expect(patched).toMatchObject({ status: 200, body: { volumeMl: 500, exciseGroup: 'TIN_BEER' } });
    expect((await call('PATCH', `/api/catalog/items/${fx.sku.beer330}`, { exciseGroup: 'RUM' })).status).toBe(400);
    expect((await call('PATCH', `/api/catalog/items/${fx.sku.beer330}`, { volumeMl: 7.5 })).status).toBe(400);
  });
});
