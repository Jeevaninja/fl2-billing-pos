import type { SqlClient } from '../../src/db/client.js';
import { one } from './pos.js';

/** Selling prices in paise. */
export const PRICE = {
  full: 220_000, // ₹2,200.00
  half: 120_000, // ₹1,200.00
  quarter: 60_000, // ₹600.00
  beer650: 25_000, // ₹250.00
  beer330: 15_000, // ₹150.00
} as const;

export type SkuKey = keyof typeof PRICE;

export const OPENING_QTY = 50;

export interface Fixture {
  cashier: string;
  manager: string;
  dayId: string;
  sku: Record<SkuKey, string>;
  waiter: {
    /** Trusted, no credit limit. */
    trusted: string;
    /** Untrusted: strict bill-on-bill. */
    untrusted: string;
    /** Trusted with a ₹1,000.00 credit limit. */
    limited: string;
  };
}

/** Bottles per supplier case (skus.case_size). */
export const CASE_SIZE: Record<SkuKey, number> = { full: 12, half: 32, quarter: 64, beer650: 12, beer330: 24 };

const SKUS: ReadonlyArray<{ key: SkuKey; product: 'rum' | 'lager'; code: string; size: string; name: string }> = [
  { key: 'full', product: 'rum', code: 'HRUM-F', size: 'FULL', name: 'House Rum — Full' },
  { key: 'half', product: 'rum', code: 'HRUM-H', size: 'HALF', name: 'House Rum — Half' },
  { key: 'quarter', product: 'rum', code: 'HRUM-Q', size: 'QUARTER', name: 'House Rum — Quarter' },
  { key: 'beer650', product: 'lager', code: 'HLAG-650', size: 'BEER_650', name: 'House Lager — 650' },
  { key: 'beer330', product: 'lager', code: 'HLAG-330', size: 'BEER_330', name: 'House Lager — 330' },
];

export async function seed(db: SqlClient): Promise<Fixture> {
  const id = async (sql: string, params: unknown[]) => (await one<{ id: string }>(db, sql, params)).id;

  const cashier = await id(`INSERT INTO staff (display_name, role) VALUES ($1, 'CASHIER') RETURNING id`, ['Counter 1']);
  const manager = await id(`INSERT INTO staff (display_name, role) VALUES ($1, 'MANAGER') RETURNING id`, ['Manager']);

  const products = {
    rum: await id(`INSERT INTO products (name, category) VALUES ($1, 'RUM') RETURNING id`, ['House Rum']),
    lager: await id(`INSERT INTO products (name, category) VALUES ($1, 'BEER') RETURNING id`, ['House Lager']),
  };

  const sku = {} as Record<SkuKey, string>;
  for (const s of SKUS) {
    sku[s.key] = await id(
      `INSERT INTO skus (product_id, sku_code, size_code, display_name, price_paise, case_size)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [products[s.product], s.code, s.size, s.name, PRICE[s.key], CASE_SIZE[s.key]],
    );
    await db.query(`INSERT INTO stock_movements (sku_id, movement_type, qty_delta) VALUES ($1, 'OPENING', $2)`, [
      sku[s.key],
      OPENING_QTY,
    ]);
  }

  const waiter = {
    trusted: await id(`INSERT INTO waiters (waiter_code, display_name, is_trusted) VALUES ('W01', 'Trusted', true) RETURNING id`, []),
    untrusted: await id(`INSERT INTO waiters (waiter_code, display_name, is_trusted) VALUES ('W02', 'Untrusted', false) RETURNING id`, []),
    limited: await id(
      `INSERT INTO waiters (waiter_code, display_name, is_trusted, credit_limit_paise) VALUES ('W03', 'Limited', true, 100000) RETURNING id`,
      [],
    ),
  };

  const dayId = await id(`INSERT INTO business_days (business_date, opened_by_staff_id) VALUES ('2026-10-14', $1) RETURNING id`, [
    manager,
  ]);

  return { cashier, manager, dayId, sku, waiter };
}
