/**
 * Sales Summary (Phase 24 §1.1, Revision 1 R3): one row per SKU — "Old Monk Full | 10 | ₹1,800 |
 * ₹18,000" — never one row per bill line. Bills: every bill in the range except OPEN tabs (the Order
 * Summary's rule), so voids and counter cancellations net in. SRate is the billed unit price; when the
 * price changed inside the range it is null ("Mixed") and the amount stays the exact billed total.
 */
import type { SqlClient } from '../../db/client.js';
import { type DbInt, type Paise, toPaise } from '../../domain/money.js';
import type { DepartmentCode, SizeCode } from '../../domain/types.js';
import { type MlSummary, mlSummary } from './ml-summary.js';
import { IN_RANGE, int, type ReportHeader, sum } from './shared.js';
import { stockLedger } from './stock-ledger.js';

export interface SalesSummaryRow {
  skuId: string;
  skuCode: string;
  name: string;
  sizeCode: SizeCode;
  categoryName: string;
  centerCode: DepartmentCode;
  centerName: string;
  /** Net billed quantity (voids and cancels netted). */
  qty: number;
  /** The billed unit price; null when it changed inside the range. */
  sRatePaise: Paise | null;
  amountPaise: Paise;
}

export interface SalesSummaryCenter {
  code: DepartmentCode;
  name: string;
  qty: number;
  amountPaise: Paise;
}

export interface SalesSummary extends ReportHeader {
  rows: SalesSummaryRow[];
  byCenter: SalesSummaryCenter[];
  totalQty: number;
  /** = Σ rows = Σ byCenter = the Order Summary's net. */
  totalPaise: Paise;
  ml: MlSummary;
}

interface Row {
  sku_id: string;
  sku_code: string;
  name: string;
  size_code: SizeCode;
  category_name: string;
  center_code: DepartmentCode;
  center_name: string;
  qty: DbInt;
  amount: DbInt;
  min_price: DbInt | null;
  max_price: DbInt | null;
}

export async function salesSummary(db: SqlClient, head: ReportHeader): Promise<SalesSummary> {
  const params = [head.range.startDate, head.range.endDate];
  // Grouped by SKU and the line's center snapshot (a brand moved between centers mid-range sells under each).
  const { rows } = await db.query<Row>(
    `SELECT i.sku_id, k.sku_code, k.display_name AS name, k.size_code, ic.name AS category_name,
            d.code AS center_code, d.name AS center_name,
            sum(i.qty)::text AS qty, sum(i.line_total_paise)::text AS amount,
            min(i.unit_price_paise) FILTER (WHERE i.qty > 0)::text AS min_price,
            max(i.unit_price_paise) FILTER (WHERE i.qty > 0)::text AS max_price
       FROM bill_items i
       JOIN bills b ON b.id = i.bill_id
       JOIN skus k ON k.id = i.sku_id
       JOIN products p ON p.id = k.product_id
       JOIN item_categories ic ON ic.id = k.item_category_id
       JOIN departments d ON d.code = i.department
      WHERE b.${IN_RANGE} AND b.status <> 'OPEN'
      GROUP BY i.sku_id, k.sku_code, k.display_name, k.size_code, ic.name, ic.sort_order, p.name, d.code, d.name, d.sort_order
     HAVING sum(i.qty) <> 0 OR sum(i.line_total_paise) <> 0
      ORDER BY d.sort_order, lower(d.name), ic.sort_order, lower(ic.name), lower(p.name),
               array_position(ARRAY['FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330', 'UNIT'], k.size_code)`,
    params,
  );
  const out: SalesSummaryRow[] = rows.map((r) => {
    // A reversal of an earlier-range sale has no positive line here: its own (negative) price is the rate.
    const single = r.min_price !== null && r.min_price === r.max_price ? toPaise(r.min_price) : null;
    const qty = int(r.qty);
    const amountPaise = toPaise(r.amount);
    const sRatePaise = single ?? (r.min_price === null && qty !== 0 && amountPaise % BigInt(qty) === 0n ? amountPaise / BigInt(qty) : null);
    return {
      skuId: r.sku_id,
      skuCode: r.sku_code,
      name: r.name,
      sizeCode: r.size_code,
      categoryName: r.category_name,
      centerCode: r.center_code,
      centerName: r.center_name,
      qty,
      sRatePaise,
      amountPaise,
    };
  });

  const byCenter: SalesSummaryCenter[] = [];
  for (const r of out) {
    const last = byCenter.find((c) => c.code === r.centerCode);
    if (last) {
      last.qty += r.qty;
      last.amountPaise += r.amountPaise;
    } else byCenter.push({ code: r.centerCode, name: r.centerName, qty: r.qty, amountPaise: r.amountPaise });
  }
  const totalPaise = sum(out, (r) => r.amountPaise);
  if (sum(byCenter, (c) => c.amountPaise) !== totalPaise) throw new Error('sales summary: centers disagree with items');

  return {
    ...head,
    rows: out,
    byCenter,
    totalQty: out.reduce((n, r) => n + r.qty, 0),
    totalPaise,
    ml: mlSummary(await stockLedger(db, head.range)),
  };
}
