/**
 * Settings → Expense Categories (Phase 18): the managed list the Expense screen picks from.
 * Master data like the catalog — editable, never deleted (disable instead). Past expenses point at a
 * category by id (or, before 0012, by its legacy code), so a rename relabels their history.
 * Phase 19: each category belongs to a P&L department, or none (null = Shared overheads); past
 * expenses follow their category's department the same way they follow its name.
 */
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { NotFoundError, PosError, PosErrorCode, withPosErrors } from '../db/errors.js';
import type { DepartmentCode } from '../domain/types.js';
import { checkDepartmentCode, requireActiveDepartment } from './department.service.js';
import { maybeOne, one } from './rows.js';

export const MAX_CATEGORY_NAME = 40;

export interface ExpenseCategory {
  id: string;
  name: string;
  isActive: boolean;
  noteRequired: boolean;
  sortOrder: number;
  /** The P&L its expenses go to; null = Shared (overheads). */
  department: DepartmentCode | null;
  /** The 0006 code this category stands for on pre-0012 expenses; null for categories added since. */
  legacyCode: string | null;
  /** Expenses filed under it (originals, voids excluded), legacy rows included. */
  usedCount: number;
}

export interface NewExpenseCategory {
  name: string;
  noteRequired?: boolean;
  /** Default null (Shared). */
  department?: DepartmentCode | null;
}

export interface ExpenseCategoryPatch {
  name?: string;
  noteRequired?: boolean;
  isActive?: boolean;
  /** null moves it to Shared; past expenses follow. */
  department?: DepartmentCode | null;
  /** Swap places with the neighbour above or below in the picker order. */
  move?: 'up' | 'down';
}

interface CategoryRow {
  id: string;
  name: string;
  is_active: boolean;
  note_required: boolean;
  sort_order: number;
  department: DepartmentCode | null;
  legacy_code: string | null;
  used_count: number;
}

const SELECT_CATEGORIES = `
  SELECT c.id, c.name, c.is_active, c.note_required, c.sort_order, c.department, c.legacy_code,
         (SELECT count(*)::int FROM cash_expenses e
           WHERE e.amount_paise > 0 AND (e.category_id = c.id OR (c.legacy_code IS NOT NULL AND e.category = c.legacy_code))) AS used_count
    FROM expense_categories c`;

function mapCategory(r: CategoryRow): ExpenseCategory {
  return {
    id: r.id,
    name: r.name,
    isActive: r.is_active,
    noteRequired: r.note_required,
    sortOrder: r.sort_order,
    department: r.department,
    legacyCode: r.legacy_code,
    usedCount: r.used_count,
  };
}

/** Trimmed, inner runs of spaces collapsed; RangeError when blank or too long. */
export function cleanCategoryName(name: string): string {
  const text = name.trim().replace(/\s+/g, ' ');
  if (text === '') throw new RangeError('a category needs a name');
  if (text.length > MAX_CATEGORY_NAME) throw new RangeError(`a category name must be at most ${MAX_CATEGORY_NAME} characters`);
  return text;
}

function checkDepartment(department: DepartmentCode | null | undefined): DepartmentCode | null | undefined {
  return department === undefined || department === null ? department : checkDepartmentCode(department);
}

async function getCategory(db: SqlClient, id: string): Promise<ExpenseCategory> {
  const row = await maybeOne<CategoryRow>(db, `${SELECT_CATEGORIES} WHERE c.id = $1`, [id]);
  if (!row) throw new NotFoundError('expense category', id);
  return mapCategory(row);
}

export class ExpenseCategoryService {
  constructor(private readonly db: SqlDatabase) {}

  /** In picker order (then name). Active ones only unless `includeInactive`. */
  async listCategories({ includeInactive = false }: { includeInactive?: boolean } = {}): Promise<ExpenseCategory[]> {
    const { rows } = await this.db.query<CategoryRow>(
      `${SELECT_CATEGORIES} ${includeInactive ? '' : 'WHERE c.is_active'} ORDER BY c.sort_order, lower(c.name)`,
    );
    return rows.map(mapCategory);
  }

  /** Added at the end of the picker order. A name already taken (any case) is PS012. */
  async createCategory(input: NewExpenseCategory): Promise<ExpenseCategory> {
    const name = cleanCategoryName(input.name);
    const department = checkDepartment(input.department) ?? null;
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await tx.query(`LOCK TABLE expense_categories IN SHARE ROW EXCLUSIVE MODE`); // one sort_order per new row
        if (department !== null) await requireActiveDepartment(tx, department);
        const row = await one<{ id: string }>(
          tx,
          `INSERT INTO expense_categories (name, note_required, department, sort_order)
           VALUES ($1, $2, $3, (SELECT coalesce(max(sort_order), 0) + 1 FROM expense_categories)) RETURNING id`,
          [name, input.noteRequired ?? false, department],
        );
        return getCategory(tx, row.id);
      }),
    );
  }

  /**
   * Renames, flips the note rule, disables / enables, or moves one place in the order. The last
   * active category can't be disabled (PS002): the Expense screen would have nothing to pick.
   */
  async updateCategory(id: string, patch: ExpenseCategoryPatch): Promise<ExpenseCategory> {
    const name = patch.name === undefined ? undefined : cleanCategoryName(patch.name);
    const department = checkDepartment(patch.department);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await tx.query(`LOCK TABLE expense_categories IN SHARE ROW EXCLUSIVE MODE`);
        if (department !== undefined && department !== null) await requireActiveDepartment(tx, department);
        const current = await getCategory(tx, id);

        if (patch.isActive === false && current.isActive) {
          const others = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM expense_categories WHERE is_active AND id <> $1`, [id]);
          if (others.n === 0) {
            throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `${current.name} is the last active category; add or enable another first`);
          }
        }

        if (name !== undefined || patch.noteRequired !== undefined || patch.isActive !== undefined || department !== undefined) {
          await tx.query(
            `UPDATE expense_categories
                SET name = coalesce($2, name), note_required = coalesce($3, note_required), is_active = coalesce($4, is_active),
                    department = CASE WHEN $5 THEN $6 ELSE department END
              WHERE id = $1`,
            [id, name ?? null, patch.noteRequired ?? null, patch.isActive ?? null, department !== undefined, department ?? null],
          );
        }

        if (patch.move) {
          const neighbour = await maybeOne<{ id: string; sort_order: number }>(
            tx,
            patch.move === 'up'
              ? `SELECT id, sort_order FROM expense_categories WHERE sort_order < $1 ORDER BY sort_order DESC LIMIT 1`
              : `SELECT id, sort_order FROM expense_categories WHERE sort_order > $1 ORDER BY sort_order ASC LIMIT 1`,
            [current.sortOrder],
          );
          if (neighbour) {
            await tx.query(`UPDATE expense_categories SET sort_order = $2 WHERE id = $1`, [neighbour.id, current.sortOrder]);
            await tx.query(`UPDATE expense_categories SET sort_order = $2 WHERE id = $1`, [id, neighbour.sort_order]);
          }
        }
        return getCategory(tx, id);
      }),
    );
  }
}
