/**
 * Expenses Summary (Phase 24 §1.5): every petty-cash payout in the range, grouped by expense category,
 * itemised, and rolled up by revenue center (a category's center, or Shared). A void and the expense it
 * voids are both listed and net to ₹0. Pre-0012 rows resolve through legacy_code, as Day End does.
 * `center`: undefined = all, a center code = that center's categories, 'SHARED' = categories with no center.
 */
import type { SqlClient } from '../../db/client.js';
import { type DbInt, type Paise, toPaise } from '../../domain/money.js';
import type { DepartmentCode } from '../../domain/types.js';
import { type ReportHeader, sum } from './shared.js';

export const SHARED = 'SHARED';

export interface ExpenseReportEntry {
  id: string;
  businessDate: string;
  at: Date;
  description: string;
  /** Negative on a void. */
  amountPaise: Paise;
  /** This row voids an earlier expense. */
  isVoid: boolean;
  /** This expense was voided later. */
  voided: boolean;
  byName: string;
}

export interface ExpenseCategoryGroup {
  categoryId: string;
  name: string;
  centerCode: DepartmentCode | null;
  /** null = Shared overheads. */
  centerName: string | null;
  amountPaise: Paise;
  /** Expenses still standing. */
  count: number;
  entries: ExpenseReportEntry[];
}

export interface ExpenseCenterTotal {
  /** 'SHARED' for categories with no center. */
  code: string;
  name: string;
  amountPaise: Paise;
}

export interface ExpenseSummary extends ReportHeader {
  center: string | null;
  byCategory: ExpenseCategoryGroup[];
  byCenter: ExpenseCenterTotal[];
  totalPaise: Paise;
}

interface Row {
  id: string;
  business_date: string;
  created_at: Date;
  description: string;
  amount: DbInt;
  is_void: boolean;
  voided: boolean;
  by_name: string;
  category_id: string;
  category_name: string;
  center_code: DepartmentCode | null;
  center_name: string | null;
}

export async function expenseSummary(db: SqlClient, head: ReportHeader, center?: string): Promise<ExpenseSummary> {
  const { rows } = await db.query<Row>(
    `SELECT e.id, d.business_date::text AS business_date, e.created_at, e.description, e.amount_paise::text AS amount,
            (e.reverses_expense_id IS NOT NULL) AS is_void,
            EXISTS (SELECT 1 FROM cash_expenses v WHERE v.reverses_expense_id = e.id) AS voided,
            s.display_name AS by_name,
            c.id AS category_id, c.name AS category_name, dp.code AS center_code, dp.name AS center_name
       FROM cash_expenses e
       JOIN business_days d ON d.id = e.business_day_id
       JOIN staff s ON s.id = e.created_by_staff_id
       JOIN expense_categories c ON c.id = e.category_id OR (e.category_id IS NULL AND c.legacy_code = e.category)
       LEFT JOIN departments dp ON dp.code = c.department
      WHERE d.business_date BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR ($3 = '${SHARED}' AND c.department IS NULL) OR c.department = $3)
      ORDER BY coalesce(dp.sort_order, 2147483647), c.sort_order, lower(c.name), d.business_date, e.created_at, e.id`,
    [head.range.startDate, head.range.endDate, center ?? null],
  );

  const byCategory: ExpenseCategoryGroup[] = [];
  for (const r of rows) {
    let group = byCategory.find((g) => g.categoryId === r.category_id);
    if (!group) {
      group = { categoryId: r.category_id, name: r.category_name, centerCode: r.center_code, centerName: r.center_name, amountPaise: 0n, count: 0, entries: [] };
      byCategory.push(group);
    }
    const entry: ExpenseReportEntry = {
      id: r.id,
      businessDate: r.business_date,
      at: r.created_at,
      description: r.description,
      amountPaise: toPaise(r.amount),
      isVoid: r.is_void,
      voided: r.voided,
      byName: r.by_name,
    };
    group.entries.push(entry);
    group.amountPaise += entry.amountPaise;
    if (!entry.isVoid && !entry.voided) group.count += 1;
  }

  const byCenter: ExpenseCenterTotal[] = [];
  for (const g of byCategory) {
    const code = g.centerCode ?? SHARED;
    const total = byCenter.find((c) => c.code === code);
    if (total) total.amountPaise += g.amountPaise;
    else byCenter.push({ code, name: g.centerName ?? 'Shared', amountPaise: g.amountPaise });
  }
  return { ...head, center: center ?? null, byCategory, byCenter, totalPaise: sum(byCategory, (g) => g.amountPaise) };
}
