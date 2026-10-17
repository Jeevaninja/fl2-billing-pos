# Phase 10 — Master Catalog & Case-Based Inwarding — Schema + Component Plan

Status: **IMPLEMENTED (2026-10-17)**. Approved with the recommended choices (§7):
- **A:** the five existing size codes, shown with ml labels.
- **B:** `cases` and a `case_size` snapshot on each GRN line, checked by the DB.
- **C:** default case sizes Full 12 / Half 32 / Quarter 64, and beer 650ml 12 / 330ml 24.
- **D:** an optional default purchase price that a GRN never overwrites.

Changes from the plan as written:
- **SQL:** the `stock_receipt_lines_case_shape` CHECK now tests `case_size IS NOT NULL` explicitly. Without it, a NULL `case_size` made the second branch NULL, and the CHECK passed.
- **Catalog behaviour:**
  - Reactivating a liquor leaves its sizes as they are.
  - A size can't be added to, or reactivated under, an inactive liquor (`InactiveError`).
  - The new-liquor form suggests a code prefix from the name.
- **GRN:** `PurchaseService` share-locks the SKUs it receives, and the old `{ quantity }` line shape is still accepted as loose only.
- **Dashboard:** it became a 4 × 2 grid, with Billing spanning two rows.
- **Client:** `ApiError` carries the server's `constraint`.

Goal: a dashboard **Inventory Catalog** tile lets the operator create and edit liquors, their sizes and prices, and each size's case size. The GRN screen then takes **Cases + Loose bottles** in place of a single Qty, works out the whole-bottle total for the stock ledger, and pre-fills the unit cost from the catalog.

---

## 0. What already exists

- **`products`** (name, category, is_active) → **`skus`**: one row per sealed size, with `sku_code`, `barcode`, `size_code`, `display_name`, `price_paise` and `is_active`. `(product_id, size_code)` is unique.
- Both are **master tables**. UPDATE is allowed: it touches `updated_at` and writes to the outbox. DELETE and TRUNCATE are forbidden, so a liquor is retired by **deactivating** it.
- **Selling price already exists** as `skus.price_paise`. `bill_items` snapshot the price, code, name and size when a line is inserted. A price edit therefore never changes a line that is already on a bill; the next scan simply uses the new price. Neither the counter nor the Captain app sends a price.
- `size_code` ∈ `FULL | HALF | QUARTER | BEER_650 | BEER_330`. It is a label only; no volume is stored.
- A new SKU gets its `sku_stock` row (at 0) from a trigger, so a liquor added in the catalog starts at zero stock. Stock arrives only through a GRN.

## 1. Migration `0009_catalog_case_size.sql`

```sql
-- Catalog defaults for inwarding. Whole integers / paise only.
ALTER TABLE skus
  ADD COLUMN case_size integer CONSTRAINT skus_case_size_range CHECK (case_size BETWEEN 1 AND 1000),
  ADD COLUMN purchase_price_paise bigint
    CONSTRAINT skus_purchase_price_non_negative CHECK (purchase_price_paise IS NULL OR purchase_price_paise >= 0);

-- Decision C: backfill existing SKUs by size, then require it.
UPDATE skus SET case_size = CASE size_code
  WHEN 'FULL' THEN 12 WHEN 'HALF' THEN 32 WHEN 'QUARTER' THEN 64
  WHEN 'BEER_650' THEN 12 WHEN 'BEER_330' THEN 24 END;
ALTER TABLE skus ALTER COLUMN case_size SET NOT NULL;

-- Decision B: record how each GRN line was counted, verified against the catalog at insert.
ALTER TABLE stock_receipt_lines
  ADD COLUMN cases     integer NOT NULL DEFAULT 0 CONSTRAINT stock_receipt_lines_cases_non_negative CHECK (cases >= 0),
  ADD COLUMN case_size integer,                    -- snapshot of skus.case_size; NULL on pre-Phase-10 lines
  ADD CONSTRAINT stock_receipt_lines_case_shape CHECK (
    (case_size IS NULL AND cases = 0)
    OR (case_size IS NOT NULL AND case_size >= 1 AND cases::bigint * case_size <= qty)
  );
```

- `price_paise` stays as the column for the **default sale price**; it is not duplicated. The API and UI call it "Sale price".
- `purchase_price_paise` is **nullable** (Decision D). NULL means no default, and the GRN cost field is then left empty.
- **The GRN line trigger is extended.** If `case_size` is supplied it must equal the SKU's current `case_size`, otherwise it raises `PS002` ("case size for X is now N — re-check the line"). This is the same pattern as the existing "unit price must be the current SKU price" rule on `bill_items`. It stops a case-size edit, made between staging a line and posting it, from silently changing the bottle count.
- **Loose bottles are not stored.** They are always `qty − cases × case_size`, and `qty` (whole bottles) stays the only thing the stock ledger sees.
- **Errors.** Duplicate-key violations are mapped to a new code, **`PS012 duplicate catalog entry`**: `products_name_unique`, `skus_sku_code_unique`, `skus_barcode_unique` and `skus_product_size_unique`. The API returns it as **409** with a message that names the field.

## 2. Backend

**`CatalogService`** (`src/services/catalog.service.ts`) is new. Every write runs in one transaction.

| Method | Notes |
|---|---|
| `listCatalog({ q?, includeInactive? }) → CatalogProduct[]` | Products ordered by name. Each one carries its SKUs, ordered FULL → HALF → QUARTER → 650 → 330, with sale price, purchase price, case size, barcode, on-hand and active. `q` matches the product name, SKU code or exact barcode. |
| `createProduct({ name, category, codePrefix, skus: [...] })` | Creates the product and 1–5 sizes together. Each size has `{ sizeCode, salePricePaise, purchasePricePaise?, caseSize, barcode? }`. `sku_code` = `PREFIX-F/-H/-Q/-650/-330`, and `display_name` = `Name — Full/Half/Quarter/650/330`, which matches the seed data. |
| `updateProduct(id, { name?, category?, isActive? })` | A rename re-derives the `display_name` of every one of its SKUs. Deactivating a product also deactivates its SKUs. |
| `addSku(productId, { sizeCode, … })` | Adds a size the liquor didn't have before. |
| `updateSku(id, { salePricePaise?, purchasePricePaise?, caseSize?, barcode?, isActive? })` | `size_code` and `sku_code` can't be changed, because bills and GRNs reference them. |

Validation is up front: a name of 1–80 characters, a prefix of 2–10 characters (A–Z, 0–9), a sale price above 0, a purchase price of 0 or more, a case size of 1–1000, and a barcode that is digits or text with no spaces. All money is bigint paise.

**`searchSkus` / `lookupSku`** add `caseSize` and `purchasePricePaise` to `SkuLookup`, and the frontend type follows. Billing keeps working unchanged because it ignores the new fields.

**`PurchaseService.recordReceipt`** lines become `{ skuId, cases, looseBottles, caseSize, unitCostPaise }`:
- `quantity = cases × caseSize + looseBottles` is computed on the server and must come to at least 1.
- The existing 100,000-bottle cap still applies.
- `caseSize` is passed through to the line so the trigger can check it.
- The old `{ quantity }` shape is still accepted as "loose only" (`cases = 0`, `case_size` NULL), so existing tests and callers keep working.

**Routes** (`server/app.ts`)

| Route | Body / query |
|---|---|
| `GET /api/catalog?q=&includeInactive=` | the catalog list |
| `POST /api/catalog/products` | `{ name, category, codePrefix, skus: [{ sizeCode, salePrice, purchasePrice?, caseSize, barcode? }] }` → 201 |
| `PATCH /api/catalog/products/:id` | `{ name?, category?, isActive? }` |
| `POST /api/catalog/products/:id/skus` | one size → 201 |
| `PATCH /api/catalog/skus/:id` | `{ salePrice?, purchasePrice? (null clears), caseSize?, barcode? (null clears), isActive? }` |
| `POST /api/purchases` | lines now take `{ skuId, cases, looseBottles, caseSize, unitCost }` |

Prices travel as paise strings, as they do everywhere else. Catalog edits don't need an open business day.

## 3. Frontend — Inventory Catalog (`frontend/src/components/CatalogScreen.tsx`)

```
┌ FL2 │ INVENTORY CATALOG │ 3 liquors · 8 sizes │ [ search name / code / barcode ] [☐ show inactive] │ Esc Dashboard ┐
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ House Whisky        WHISKY                                                     [ Edit ] [ + Size ]              │
│   HWHS-F  Full 750ml     Sale 1,800.00   Buy 1,100.00   Case 12   48 on hand   ● active    [ Edit ]             │
│   HWHS-H  Half 375ml     Sale   950.00   Buy   560.00   Case 32   48 on hand   ● active    [ Edit ]             │
│   HWHS-Q  Quarter 180ml  Sale   500.00   Buy      —     Case 64   48 on hand   ● active    [ Edit ]             │
│ House Rum           RUM   …                                                                                     │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ [ + New liquor (Ins) ]                                                    ↑/↓ select · Enter edit · Esc back    │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **New liquor modal** (touch-sized): name, category chips, code prefix, plus one row per size: a checkbox for Full / Half / Quarter / 650 / 330, then sale ₹, buy ₹ (optional), case size and barcode (optional).
  - Ticking a size pre-fills its case size from the defaults in Decision C. The operator can change it.
  - A live preview shows the SKU codes, e.g. `HWHS-F, HWHS-H`.
- **Edit modals:** the product modal edits name, category and active; the SKU modal edits sale, buy, case size, barcode and active. Code and size are shown read-only.
  - Deactivating asks for confirmation: "Deactivate HWHS-Q? It can no longer be billed or received; stock stays on record".
- **Size labels:** the codes display as ml labels (Full 750ml, Half 375ml, Quarter 180ml, 650ml, 330ml), using one map in `lib/ui.ts`. This is Decision A. It is a label only, and no ml is tracked.
- **Conflicts:** a 409 (`PS012`) keeps the modal open and highlights the clashing field (name, code or barcode).
- **State:** `catalog/catalogReducer.ts` is pure and unit-tested. It covers list, filter and selection, the form fields and validation (rupees → paise via `parseRupeesToPaise`, whole-integer case size), building the payload, and submit / conflict / reset.
- **Wiring:**
  - `ACTIONS['catalog']` is labelled "Inventory Catalog", with the hint "Liquors, prices and case sizes" and a `Boxes` icon.
  - It goes into `MODULE_TILES` after `purchase`.
  - `App` gets `view: 'catalog'`.
  - The client gets `listCatalog`, `createProduct`, `updateProduct`, `addSku` and `updateSku`.

## 4. Frontend — GRN upgrade (`PurchaseScreen.tsx` + `purchaseReducer.ts`)

```
│ SKU  [ House Whisky — Quarter ]  QTR · case of 64 · 48 left     │
│ Cases [ 2 ]  Loose bottles [ 3 ]  = 131 bottles                  │
│ Unit cost ₹ [ 100.00 ]  (catalog default — editable)             │
│ [ Add line  (Enter) ]                                            │
```

- **Picking a SKU** reads `caseSize` and `purchasePricePaise` from the search result, which comes from the same request with no extra fetch. If a default cost exists, it pre-fills **Unit cost**, and the operator can overwrite it. With no default, the field stays empty and is still required, as in Phase 9.
- **Keyboard path:** SKU → Enter → Cases → Enter → Loose → Enter → Unit cost → Enter stages the line.
  - Both quantity fields take digits only, and an empty field counts as 0.
  - The live total reads "= 131 bottles" (2 × 64 + 3).
- **Validation (`lineError`):**
  - The total must be at least 1 bottle.
  - Loose bottles must be below the case size: "64 loose is a full case — add it to Cases".
  - The total must not exceed 100,000.
- **Staging:**
  - A line stores `{ sku, cases, looseBottles, caseSize, quantity, unitCostPaise }`. The list shows `2 cs + 3 = 131` in place of a bare qty.
  - Re-adding the same SKU at the same cost adds the cases and the loose bottles together, carrying overflow into cases. For example, 40 loose + 40 loose of 64 becomes 1 case + 16.
  - The rule from Phase 9 that refuses a different cost still applies.
- **Post:** the confirm modal and the success flash use the total bottles. A `PS002` case-size mismatch keeps the staged lines and flashes the server message.
- **Unit cost stays per bottle**, as in Phase 9. Converting a per-case price would mean dividing paise, which can leave fractions, so it isn't offered.

## 5. Tests

- **DB / service (`test/services/catalog.service.test.ts`, extending `purchase.service.test.ts`):**
  - Migration: existing SKUs are backfilled, and `case_size` is NOT NULL and range-checked.
  - Catalog: create a product with 3 sizes, after which codes and display names are derived and the new SKUs are at 0 stock. Then cover a rename re-deriving names, a price edit not changing an existing bill line's snapshot, product deactivation cascading to its SKUs, and duplicate name, code, barcode or size returning `PS012`. Outbox rows are written.
  - GRN case math: 2 cases + 3 loose at case_size 64 posts **131** bottles, and `sku_stock` rises by 131. The line stores `cases = 2` and `case_size = 64`.
  - GRN rejections: a stale `caseSize` gives `PS002` and writes nothing. The `stock_receipt_lines_case_shape` CHECK is enforced, and a legacy `{ quantity }` line still posts.
  - `v_invariant_violations` stays empty.
- **API (`test/server/catalog-api.test.ts`):** the CRUD routes return 201/200, 400 on a bad body and 409 on a duplicate. Then the full lifecycle: create a liquor, GRN 1 case + 5, see `lookupSku` report `case size + 5` on hand, and sell 1.
- **Frontend unit:**
  - `catalogReducer`: form validation and the payload.
  - `purchaseReducer`: cases × size + loose (2 × 64 + 3 = 131), cost pre-fill and override, loose ≥ case size refused, merge carry, and that a 0 + 0 line is refused.
- **End to end (headless Chrome):** create a liquor in the catalog, open Purchase, pick it, enter 2 cases and 3 loose, check the cost is pre-filled, then post. Billing then shows 131 − 1 left after one sale.
- **Finish:**
  - Run `npx vitest run` and `npx tsc --noEmit` at the root.
  - Run the frontend test, tsc, lint and build.

## 6. Docs

`backend_state.md` gets the new columns, PS012, `CatalogService` and the routes. `frontend_state.md` gets the Catalog screen and the GRN case entry. This plan is marked IMPLEMENTED once it's done.

## 7. Decisions

- **A. "Size" field.** *Recommended:* keep the five existing size codes and display them as ml labels (Full 750ml, Half 375ml, Quarter 180ml, 650ml, 330ml). Only labels change, so no migration of existing bills is needed. *Alternative:* also add sizes such as 90ml, 1000ml, 2000ml and a 500ml can to the `size_code` CHECK now. This is cheap, but every report and SizeChip would have to learn them.
- **B. Recording the case breakdown.** *Recommended:* store `cases` and the `case_size` snapshot on each GRN line, verified by the DB against the catalog. The GRN can then be matched to a supplier invoice that is counted in cases, and a case-size edit made mid-entry can't skew stock. *Alternative:* the frontend does the math and posts only total bottles. That needs no GRN schema change, but the breakdown is lost and a stale case size can't be caught.
- **C. Case-size defaults (backfill and form pre-fill).** *Recommended:* Full 12, Half 32, Quarter 64 (your examples), 650ml beer 12 and 330ml beer 24. *Alternative:* the 9-litre carton standard of 12 / 24 / 48. Either way it's editable per SKU.
- **D. Default purchase price.** *Recommended:* optional (nullable); when it isn't set, the GRN cost field is left empty. A GRN does not overwrite the catalog default with the last invoice cost. *Alternative:* make it required for every SKU, or have each posted GRN update the default to the last cost paid.
