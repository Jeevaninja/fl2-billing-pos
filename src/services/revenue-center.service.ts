/**
 * Revenue Centers (Phase 22; Kitchen Kiosk in Phase 21). Each non-liquor center — Kitchen, Cigarettes,
 * Cool Drinks, Water Bottles, AC Charges, … — gets its own daily P&L:
 *
 *   sales      = the center's bill lines on the bills Day End counts (settled normal bills, ended peaks)
 *   expenses   = petty-cash expenses whose category maps to the center (Shared overheads stay out)
 *   purchases  = stock purchases (GRN lines today for items whose brand is in the center)
 *              + supply purchases (the center's own purchase ledger, drawer and outside)        (D2)
 *   gross      = sales − expenses − purchases
 *
 * Supply purchases paid from the drawer also lower Day End's expected cash (pos_day_expected_cash).
 */
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { NotFoundError, withPosErrors } from '../db/errors.js';
import { assertPaise, type DbInt, type Paise, paiseParam, toPaise } from '../domain/money.js';
import type { DepartmentCode, DepartmentStation } from '../domain/types.js';
import { COUNTED_BILLS, DayEndService, getDay, getDayFigures, type DaySummary, type ExpenseEntry } from './day-end.service.js';
import { checkDepartmentCode, getDepartment } from './department.service.js';
import { maybeOne, one } from './rows.js';

export type PurchasePaidFrom = 'DRAWER' | 'OUTSIDE';

export const MAX_PURCHASE_LINES = 30;
/** ₹10,00,000: a guard against a mistyped amount, not a business rule. */
export const MAX_PURCHASE_PAISE = 10_00_000_00n;

export interface CenterPurchaseLineInput {
  description: string;
  /** Free text, e.g. "5 kg": a label, never arithmetic. */
  quantity?: string | null | undefined;
  amountPaise: Paise;
}

export interface CenterPurchaseInput {
  /** The revenue center it belongs to (active, not LIQUOR). */
  department: DepartmentCode;
  vendorName?: string | null | undefined;
  paidFrom: PurchasePaidFrom;
  note?: string | null | undefined;
  lines: readonly CenterPurchaseLineInput[];
}

export interface CenterPurchaseLine {
  lineNo: number;
  description: string;
  quantity: string | null;
  amountPaise: Paise;
}

export interface CenterPurchase {
  id: string;
  businessDayId: string;
  department: DepartmentCode;
  vendorName: string | null;
  paidFrom: PurchasePaidFrom;
  /** Negative on a void row. */
  amountPaise: Paise;
  note: string | null;
  reversesPurchaseId: string | null;
  createdByStaffId: string;
  createdAt: Date;
  /** Empty on a void row. */
  lines: CenterPurchaseLine[];
}

export interface CenterPurchaseEntry extends CenterPurchase {
  voidedAt: Date | null;
}

export interface CenterItemSold {
  skuId: string;
  displayName: string;
  quantity: number;
  amountPaise: Paise;
}

export interface RevenueCenterSummary {
  center: { code: DepartmentCode; name: string; tracksStock: boolean; kotStation: DepartmentStation };
  day: Pick<DaySummary, 'id' | 'businessDate' | 'status'>;
  /** The center's lines on counted bills: the same figure as Day End's byDepartment for its code. */
  salesPaise: Paise;
  /** Its lines on bills not counted yet (open tabs, a running peak): information, not sales. */
  openTabsPaise: Paise;
  /** Σ the day's expenses in categories mapped to the center, voids netted out. */
  expensesPaise: Paise;
  /** stockPurchasesPaise + supplyPurchasesPaise. */
  purchasesPaise: Paise;
  /** GRN lines received today for items whose brand is in the center (qty × unit cost). */
  stockPurchasesPaise: Paise;
  /** The center's own purchase ledger, voids netted out … */
  supplyPurchasesPaise: Paise;
  /** … of which paid from the drawer. */
  supplyDrawerPaise: Paise;
  /** sales − expenses − purchases. */
  grossPaise: Paise;
  /** Best sellers first (by amount, then quantity). */
  itemsSold: CenterItemSold[];
  /** The day's expenses in the center's categories (originals, newest first, with voidedAt). */
  expenses: ExpenseEntry[];
  /** The center's own purchases (originals, newest first, with lines and voidedAt). */
  purchases: CenterPurchaseEntry[];
}

export interface RevenueCenterOverviewRow {
  code: DepartmentCode;
  name: string;
  salesPaise: Paise;
  expensesPaise: Paise;
  purchasesPaise: Paise;
  grossPaise: Paise;
}

export interface RevenueCenterOverview {
  day: Pick<DaySummary, 'id' | 'businessDate' | 'status'>;
  /** Every active non-liquor center, in display order. */
  centers: RevenueCenterOverviewRow[];
  total: Omit<RevenueCenterOverviewRow, 'code' | 'name'>;
}

interface PurchaseRow {
  id: string;
  business_day_id: string;
  department: DepartmentCode;
  vendor_name: string | null;
  paid_from: PurchasePaidFrom;
  amount_paise: DbInt;
  note: string | null;
  reverses_purchase_id: string | null;
  created_by_staff_id: string;
  created_at: Date;
}

interface LineRow {
  purchase_id: string;
  line_no: number;
  description: string;
  quantity: string | null;
  amount_paise: DbInt;
}

function mapPurchase(r: PurchaseRow, lines: readonly LineRow[]): CenterPurchase {
  return {
    id: r.id,
    businessDayId: r.business_day_id,
    department: r.department,
    vendorName: r.vendor_name,
    paidFrom: r.paid_from,
    amountPaise: toPaise(r.amount_paise),
    note: r.note,
    reversesPurchaseId: r.reverses_purchase_id,
    createdByStaffId: r.created_by_staff_id,
    createdAt: r.created_at,
    lines: lines
      .filter((l) => l.purchase_id === r.id)
      .map((l) => ({ lineNo: l.line_no, description: l.description, quantity: l.quantity, amountPaise: toPaise(l.amount_paise) })),
  };
}

/** Trimmed; blank → null; RangeError when longer than `max`. */
function optionalText(value: string | null | undefined, name: string, max: number): string | null {
  const text = value?.trim().replace(/\s+/g, ' ') ?? '';
  if (text === '') return null;
  if (text.length > max) throw new RangeError(`${name} must be at most ${max} characters`);
  return text;
}

function checkPurchase(input: CenterPurchaseInput): { vendor: string | null; note: string | null; lines: CenterPurchaseLine[]; total: Paise } {
  checkDepartmentCode(input.department);
  if (input.paidFrom !== 'DRAWER' && input.paidFrom !== 'OUTSIDE') throw new RangeError('paidFrom must be DRAWER or OUTSIDE');
  if (input.lines.length === 0) throw new RangeError('a purchase needs at least one line');
  if (input.lines.length > MAX_PURCHASE_LINES) throw new RangeError(`a purchase can have at most ${MAX_PURCHASE_LINES} lines`);
  const lines = input.lines.map((l, i): CenterPurchaseLine => {
    const description = optionalText(l.description, `lines[${i}].description`, 60);
    if (description === null) throw new RangeError(`lines[${i}].description is required`);
    assertPaise(l.amountPaise, `lines[${i}].amountPaise`);
    return { lineNo: i + 1, description, quantity: optionalText(l.quantity, `lines[${i}].quantity`, 20), amountPaise: l.amountPaise };
  });
  const total = lines.reduce((sum, l) => sum + l.amountPaise, 0n);
  if (total > MAX_PURCHASE_PAISE) throw new RangeError('a purchase can be at most ₹10,00,000');
  return { vendor: optionalText(input.vendorName, 'vendorName', 80), note: optionalText(input.note, 'note', 200), lines, total };
}

async function loadPurchase(db: SqlClient, id: string): Promise<CenterPurchase> {
  const row = await maybeOne<PurchaseRow>(db, `SELECT * FROM revenue_center_purchases WHERE id = $1`, [id]);
  if (!row) throw new NotFoundError('purchase', id);
  const { rows } = await db.query<LineRow>(`SELECT * FROM revenue_center_purchase_lines WHERE purchase_id = $1 ORDER BY line_no`, [id]);
  return mapPurchase(row, rows);
}

const live = <T extends { voidedAt: Date | null }>(rows: readonly T[]) => rows.filter((r) => r.voidedAt === null);
const sum = <T>(rows: readonly T[], pick: (r: T) => Paise) => rows.reduce((total, r) => total + pick(r), 0n);

export class RevenueCenterService {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Records a supply purchase for a center on the open day, with its lines, in one transaction. The
   * center must be active and not Liquor (PS002); a DRAWER purchase is refused during a peak (PS007).
   */
  async recordPurchase(input: CenterPurchaseInput, staffId: string): Promise<CenterPurchase> {
    const { vendor, note, lines, total } = checkPurchase(input);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await getDepartment(tx, input.department); // NotFoundError for an unknown center
        const { id } = await one<{ id: string }>(
          tx,
          `INSERT INTO revenue_center_purchases (department, vendor_name, paid_from, amount_paise, note, created_by_staff_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [input.department, vendor, input.paidFrom, paiseParam(total), note, staffId],
        );
        for (const line of lines) {
          await tx.query(
            `INSERT INTO revenue_center_purchase_lines (purchase_id, line_no, description, quantity, amount_paise) VALUES ($1, $2, $3, $4, $5)`,
            [id, line.lineNo, line.description, line.quantity, paiseParam(line.amountPaise)],
          );
        }
        return loadPurchase(tx, id);
      }),
    );
  }

  /** Appends the row that negates a purchase (same day only, once). */
  async voidPurchase(purchaseId: string, staffId: string): Promise<CenterPurchase> {
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const original = await maybeOne<PurchaseRow>(tx, `SELECT * FROM revenue_center_purchases WHERE id = $1`, [purchaseId]);
        if (!original) throw new NotFoundError('purchase', purchaseId);
        const { id } = await one<{ id: string }>(
          tx,
          `INSERT INTO revenue_center_purchases (department, paid_from, amount_paise, reverses_purchase_id, created_by_staff_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [original.department, original.paid_from, paiseParam(-toPaise(original.amount_paise)), purchaseId, staffId],
        );
        return loadPurchase(tx, id);
      }),
    );
  }

  /** The day's purchases (one center, or all), newest first: originals with their lines and voidedAt. */
  async listPurchases(businessDayId: string, department?: DepartmentCode): Promise<CenterPurchaseEntry[]> {
    const { rows } = await this.db.query<PurchaseRow & { voided_at: Date | null }>(
      `SELECT q.*, v.created_at AS voided_at
         FROM revenue_center_purchases q
         LEFT JOIN revenue_center_purchases v ON v.reverses_purchase_id = q.id
        WHERE q.business_day_id = $1 AND q.reverses_purchase_id IS NULL AND ($2::text IS NULL OR q.department = $2)
        ORDER BY q.created_at DESC, q.id DESC`,
      [businessDayId, department ?? null],
    );
    const { rows: lines } = await this.db.query<LineRow>(
      `SELECT l.* FROM revenue_center_purchase_lines l JOIN revenue_center_purchases q ON q.id = l.purchase_id
        WHERE q.business_day_id = $1 AND ($2::text IS NULL OR q.department = $2) ORDER BY l.purchase_id, l.line_no`,
      [businessDayId, department ?? null],
    );
    return rows.map((r) => ({ ...mapPurchase(r, lines), voidedAt: r.voided_at }));
  }

  /** One center's P&L for a day. NotFoundError for an unknown day or center. */
  async getSummary(businessDayId: string, department: DepartmentCode): Promise<RevenueCenterSummary> {
    const day = await getDay(this.db, businessDayId);
    const center = await getDepartment(this.db, checkDepartmentCode(department));
    const sums = await one<{ sales: DbInt; open: DbInt; stock: DbInt }>(
      this.db,
      `WITH counted AS (${COUNTED_BILLS}),
       lines AS (
         SELECT i.line_total_paise, i.bill_id IN (SELECT id FROM counted) AS counted
           FROM bill_items i JOIN bills b ON b.id = i.bill_id
          WHERE i.department = $2 AND b.business_day_id = $1
       )
       SELECT coalesce((SELECT sum(line_total_paise) FROM lines WHERE counted), 0)::text AS sales,
              coalesce((SELECT sum(line_total_paise) FROM lines WHERE NOT counted), 0)::text AS open,
              coalesce((SELECT sum(rl.qty::bigint * rl.unit_cost_paise)
                          FROM stock_receipt_lines rl
                          JOIN stock_receipts r ON r.id = rl.receipt_id
                          JOIN skus k ON k.id = rl.sku_id
                          JOIN products p ON p.id = k.product_id
                         WHERE r.business_day_id = $1 AND p.department = $2), 0)::text AS stock`,
      [day.id, center.code],
    );
    const { rows: sold } = await this.db.query<{ sku_id: string; display_name: string; quantity: number; amount: DbInt }>(
      `WITH counted AS (${COUNTED_BILLS})
       SELECT i.sku_id, max(i.display_name_snapshot) AS display_name, sum(i.qty)::int AS quantity, sum(i.line_total_paise)::text AS amount
         FROM bill_items i
        WHERE i.department = $2 AND i.bill_id IN (SELECT id FROM counted)
        GROUP BY i.sku_id
       HAVING sum(i.qty) <> 0 OR sum(i.line_total_paise) <> 0
        ORDER BY sum(i.line_total_paise) DESC, sum(i.qty) DESC, max(i.display_name_snapshot)`,
      [day.id, center.code],
    );

    const salesPaise = toPaise(sums.sales);
    // The same counted-bill rule as Day End, so the two screens can never disagree.
    const { sales } = await getDayFigures(this.db, day);
    const dayEndFigure = sales.byDepartment.find((d) => d.code === center.code)?.salesPaise ?? 0n;
    if (dayEndFigure !== salesPaise) {
      throw new Error(`day ${day.businessDate}: ${center.name} sales ${salesPaise} disagree with Day End's ${dayEndFigure}`);
    }

    const expenses = (await new DayEndService(this.db).listCashExpenses(day.id)).filter((e) => e.category.department === center.code);
    const purchases = await this.listPurchases(day.id, center.code);
    const expensesPaise = sum(live(expenses), (e) => e.amountPaise);
    const supplyPurchasesPaise = sum(live(purchases), (p) => p.amountPaise);
    const supplyDrawerPaise = sum(
      live(purchases).filter((p) => p.paidFrom === 'DRAWER'),
      (p) => p.amountPaise,
    );
    const stockPurchasesPaise = toPaise(sums.stock);
    const purchasesPaise = stockPurchasesPaise + supplyPurchasesPaise;

    return {
      center: { code: center.code, name: center.name, tracksStock: center.tracksStock, kotStation: center.kotStation },
      day: { id: day.id, businessDate: day.businessDate, status: day.status },
      salesPaise,
      openTabsPaise: toPaise(sums.open),
      expensesPaise,
      purchasesPaise,
      stockPurchasesPaise,
      supplyPurchasesPaise,
      supplyDrawerPaise,
      grossPaise: salesPaise - expensesPaise - purchasesPaise,
      itemsSold: sold.map((r) => ({ skuId: r.sku_id, displayName: r.display_name, quantity: r.quantity, amountPaise: toPaise(r.amount) })),
      expenses,
      purchases,
    };
  }

  /** Every active non-liquor center's P&L for a day, with a total row (the "All centers" tab). */
  async getOverview(businessDayId: string): Promise<RevenueCenterOverview> {
    const day = await getDay(this.db, businessDayId);
    const { rows } = await this.db.query<{ code: DepartmentCode }>(
      `SELECT code FROM departments WHERE is_active AND code <> 'LIQUOR' ORDER BY sort_order, lower(name)`,
    );
    const centers: RevenueCenterOverviewRow[] = [];
    for (const { code } of rows) {
      const s = await this.getSummary(day.id, code);
      centers.push({ code, name: s.center.name, salesPaise: s.salesPaise, expensesPaise: s.expensesPaise, purchasesPaise: s.purchasesPaise, grossPaise: s.grossPaise });
    }
    return {
      day: { id: day.id, businessDate: day.businessDate, status: day.status },
      centers,
      total: {
        salesPaise: sum(centers, (c) => c.salesPaise),
        expensesPaise: sum(centers, (c) => c.expensesPaise),
        purchasesPaise: sum(centers, (c) => c.purchasesPaise),
        grossPaise: sum(centers, (c) => c.grossPaise),
      },
    };
  }
}
