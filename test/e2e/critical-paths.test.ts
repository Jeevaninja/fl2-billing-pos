/**
 * Phase 25 QA (plan D9): end-to-end journeys through the real HTTP API on PGlite, signed in the way the
 * till is (password → HttpOnly cookie), across the critical paths:
 *   universal billing search · KOT routing · waiter partial payments · peak math · Revenue Center P&L ·
 *   Day End variance · PIN Day Open · ML summary math · all eight reports over a two-day range.
 * Every expected figure is worked out by hand in the comments, never read back from the system.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthService, formatKot, type KotPrinter, type KotTicket } from '../../src/services/index.js';
import { type Call, TEST_SCRYPT, useApi, useCaptainApi } from '../support/api.js';
import { useSeededDb } from '../support/db.js';
import { OPENING_QTY, PRICE } from '../support/fixtures.js';

const DISH = 26_000; // ₹260.00 Paneer Tikka (KITCHEN, not stock-tracked)
const PASSWORD = 'correct horse battery';

function recordingPrinter() {
  const tickets: KotTicket[] = [];
  const printer: KotPrinter = {
    async printKOT(ticket) {
      tickets.push(ticket);
      return { station: ticket.station, printedAt: new Date(), text: formatKot(ticket) };
    },
  };
  return { tickets, printer };
}

/** Signs in through POST /api/auth/login and returns a caller that sends the session cookie. */
async function signIn(call: Call): Promise<Call> {
  const login = await call('POST', '/api/auth/login', { username: 'owner', password: PASSWORD });
  expect(login.status).toBe(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  return (method, path, body, headers = {}) => call(method, path, body, { cookie, ...headers });
}

async function addDish(api: Call): Promise<string> {
  const dish = await api('POST', '/api/catalog/products', {
    name: 'Paneer Tikka',
    category: 'FOOD',
    department: 'KITCHEN',
    codePrefix: 'PTKA',
    skus: [{ sizeCode: 'UNIT', salePrice: String(DISH), caseSize: 1 }],
  });
  expect(dish.status).toBe(201);
  return dish.body.skus[0].id;
}

describe('Phase 25 critical paths (E2E over HTTP)', () => {
  const ctx = useSeededDb();
  const start = useApi(ctx);
  const startCaptain = useCaptainApi(ctx);

  it('trades two days end to end: search, KOT, waiter part-payments, peak, center P&L, Day End, PIN open, reports', async () => {
    const { tickets, printer } = recordingPrinter();
    const { db, fx, call: anonymous } = await start({ signedIn: false, kotPrinter: printer });
    const auth = new AuthService(db, TEST_SCRYPT);
    await auth.setAdminPassword('owner', PASSWORD);
    await auth.setPin(fx.manager, '2468');

    // Nothing works before sign-in.
    expect(await anonymous('POST', '/api/bills', { mode: 'NORMAL' })).toMatchObject({ status: 401 });
    const api = await signIn(anonymous);
    const dishSku = await addDish(api);

    // ── 1. Universal billing search (Phase 21): every typed word matches; exact code lookup ──
    const search = await api('GET', '/api/skus?q=rum%20quar&limit=8&active=1');
    expect(search.body.map((s: { skuCode: string }) => s.skuCode)).toEqual(['HRUM-Q']);
    expect((await api('GET', '/api/skus?q=paneer&limit=8&active=1')).body.map((s: { skuCode: string }) => s.skuCode)).toEqual(['PTKA-U']);
    expect((await api('GET', '/api/skus/lookup?code=HLAG-650')).body).toMatchObject({ id: fx.sku.beer650 });
    expect((await api('GET', '/api/skus/lookup?code=NOPE-1')).status).toBe(404);

    // Bill A: 2 quarters (found by search) + 1 beer 650 = 2 × 600 + 250 = ₹1,450 → split ₹1,000 cash + ₹450 UPI.
    const billA = (await api('POST', '/api/bills', { mode: 'NORMAL' })).body;
    await api('POST', `/api/bills/${billA.id}/items`, { skuId: search.body[0].id, quantity: 2 });
    await api('POST', `/api/bills/${billA.id}/items`, { skuId: fx.sku.beer650, quantity: 1 });
    expect((await api('GET', `/api/bills/${billA.id}`)).body.bill.totalPaise).toBe('145000');
    expect(await api('POST', `/api/bills/${billA.id}/settle`, { payments: [{ mode: 'CASH', amount: '100000' }] })).toMatchObject({ status: 409, body: { error: { code: 'PS005' } } });
    expect(
      await api('POST', `/api/bills/${billA.id}/settle`, { payments: [{ mode: 'CASH', amount: '100000' }, { mode: 'UPI', amount: '45000' }] }),
    ).toMatchObject({ status: 200, body: { bill: { status: 'SETTLED' } } });

    // ── 2. KOT routing: counter bill with liquor + a dish; F6 sends only the dish to KITCHEN ──
    // Bill B: 1 full + 1 dish = 2,200 + 260 = ₹2,460 cash.
    const billB = (await api('POST', '/api/bills', { mode: 'NORMAL' })).body;
    await api('POST', `/api/bills/${billB.id}/items`, { skuId: fx.sku.full, quantity: 1 });
    await api('POST', `/api/bills/${billB.id}/items`, { skuId: dishSku, quantity: 1 });
    expect((await api('POST', `/api/bills/${billB.id}/kot`, {})).body.kots).toMatchObject([{ station: 'KITCHEN', sentQuantity: 1, printed: true }]);
    await api('POST', `/api/bills/${billB.id}/settle`, { payments: [{ mode: 'CASH', amount: '246000' }] });
    expect(tickets.map((t) => [t.station, t.lines.map((l) => `${l.skuCode}×${l.quantity}`)])).toEqual([['KITCHEN', ['PTKA-U×1']]]);

    // ── 3. Waiter partial payments ──
    // Trusted W01, bill C: 1 full ₹2,200 → ₹1,000 cash now, ₹1,200 collect-later, repaid in cash before close.
    const billC = (await api('POST', '/api/bills', { mode: 'NORMAL' })).body;
    await api('PUT', `/api/bills/${billC.id}/waiter`, { waiterId: fx.waiter.trusted });
    await api('POST', `/api/bills/${billC.id}/items`, { skuId: fx.sku.full, quantity: 1 });
    expect(await api('POST', `/api/bills/${billC.id}/settle-waiter`, { waiterId: fx.waiter.trusted, tender: 'CASH', amount: '100000' })).toMatchObject({
      status: 200,
      body: { bill: { status: 'OPEN' }, remainingDuePaise: '120000' },
    });
    expect(await api('POST', `/api/bills/${billC.id}/settle-waiter`, { waiterId: fx.waiter.trusted, tender: 'WAITER_CREDIT', amount: '120000' })).toMatchObject({
      status: 200,
      body: { bill: { status: 'SETTLED' }, remainingDuePaise: '0' },
    });
    // Untrusted W02, bill D: 1 quarter ₹600 — strict bill-on-bill: no part payment, no credit.
    const billD = (await api('POST', '/api/bills', { mode: 'NORMAL' })).body;
    await api('PUT', `/api/bills/${billD.id}/waiter`, { waiterId: fx.waiter.untrusted });
    await api('POST', `/api/bills/${billD.id}/items`, { skuId: fx.sku.quarter, quantity: 1 });
    expect((await api('POST', `/api/bills/${billD.id}/settle-waiter`, { waiterId: fx.waiter.untrusted, tender: 'CASH', amount: '30000' })).status).toBe(409);
    expect((await api('POST', `/api/bills/${billD.id}/settle-waiter`, { waiterId: fx.waiter.untrusted, tender: 'WAITER_CREDIT' })).body.error.code).toBe('PS004');
    expect(await api('POST', `/api/bills/${billD.id}/settle-waiter`, { waiterId: fx.waiter.untrusted, tender: 'CASH' })).toMatchObject({ status: 200, body: { bill: { status: 'SETTLED' } } });

    // Day End is blocked while W01 owes ₹1,200; the repayment clears it.
    const blocked = (await api('GET', '/api/day-end')).body;
    expect(blocked).toMatchObject({ canClose: false, blockers: { waiterBalance: { totalPaise: '120000' } } });
    expect(await api('POST', `/api/waiters/${fx.waiter.trusted}/receive`, { amount: '120000', tender: 'CASH' })).toMatchObject({ status: 201 });

    // ── 4. Peak mode: start with readings, 3 quarter scans (₹1,800), one undone and re-scanned, end ₹1 short ──
    const peak = (await api('POST', '/api/peak/sessions', { businessDayId: fx.dayId, declaredCash: '500000', declaredUpi: '45000' })).body;
    for (let i = 0; i < 3; i++) expect((await api('POST', '/api/peak/sales', { sessionId: peak.id, skuId: fx.sku.quarter, quantity: 1 })).status).toBe(201);
    expect((await api('POST', '/api/peak/undo-last', {})).status).toBe(201);
    await api('POST', '/api/peak/sales', { sessionId: peak.id, skuId: fx.sku.quarter, quantity: 1 });
    expect((await api('POST', '/api/bank-deposits', { amount: '1000' })).body.error.code).toBe('PS007'); // no cash drops mid-peak
    // Expected = start 5,000 + 450 UPI + 1,800 sales = ₹7,250; counted 6,799 cash + 450 UPI = ₹7,249 → −₹1.
    const ended = await api('POST', `/api/peak/sessions/${peak.id}/end`, { countedCash: '679900', countedUpi: '45000' });
    expect(ended).toMatchObject({ status: 200, body: { session: { variancePaise: '-100' }, breakdown: { peakBillsPaise: '180000' } } });

    // ── 5. Money out of the drawer, and the Kitchen's own purchase ──
    expect(await api('POST', '/api/expenses', { amount: '50000', categoryId: fx.expenseCategory.ICE })).toMatchObject({ status: 201 }); // ₹500 ice (Liquor)
    expect(await api('POST', '/api/bank-deposits', { amount: '100000', reference: 'RTGS 1' })).toMatchObject({ status: 201 }); // ₹1,000 banked
    const supply = await api('POST', '/api/revenue-centers/purchases', {
      department: 'KITCHEN',
      paidFrom: 'DRAWER',
      vendorName: 'Market',
      lines: [{ description: 'Onions', quantity: '2 kg', amount: '6000' }, { description: 'Paneer', quantity: '1 kg', amount: '4000' }],
    });
    expect(supply).toMatchObject({ status: 201 }); // ₹100 from the drawer

    // ── 6. Revenue Center P&L: Kitchen sold ₹260, bought ₹100 → gross ₹160; Liquor carries the ice ──
    expect((await api('GET', '/api/revenue-centers/KITCHEN/summary')).body).toMatchObject({
      salesPaise: '26000',
      expensesPaise: '0',
      purchasesPaise: '10000',
      supplyDrawerPaise: '10000',
      grossPaise: '16000',
      itemsSold: [{ quantity: 1 }],
    });
    // Liquor: A 1,450 + B 2,200 + C 2,200 + D 600 + peak 1,800 = ₹8,250, less the ₹500 ice.
    expect((await api('GET', '/api/revenue-centers/LIQUOR/summary')).body).toMatchObject({ salesPaise: '825000', expensesPaise: '50000', grossPaise: '775000' });

    // ── 7. Day End: expected cash, close ₹2 short ──
    // Normal cash: A 1,000 + B 2,460 + C 1,000 + D 600 = 5,060; peak counted delta 6,799 − 5,000 = 1,799;
    // W01 repayment 1,200; less ice 500, deposit 1,000, kitchen supplies 100 → ₹6,459.
    const dayEnd = (await api('GET', '/api/day-end')).body;
    expect(dayEnd).toMatchObject({ canClose: true, breakdown: { expectedCashPaise: '645900' } });
    // Sales ₹8,510: normal 1,450 + 2,460 + 2,200 + 600 = 6,710 (of which ₹1,200 collect-later) + peak 1,800.
    expect(dayEnd.sales.total).toMatchObject({ salesPaise: '851000', creditPaise: '120000' });
    expect(dayEnd.sales.peak).toMatchObject({ salesPaise: '180000', sessionCount: 1 });
    const closed = await api('POST', `/api/days/${fx.dayId}/close`, { countedCash: '645700' });
    expect(closed).toMatchObject({ status: 200, body: { day: { status: 'CLOSED', expectedCashPaise: '645900', cashVariancePaise: '-200' } } });
    expect((await api('POST', '/api/bills', { mode: 'NORMAL' })).body.error.code).toBe('PS007');

    // ── 8. PIN Day Open: pin holders, a wrong PIN, then the manager's ──
    expect((await api('GET', '/api/staff/pin-holders')).body).toEqual([{ id: fx.manager, displayName: 'Manager', role: 'MANAGER' }]);
    expect(await api('POST', '/api/days', { openingFloat: '200000', staffId: fx.manager, pin: '0000' })).toMatchObject({ status: 403, body: { error: { code: 'INVALID_PIN', attemptsLeft: 4 } } });
    const day2 = await api('POST', '/api/days', { openingFloat: '200000', staffId: fx.manager, pin: '2468' });
    expect(day2).toMatchObject({ status: 201, body: { status: 'OPEN', openingFloatPaise: '200000' } });
    const date2: string = day2.body.businessDate;

    // Day 2: one full by UPI.
    const billE = (await api('POST', '/api/bills', { mode: 'NORMAL' })).body;
    await api('POST', `/api/bills/${billE.id}/items`, { skuId: fx.sku.full, quantity: 1 });
    await api('POST', `/api/bills/${billE.id}/settle`, { payments: [{ mode: 'UPI', amount: String(PRICE.full) }] });

    // ── 9. Reports over both days ──
    const q = `?startDate=2026-10-14&endDate=${date2}`;
    // Sold: full 1 (B) + 1 (C) + 1 (E) = 3; quarter 2 (A) + 1 (D) + 3 (peak, after the undo) = 6; beer 650 × 1; dish × 1.
    const summary = (await api('GET', `/api/reports/sales-summary${q}`)).body;
    const qty = (skuId: string) => summary.rows.find((r: { skuId: string }) => r.skuId === skuId)?.qty;
    expect([qty(fx.sku.full), qty(fx.sku.quarter), qty(fx.sku.beer650), qty(dishSku)]).toEqual([3, 6, 1, 1]);

    // ML summary (excise label × whole bottles, integers only): Liquor 3 × 750 + 6 × 180 = 3,330 ml in 9 units;
    // Beer 1 × 650. Closing: Liquor full 47 × 750 + half 50 × 375 + quarter 44 × 180 = 62,920 ml.
    const ml = summary.ml;
    const group = (g: string) => ml.groups.find((x: { group: string }) => x.group === g);
    expect(group('LIQUOR')).toMatchObject({ saleUnits: 9, saleMl: 3330, closingUnits: 47 + 50 + 44, closingMl: 47 * 750 + 50 * 375 + 44 * 180 });
    expect(group('BEER')).toMatchObject({ saleUnits: 1, saleMl: 650 });
    expect(ml.total).toMatchObject({ saleUnits: 10, saleMl: 3980 });
    expect(Number.isInteger(ml.total.closingMl)).toBe(true);

    const stock = (await api('GET', `/api/reports/stock-summary${q}`)).body;
    const stockRow = (skuId: string) => stock.groups.flatMap((g: { rows: Array<{ skuId: string }> }) => g.rows).find((r: { skuId: string }) => r.skuId === skuId);
    expect(stockRow(fx.sku.full)).toMatchObject({ opStk: OPENING_QTY, sale: 3, closing: OPENING_QTY - 3 });
    expect(stockRow(fx.sku.quarter)).toMatchObject({ opStk: OPENING_QTY, sale: 6, closing: OPENING_QTY - 6 });

    const dayLog = (await api('GET', `/api/reports/day-end${q}`)).body;
    expect(JSON.stringify(dayLog)).toContain('"-200"'); // day 1's frozen variance

    const full = (await api('GET', `/api/reports/full${q}`)).body;
    expect(full.sales.totalPaise).toBe(String(851000 + PRICE.full));

    for (const path of ['sales-summary', 'member-sales', 'orders', 'stock-summary', 'expenses', 'purchases', 'bank-deposits', 'day-end', 'full']) {
      expect((await api('GET', `/api/reports/${path}${q}`)).status, path).toBe(200);
    }

    // Every KOT went to the kitchen: liquor never prints from the counter (the counter is the bar).
    expect(tickets.every((t) => t.station === 'KITCHEN')).toBe(true);

    // Signing out ends it.
    await api('POST', '/api/auth/logout', {});
    expect((await api('GET', '/api/context')).status).toBe(401);
  });

  it('routes Captain orders: liquor to the counter BAR printer, dishes to the KITCHEN, one ticket each', async () => {
    const { tickets, printer } = recordingPrinter();
    const { fx, call, counter } = await startCaptain({ printer });
    const dishSku = await addDish(counter);

    const order = await call('POST', '/api/captain/kot', {
      requestId: randomUUID(),
      waiterId: fx.waiter.trusted,
      items: [
        { skuId: fx.sku.full, quantity: 1 },
        { skuId: dishSku, quantity: 2 },
        { skuId: fx.sku.beer330, quantity: 3 },
      ],
    });
    expect(order.status).toBe(201);
    const byStation = Object.fromEntries(tickets.map((t) => [t.station, t.lines.map((l) => `${l.skuCode}×${l.quantity}`)]));
    expect(byStation).toEqual({ BAR: ['HRUM-F×1', 'HLAG-330×3'], KITCHEN: ['PTKA-U×2'] });

    // The same request replayed (handset retry) prints nothing new.
    const replay = await call('POST', '/api/captain/kot', { requestId: order.body.bill.requestId, waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.full, quantity: 1 }, { skuId: dishSku, quantity: 2 }, { skuId: fx.sku.beer330, quantity: 3 }] });
    expect(replay).toMatchObject({ status: 200, body: { replayed: true } });
    expect(tickets).toHaveLength(2);
  });
});
