/**
 * Purchase Summary (Phase 24 §1.6): every inward in the range, separated by revenue center.
 *   GRN       stock receipts (supplier invoices of sealed bottles / packs). A line belongs to its brand's
 *             current center — the Phase 23 ledger rule — so one invoice can split across centers.
 *   Supplies  each center's own purchase ledger (raw material, ancillaries), paid from the drawer or
 *             outside; a void and the purchase it voids are both listed and net to ₹0.
 * `center`: undefined = every center, else that center only.
 */
import type { SqlClient } from '../../db/client.js';
import { type DbInt, type Paise, toPaise } from '../../domain/money.js';
import type { DepartmentCode, SizeCode } from '../../domain/types.js';
import { int, type ReportHeader, sum } from './shared.js';

export interface PurchaseGrnLine {
  name: string;
  sizeCode: SizeCode;
  qty: number;
  unitCostPaise: Paise;
  amountPaise: Paise;
}

export interface PurchaseGrn {
  receiptId: string;
  businessDate: string;
  at: Date;
  invoiceNo: string;
  vendorName: string | null;
  receivedByName: string;
  lines: PurchaseGrnLine[];
  amountPaise: Paise;
}

export interface PurchaseSupplyLine {
  description: string;
  quantity: string | null;
  amountPaise: Paise;
}

export interface PurchaseSupply {
  purchaseId: string;
  businessDate: string;
  at: Date;
  vendorName: string | null;
  paidFrom: 'DRAWER' | 'OUTSIDE';
  note: string | null;
  lines: PurchaseSupplyLine[];
  /** Negative on a void. */
  amountPaise: Paise;
  isVoid: boolean;
  voided: boolean;
  byName: string;
}

export interface PurchaseCenter {
  code: DepartmentCode;
  name: string;
  grn: PurchaseGrn[];
  supplies: PurchaseSupply[];
  grnPaise: Paise;
  suppliesPaise: Paise;
  /** Of the supplies, paid from the drawer. */
  suppliesDrawerPaise: Paise;
  totalPaise: Paise;
}

export interface PurchaseSummary extends ReportHeader {
  center: string | null;
  centers: PurchaseCenter[];
  totalPaise: Paise;
}

export async function purchaseSummary(db: SqlClient, head: ReportHeader, center?: string): Promise<PurchaseSummary> {
  const params = [head.range.startDate, head.range.endDate, center ?? null];
  const { rows: grnRows } = await db.query<{
    receipt_id: string;
    business_date: string;
    created_at: Date;
    invoice_no: string;
    vendor_name: string | null;
    received_by: string;
    center_code: DepartmentCode;
    name: string;
    size_code: SizeCode;
    qty: number;
    unit_cost: DbInt;
  }>(
    `SELECT r.id AS receipt_id, d.business_date::text AS business_date, r.created_at, r.invoice_no, r.vendor_name,
            s.display_name AS received_by, p.department AS center_code, k.display_name AS name, k.size_code,
            rl.qty, rl.unit_cost_paise::text AS unit_cost
       FROM stock_receipt_lines rl
       JOIN stock_receipts r ON r.id = rl.receipt_id
       JOIN business_days d ON d.id = r.business_day_id
       JOIN staff s ON s.id = r.received_by_staff_id
       JOIN skus k ON k.id = rl.sku_id
       JOIN products p ON p.id = k.product_id
      WHERE d.business_date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR p.department = $3)
      ORDER BY d.business_date, r.created_at, r.id, rl.line_no`,
    params,
  );
  const { rows: supplyRows } = await db.query<{
    id: string;
    business_date: string;
    created_at: Date;
    center_code: DepartmentCode;
    vendor_name: string | null;
    paid_from: 'DRAWER' | 'OUTSIDE';
    note: string | null;
    amount: DbInt;
    is_void: boolean;
    voided: boolean;
    by_name: string;
  }>(
    `SELECT q.id, d.business_date::text AS business_date, q.created_at, q.department AS center_code,
            coalesce(q.vendor_name, o.vendor_name) AS vendor_name, q.paid_from, coalesce(q.note, o.note) AS note,
            q.amount_paise::text AS amount, (q.reverses_purchase_id IS NOT NULL) AS is_void,
            EXISTS (SELECT 1 FROM revenue_center_purchases v WHERE v.reverses_purchase_id = q.id) AS voided,
            s.display_name AS by_name
       FROM revenue_center_purchases q
       JOIN business_days d ON d.id = q.business_day_id
       JOIN staff s ON s.id = q.created_by_staff_id
       LEFT JOIN revenue_center_purchases o ON o.id = q.reverses_purchase_id
      WHERE d.business_date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR q.department = $3)
      ORDER BY d.business_date, q.created_at, q.id`,
    params,
  );
  const { rows: lineRows } = await db.query<{ purchase_id: string; description: string; quantity: string | null; amount: DbInt }>(
    `SELECT l.purchase_id, l.description, l.quantity, l.amount_paise::text AS amount
       FROM revenue_center_purchase_lines l
       JOIN revenue_center_purchases q ON q.id = l.purchase_id
       JOIN business_days d ON d.id = q.business_day_id
      WHERE d.business_date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR q.department = $3)
      ORDER BY l.purchase_id, l.line_no`,
    params,
  );
  const { rows: centerRows } = await db.query<{ code: DepartmentCode; name: string }>(`SELECT code, name FROM departments ORDER BY sort_order, lower(name)`);

  const linesOf = new Map<string, PurchaseSupplyLine[]>();
  for (const l of lineRows) {
    const list = linesOf.get(l.purchase_id) ?? [];
    list.push({ description: l.description, quantity: l.quantity, amountPaise: toPaise(l.amount) });
    linesOf.set(l.purchase_id, list);
  }

  const centers: PurchaseCenter[] = centerRows.map((c) => ({
    code: c.code,
    name: c.name,
    grn: [],
    supplies: [],
    grnPaise: 0n,
    suppliesPaise: 0n,
    suppliesDrawerPaise: 0n,
    totalPaise: 0n,
  }));
  const centerOf = (code: DepartmentCode) => {
    const c = centers.find((x) => x.code === code);
    if (!c) throw new Error(`purchase summary: unknown center ${code}`);
    return c;
  };

  for (const r of grnRows) {
    const c = centerOf(r.center_code);
    let receipt = c.grn.find((g) => g.receiptId === r.receipt_id);
    if (!receipt) {
      receipt = {
        receiptId: r.receipt_id,
        businessDate: r.business_date,
        at: r.created_at,
        invoiceNo: r.invoice_no,
        vendorName: r.vendor_name,
        receivedByName: r.received_by,
        lines: [],
        amountPaise: 0n,
      };
      c.grn.push(receipt);
    }
    const unitCostPaise = toPaise(r.unit_cost);
    const amountPaise = BigInt(r.qty) * unitCostPaise;
    receipt.lines.push({ name: r.name, sizeCode: r.size_code, qty: int(r.qty), unitCostPaise, amountPaise });
    receipt.amountPaise += amountPaise;
  }
  for (const r of supplyRows) {
    const c = centerOf(r.center_code);
    c.supplies.push({
      purchaseId: r.id,
      businessDate: r.business_date,
      at: r.created_at,
      vendorName: r.vendor_name,
      paidFrom: r.paid_from,
      note: r.note,
      lines: linesOf.get(r.id) ?? [],
      amountPaise: toPaise(r.amount),
      isVoid: r.is_void,
      voided: r.voided,
      byName: r.by_name,
    });
  }
  for (const c of centers) {
    c.grnPaise = sum(c.grn, (g) => g.amountPaise);
    c.suppliesPaise = sum(c.supplies, (s) => s.amountPaise);
    c.suppliesDrawerPaise = sum(
      c.supplies.filter((s) => s.paidFrom === 'DRAWER'),
      (s) => s.amountPaise,
    );
    c.totalPaise = c.grnPaise + c.suppliesPaise;
  }
  const shown = centers.filter((c) => c.grn.length > 0 || c.supplies.length > 0 || (center === undefined && c.code === 'LIQUOR') || c.code === center);
  return { ...head, center: center ?? null, centers: shown, totalPaise: sum(shown, (c) => c.totalPaise) };
}
