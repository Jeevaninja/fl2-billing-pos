/**
 * Master catalog: liquors (products) and their sealed sizes (SKUs) with sale price, default
 * purchase price and case size. Products and SKUs are mutable master rows (UPDATE captured by the
 * outbox) but never deleted: a liquor is retired by deactivating it. Bill lines snapshot the price,
 * so a price edit never changes a bill already rung up. Duplicates surface as PS012.
 */
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { InactiveError, NotFoundError, withPosErrors } from '../db/errors.js';
import { assertPaise, type Paise, paiseParam } from '../domain/money.js';
import type { SizeCode } from '../domain/types.js';
import { mapSkuLookup, type SkuLookup, type SkuLookupRow } from './counter-queries.js';
import { maybeOne, one } from './rows.js';

export const PRODUCT_CATEGORIES = ['WHISKY', 'RUM', 'VODKA', 'BRANDY', 'GIN', 'WINE', 'BEER', 'OTHER'] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** Display order of sizes everywhere in the catalog. */
export const SIZE_CODES = ['FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330'] as const satisfies readonly SizeCode[];

/** Bottles per case pre-filled for a new size (Indian distribution cases); editable per SKU. */
export const DEFAULT_CASE_SIZE: Readonly<Record<SizeCode, number>> = { FULL: 12, HALF: 32, QUARTER: 64, BEER_650: 12, BEER_330: 24 };

/** SKU code suffix (`HWHS-F`) and display-name label (`House Whisky — Full`) per size. */
const SIZE_SUFFIX: Readonly<Record<SizeCode, string>> = { FULL: 'F', HALF: 'H', QUARTER: 'Q', BEER_650: '650', BEER_330: '330' };
const SIZE_LABEL: Readonly<Record<SizeCode, string>> = { FULL: 'Full', HALF: 'Half', QUARTER: 'Quarter', BEER_650: '650', BEER_330: '330' };

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
  /** Upper-case letters/digits; SKU codes are `PREFIX-F`, `PREFIX-H`, `PREFIX-Q`, `PREFIX-650`, `PREFIX-330`. */
  codePrefix: string;
  skus: readonly NewSkuInput[];
}

export interface ProductPatch {
  name?: string | undefined;
  category?: ProductCategory | undefined;
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

export function skuCodeFor(prefix: string, size: SizeCode): string {
  return `${prefix}-${SIZE_SUFFIX[size]}`;
}

export function displayNameFor(productName: string, size: SizeCode): string {
  return `${productName} — ${SIZE_LABEL[size]}`;
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
  product_active: boolean;
}

const CATALOG_SELECT = `
  SELECT p.id AS product_id, p.name AS product_name, p.category, p.is_active AS product_active,
         k.id, k.sku_code, k.barcode, k.display_name, k.size_code, k.price_paise, k.purchase_price_paise,
         k.case_size, k.is_active, coalesce(s.on_hand_qty, 0) AS on_hand_qty
    FROM products p
    LEFT JOIN skus k ON k.product_id = p.id
    LEFT JOIN sku_stock s ON s.sku_id = k.id`;
const CATALOG_ORDER = `
  ORDER BY lower(p.name), p.id,
           array_position(ARRAY['FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330'], k.size_code)`;

/** Groups product × SKU rows (in order) into products; a product without SKUs gets an empty list. */
function groupCatalog(rows: readonly CatalogRow[]): CatalogProduct[] {
  const products: CatalogProduct[] = [];
  for (const row of rows) {
    let product = products.at(-1);
    if (product?.id !== row.product_id) {
      product = { id: row.product_id, name: row.product_name, category: row.category, isActive: row.product_active, skus: [] };
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

  /** Creates a liquor with 1–5 sizes in one transaction. SKUs start at zero stock (stock comes from a GRN). */
  async createProduct(input: NewProductInput): Promise<CatalogProduct> {
    const name = checkName(input.name);
    const category = checkCategory(input.category);
    const prefix = checkPrefix(input.codePrefix);
    if (input.skus.length === 0) throw new RangeError('add at least one size');
    const skus = input.skus.map((s, i) => checkNewSku(s, `skus[${i}]`));
    if (new Set(skus.map((s) => s.sizeCode)).size !== skus.length) throw new RangeError('each size can appear only once');

    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const { id } = await one<{ id: string }>(tx, `INSERT INTO products (name, category) VALUES ($1, $2) RETURNING id`, [name, category]);
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

    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const current = await maybeOne<{ name: string }>(tx, `SELECT name FROM products WHERE id = $1 FOR UPDATE`, [productId]);
        if (!current) throw new NotFoundError('product', productId);
        await tx.query(
          `UPDATE products SET name = coalesce($2, name), category = coalesce($3, category), is_active = coalesce($4, is_active)
            WHERE id = $1`,
          [productId, name ?? null, category ?? null, patch.isActive ?? null],
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
    if (patch.salePricePaise !== undefined) assertPaise(patch.salePricePaise, 'salePricePaise');
    if (patch.purchasePricePaise !== undefined && patch.purchasePricePaise !== null) {
      assertPaise(patch.purchasePricePaise, 'purchasePricePaise', { allowZero: true });
    }
    if (patch.caseSize !== undefined) checkCaseSize(patch.caseSize);
    const barcode = patch.barcode === undefined ? undefined : checkBarcode(patch.barcode, 'barcode');

    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const current = await maybeOne<{ product_id: string; product_name: string; product_active: boolean }>(
          tx,
          `SELECT k.product_id, p.name AS product_name, p.is_active AS product_active
             FROM skus k JOIN products p ON p.id = k.product_id
            WHERE k.id = $1
              FOR UPDATE OF k`,
          [skuId],
        );
        if (!current) throw new NotFoundError('sku', skuId);
        if (patch.isActive === true && !current.product_active) {
          throw new InactiveError('product', current.product_id, current.product_name);
        }
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
        return loadProduct(tx, current.product_id);
      }),
    );
  }
}

async function insertSku(
  tx: SqlClient,
  productId: string,
  productName: string,
  prefix: string,
  sku: ReturnType<typeof checkNewSku>,
): Promise<void> {
  await tx.query(
    `INSERT INTO skus (product_id, sku_code, barcode, size_code, display_name, price_paise, purchase_price_paise, case_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      productId,
      skuCodeFor(prefix, sku.sizeCode),
      sku.barcode,
      sku.sizeCode,
      displayNameFor(productName, sku.sizeCode),
      paiseParam(sku.salePricePaise),
      sku.purchasePricePaise === null ? null : paiseParam(sku.purchasePricePaise),
      sku.caseSize,
    ],
  );
}
