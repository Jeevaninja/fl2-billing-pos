/**
 * Demo data for running the counter locally: staff, a small catalogue with barcodes and opening
 * stock, three waiters, a few members and an open business day. Only ever applied to an empty
 * database (no staff rows); a real deployment never runs it.
 */
import type { SqlClient } from '../src/db/client.js';

// [code, size, display name, sale price, purchase price, case size]. Kitchen items get no opening stock (not tracked).
const PRODUCTS = [
  { name: 'House Whisky', category: 'WHISKY', department: 'LIQUOR', skus: [['HWHS-F', 'FULL', 'House Whisky — Full', 180_000, 110_000, 12], ['HWHS-H', 'HALF', 'House Whisky — Half', 95_000, 56_000, 32], ['HWHS-Q', 'QUARTER', 'House Whisky — Quarter', 50_000, 29_000, 64]] },
  { name: 'House Rum', category: 'RUM', department: 'LIQUOR', skus: [['HRUM-F', 'FULL', 'House Rum — Full', 120_000, 72_000, 12], ['HRUM-H', 'HALF', 'House Rum — Half', 65_000, 38_000, 32], ['HRUM-Q', 'QUARTER', 'House Rum — Quarter', 35_000, 21_000, 64]] },
  { name: 'House Lager', category: 'BEER', department: 'LIQUOR', skus: [['HLAG-650', 'BEER_650', 'House Lager — 650', 22_000, 13_000, 12], ['HLAG-330', 'BEER_330', 'House Lager — 330', 14_000, 8_500, 24]] },
  { name: 'Soda', category: 'BEVERAGE', department: 'ANCILLARY', skus: [['SODA-U', 'UNIT', 'Soda', 4_000, 2_000, 24]] },
  { name: 'Chicken 65', category: 'FOOD', department: 'KITCHEN', skus: [['CH65-H', 'HALF', 'Chicken 65 — Half', 18_000, null, 1], ['CH65-F', 'FULL', 'Chicken 65 — Full', 32_000, null, 1]] },
  { name: 'Masala Peanuts', category: 'FOOD', department: 'KITCHEN', skus: [['MPNT-U', 'UNIT', 'Masala Peanuts', 12_000, null, 1]] },
] as const;

const OPENING_QTY = 48;

async function insertId(db: SqlClient, sql: string, params: unknown[]): Promise<string> {
  const { rows } = await db.query<{ id: string }>(sql, params);
  const row = rows[0];
  if (!row) throw new Error(`dev seed insert returned no id: ${sql}`);
  return row.id;
}

/** Seeds an empty database and returns the demo cashier; returns null if staff already exist. */
export async function seedDevData(db: SqlClient): Promise<{ cashierId: string } | null> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM staff`);
  if ((rows[0]?.n ?? 0) > 0) return null;

  const cashierId = await insertId(db, `INSERT INTO staff (display_name, role) VALUES ('Counter 1', 'CASHIER') RETURNING id`, []);
  const managerId = await insertId(db, `INSERT INTO staff (display_name, role) VALUES ('Manager', 'MANAGER') RETURNING id`, []);

  let barcode = 8_900_000_000_001;
  for (const product of PRODUCTS) {
    const productId = await insertId(db, `INSERT INTO products (name, category, department) VALUES ($1, $2, $3) RETURNING id`, [
      product.name,
      product.category,
      product.department,
    ]);
    for (const [code, size, name, price, cost, caseSize] of product.skus) {
      const skuId = await insertId(
        db,
        `INSERT INTO skus (product_id, sku_code, barcode, size_code, display_name, price_paise, purchase_price_paise, case_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [productId, code, String(barcode++), size, name, price, cost, caseSize],
      );
      if (product.department !== 'KITCHEN') {
        await db.query(`INSERT INTO stock_movements (sku_id, movement_type, qty_delta) VALUES ($1, 'OPENING', $2)`, [skuId, OPENING_QTY]);
      }
    }
  }

  await db.query(
    `INSERT INTO waiters (waiter_code, display_name, is_trusted, credit_limit_paise) VALUES
       ('W01', 'Suresh', true, NULL),
       ('W02', 'Manoj', false, NULL),
       ('W03', 'Prakash', true, 500000)`,
  );
  await db.query(
    `INSERT INTO members (membership_no, display_name) VALUES
       ('M-0001', 'Anil Kumar'), ('M-0002', 'Deepa Rao'), ('M-0003', 'Farhan Shaikh')`,
  );
  await db.query(`INSERT INTO business_days (business_date, opened_by_staff_id) VALUES (current_date, $1)`, [managerId]);

  return { cashierId };
}
