/**
 * Master catalog: liquors (products) and their sealed sizes (SKUs) with sale price, default
 * purchase price and case size. Products and SKUs are mutable master rows (UPDATE captured by the
 * outbox) but never deleted: a liquor is retired by deactivating it. Bill lines snapshot the price,
 * so a price edit never changes a bill already rung up. Duplicates surface as PS012.
 */
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { InactiveError, NotFoundError, PosError, PosErrorCode, withPosErrors } from '../db/errors.js';
import { assertPaise, type Paise, paiseParam } from '../domain/money.js';
import type { DepartmentCode, SizeCode } from '../domain/types.js';
import { mapSkuLookup, SKU_COLUMNS, SKU_FROM, type SkuLookup, type SkuLookupRow } from './counter-queries.js';
import { checkDepartmentCode, requireActiveDepartment } from './department.service.js';
import { getItemCategory } from './item-category.service.js';
import { maybeOne, one } from './rows.js';

export const PRODUCT_CATEGORIES = ['WHISKY', 'RUM', 'VODKA', 'BRANDY', 'GIN', 'WINE', 'BEER', 'OTHER', 'FOOD', 'BEVERAGE', 'TOBACCO'] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** Display order of sizes everywhere in the catalog. UNIT is the single size of a dish or a soda. */
export const SIZE_CODES = ['FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330', 'UNIT'] as const satisfies readonly SizeCode[];

/** Bottles per case pre-filled for a new size (Indian distribution cases); editable per SKU. */
export const DEFAULT_CASE_SIZE: Readonly<Record<SizeCode, number>> = { FULL: 12, HALF: 32, QUARTER: 64, BEER_650: 12, BEER_330: 24, UNIT: 1 };

/** SKU code suffix (`HWHS-F`) and display-name label (`House Whisky — Full`) per size. */
const SIZE_SUFFIX: Readonly<Record<SizeCode, string>> = { FULL: 'F', HALF: 'H', QUARTER: 'Q', BEER_650: '650', BEER_330: '330', UNIT: 'U' };
const SIZE_LABEL: Readonly<Record<SizeCode, string>> = { FULL: 'Full', HALF: 'Half', QUARTER: 'Quarter', BEER_650: '650', BEER_330: '330', UNIT: 'Unit' };

export const MAX_CASE_SIZE = 1000;
const MAX_NAME = 80;
const CODE_PREFIX = /^[A-Z0-9]{2,10}$/;
const BARCODE = /^\S{1,40}$/;

export interface CatalogSku extends SkuLookup {
  productId: string;
}

export interface CatalogProduct {
  id: string;
  name: string;
  category: ProductCategory;
  department: DepartmentCode;
  isActive: boolean;
  skus: CatalogSku[];
}

export interface NewSkuInput {
  sizeCode: SizeCode;
  salePricePaise: Paise;
  purchasePricePaise?: Paise | null | undefined;
  caseSize: number;
  barcode?: string | null | undefined;
}

export interface NewProductInput {
  name: string;
  category: ProductCategory;
  /** Default LIQUOR. Every size of the product shares it. */
  department?: DepartmentCode | undefined;
  /** Upper-case letters/digits; SKU codes are `PREFIX-F`, `PREFIX-H`, `PREFIX-Q`, `PREFIX-650`, `PREFIX-330`. */
  codePrefix: string;
  skus: readonly NewSkuInput[];
}

export interface ProductPatch {
  name?: string | undefined;
  category?: ProductCategory | undefined;
  /** Applies to new sales only: billed lines keep their snapshot. */
  department?: DepartmentCode | undefined;
  isActive?: boolean | undefined;
}

/** `null` clears the purchase price or barcode; `undefined` leaves a field unchanged. */
export interface SkuPatch {
  salePricePaise?: Paise | undefined;
  purchasePricePaise?: Paise | null | undefined;
  caseSize?: number | undefined;
  barcode?: string | null | undefined;
  isActive?: boolean | undefined;
}

export interface CatalogFilter {
  /** Product name contains, SKU code prefix, or exact barcode. */
  q?: string | undefined;
  includeInactive?: boolean | undefined;
}

/** Phase 20: one item = one SKU in one category; its brand (product) is found or created by name. */
export interface CatalogItem extends SkuLookup {
  productId: string;
  /** The brand name (shown under the category header; the display name adds the size). */
  brandName: string;
  /** The brand's liquor type (Whisky, Rum…). */
  productCategory: ProductCategory;
  /** The brand is active (an item of an inactive brand can't be sold). */
  brandActive: boolean;
}

export interface NewItemInput {
  categoryId: string;
  /** The brand name, e.g. "1848"; an existing brand (any case) gets this item as another size. */
  name: string;
  /** Default: the category's default size. */
  sizeCode?: SizeCode | undefined;
  salePricePaise: Paise;
  purchasePricePaise?: Paise | null | undefined;
  /** Default: by size (Kitchen 1). */
  caseSize?: number | undefined;
  barcode?: string | null | undefined;
  /** Default: the brand's existing prefix, else suggested from the name. */
  codePrefix?: string | undefined;
  /** D5: optional opening stock, posted once as an OPENING movement (tracked departments only). */
  openingQty?: number | undefined;
  /** New brands only. Default: the category's default department. */
  department?: DepartmentCode | undefined;
  /** New brands only. Default: from the category (WINE, BEER, FOOD…), else OTHER. */
  productCategory?: ProductCategory | undefined;
}

export interface ItemPatch extends SkuPatch {
  /** Moves this item to the brand of that name (found or created); a case-only change renames the brand. */
  name?: string | undefined;
  categoryId?: string | undefined;
}

export const MAX_OPENING_QTY = 100_000;

/** Suggested SKU code prefix: the first two letters of the first two words, or the first four of one ("Royal Stag" → ROST). */
export function suggestPrefix(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const prefix = words.length === 1 ? words[0]!.slice(0, 4) : words.slice(0, 2).map((w) => w.slice(0, 2)).join('');
  return prefix.slice(0, 10);
}

export function skuCodeFor(prefix: string, size: SizeCode): string {
  return `${prefix}-${SIZE_SUFFIX[size]}`;
}

/** `House Whisky — Full`; a single-size (UNIT) item is just its name. */
export function displayNameFor(productName: string, size: SizeCode): string {
  return size === 'UNIT' ? productName : `${productName} — ${SIZE_LABEL[size]}`;
}

// ── Validation (RangeError → HTTP 400) ──

function checkName(name: string): string {
  const text = name.trim().replace(/\s+/g, ' ');
  if (text === '') throw new RangeError('name is required');
  if (text.length > MAX_NAME) throw new RangeError(`name must be at most ${MAX_NAME} characters`);
  return text;
}

function checkCategory(category: string): ProductCategory {
  if (!(PRODUCT_CATEGORIES as readonly string[]).includes(category)) {
    throw new RangeError(`category must be one of ${PRODUCT_CATEGORIES.join(', ')}`);
  }
  return category as ProductCategory;
}

function checkPrefix(prefix: string): string {
  const text = prefix.trim().toUpperCase();
  if (!CODE_PREFIX.test(text)) throw new RangeError('codePrefix must be 2–10 letters or digits, e.g. HWHS');
  return text;
}

function checkSize(size: string, name: string): SizeCode {
  if (!(SIZE_CODES as readonly string[]).includes(size)) throw new RangeError(`${name} must be one of ${SIZE_CODES.join(', ')}`);
  return size as SizeCode;
}

export function checkCaseSize(value: number, name = 'caseSize'): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CASE_SIZE) {
    throw new RangeError(`${name} must be a whole number of bottles from 1 to ${MAX_CASE_SIZE}`);
  }
  return value;
}

function checkBarcode(value: string | null | undefined, name: string): string | null {
  const text = value?.trim() ?? '';
  if (text === '') return null;
  if (!BARCODE.test(text)) throw new RangeError(`${name} must be 1–40 characters with no spaces`);
  return text;
}

function checkPurchasePrice(value: Paise | null | undefined, name: string): Paise | null {
  if (value === undefined || value === null) return null;
  assertPaise(value, name, { allowZero: true });
  return value;
}

function checkNewSku(sku: NewSkuInput, name: string): NewSkuInput & { barcode: string | null; purchasePricePaise: Paise | null } {
  const sizeCode = checkSize(sku.sizeCode, `${name}.sizeCode`);
  assertPaise(sku.salePricePaise, `${name}.salePricePaise`);
  return {
    sizeCode,
    salePricePaise: sku.salePricePaise,
    purchasePricePaise: checkPurchasePrice(sku.purchasePricePaise, `${name}.purchasePricePaise`),
    caseSize: checkCaseSize(sku.caseSize, `${name}.caseSize`),
    barcode: checkBarcode(sku.barcode, `${name}.barcode`),
  };
}

// ── Reads ──

interface CatalogRow extends SkuLookupRow {
  product_id: string;
  product_name: string;
  category: ProductCategory;
  product_department: DepartmentCode;
  product_active: boolean;
}

const CATALOG_SELECT = `
  SELECT p.id AS product_id, p.name AS product_name, p.category, p.department AS product_department, p.is_active AS product_active,
         k.id, k.sku_code, k.barcode, k.display_name, k.size_code, k.price_paise, k.purchase_price_paise,
         k.case_size, k.is_active, coalesce(s.on_hand_qty, 0) AS on_hand_qty, p.department, d.name AS department_name, d.tracks_stock,
         k.item_category_id, ic.name AS item_category_name
    FROM products p
    JOIN departments d ON d.code = p.department
    LEFT JOIN skus k ON k.product_id = p.id
    LEFT JOIN item_categories ic ON ic.id = k.item_category_id
    LEFT JOIN sku_stock s ON s.sku_id = k.id`;
const CATALOG_ORDER = `
  ORDER BY lower(p.name), p.id,
           array_position(ARRAY['FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330', 'UNIT'], k.size_code)`;

/** Groups product × SKU rows (in order) into products; a product without SKUs gets an empty list. */
function groupCatalog(rows: readonly CatalogRow[]): CatalogProduct[] {
  const products: CatalogProduct[] = [];
  for (const row of rows) {
    let product = products.at(-1);
    if (product?.id !== row.product_id) {
      product = {
        id: row.product_id,
        name: row.product_name,
        category: row.category,
        department: row.product_department,
        isActive: row.product_active,
        skus: [],
      };
      products.push(product);
    }
    if (row.id !== null) product.skus.push({ ...mapSkuLookup(row), productId: row.product_id });
  }
  return products;
}

async function loadProduct(db: SqlClient, productId: string): Promise<CatalogProduct> {
  const { rows } = await db.query<CatalogRow>(`${CATALOG_SELECT} WHERE p.id = $1 ${CATALOG_ORDER}`, [productId]);
  const product = groupCatalog(rows)[0];
  if (!product) throw new NotFoundError('product', productId);
  return product;
}

/** Escapes LIKE metacharacters so user input matches literally. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class CatalogService {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Products by name with their sizes (FULL → 330). Without `includeInactive`, inactive products and
   * sizes are left out. A query matches the product name, any of its SKU codes (prefix) or barcodes
   * (exact) and returns the whole product.
   */
  async listCatalog(filter: CatalogFilter = {}): Promise<CatalogProduct[]> {
    const text = filter.q?.trim() ?? '';
    const all = filter.includeInactive === true;
    const { rows } = await this.db.query<CatalogRow>(
      `${CATALOG_SELECT}
        WHERE ($1 OR (p.is_active AND (k.id IS NULL OR k.is_active)))
          AND ($2 = '' OR p.id IN (
                SELECT p2.id FROM products p2 LEFT JOIN skus k2 ON k2.product_id = p2.id
                 WHERE p2.name ILIKE '%' || $3 || '%' OR k2.sku_code ILIKE $3 || '%' OR k2.barcode = $2))
        ${CATALOG_ORDER}`,
      [all, text, likeLiteral(text)],
    );
    return groupCatalog(rows);
  }

  async getProduct(productId: string): Promise<CatalogProduct> {
    return loadProduct(this.db, productId);
  }

  /**
   * Creates an item with 1–6 sizes in one transaction. Tracked SKUs start at zero stock (stock comes
   * from a GRN); Kitchen items are never stock-tracked.
   */
  async createProduct(input: NewProductInput): Promise<CatalogProduct> {
    const name = checkName(input.name);
    const category = checkCategory(input.category);
    const department = checkDepartmentCode(input.department ?? 'LIQUOR');
    const prefix = checkPrefix(input.codePrefix);
    if (input.skus.length === 0) throw new RangeError('add at least one size');
    const skus = input.skus.map((s, i) => checkNewSku(s, `skus[${i}]`));
    if (new Set(skus.map((s) => s.sizeCode)).size !== skus.length) throw new RangeError('each size can appear only once');

    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await requireActiveDepartment(tx, department);
        const { id } = await one<{ id: string }>(tx, `INSERT INTO products (name, category, department) VALUES ($1, $2, $3) RETURNING id`,
          [name, category, department],
        );
        for (const sku of skus) await insertSku(tx, id, name, prefix, sku);
        return loadProduct(tx, id);
      }),
    );
  }

  /**
   * Renames (re-deriving every size's display name), recategorises or (de)activates a liquor.
   * Deactivating also deactivates its sizes; reactivating leaves the sizes as they are.
   */
  async updateProduct(productId: string, patch: ProductPatch): Promise<CatalogProduct> {
    const name = patch.name === undefined ? undefined : checkName(patch.name);
    const category = patch.category === undefined ? undefined : checkCategory(patch.category);
    const department = patch.department === undefined ? undefined : checkDepartmentCode(patch.department);

    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const current = await maybeOne<{ name: string }>(tx, `SELECT name FROM products WHERE id = $1 FOR UPDATE`, [productId]);
        if (!current) throw new NotFoundError('product', productId);
        if (department !== undefined) await requireActiveDepartment(tx, department);
        await tx.query(
          `UPDATE products SET name = coalesce($2, name), category = coalesce($3, category), is_active = coalesce($4, is_active),
                  department = coalesce($5, department)
            WHERE id = $1`,
          [productId, name ?? null, category ?? null, patch.isActive ?? null, department ?? null],
        );
        if (name !== undefined && name !== current.name) {
          const { rows } = await tx.query<{ id: string; size_code: SizeCode }>(`SELECT id, size_code FROM skus WHERE product_id = $1`, [productId]);
          for (const sku of rows) {
            await tx.query(`UPDATE skus SET display_name = $2 WHERE id = $1`, [sku.id, displayNameFor(name, sku.size_code)]);
          }
        }
        if (patch.isActive === false) {
          await tx.query(`UPDATE skus SET is_active = false WHERE product_id = $1 AND is_active`, [productId]);
        }
        return loadProduct(tx, productId);
      }),
    );
  }

  /**
   * Adds a size the liquor doesn't have yet. The code prefix defaults to that of an existing size
   * (`HWHS` from `HWHS-F`).
   */
  async addSku(productId: string, input: NewSkuInput & { codePrefix?: string | undefined }): Promise<CatalogProduct> {
    const sku = checkNewSku(input, 'sku');
    const given = input.codePrefix === undefined ? undefined : checkPrefix(input.codePrefix);

    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const product = await maybeOne<{ name: string; is_active: boolean }>(
          tx,
          `SELECT name, is_active FROM products WHERE id = $1 FOR UPDATE`,
          [productId],
        );
        if (!product) throw new NotFoundError('product', productId);
        if (!product.is_active) throw new InactiveError('product', productId, product.name);
        let prefix = given;
        if (prefix === undefined) {
          const sibling = await maybeOne<{ sku_code: string }>(tx, `SELECT sku_code FROM skus WHERE product_id = $1 ORDER BY created_at LIMIT 1`, [productId]);
          const dash = sibling?.sku_code.lastIndexOf('-') ?? -1;
          if (!sibling || dash < 1) throw new RangeError('codePrefix is required: no existing size to take it from');
          prefix = sibling.sku_code.slice(0, dash);
        }
        await insertSku(tx, productId, product.name, prefix, sku);
        return loadProduct(tx, productId);
      }),
    );
  }

  /**
   * Edits a size's prices, case size, barcode or active flag. Size and SKU code are fixed once
   * created (bills and GRNs reference them). A size can't be reactivated under an inactive liquor.
   * Returns the whole liquor.
   */
  async updateSku(skuId: string, patch: SkuPatch): Promise<CatalogProduct> {
    const barcode = checkSkuPatch(patch);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const current = await lockSku(tx, skuId);
        if (patch.isActive === true && !current.product_active) {
          throw new InactiveError('product', current.product_id, current.product_name);
        }
        await applySkuFields(tx, skuId, patch, barcode);
        return loadProduct(tx, current.product_id);
      }),
    );
  }

  // ── Phase 20: flat items (one SKU in one category; the brand is an internal link) ──

  /**
   * Every item in report order: category `sort_order`, then brand name, then size. Without
   * `includeInactive`, inactive items (and items of an inactive brand) are left out. A query matches
   * the brand or display name (contains), the SKU code (prefix) or the barcode (exact), across all
   * categories.
   */
  async listItems(filter: CatalogFilter = {}): Promise<CatalogItem[]> {
    const text = filter.q?.trim() ?? '';
    const { rows } = await this.db.query<ItemRow>(
      `${ITEM_SELECT}
        WHERE ($1 OR (k.is_active AND p.is_active))
          AND ($2 = '' OR k.barcode = $2 OR k.sku_code ILIKE $3 || '%' OR p.name ILIKE '%' || $3 || '%' OR k.display_name ILIKE '%' || $3 || '%')
        ORDER BY ic.sort_order, lower(ic.name), lower(p.name),
                 array_position(ARRAY['FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330', 'UNIT'], k.size_code)`,
      [filter.includeInactive === true, text, likeLiteral(text)],
    );
    return rows.map(mapItem);
  }

  async getItem(skuId: string): Promise<CatalogItem> {
    return loadItem(this.db, skuId);
  }

  /**
   * Creates one item inside a category (D1). The brand is found by name (any case) or created with
   * the category's default department and type; an existing brand that already has this size is
   * PS012. `openingQty` posts one OPENING movement (D5), refused for an untracked (Kitchen) item.
   */
  async createItem(input: NewItemInput, staffId: string): Promise<CatalogItem> {
    const name = checkName(input.name);
    const given = input.codePrefix === undefined || input.codePrefix.trim() === '' ? undefined : checkPrefix(input.codePrefix);
    if (input.sizeCode !== undefined) checkSize(input.sizeCode, 'sizeCode');
    assertPaise(input.salePricePaise, 'salePricePaise');
    const purchase = checkPurchasePrice(input.purchasePricePaise, 'purchasePricePaise');
    if (input.caseSize !== undefined) checkCaseSize(input.caseSize);
    const barcode = checkBarcode(input.barcode, 'barcode');
    const opening = input.openingQty ?? 0;
    if (!Number.isSafeInteger(opening) || opening < 0 || opening > MAX_OPENING_QTY) {
      throw new RangeError(`openingQty must be a whole number of bottles from 0 to ${MAX_OPENING_QTY}`);
    }
    const department = input.department === undefined ? undefined : checkDepartmentCode(input.department);
    const type = input.productCategory === undefined ? undefined : checkCategory(input.productCategory);

    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const category = await getItemCategory(tx, input.categoryId);
        if (!category.isActive) throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `item category ${category.name} is disabled`);
        const sizeCode = input.sizeCode ?? category.defaultSizeCode;
        if (sizeCode === null) throw new RangeError(`choose a size: ${category.name} has no default size`);

        type BrandRow = { id: string; name: string; is_active: boolean; department: DepartmentCode };
        let brand = await maybeOne<BrandRow>(
          tx,
          `SELECT id, name, is_active, department FROM products WHERE lower(name) = lower($1) FOR UPDATE`,
          [name],
        );
        if (!brand) {
          const dept = await requireActiveDepartment(tx, department ?? category.defaultDepartment);
          brand = await one<BrandRow>(
            tx,
            `INSERT INTO products (name, category, department) VALUES ($1, $2, $3) RETURNING id, name, is_active, department`,
            [name, type ?? typeForCategory(category.systemKey, dept), dept],
          );
        } else if (!brand.is_active) {
          // The flat catalog has no brand screen: adding an item brings its brand back.
          await tx.query(`UPDATE products SET is_active = true WHERE id = $1`, [brand.id]);
        }

        let prefix = given;
        if (prefix === undefined) {
          const sibling = await maybeOne<{ sku_code: string }>(tx, `SELECT sku_code FROM skus WHERE product_id = $1 ORDER BY created_at LIMIT 1`, [brand.id]);
          const dash = sibling?.sku_code.lastIndexOf('-') ?? -1;
          prefix = sibling && dash > 0 ? sibling.sku_code.slice(0, dash) : checkPrefix(suggestPrefix(name).padEnd(2, 'X'));
        }
        const tracks = (await one<{ tracks_stock: boolean }>(tx, `SELECT tracks_stock FROM departments WHERE code = $1`, [brand.department])).tracks_stock;
        if (opening > 0 && !tracks) throw new RangeError(`${name} is a Kitchen item: it has no stock to open`);

        const skuId = await insertSku(
          tx,
          brand.id,
          brand.name,
          prefix,
          {
            sizeCode,
            salePricePaise: input.salePricePaise,
            purchasePricePaise: purchase,
            caseSize: input.caseSize ?? (tracks ? DEFAULT_CASE_SIZE[sizeCode] : 1),
            barcode,
          },
          category.id,
        );
        if (opening > 0) {
          await tx.query(
            `INSERT INTO stock_movements (sku_id, business_day_id, movement_type, qty_delta, created_by_staff_id)
             VALUES ($1, (SELECT id FROM business_days WHERE status = 'OPEN'), 'OPENING', $2, $3)`,
            [skuId, opening, staffId],
          );
        }
        return loadItem(tx, skuId);
      }),
    );
  }

  /**
   * Edits one item. A new name moves this item alone to the brand of that name (found or created,
   * keeping the old brand's department and type); a case-only change renames the brand itself. The
   * size and SKU code never change. Reactivating an item reactivates its brand.
   */
  async updateItem(skuId: string, patch: ItemPatch): Promise<CatalogItem> {
    const barcode = checkSkuPatch(patch);
    const name = patch.name === undefined ? undefined : checkName(patch.name);

    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const current = await lockSku(tx, skuId);

        if (name !== undefined && name !== current.product_name) {
          if (name.toLowerCase() === current.product_name.toLowerCase()) {
            await renameBrand(tx, current.product_id, name);
          } else {
            await moveToBrand(tx, skuId, current, name);
          }
        }
        if (patch.categoryId !== undefined) {
          const category = await getItemCategory(tx, patch.categoryId);
          if (!category.isActive) throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `item category ${category.name} is disabled`);
          await tx.query(`UPDATE skus SET item_category_id = $2 WHERE id = $1`, [skuId, category.id]);
        }
        if (patch.isActive === true) {
          await tx.query(`UPDATE products SET is_active = true WHERE id = (SELECT product_id FROM skus WHERE id = $1) AND NOT is_active`, [skuId]);
        }
        await applySkuFields(tx, skuId, patch, barcode);
        return loadItem(tx, skuId);
      }),
    );
  }
}

// ── Item helpers ──

interface ItemRow extends SkuLookupRow {
  product_id: string;
  brand_name: string;
  product_category: ProductCategory;
  brand_active: boolean;
}

const ITEM_SELECT = `
  SELECT ${SKU_COLUMNS}, k.product_id, p.name AS brand_name, p.category AS product_category, p.is_active AS brand_active
    FROM ${SKU_FROM}`;

function mapItem(r: ItemRow): CatalogItem {
  return { ...mapSkuLookup(r), productId: r.product_id, brandName: r.brand_name, productCategory: r.product_category, brandActive: r.brand_active };
}

async function loadItem(db: SqlClient, skuId: string): Promise<CatalogItem> {
  const row = await maybeOne<ItemRow>(db, `${ITEM_SELECT} WHERE k.id = $1`, [skuId]);
  if (!row) throw new NotFoundError('sku', skuId);
  return mapItem(row);
}

/** A new brand's type, from its category and center: WINE / BEER as named, Kitchen → FOOD, Cigarettes → TOBACCO, drinks → BEVERAGE. */
function typeForCategory(systemKey: string | null, department: DepartmentCode): ProductCategory {
  if (systemKey === 'WINE') return 'WINE';
  if (systemKey === 'BEER') return 'BEER';
  if (department === 'KITCHEN') return 'FOOD';
  if (department === 'CIGARETTES') return 'TOBACCO';
  if (department === 'ANCILLARY' || department === 'COOL_DRINKS' || department === 'WATER') return 'BEVERAGE';
  return 'OTHER';
}

interface LockedSku {
  product_id: string;
  product_name: string;
  product_active: boolean;
  size_code: SizeCode;
  on_hand_qty: number;
}

async function lockSku(tx: SqlClient, skuId: string): Promise<LockedSku> {
  const current = await maybeOne<LockedSku>(
    tx,
    `SELECT k.product_id, p.name AS product_name, p.is_active AS product_active, k.size_code, coalesce(s.on_hand_qty, 0) AS on_hand_qty
       FROM skus k JOIN products p ON p.id = k.product_id LEFT JOIN sku_stock s ON s.sku_id = k.id
      WHERE k.id = $1
        FOR UPDATE OF k`,
    [skuId],
  );
  if (!current) throw new NotFoundError('sku', skuId);
  return current;
}

/** Validates a SKU patch before any write; returns the cleaned barcode (undefined = unchanged). */
function checkSkuPatch(patch: SkuPatch): string | null | undefined {
  if (patch.salePricePaise !== undefined) assertPaise(patch.salePricePaise, 'salePricePaise');
  if (patch.purchasePricePaise !== undefined && patch.purchasePricePaise !== null) {
    assertPaise(patch.purchasePricePaise, 'purchasePricePaise', { allowZero: true });
  }
  if (patch.caseSize !== undefined) checkCaseSize(patch.caseSize);
  return patch.barcode === undefined ? undefined : checkBarcode(patch.barcode, 'barcode');
}

async function applySkuFields(tx: SqlClient, skuId: string, patch: SkuPatch, barcode: string | null | undefined): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [skuId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.salePricePaise !== undefined) set('price_paise', paiseParam(patch.salePricePaise));
  if (patch.purchasePricePaise !== undefined) {
    set('purchase_price_paise', patch.purchasePricePaise === null ? null : paiseParam(patch.purchasePricePaise));
  }
  if (patch.caseSize !== undefined) set('case_size', patch.caseSize);
  if (barcode !== undefined) set('barcode', barcode);
  if (patch.isActive !== undefined) set('is_active', patch.isActive);
  if (sets.length > 0) await tx.query(`UPDATE skus SET ${sets.join(', ')} WHERE id = $1`, params);
}

/** Renames a brand (e.g. a case fix) and re-derives every size's display name. */
async function renameBrand(tx: SqlClient, productId: string, name: string): Promise<void> {
  await tx.query(`UPDATE products SET name = $2 WHERE id = $1`, [productId, name]);
  const { rows } = await tx.query<{ id: string; size_code: SizeCode }>(`SELECT id, size_code FROM skus WHERE product_id = $1`, [productId]);
  for (const sku of rows) await tx.query(`UPDATE skus SET display_name = $2 WHERE id = $1`, [sku.id, displayNameFor(name, sku.size_code)]);
}

/**
 * Re-links one item to another brand (found by name, else created with the old brand's type and
 * department). PS012 if that brand already has this size; PS002 if the item has stock and the target
 * brand is untracked (Kitchen).
 */
async function moveToBrand(tx: SqlClient, skuId: string, current: LockedSku, name: string): Promise<void> {
  type TargetRow = { id: string; name: string; tracks_stock: boolean };
  let target = await maybeOne<TargetRow>(
    tx,
    `SELECT p.id, p.name, d.tracks_stock FROM products p JOIN departments d ON d.code = p.department WHERE lower(p.name) = lower($1) FOR UPDATE OF p`,
    [name],
  );
  if (!target) {
    target = await one<TargetRow>(
      tx,
      `INSERT INTO products (name, category, department)
       SELECT $1, category, department FROM products WHERE id = $2
       RETURNING id, name, (SELECT tracks_stock FROM departments WHERE code = products.department) AS tracks_stock`,
      [name, current.product_id],
    );
  } else {
    await tx.query(`UPDATE products SET is_active = true WHERE id = $1 AND NOT is_active`, [target.id]);
  }
  if (!target.tracks_stock && current.on_hand_qty !== 0) {
    throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `${target.name} is a Kitchen brand; this item still has ${current.on_hand_qty} on hand`);
  }
  await tx.query(`UPDATE skus SET product_id = $2, display_name = $3 WHERE id = $1`, [skuId, target.id, displayNameFor(target.name, current.size_code)]);
}

async function insertSku(
  tx: SqlClient,
  productId: string,
  productName: string,
  prefix: string,
  sku: ReturnType<typeof checkNewSku>,
  itemCategoryId: string | null = null,
): Promise<string> {
  const { id } = await one<{ id: string }>(
    tx,
    `INSERT INTO skus (product_id, sku_code, barcode, size_code, display_name, price_paise, purchase_price_paise, case_size, item_category_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      productId,
      skuCodeFor(prefix, sku.sizeCode),
      sku.barcode,
      sku.sizeCode,
      displayNameFor(productName, sku.sizeCode),
      paiseParam(sku.salePricePaise),
      sku.purchasePricePaise === null ? null : paiseParam(sku.purchasePricePaise),
      sku.caseSize,
      itemCategoryId,
    ],
  );
  return id;
}
