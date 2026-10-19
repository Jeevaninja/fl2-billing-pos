/**
 * The stock ledger behind the stock register (Phase 23) and the statutory stock summary (Phase 24):
 * one row per SKU with its movements bucketed by business date. A movement is dated by its business
 * day; an opening count posted between days is dated to the next day opened after it (none yet:
 * after every range). Rows: every SKU of a stock-tracked center that is active or holds stock, plus any
 * SKU that held or moved stock in the range. Whole bottles only.
 */
import type { SqlClient } from '../../db/client.js';
import { type DbInt, type Paise, toPaise, toPaiseOrNull } from '../../domain/money.js';
import type { DepartmentCode, ExciseGroup, SizeCode } from '../../domain/types.js';
import { maybeOne } from '../rows.js';
import { int, type ReportRange } from './shared.js';

export interface StockLedgerRow {
  skuId: string;
  skuCode: string;
  name: string;
  sizeCode: SizeCode;
  categoryName: string;
  centerCode: DepartmentCode;
  centerName: string;
  isActive: boolean;
  /** Σ movements dated before the start date. */
  openingQty: number;
  /** GRN receipts in range. */
  inwardQty: number;
  /** Bottles out in range, net of restocked returns. */
  salesQty: number;
  /** OPENING movements in range (items created inside it). */
  openingCountQty: number;
  /** ADJUSTMENT movements in range (signed: breakage is negative). */
  adjustmentQty: number;
  closingQty: number;
  pricePaise: Paise;
  purchasePricePaise: Paise | null;
  volumeMl: number | null;
  exciseGroup: ExciseGroup | null;
}

interface Row {
  sku_id: string;
  sku_code: string;
  display_name: string;
  size_code: SizeCode;
  category_name: string;
  center_code: DepartmentCode;
  center_name: string;
  is_active: boolean;
  on_hand: number;
  opening: DbInt;
  inward: DbInt;
  sales: DbInt;
  opening_counts: DbInt;
  adjustments: DbInt;
  closing: DbInt;
  undated: DbInt;
  price_paise: DbInt;
  purchase_price_paise: DbInt | null;
  volume_ml: number | null;
  excise_group: ExciseGroup | null;
}

/** Throws when a row doesn't add up, or when a range reaching today doesn't end on the shelf count. */
export async function stockLedger(db: SqlClient, range: ReportRange): Promise<StockLedgerRow[]> {
  const { rows } = await db.query<Row>(
    `WITH mv AS (
       SELECT m.sku_id, m.movement_type, m.qty_delta,
              coalesce(d.business_date,
                       (SELECT n.business_date FROM business_days n WHERE n.opened_at >= m.created_at ORDER BY n.opened_at LIMIT 1)) AS eff
         FROM stock_movements m LEFT JOIN business_days d ON d.id = m.business_day_id
     ), per_sku AS (
       SELECT sku_id,
              coalesce(sum(qty_delta) FILTER (WHERE eff < $1::date), 0) AS opening,
              coalesce(sum(qty_delta) FILTER (WHERE eff BETWEEN $1::date AND $2::date AND movement_type = 'PURCHASE_RECEIPT'), 0) AS inward,
              coalesce(-sum(qty_delta) FILTER (WHERE eff BETWEEN $1::date AND $2::date AND movement_type IN ('SALE', 'SALE_REVERSAL')), 0) AS sales,
              coalesce(sum(qty_delta) FILTER (WHERE eff BETWEEN $1::date AND $2::date AND movement_type = 'OPENING'), 0) AS opening_counts,
              coalesce(sum(qty_delta) FILTER (WHERE eff BETWEEN $1::date AND $2::date AND movement_type = 'ADJUSTMENT'), 0) AS adjustments,
              coalesce(sum(qty_delta) FILTER (WHERE eff <= $2::date), 0) AS closing,
              coalesce(sum(qty_delta) FILTER (WHERE eff IS NULL), 0) AS undated,
              count(*) FILTER (WHERE eff BETWEEN $1::date AND $2::date) AS moves
         FROM mv GROUP BY sku_id
     )
     SELECT k.id AS sku_id, k.sku_code, k.display_name, k.size_code, ic.name AS category_name, dp.code AS center_code, dp.name AS center_name,
            (k.is_active AND p.is_active) AS is_active, coalesce(st.on_hand_qty, 0)::int AS on_hand,
            coalesce(s.opening, 0)::text AS opening, coalesce(s.inward, 0)::text AS inward, coalesce(s.sales, 0)::text AS sales,
            coalesce(s.opening_counts, 0)::text AS opening_counts, coalesce(s.adjustments, 0)::text AS adjustments,
            coalesce(s.closing, 0)::text AS closing, coalesce(s.undated, 0)::text AS undated,
            k.price_paise::text AS price_paise, k.purchase_price_paise::text AS purchase_price_paise, k.volume_ml, k.excise_group
       FROM skus k
       JOIN products p ON p.id = k.product_id
       JOIN departments dp ON dp.code = p.department
       JOIN item_categories ic ON ic.id = k.item_category_id
       LEFT JOIN sku_stock st ON st.sku_id = k.id
       LEFT JOIN per_sku s ON s.sku_id = k.id
      WHERE (dp.tracks_stock AND ((k.is_active AND p.is_active) OR coalesce(st.on_hand_qty, 0) <> 0))
         OR coalesce(s.moves, 0) > 0 OR coalesce(s.opening, 0) <> 0
      ORDER BY ic.sort_order, lower(ic.name), lower(p.name),
               array_position(ARRAY['FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330', 'UNIT'], k.size_code)`,
    [range.startDate, range.endDate],
  );
  const latest = await maybeOne<{ d: string | null }>(db, `SELECT max(business_date)::text AS d FROM business_days`);
  const reachesToday = latest?.d == null || range.endDate >= latest.d;

  return rows.map((r) => {
    const row: StockLedgerRow = {
      skuId: r.sku_id,
      skuCode: r.sku_code,
      name: r.display_name,
      sizeCode: r.size_code,
      categoryName: r.category_name,
      centerCode: r.center_code,
      centerName: r.center_name,
      isActive: r.is_active,
      openingQty: int(r.opening),
      inwardQty: int(r.inward),
      salesQty: int(r.sales),
      openingCountQty: int(r.opening_counts),
      adjustmentQty: int(r.adjustments),
      closingQty: int(r.closing),
      pricePaise: toPaise(r.price_paise),
      purchasePricePaise: toPaiseOrNull(r.purchase_price_paise),
      volumeMl: r.volume_ml === null ? null : int(r.volume_ml),
      exciseGroup: r.excise_group,
    };
    // The ledger must add up, and a range reaching today must end on the shelf count.
    if (row.openingQty + row.inwardQty - row.salesQty + row.openingCountQty + row.adjustmentQty !== row.closingQty) {
      throw new Error(`stock ledger ${row.skuCode}: opening + inward − sales + opening counts + adjustments ≠ closing ${row.closingQty}`);
    }
    if (reachesToday && row.closingQty + int(r.undated) !== int(r.on_hand)) {
      throw new Error(`stock ledger ${row.skuCode}: closing ${row.closingQty} disagrees with on hand ${r.on_hand}`);
    }
    return row;
  });
}
