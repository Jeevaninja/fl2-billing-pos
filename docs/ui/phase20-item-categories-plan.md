# Phase 20 — Custom Item Categories & Flat Inventory — Schema + Component Plan

Status: **IMPLEMENTED (2026-10-19)**. D1–D5 approved as recommended. One migration: `0014_item_categories`.

**As built, differences from this plan:**
- **Back-fill rule order:** a Kitchen item goes to FOOD and an Ancillary item to OTHERS whatever its size (a Full plate
  is food, not a 750 ml bottle); then wine → WINE, beer sizes → BEER, Full / Half / Quarter → the same.
- **`system_key`:** the seven seeded categories carry an immutable key, so the rule still finds them after a rename. A
  trigger gives a SKU inserted without a category (older callers, seeds) the same default.
- **Client-side search:** the Catalog loads every item once and filters locally, so it can tell the New Item form
  whether a typed name is an existing brand. `GET /api/catalog/items?q=` is still there.
- **Brand reactivation:** adding or reactivating an item brings back an inactive brand (the flat UI has no brand
  screen).
- **Frontend:** the brand-and-sizes client calls were removed (the API routes stay). The Settings controls shared by
  the two category screens moved to `components/settings/SettingsControls.tsx`.
- **No category tag in the billing picker:** it wasn't needed, and scanning and search are unchanged.

Goal: the manager defines item categories (FULL, HALF, QUARTER, BEER, WINE, …), creates each item directly inside a
category, and the Inventory Catalog reads like a TASMAC / FL2 stock report: a FULL header with every 750 ml brand
under it, then HALF, QUARTER, BEER…

## 0. What exists (and what this phase has to respect)

- **Two levels today:** `products` (the brand: name, liquor type WHISKY / RUM…, Phase 19 `department`) → `skus` (one
  per size, unique per product: `FULL`, `HALF`, `QUARTER`, `BEER_650`, `BEER_330`, `UNIT`). The Catalog lists brands
  with their sizes indented under them, and "New liquor" creates a brand with 1–6 sizes at once.
- **Derived names:** `sku_code` = `PREFIX-F / -H / -Q / -650 / -330 / -U`; `display_name` = `Brand — Full` (just the
  brand for UNIT). Bill lines snapshot both, so a catalog edit never rewrites a bill.
- **The size code matters beyond the catalog:**
  - KOT size column, the billing size chip, default case sizes (12 / 32 / 64 / 12 / 24);
  - CLAUDE.md: *distinct SKUs for sizes (Full, Half, Quarter)*;
  - future excise / F.Ac.2 reporting by bottle size.
- **Billing never looks at products or categories:** scanning is `lookupSku` (exact barcode, then SKU code) and the
  picker is `searchSkus` (barcode, code prefix, name contains). Both read `skus` (+ the department join), so they keep
  working whatever the grouping is.
- **Stock comes only from a GRN** (Phase 9). The only other way in is an `OPENING` movement, used today by the seeds
  only. The request asks for "Price / Stock" on the New Item form (D5).

## 1. Migration `0014_item_categories.sql`

```sql
CREATE TABLE item_categories (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  name               text        NOT NULL CHECK (btrim(name) <> '' AND name = btrim(name) AND length(name) <= 30),
  sort_order         integer     NOT NULL CHECK (sort_order > 0),     -- report / catalog order
  is_active          boolean     NOT NULL DEFAULT true,
  default_size_code  text        CHECK (default_size_code IN ('FULL','HALF','QUARTER','BEER_650','BEER_330','UNIT')),
  default_department text        NOT NULL DEFAULT 'LIQUOR' REFERENCES departments (code),   -- D3
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX item_categories_name_unique ON item_categories (lower(name));
```

- **Master data, like expense categories:** editable (name, order, defaults, active), never deleted
  (`pos_forbid_change` on DELETE / TRUNCATE), outbox on change. A category with active items can't be disabled
  (`PS002`): its items would vanish from the catalog while still on sale.
- **Seeds,** in report order:

  | Category | Default size | Default department |
  |---|---|---|
  | FULL | FULL | Liquor |
  | HALF | HALF | Liquor |
  | QUARTER | QUARTER | Liquor |
  | BEER | BEER_650 | Liquor |
  | WINE | FULL | Liquor |
  | FOOD | UNIT | Kitchen |
  | OTHERS | UNIT | Ancillary |

- **`skus.item_category_id uuid NOT NULL REFERENCES item_categories`**, back-filled for every existing SKU (an
  UPDATE of master data, so the outbox carries it):
  - a product of type WINE → WINE;
  - a `BEER_650` / `BEER_330` size → BEER;
  - `FULL` / `HALF` / `QUARTER` → the category of the same name;
  - `UNIT` → FOOD for Kitchen items, OTHERS for the rest.
- **Unchanged:** `size_code` and its CHECK, `skus_product_size_unique`, the SKU code and display-name derivation,
  departments, stock, bills, KOTs and Day End.

## 2. Backend

**`ItemCategoryService` (new)**, mirroring `ExpenseCategoryService`:
- `listCategories({ includeInactive })` in `sort_order`, each with `itemCount` (active items) and `onHandQty`.
- `createCategory({ name, defaultSizeCode?, defaultDepartment? })`: name trimmed, spaces collapsed, at most 30
  characters, upper-cased for display consistency (D4). Appended last; a duplicate (any case) is `PS012`.
- `updateCategory(id, { name?, defaultSizeCode?, defaultDepartment?, isActive?, move? })`. Disabling a category that
  still has active items is `PS002`.

**`CatalogService` — flat items (D1):**
- **`listItems({ q, includeInactive })` → `CatalogItem[]`.** Each item is one SKU with its brand name, category, size,
  department, prices, case size, stock and status, ordered by category `sort_order`, then name. `q` matches the item
  name (contains), SKU code (prefix) or barcode (exact), across all categories.
- **`createItem(input)`:**
  - **Input:** `{ categoryId, name, sizeCode?, salePricePaise, purchasePricePaise?, caseSize?, barcode?, codePrefix?,
    openingQty?, department? }`.
  - **Defaults:** size from the category's default; department from the category's default (new brands only, D3);
    case size from the size (Kitchen 1).
  - **Brand:** found by name (case-insensitive) or created. "1848" in QUARTER and later "1848" in FULL are two items
    of one brand, so `sku_code` stays `1848-Q` / `1848-F` and the display names stay `1848 — Quarter`. The same brand
    already having that size is `PS012` ("1848 already has a Quarter — edit it instead").
  - **Code prefix:** taken from the brand's existing SKUs, else suggested from the name and editable.
  - **Opening stock (D5):** `openingQty > 0` posts one `OPENING` movement in the same transaction (tracked
    departments only).
- **`updateItem(skuId, patch)`:** `{ name?, categoryId?, salePricePaise?, purchasePricePaise?, caseSize?, barcode?,
  isActive? }`.
  - **Renaming:** moves this one item to the brand of the new name (found or created) and re-derives its display
    name; other sizes of the old brand are untouched.
  - **Fixed once created:** the size code and SKU code, as today.
  - **Department (Phase 19):** changes on the brand, so it applies to all its sizes, as today.
- **`createProduct` / `addSku` / `updateProduct` / `updateSku` stay** for existing callers and tests. The new UI uses
  the item calls.

**Lookups:** `SkuLookup` gains `itemCategory: { id, name }`. `lookupSku` and `searchSkus` keep their matching rules and
their response shape otherwise, so billing, peak scans, Purchase and Captain orders are unaffected (tested, §6).

**Routes:**

| Route | Body | → |
|---|---|---|
| `GET /api/item-categories` | `?includeInactive=1` | list |
| `POST /api/item-categories` | `{ name, defaultSizeCode?, defaultDepartment? }` | create · 201 |
| `PATCH /api/item-categories/:id` | `{ name?, defaultSizeCode?, defaultDepartment?, isActive?, move? }` | update |
| `GET /api/catalog/items` | `?q=&includeInactive=true` | `listItems` |
| `POST /api/catalog/items` | `{ categoryId, name, sizeCode?, salePrice, purchasePrice?, caseSize?, barcode?, codePrefix?, openingQty?, department? }` | create · 201 |
| `PATCH /api/catalog/items/:skuId` | `{ name?, categoryId?, salePrice?, purchasePrice?, caseSize?, barcode?, isActive? }` | update |

## 3. Settings → Item Categories

- **Gear menu:** a third entry under Inventory Catalog and Expense Categories, built like Expense Categories.
- **List:** categories in report order, with item count, total bottles on hand, default size and department badge,
  and ↑ / ↓ reorder buttons. "Show disabled" toggles disabled ones.
- **Touch-friendly modal:** name, default size (chips), default department (Liquor / Kitchen / Ancillary), and
  Active. Disabling a category that still has items is blocked with a hint.
- **Keys:** Ins new · Enter edit · Alt+↑ / Alt+↓ reorder · Esc back.

## 4. Inventory Catalog — stock-report layout

```
 Search: [ 18__________ ]                                    [ + New item  Ins ]   [ Show inactive ]
 ────────────────────────────────────────────────────────────────────────────────────────────────
 FULL                                                              4 items · 132 bottles
   HWHS-F   House Whisky        Full 750ml   ₹1,800.00   ₹1,100.00   12    48   ● active
   1848-F   1848                Full 750ml   ₹1,450.00   ₹  900.00   12    36   ● active
 HALF                                                              3 items ·  96 bottles
   …
 QUARTER                                                           5 items · 240 bottles
   1848-Q   1848                Quarter      ₹  390.00   ₹  240.00   64    64   ● active
 BEER …   WINE …   FOOD (Kitchen: stock "not tracked") …   OTHERS …
```

- **Rows:**
  - Category headers show the item count and Σ on hand. Headers are skipped by ↑/↓, and empty categories are hidden
    while searching.
  - Items show the brand name alone: the header already says the size.
  - Search filters every category at once, as today (name, code prefix, exact barcode).
- **New item (Ins)** opens a single touch-friendly modal:
  - Fields: **Category** chips (pre-selected from the highlighted row's category), **Name**, then **Size**,
    pre-filled from the category; it's shown only when the category has no default or for BEER (650 / 330).
  - Then **Sale ₹**, **Purchase ₹** (optional), **Case size**, **Barcode** (optional) and **Opening stock** (D5;
    hidden for Kitchen).
  - The **SKU code** preview (`1848-Q`) is editable when the brand is new.
  - An existing brand name shows "Adds a Quarter to 1848" under the name.
  - Enter / F9 saves.
- **Edit item (Enter / tap):** name, category, prices, case size, barcode, and active. The department is shown with
  "applies to every size of 1848". Stock is read-only: it changes only by GRN.
- **Keys:** ↑/↓ items · Enter edit · Ins new (in the highlighted category) · Esc clears search / back. The brand-level
  "New liquor with 1–6 sizes" form goes away.

## 5. Billing, scanning and other screens

- No change to scan or search behaviour. The billing picker and Purchase picker may show the category name as a
  small tag. KOTs and receipts are unchanged: the display name already carries the size.
- **Dev seed and test fixtures:** the seeded SKUs land in the seeded categories via the migration's back-fill rule,
  applied by the seed itself.

## 6. Tests

**Backend:**
- **Migration:** seeds; the back-fill maps every existing SKU (Full / Half / Quarter / Beer 650 / 330 / Wine / Kitchen
  unit / Ancillary unit); no DELETE; disabling a non-empty category is refused; upgrade from 0013 leaves bills,
  stock and expected cash unchanged.
- **Items:**
  - `createItem` into a new brand, then into the same brand in another category (shared prefix, PS012 for a
    duplicate size);
  - opening stock posts one OPENING movement, and none for Kitchen;
  - rename moves only that item;
  - category move;
  - `listItems` grouping order and search across categories.
- **Billing regression:** an item created through the new flow is found by barcode, by SKU code and by name search,
  sells, and appears on a KOT and a receipt. Existing billing and peak tests pass untouched.
- **API:** the six new routes.

**Frontend:**
- **Grouping:** category rows, Σ on hand, selection skipping headers, search across categories.
- **New Item form:** defaults from the category, the size shown only when needed, the existing-brand note, opening
  stock rules, the payload in paise.
- **Item Categories form:** validation and patch.

**Verification:** root and frontend checks, then headless Chrome:
- create a QUARTER "1848", then a FULL "1848";
- check the grouped catalog and search;
- scan and sell it on the billing screen;
- add and reorder a category in Settings.

## 7. Decisions for approval

- **D1 — What an "item" is. Recommended: one SKU in one category; the brand (`products`) becomes an
  internal link** found or created by name, so "1848 Full" and "1848 Quarter" stay one brand. Codes stay `1848-F` /
  `1848-Q`, names stay `1848 — Quarter` on bills and KOTs, Phase 19's department stays per brand, and nothing
  already billed changes. *Alternative:* drop brands entirely, so every item stands alone. That means a schema
  rework of `skus` (name, department and liquor type moved onto each SKU) and losing the brand link that future
  stock and excise reports group by.
- **D2 — Category vs bottle size. Recommended: keep the size code on every item; the category only groups and
  suggests a default size.** The size still drives KOT labels, case sizes and future excise reports (CLAUDE.md:
  distinct SKUs for Full / Half / Quarter). BEER covers both 650 and 330, and WINE covers any size. *Alternative:* the
  category *is* the size (no size code): simpler, but BEER 650 vs 330 and WINE sizes become indistinguishable.
- **D3 — Department. Recommended: it stays on the brand (Phase 19); each category has a default department that
  pre-selects it for a new brand** (FOOD → Kitchen, OTHERS → Ancillary). *Alternative:* move the department onto the
  category, so every item follows its category. That changes Phase 19's model and its catalog switch.
- **D4 — Category names. Recommended: free text, stored as typed but shown upper-case in headers** (TASMAC style),
  unique case-insensitively, at most 30 characters. Seeds: FULL, HALF, QUARTER, BEER, WINE, FOOD, OTHERS.
- **D5 — Stock on the New Item form. Recommended: an optional *opening stock*, entered only at creation**, posted
  as one audited `OPENING` movement, for go-live or a brand found on the shelf. After that, stock changes only through
  Purchase (GRN), so every later bottle traces to an invoice. Kitchen items have no stock field. *Alternative:* no
  stock on the form: every bottle comes in by GRN, including the first.
