/**
 * Stock inwarding (GRN): a supplier invoice received on the open day. The service validates and
 * writes the receipt and its lines in one transaction; the database posts one PURCHASE_RECEIPT
 * stock movement per line (linked by receipt_line_id) and raises sku_stock from it. Receipts are
 * append-only and touch no drawer cash.
 */
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { InactiveError, NotFoundError, withPosErrors } from '../db/errors.js';
import { assertPaise, assertQuantity, type DbInt, type Paise, paiseParam, toPaise } from '../domain/money.js';
import type { SizeCode } from '../domain/types.js';
import { maybeOne, one } from './rows.js';

export const MAX_RECEIPT_LINES = 200;
/** Per-line sanity cap: catches a mistyped quantity long before the integer column would overflow. */
export const MAX_RECEIPT_QTY = 100_000;
const MAX_INVOICE_NO = 60;
const MAX_VENDOR_NAME = 100;

export interface ReceiptLineInput {
  skuId: string;
  quantity: number;
  /** Per-bottle cost on the invoice; 0 for scheme / free bottles. */
  unitCostPaise: Paise;
}

export interface ReceiptInput {
  invoiceNo: string;
  vendorName?: string | null | undefined;
  lines: readonly ReceiptLineInput[];
}

export interface StockReceipt {
  id: string;
  businessDayId: string;
  invoiceNo: string;
  vendorName: string | null;
  receivedByStaffId: string;
  receivedBy: string;
  createdAt: Date;
  lineCount: number;
  bottles: number;
  totalCostPaise: Paise;
}

export interface StockReceiptLine {
  id: string;
  lineNo: number;
  skuId: string;
  skuCode: string;
  displayName: string;
  sizeCode: SizeCode;
  quantity: number;
  unitCostPaise: Paise;
  lineTotalPaise: Paise;
}

export interface StockReceiptDetail {
  receipt: StockReceipt;
  lines: StockReceiptLine[];
}

interface ReceiptRow {
  id: string;
  business_day_id: string;
  invoice_no: string;
  vendor_name: string | null;
  received_by_staff_id: string;
  received_by: string;
  created_at: Date;
  line_count: number;
  bottles: number;
  total_cost: DbInt;
}

interface LineRow {
  id: string;
  line_no: number;
  sku_id: string;
  sku_code: string;
  display_name: string;
  size_code: SizeCode;
  qty: number;
  unit_cost_paise: DbInt;
  line_total: DbInt;
}

const RECEIPT_SELECT = `
  SELECT r.id, r.business_day_id, r.invoice_no, r.vendor_name, r.received_by_staff_id, s.display_name AS received_by,
         r.created_at, count(l.id)::int AS line_count, coalesce(sum(l.qty), 0)::int AS bottles,
         coalesce(sum(l.qty::bigint * l.unit_cost_paise), 0)::text AS total_cost
    FROM stock_receipts r
    JOIN staff s ON s.id = r.received_by_staff_id
    LEFT JOIN stock_receipt_lines l ON l.receipt_id = r.id`;
const RECEIPT_GROUP = `GROUP BY r.id, s.display_name`;

function mapReceipt(r: ReceiptRow): StockReceipt {
  return {
    id: r.id,
    businessDayId: r.business_day_id,
    invoiceNo: r.invoice_no,
    vendorName: r.vendor_name,
    receivedByStaffId: r.received_by_staff_id,
    receivedBy: r.received_by,
    createdAt: r.created_at,
    lineCount: r.line_count,
    bottles: r.bottles,
    totalCostPaise: toPaise(r.total_cost),
  };
}

function mapLine(r: LineRow): StockReceiptLine {
  return {
    id: r.id,
    lineNo: r.line_no,
    skuId: r.sku_id,
    skuCode: r.sku_code,
    displayName: r.display_name,
    sizeCode: r.size_code,
    quantity: r.qty,
    unitCostPaise: toPaise(r.unit_cost_paise),
    lineTotalPaise: toPaise(r.line_total),
  };
}

/** Trims the invoice and vendor and checks every line; throws RangeError on the first problem. */
function normalise(input: ReceiptInput): { invoiceNo: string; vendorName: string | null; lines: readonly ReceiptLineInput[] } {
  const invoiceNo = input.invoiceNo.trim();
  if (invoiceNo === '') throw new RangeError('invoiceNo is required');
  if (invoiceNo.length > MAX_INVOICE_NO) throw new RangeError(`invoiceNo must be at most ${MAX_INVOICE_NO} characters`);
  const vendorName = input.vendorName?.trim() || null;
  if (vendorName !== null && vendorName.length > MAX_VENDOR_NAME) {
    throw new RangeError(`vendorName must be at most ${MAX_VENDOR_NAME} characters`);
  }
  const { lines } = input;
  if (lines.length === 0) throw new RangeError('a receipt needs at least one line');
  if (lines.length > MAX_RECEIPT_LINES) throw new RangeError(`a receipt can have at most ${MAX_RECEIPT_LINES} lines`);
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    assertQuantity(line.quantity, `lines[${i}].quantity`);
    if (line.quantity > MAX_RECEIPT_QTY) throw new RangeError(`lines[${i}].quantity must be at most ${MAX_RECEIPT_QTY} bottles`);
    assertPaise(line.unitCostPaise, `lines[${i}].unitCostPaise`, { allowZero: true });
    if (seen.has(line.skuId)) throw new RangeError(`lines[${i}]: the same SKU appears twice; combine it into one line`);
    seen.add(line.skuId);
  });
  return { invoiceNo, vendorName, lines };
}

export class PurchaseService {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Records a supplier invoice on the open day and raises stock for every line, atomically.
   * Refused for an unknown (NotFoundError) or inactive (InactiveError) SKU, with no open day
   * (PS007), and for an invoice number already received from the same vendor (PS011).
   */
  async recordReceipt(input: ReceiptInput, staffId: string): Promise<StockReceiptDetail> {
    const { invoiceNo, vendorName, lines } = normalise(input);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        for (const { skuId } of lines) {
          const sku = await maybeOne<{ sku_code: string; is_active: boolean }>(tx, `SELECT sku_code, is_active FROM skus WHERE id = $1`, [skuId]);
          if (!sku) throw new NotFoundError('sku', skuId);
          if (!sku.is_active) throw new InactiveError('sku', skuId, sku.sku_code);
        }
        const { id } = await one<{ id: string }>(
          tx,
          `INSERT INTO stock_receipts (invoice_no, vendor_name, received_by_staff_id) VALUES ($1, $2, $3) RETURNING id`,
          [invoiceNo, vendorName, staffId],
        );
        for (const [i, line] of lines.entries()) {
          await tx.query(
            `INSERT INTO stock_receipt_lines (receipt_id, line_no, sku_id, qty, unit_cost_paise) VALUES ($1, $2, $3, $4, $5)`,
            [id, i + 1, line.skuId, line.quantity, paiseParam(line.unitCostPaise)],
          );
        }
        return loadReceipt(tx, id);
      }),
    );
  }

  /** The day's receipts, newest first, with line count, bottles and total cost. */
  async listReceipts(businessDayId: string): Promise<StockReceipt[]> {
    const { rows } = await this.db.query<ReceiptRow>(
      `${RECEIPT_SELECT} WHERE r.business_day_id = $1 ${RECEIPT_GROUP} ORDER BY r.created_at DESC, r.id DESC`,
      [businessDayId],
    );
    return rows.map(mapReceipt);
  }

  async getReceipt(receiptId: string): Promise<StockReceiptDetail> {
    return loadReceipt(this.db, receiptId);
  }
}

async function loadReceipt(db: SqlClient, receiptId: string): Promise<StockReceiptDetail> {
  const row = await maybeOne<ReceiptRow>(db, `${RECEIPT_SELECT} WHERE r.id = $1 ${RECEIPT_GROUP}`, [receiptId]);
  if (!row) throw new NotFoundError('stock receipt', receiptId);
  const { rows } = await db.query<LineRow>(
    `SELECT l.id, l.line_no, l.sku_id, k.sku_code, k.display_name, k.size_code, l.qty, l.unit_cost_paise,
            (l.qty::bigint * l.unit_cost_paise)::text AS line_total
       FROM stock_receipt_lines l
       JOIN skus k ON k.id = l.sku_id
      WHERE l.receipt_id = $1
      ORDER BY l.line_no`,
    [receiptId],
  );
  return { receipt: mapReceipt(row), lines: rows.map(mapLine) };
}
