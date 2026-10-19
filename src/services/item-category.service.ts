/**
 * Settings → Item Categories (Phase 20): the manager's catalog groupings (FULL, HALF, QUARTER, BEER,
 * WINE, …) in stock-report order. Master data like expense categories — editable, never deleted
 * (disable instead). Each suggests a default size and department for new items; the size itself
 * stays on every item.
 */
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { NotFoundError, withPosErrors } from '../db/errors.js';
import type { DepartmentCode, SizeCode } from '../domain/types.js';
import { DEPARTMENT_CODES, SIZE_CODES } from './catalog.service.js';
import { maybeOne, one } from './rows.js';

export const MAX_ITEM_CATEGORY_NAME = 30;

export interface ItemCategory {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  /** Pre-fills a new item's size; null = always ask. */
  defaultSizeCode: SizeCode | null;
  /** Pre-fills a new brand's department. */
  defaultDepartment: DepartmentCode;
  /** The seeded category this is (FULL … OTHERS); null for categories added since. */
  systemKey: string | null;
  /** Active items in it. */
  itemCount: number;
  /** Σ bottles on hand over its stock-tracked items. */
  onHandQty: number;
}

export interface NewItemCategory {
  name: string;
  defaultSizeCode?: SizeCode | null;
  defaultDepartment?: DepartmentCode;
}

export interface ItemCategoryPatch {
  name?: string;
  /** null clears it (always ask for a size). */
  defaultSizeCode?: SizeCode | null;
  defaultDepartment?: DepartmentCode;
  isActive?: boolean;
  /** Swap places with the neighbour above or below in report order. */
  move?: 'up' | 'down';
}

interface CategoryRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  default_size_code: SizeCode | null;
  default_department: DepartmentCode;
  system_key: string | null;
  item_count: number;
  on_hand_qty: number;
}

const SELECT_CATEGORIES = `
  SELECT c.id, c.name, c.sort_order, c.is_active, c.default_size_code, c.default_department, c.system_key,
         (SELECT count(*)::int FROM skus k WHERE k.item_category_id = c.id AND k.is_active) AS item_count,
         (SELECT coalesce(sum(s.on_hand_qty), 0)::int FROM skus k JOIN sku_stock s ON s.sku_id = k.id
           WHERE k.item_category_id = c.id) AS on_hand_qty
    FROM item_categories c`;

function mapCategory(r: CategoryRow): ItemCategory {
  return {
    id: r.id,
    name: r.name,
    sortOrder: r.sort_order,
    isActive: r.is_active,
    defaultSizeCode: r.default_size_code,
    defaultDepartment: r.default_department,
    systemKey: r.system_key,
    itemCount: r.item_count,
    onHandQty: r.on_hand_qty,
  };
}

/** Trimmed, inner runs of spaces collapsed; RangeError when blank or too long. Stored as typed (D4). */
export function cleanItemCategoryName(name: string): string {
  const text = name.trim().replace(/\s+/g, ' ');
  if (text === '') throw new RangeError('a category needs a name');
  if (text.length > MAX_ITEM_CATEGORY_NAME) throw new RangeError(`a category name must be at most ${MAX_ITEM_CATEGORY_NAME} characters`);
  return text;
}

function checkSize(size: SizeCode | null | undefined): SizeCode | null | undefined {
  if (size === undefined || size === null) return size;
  if (!(SIZE_CODES as readonly string[]).includes(size)) throw new RangeError(`defaultSizeCode must be one of ${SIZE_CODES.join(', ')}, or null`);
  return size;
}

function checkDepartment(department: DepartmentCode | undefined): DepartmentCode | undefined {
  if (department !== undefined && !(DEPARTMENT_CODES as readonly string[]).includes(department)) {
    throw new RangeError(`defaultDepartment must be one of ${DEPARTMENT_CODES.join(', ')}`);
  }
  return department;
}

export async function getItemCategory(db: SqlClient, id: string): Promise<ItemCategory> {
  const row = await maybeOne<CategoryRow>(db, `${SELECT_CATEGORIES} WHERE c.id = $1`, [id]);
  if (!row) throw new NotFoundError('item category', id);
  return mapCategory(row);
}

export class ItemCategoryService {
  constructor(private readonly db: SqlDatabase) {}

  /** In report order (then name). Active ones only unless `includeInactive`. */
  async listCategories({ includeInactive = false }: { includeInactive?: boolean } = {}): Promise<ItemCategory[]> {
    const { rows } = await this.db.query<CategoryRow>(
      `${SELECT_CATEGORIES} ${includeInactive ? '' : 'WHERE c.is_active'} ORDER BY c.sort_order, lower(c.name)`,
    );
    return rows.map(mapCategory);
  }

  /** Added at the end of the report order. A name already taken (any case) is PS012. */
  async createCategory(input: NewItemCategory): Promise<ItemCategory> {
    const name = cleanItemCategoryName(input.name);
    const size = checkSize(input.defaultSizeCode) ?? null;
    const department = checkDepartment(input.defaultDepartment) ?? 'LIQUOR';
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await tx.query(`LOCK TABLE item_categories IN SHARE ROW EXCLUSIVE MODE`); // one sort_order per new row
        const row = await one<{ id: string }>(
          tx,
          `INSERT INTO item_categories (name, default_size_code, default_department, sort_order)
           VALUES ($1, $2, $3, (SELECT coalesce(max(sort_order), 0) + 1 FROM item_categories)) RETURNING id`,
          [name, size, department],
        );
        return getItemCategory(tx, row.id);
      }),
    );
  }

  /**
   * Renames, changes the defaults, disables / enables, or moves one place. Disabling a category that
   * still has active items is PS002 (the trigger).
   */
  async updateCategory(id: string, patch: ItemCategoryPatch): Promise<ItemCategory> {
    const name = patch.name === undefined ? undefined : cleanItemCategoryName(patch.name);
    const size = checkSize(patch.defaultSizeCode);
    const department = checkDepartment(patch.defaultDepartment);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await tx.query(`LOCK TABLE item_categories IN SHARE ROW EXCLUSIVE MODE`);
        const current = await getItemCategory(tx, id);
        if (name !== undefined || size !== undefined || department !== undefined || patch.isActive !== undefined) {
          await tx.query(
            `UPDATE item_categories
                SET name = coalesce($2, name),
                    default_size_code = CASE WHEN $3 THEN $4 ELSE default_size_code END,
                    default_department = coalesce($5, default_department),
                    is_active = coalesce($6, is_active)
              WHERE id = $1`,
            [id, name ?? null, size !== undefined, size ?? null, department ?? null, patch.isActive ?? null],
          );
        }
        if (patch.move) {
          const neighbour = await maybeOne<{ id: string; sort_order: number }>(
            tx,
            patch.move === 'up'
              ? `SELECT id, sort_order FROM item_categories WHERE sort_order < $1 ORDER BY sort_order DESC LIMIT 1`
              : `SELECT id, sort_order FROM item_categories WHERE sort_order > $1 ORDER BY sort_order ASC LIMIT 1`,
            [current.sortOrder],
          );
          if (neighbour) {
            await tx.query(`UPDATE item_categories SET sort_order = $2 WHERE id = $1`, [neighbour.id, current.sortOrder]);
            await tx.query(`UPDATE item_categories SET sort_order = $2 WHERE id = $1`, [id, neighbour.sort_order]);
          }
        }
        return getItemCategory(tx, id);
      }),
    );
  }
}
