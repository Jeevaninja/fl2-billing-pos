/**
 * Stock valuation rate (Phase 24 D2): the last non-zero GRN unit cost received on or before a business
 * date, else the catalog purchase price (when above zero), else unrated. Historical and deterministic:
 * a later GRN or catalog edit never revalues an earlier closing. ₹0 scheme / free bottles are skipped.
 */
import type { SqlClient } from '../../db/client.js';
import { type DbInt, type Paise, toPaise } from '../../domain/money.js';

export type RateSource = 'GRN' | 'CATALOG';

export interface ValuationRate {
  ratePaise: Paise;
  source: RateSource;
}

/** Rates as of `asOf` (inclusive) for every SKU that has one; a SKU missing from the map is unrated. */
export async function ratesAsOf(db: SqlClient, asOf: string): Promise<Map<string, ValuationRate>> {
  const { rows } = await db.query<{ sku_id: string; grn: DbInt | null; catalog: DbInt | null }>(
    `SELECT k.id AS sku_id,
            (SELECT rl.unit_cost_paise
               FROM stock_receipt_lines rl
               JOIN stock_receipts r ON r.id = rl.receipt_id
               JOIN business_days d ON d.id = r.business_day_id
              WHERE rl.sku_id = k.id AND rl.unit_cost_paise > 0 AND d.business_date <= $1::date
              ORDER BY d.business_date DESC, r.created_at DESC, rl.line_no DESC
              LIMIT 1)::text AS grn,
            nullif(k.purchase_price_paise, 0)::text AS catalog
       FROM skus k`,
    [asOf],
  );
  const rates = new Map<string, ValuationRate>();
  for (const r of rows) {
    if (r.grn !== null) rates.set(r.sku_id, { ratePaise: toPaise(r.grn), source: 'GRN' });
    else if (r.catalog !== null) rates.set(r.sku_id, { ratePaise: toPaise(r.catalog), source: 'CATALOG' });
  }
  return rates;
}

/** qty × rate in whole paise, or null when unrated. */
export function valueOf(qty: number, rate: ValuationRate | undefined): Paise | null {
  return rate ? BigInt(qty) * rate.ratePaise : null;
}
