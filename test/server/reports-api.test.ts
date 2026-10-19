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
});
