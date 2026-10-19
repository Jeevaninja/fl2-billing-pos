/**
 * Kitchen Kiosk (Phase 21, migration 0015): kitchen purchases (raw materials, apart from the liquor
 * GRN) and the daily Kitchen P&L.
 *
 *   sales      = KITCHEN bill lines on the bills Day End counts (settled normal bills, ended peaks)
 *   expenses   = petty-cash expenses whose category is Kitchen (Shared overheads stay out)
 *   purchases  = kitchen purchases, drawer and outside
 *   gross      = sales − expenses − purchases
 *
 * Purchases paid from the drawer also lower Day End's expected cash (pos_day_expected_cash).
 */
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { NotFoundError, withPosErrors } from '../db/errors.js';
import { assertPaise, type DbInt, type Paise, paiseParam, toPaise } from '../domain/money.js';
import { COUNTED_BILLS, DayEndService, getDay, getDayFigures, type DaySummary, type ExpenseEntry } from './day-end.service.js';
import { maybeOne, one } from './rows.js';

export type KitchenPaidFrom = 'DRAWER' | 'OUTSIDE';

export const MAX_PURCHASE_LINES = 30;
/** ₹10,00,000: a guard against a mistyped amount, not a business rule. */
export const MAX_PURCHASE_PAISE = 10_00_000_00n;

export interface KitchenPurchaseLineInput {
  description: string;
  /** Free text, e.g. "5 kg": a label, never arithmetic. */
  quantity?: string | null | undefined;
  amountPaise: Paise;
}

export interface KitchenPurchaseInput {
  vendorName?: string | null | undefined;
  paidFrom: KitchenPaidFrom;
  note?: string | null | undefined;
  lines: readonly KitchenPurchaseLineInput[];
}

export interface KitchenPurchaseLine {
  lineNo: number;
  description: string;
  quantity: string | null;
  amountPaise: Paise;
}

export interface KitchenPurchase {
  id: string;
  businessDayId: string;
  vendorName: string | null;
  paidFrom: KitchenPaidFrom;
  /** Negative on a void row. */
  amountPaise: Paise;
  note: string | null;
  reversesPurchaseId: string | null;
  createdByStaffId: string;
  createdAt: Date;
  /** Empty on a void row. */
  lines: KitchenPurchaseLine[];
}

export interface KitchenPurchaseEntry extends KitchenPurchase {
  voidedAt: Date | null;
}

export interface KitchenItemSold {
  skuId: string;
  displayName: string;
  quantity: number;
  amountPaise: Paise;
}

export interface KitchenSummary {
  day: Pick<DaySummary, 'id' | 'businessDate' | 'status'>;
  /** KITCHEN lines on counted bills: the same figure as Day End's byDepartment KITCHEN. */
  salesPaise: Paise;
  /** KITCHEN lines on bills not counted yet (open tabs, a running peak): information, not sales. */
  openTabsPaise: Paise;
  /** Σ the day's Kitchen-category expenses that weren't voided. */
  expensesPaise: Paise;
  /** Σ the day's kitchen purchases that weren't voided, drawer and outside. */
  purchasesPaise: Paise;
  purchasesDrawerPaise: Paise;
  /** sales − expenses − purchases. */
  grossPaise: Paise;
  /** Best sellers first (by amount, then quantity). */
  itemsSold: KitchenItemSold[];
  /** The day's Kitchen-category expenses (originals, newest first, with voidedAt). */
  expenses: ExpenseEntry[];
  purchases: KitchenPurchaseEntry[];
}

interface PurchaseRow {
  id: string;
  business_day_id: string;
  vendor_name: string | null;
  paid_from: KitchenPaidFrom;
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

function mapPurchase(r: PurchaseRow, lines: readonly LineRow[]): KitchenPurchase {
  return {
    id: r.id,
    businessDayId: r.business_day_id,
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

function checkPurchase(input: KitchenPurchaseInput): { vendor: string | null; note: string | null; lines: KitchenPurchaseLine[]; total: Paise } {
  if (input.paidFrom !== 'DRAWER' && input.paidFrom !== 'OUTSIDE') throw new RangeError('paidFrom must be DRAWER or OUTSIDE');
  if (input.lines.length === 0) throw new RangeError('a kitchen purchase needs at least one line');
  if (input.lines.length > MAX_PURCHASE_LINES) throw new RangeError(`a kitchen purchase can have at most ${MAX_PURCHASE_LINES} lines`);
  const lines = input.lines.map((l, i): KitchenPurchaseLine => {
    const description = optionalText(l.description, `lines[${i}].description`, 60);
    if (description === null) throw new RangeError(`lines[${i}].description is required`);
    assertPaise(l.amountPaise, `lines[${i}].amountPaise`);
    return { lineNo: i + 1, description, quantity: optionalText(l.quantity, `lines[${i}].quantity`, 20), amountPaise: l.amountPaise };
  });
  const total = lines.reduce((sum, l) => sum + l.amountPaise, 0n);
  if (total > MAX_PURCHASE_PAISE) throw new RangeError('a kitchen purchase can be at most ₹10,00,000');
  return { vendor: optionalText(input.vendorName, 'vendorName', 80), note: optionalText(input.note, 'note', 200), lines, total };
}

async function loadPurchase(db: SqlClient, id: string): Promise<KitchenPurchase> {
  const row = await maybeOne<PurchaseRow>(db, `SELECT * FROM kitchen_purchases WHERE id = $1`, [id]);
  if (!row) throw new NotFoundError('kitchen purchase', id);
  const { rows } = await db.query<LineRow>(`SELECT * FROM kitchen_purchase_lines WHERE purchase_id = $1 ORDER BY line_no`, [id]);
  return mapPurchase(row, rows);
}

export class KitchenService {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Records a purchase on the open day with its lines, in one transaction. A DRAWER purchase is
   * refused while a peak session runs (PS007); no open day is PS007.
   */
  async recordPurchase(input: KitchenPurchaseInput, staffId: string): Promise<KitchenPurchase> {
    const { vendor, note, lines, total } = checkPurchase(input);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const { id } = await one<{ id: string }>(
          tx,
          `INSERT INTO kitchen_purchases (vendor_name, paid_from, amount_paise, note, created_by_staff_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [vendor, input.paidFrom, paiseParam(total), note, staffId],
        );
        for (const line of lines) {
          await tx.query(
            `INSERT INTO kitchen_purchase_lines (purchase_id, line_no, description, quantity, amount_paise) VALUES ($1, $2, $3, $4, $5)`,
            [id, line.lineNo, line.description, line.quantity, paiseParam(line.amountPaise)],
          );
        }
        return loadPurchase(tx, id);
      }),
    );
  }

  /** Appends the row that negates a purchase (same day only, once). */
  async voidPurchase(purchaseId: string, staffId: string): Promise<KitchenPurchase> {
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const original = await maybeOne<PurchaseRow>(tx, `SELECT * FROM kitchen_purchases WHERE id = $1`, [purchaseId]);
        if (!original) throw new NotFoundError('kitchen purchase', purchaseId);
        const { id } = await one<{ id: string }>(
          tx,
          `INSERT INTO kitchen_purchases (paid_from, amount_paise, reverses_purchase_id, created_by_staff_id)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [original.paid_from, paiseParam(-toPaise(original.amount_paise)), purchaseId, staffId],
        );
        return loadPurchase(tx, id);
      }),
    );
  }

  /** The day's purchases, newest first: originals only, each with its lines and when (if ever) it was voided. */
  async listPurchases(businessDayId: string): Promise<KitchenPurchaseEntry[]> {
    const { rows } = await this.db.query<PurchaseRow & { voided_at: Date | null }>(
      `SELECT q.*, v.created_at AS voided_at
         FROM kitchen_purchases q
         LEFT JOIN kitchen_purchases v ON v.reverses_purchase_id = q.id
        WHERE q.business_day_id = $1 AND q.reverses_purchase_id IS NULL
        ORDER BY q.created_at DESC, q.id DESC`,
      [businessDayId],
    );
    const { rows: lines } = await this.db.query<LineRow>(
      `SELECT l.* FROM kitchen_purchase_lines l JOIN kitchen_purchases q ON q.id = l.purchase_id
        WHERE q.business_day_id = $1 ORDER BY l.purchase_id, l.line_no`,
      [businessDayId],
    );
    return rows.map((r) => ({ ...mapPurchase(r, lines), voidedAt: r.voided_at }));
  }

  /** The Kitchen P&L for a day (D5). NotFoundError for an unknown day. */
  async getKitchenSummary(businessDayId: string): Promise<KitchenSummary> {
    const day = await getDay(this.db, businessDayId);
    const sums = await one<{ sales: DbInt; open: DbInt }>(
      this.db,
      `WITH counted AS (${COUNTED_BILLS}),
       kitchen AS (
         SELECT i.line_total_paise, i.bill_id IN (SELECT id FROM counted) AS counted
           FROM bill_items i JOIN bills b ON b.id = i.bill_id
          WHERE i.department = 'KITCHEN' AND b.business_day_id = $1
       )
       SELECT coalesce(sum(line_total_paise) FILTER (WHERE counted), 0)::text AS sales,
              coalesce(sum(line_total_paise) FILTER (WHERE NOT counted), 0)::text AS open
         FROM kitchen`,
      [day.id],
    );
    const { rows: sold } = await this.db.query<{ sku_id: string; display_name: string; quantity: number; amount: DbInt }>(
      `WITH counted AS (${COUNTED_BILLS})
       SELECT i.sku_id, max(i.display_name_snapshot) AS display_name, sum(i.qty)::int AS quantity, sum(i.line_total_paise)::text AS amount
         FROM bill_items i
        WHERE i.department = 'KITCHEN' AND i.bill_id IN (SELECT id FROM counted)
        GROUP BY i.sku_id
       HAVING sum(i.qty) <> 0 OR sum(i.line_total_paise) <> 0
        ORDER BY sum(i.line_total_paise) DESC, sum(i.qty) DESC, max(i.display_name_snapshot)`,
      [day.id],
    );

    const salesPaise = toPaise(sums.sales);
    // The same counted-bill rule as Day End, so the two screens can never disagree.
    const { sales } = await getDayFigures(this.db, day);
    const dayEndKitchen = sales.byDepartment.find((d) => d.code === 'KITCHEN')?.salesPaise ?? 0n;
    if (dayEndKitchen !== salesPaise) {
      throw new Error(`day ${day.businessDate}: kitchen sales ${salesPaise} disagree with Day End's ${dayEndKitchen}`);
    }

    const expenses = (await new DayEndService(this.db).listCashExpenses(day.id)).filter((e) => e.category.department === 'KITCHEN');
    const purchases = await this.listPurchases(day.id);
    const live = <T extends { voidedAt: Date | null }>(rows: readonly T[]) => rows.filter((r) => r.voidedAt === null);
    const expensesPaise = live(expenses).reduce((sum, e) => sum + e.amountPaise, 0n);
    const purchasesPaise = live(purchases).reduce((sum, p) => sum + p.amountPaise, 0n);
    const purchasesDrawerPaise = live(purchases)
      .filter((p) => p.paidFrom === 'DRAWER')
      .reduce((sum, p) => sum + p.amountPaise, 0n);

    return {
      day: { id: day.id, businessDate: day.businessDate, status: day.status },
      salesPaise,
      openTabsPaise: toPaise(sums.open),
      expensesPaise,
      purchasesPaise,
      purchasesDrawerPaise,
      grossPaise: salesPaise - expensesPaise - purchasesPaise,
      itemsSold: sold.map((r) => ({ skuId: r.sku_id, displayName: r.display_name, quantity: r.quantity, amountPaise: toPaise(r.amount) })),
      expenses,
      purchases,
    };
  }
}
