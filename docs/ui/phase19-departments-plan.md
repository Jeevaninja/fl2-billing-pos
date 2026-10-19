# Phase 19 — Unified Billing, Split Ledger (Departments) — Schema + Component Plan

Status: **IMPLEMENTED (2026-10-19)**. D1–D5 approved as recommended. One migration: `0013_departments`.

**As built, differences from this plan:**
- **Defaults:** `products.department` and `bill_items.department` keep `DEFAULT 'LIQUOR'` after the upgrade (the
  insert trigger always sets a line's real department; the default lets a missing SKU still surface as its FK error).
- **Kitchen sizes:** the catalog offers a Kitchen item only Full plate / Half plate / Single size (`UNIT`), with no
  case size (stored as 1).
- **Counter waiter settlement:** `POST /api/bills/:id/settle-waiter` also sends pending Kitchen lines, like F9.
- **One printed line per SKU:** two scans of a dish print as `2  Chicken 65 - Half`; the ledger keeps each bill line.
- **Receipt:** the footer reads `TOTAL (n items)` instead of `(n btl)`, since a bill can now carry dishes.
- **Day End:** `closeBusinessDay` also asserts the split is complete (`unallocated = 0`) at close.
- **Expense split on Day End:** not shown (only the sales split was requested); expenses carry their department for
  the future P&L report.

Goal: tag every sale line and every petty-cash category with a department (LIQUOR / KITCHEN / ANCILLARY) so
revenue can be split per P&L, while bills, tenders, the drawer and the Day End cash math stay exactly as they are.

## 0. What exists (and what this phase has to work around)

- **Catalog:** `products` (category `WHISKY … BEER, OTHER`, all liquor) → `skus` (one per sealed size: `FULL`,
  `HALF`, `QUARTER`, `BEER_650`, `BEER_330`; unique per product). There is no concept of a non-liquor item.
- **Every sale line moves stock:** `bill_items` posts a `SALE` stock movement and `sku_stock` can't go below 0
  (`PS003`). New SKUs start at 0 and stock arrives only through a GRN. **A cooked dish could not be sold at all**
  today — this phase has to decide how kitchen items treat stock (D2).
- **Bill lines snapshot** the SKU's code, name, size and price at insert, so catalog edits never rewrite history.
- **KOTs:** only Captain orders print one, after commit, to a single station `'COUNTER'` (console stub; no real
  printer yet). Counter bills print no KOT. Receipts are printed only as Phase 17 reprints, and already list every
  line of the bill.
- **Day End:** `SalesBreakdown` is tender-based (normal tenders + ended peak sessions). `pos_day_expected_cash`,
  the peak functions and the close trigger never look at what was sold — **they need no change**.
- **Expense categories (Phase 18):** names resolve by id, or through `legacy_code` for pre-0012 rows.

## 1. Migration `0013_departments.sql`

```sql
-- Fixed list; read-only master data (no insert UI, UPDATE / DELETE / TRUNCATE forbidden).
CREATE TABLE departments (
  code        text    PRIMARY KEY CONSTRAINT departments_code_valid CHECK (code IN ('LIQUOR','KITCHEN','ANCILLARY')),
  name        text    NOT NULL,
  kot_station text    NOT NULL CONSTRAINT departments_station_valid CHECK (kot_station IN ('BAR','KITCHEN')),
  tracks_stock boolean NOT NULL,                     -- D2
  sort_order  integer NOT NULL
);
INSERT INTO departments VALUES
  ('LIQUOR',    'Liquor',    'BAR',     true,  1),
  ('KITCHEN',   'Kitchen',   'KITCHEN', false, 2),
  ('ANCILLARY', 'Ancillary', 'BAR',     true,  3);   -- soda, water, cigarettes: handed over at the bar (D5)
```

**Catalog (D1, D3):**
- `products.department text NOT NULL DEFAULT 'LIQUOR' REFERENCES departments` (every existing product is liquor;
  the default is dropped after the column is added). Editable like name and category, outbox on change.
- `products_category_valid` gains `FOOD`, `BEVERAGE` (soft drinks, soda, water) and `TOBACCO`.
- `skus_size_code_valid` gains **`UNIT`** for single-size items (a dish, a soda). Full / half plates reuse `FULL` /
  `HALF`.

**Bill lines — department snapshot:**
- `bill_items.department text NOT NULL REFERENCES departments`, added with `DEFAULT 'LIQUOR'` (every existing line
  is liquor; added by DDL, so no UPDATE trigger fires and the append-only rule holds), then the default is dropped.
- The insert trigger sets it from the SKU's product for a positive line, and copies the original's for a
  cancellation / reversal line, exactly like the name and price snapshots. A later department change never moves
  revenue already billed.
- **Stock (D2):** when the line's department has `tracks_stock = false`, the trigger posts **no** stock movement
  and the `PS003` check is skipped (`BillingService.assertStockAvailable` too). OPENING / ADJUSTMENT movements and
  GRN lines for such a SKU are refused with `PS002` ("Kitchen items are not stock-tracked").

**Expense categories (D4):**
- `expense_categories.department text REFERENCES departments` — **NULL = Shared** (overheads such as transport,
  cleaning, repairs, wages). Seeds: Ice → `LIQUOR`; the rest stay Shared. Editable; outbox on change.
- An expense's department resolves through its category (by id, or `legacy_code` for old rows), the same way its
  name does. No new column on `cash_expenses`.

**KOT ledger (D5):**

```sql
CREATE TABLE kot_tickets (                       -- append-only, outbox
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  bill_id             uuid        NOT NULL REFERENCES bills (id),
  station             text        NOT NULL CHECK (station IN ('BAR','KITCHEN')),
  ticket_no           integer     NOT NULL CHECK (ticket_no >= 1),   -- per bill and station: KOT #12/1, #12/2
  printed_at          timestamptz NOT NULL DEFAULT now(),
  created_by_staff_id uuid        REFERENCES staff (id),            -- counter
  captain_device_id   text,                                          -- or a handset
  CONSTRAINT kot_tickets_no_unique UNIQUE (bill_id, station, ticket_no)
);
CREATE TABLE kot_ticket_lines (                  -- append-only, outbox
  id           uuid    PRIMARY KEY DEFAULT uuidv7(),
  ticket_id    uuid    NOT NULL REFERENCES kot_tickets (id),
  bill_item_id uuid    NOT NULL REFERENCES bill_items (id),   -- always the original (positive) line
  qty          integer NOT NULL CHECK (qty <> 0),             -- negative = a CANCEL ticket line
  CONSTRAINT kot_ticket_lines_item_unique UNIQUE (ticket_id, bill_item_id)
);
```

Trigger: the line's bill must be the ticket's bill, and the line's department must route to the ticket's station
(`PS002`). `DELETE` / `UPDATE` / `TRUNCATE` → `PS001`.

**Not touched:** `pos_day_expected_cash`, `v_peak_sessions`, the peak and close triggers, bills, tenders.

## 2. Backend

**`CatalogService`:**
- `createProduct` / `updateProduct` take `department` (default `LIQUOR`).
- Sizes accept `UNIT`: code suffix `-U`, display name = the product name alone ("Chicken 65", not "Chicken 65 —
  Unit"); case size defaults to 1.
- `CatalogProduct` and `SkuLookup` carry `department`, so the billing screen and pickers can show it.
- `PurchaseService` refuses Kitchen SKUs (`PS002`, also enforced by the GRN line trigger); the GRN picker hides
  them.

**`ExpenseCategoryService`:** create / update take `department: DepartmentCode | null`. `ExpenseCategory` and
`CashExpense.category` carry `department` (resolved). `usedCount` is already there for the UI warning.

**`KotService` (new, `src/services/kot.service.ts`)** — one place that prints KOTs for any bill:
- `sendPending(billId, by: { staffId } | { deviceId })`, in one transaction that locks the bill row:
  1. For every original line, `pending = net quantity (line + its cancellations) − Σ already sent`.
  2. Group the non-zero deltas by station; positive deltas make a KOT, negative ones a **CANCEL** KOT.
  3. Print each ticket, then insert it with its lines. A printer error rolls that station back, so its lines stay
     pending and the next send retries them. A print never undoes a sale.
- **When it runs** (always after the sale itself commits):

  | Event | Stations |
  |---|---|
  | Captain order placed | BAR and KITCHEN (replays never print, as today) |
  | Counter **F6 "Send KOT"** (new, `POST /api/bills/:id/kot`) | KITCHEN |
  | Counter bill settled (F9) | KITCHEN (whatever is still pending) |
  | Peak scan (each scan is its own bill) | KITCHEN |
  | A sent Kitchen line cancelled on an open bill | KITCHEN (CANCEL ticket) |
  | Peak "undo last scan" of a Kitchen item | KITCHEN (CANCEL ticket) |

  Counter bills print no BAR ticket, as today: the cashier is at the bar. A refund reversal of a settled bill
  prints nothing (the food was served).
- **`PrinterService`:** `KotStation = 'BAR' | 'KITCHEN'` (`'COUNTER'` is renamed `'BAR'`). One sink per station
  (both the console stub until real printers exist). Tickets: header `KOT #12/2 · KITCHEN`, the waiter (Captain /
  tagged bill) or `COUNTER`, the lines, no prices; CANCEL tickets carry a banner `*** CANCEL ***`.
- **Captain API:** `PlacedOrder.kots: KotStatus[]` (one per station printed). `kot` is kept for compatibility
  (the BAR ticket, else the KITCHEN one).
- **Receipt:** unchanged — one unified bill with every line, any department.

**Day End — `SalesBreakdown.byDepartment` (new, info only):**
- `byDepartment: Array<{ code, name, salesPaise }>` (all three, in `sort_order`) + `unallocatedPaise`.
- It's Σ `bill_items.line_total_paise` by `bill_items.department` over the same bills the tender totals count:
  the day's settled normal bills (whose tenders aren't in a still-running peak window) and the bills of ended peak
  sessions (reversals included, as negative lines).
- `unallocatedPaise` = tenders already counted on bills that are still open (part-payments) or settled inside a
  running peak. It is shown as "On bills still open" and is always ₹0 at close (open bills and a running peak
  block the close).
- **Asserted** like the other identities: `Σ byDepartment + unallocated = total.salesPaise`, else it throws.
- `CashBreakdown.expectedCashPaise` is untouched: **one combined drawer number**.

**Routes:**

| Route | Body | → |
|---|---|---|
| `POST /api/catalog/products`, `PATCH /api/catalog/products/:id` | + `department` | create / update |
| `POST /api/expense-categories`, `PATCH /api/expense-categories/:id` | + `department` (`null` = Shared) | create / update |
| `POST /api/bills/:billId/kot` | `{}` | `sendPending` → `{ kots: KotStatus[] }` |
| `POST /api/bills/:billId/settle`, `POST /api/peak/sales`, cancel, peak undo | — | responses gain `kots` |
| `GET /api/departments` | | the three departments |

`BillDetail.items[]` gain `department` and `kotSentQuantity`, so the screen can show what's pending.

## 3. Inventory Catalog (Settings)

- **Department** on the product form (new and edit): a large three-way segmented switch (Liquor · Kitchen ·
  Ancillary). Choosing a category pre-selects it (liquor categories → Liquor, `FOOD` → Kitchen, `BEVERAGE` /
  `TOBACCO` → Ancillary); the manager can override.
- The size picker offers **Unit** ("single size") alongside Full / Half / Quarter / 650 / 330.
- The product list shows a small department chip; Kitchen sizes show stock as "not tracked".
- Changing a product's department warns: "Applies to new sales only — billed lines keep their department".

## 4. Expense Categories (Settings)

- The category modal gains a **Department** switch: Liquor · Kitchen · Ancillary · Shared (default Shared).
- The list shows a department badge.
- Changing the department of a used category warns: "Moves its N past expenses to Kitchen" (they follow the
  category, like the name).

## 5. Billing screen

- Kitchen lines show a **KITCHEN** chip; a line with unsent quantity shows "KOT pending", then "KOT ✓" once sent.
- **F6 Send KOT** (free in billing today) sends pending Kitchen lines; the side panel shows the button with the
  pending count when there is any. Flash: "Kitchen KOT #12/1 sent · 3 items", or the printer error (lines stay
  pending).
- F9 settle and peak scans send automatically; nothing extra for the cashier to remember.
- Out-of-stock (`PS003`) never applies to Kitchen items.

## 6. Day End

The **Sales breakdown** card gains a **By department** block under the tender table:

```
By department        Liquor     ₹ 48,200.00
                     Kitchen    ₹  6,350.00
                     Ancillary  ₹    900.00
                     On bills still open ₹ 500.00   (only when ≠ 0)
                     Total      ₹ 55,950.00   (= Total sales)
```

The cash breakdown and **Expected cash** stay one combined figure.

## 7. Tests

**Backend (PGlite):**
- Migration: seeds; existing products and bill lines read `LIQUOR`; departments are read-only; upgrade from 0012
  with existing bills leaves every total and `pos_day_expected_cash` unchanged.
- Bill lines snapshot the department; a department change after a sale doesn't move it; cancellation / reversal
  lines copy it.
- Kitchen SKUs: sold with zero stock, no stock movement, cancellations don't restock; GRN, OPENING and ADJUSTMENT
  for them are refused. Ancillary items behave like liquor (PS003 at zero).
- KOT: a Captain order with liquor + kitchen prints two tickets; counter F6 sends only pending kitchen lines; a
  second send prints nothing; a cancel after sending prints a CANCEL ticket; a printer failure leaves lines pending
  and the retry prints them once; settle and peak scans auto-send; the KOT ledger is append-only.
- **Day End (requested):** a day with mixed bills (normal, waiter credit, peak, a reversal, a part-paid open bill):
  `byDepartment` sums correctly, `Σ + unallocated = total.salesPaise`, Expected cash equals the same day without
  departments, and the day closes with zero variance and `unallocated = 0`.
- API: department on catalog and expense-category routes, `POST /api/bills/:id/kot`, `kots` on responses.

**Frontend:** catalog department defaulting and payloads, expense-category department and the move warning,
billing pending-KOT counts, the Day End department rows (and the "still open" row only when ≠ 0).

**Verification:** root and frontend `vitest` + `tsc` + lint + build, then a headless-Chrome pass: add a Kitchen
item and an Ancillary item in the Catalog, sell them with liquor on one bill, F6 / F9 KOT output, Day End split and
unchanged Expected cash. Then the state docs and `docs/roadmap.md`.

## 8. Decisions for approval

- **D1 — Where the department lives. Recommended: on `products`** (all sizes of a product share it), snapshotted
  onto every `bill_items` line. A dish's Half and Full plates can't then end up in different P&Ls, and the catalog
  form sets it once. *Alternative (as written in the request):* a column on `skus`, set per size.
- **D2 — Stock for kitchen items. Recommended: Kitchen items are not stock-tracked** in this phase (no stock
  movement, no out-of-stock refusal, not in GRN). Cooked dishes aren't sealed bottles, and food inventory belongs
  to the later Kitchen module (ingredients, its own units). **Ancillary items are tracked** in whole units like
  liquor (a soda or a cigarette pack is a countable sealed item). CLAUDE.md's whole-bottle rule stays exactly as is
  for liquor.
- **D3 — Item shapes. Recommended:** add categories `FOOD`, `BEVERAGE`, `TOBACCO` and one size `UNIT` (single-size
  items; full / half plates reuse `FULL` / `HALF`). Category pre-selects the department; the manager can change it.
- **D4 — Expense departments. Recommended: a fourth choice, "Shared"** (NULL) for overheads that belong to no
  single P&L (transport, cleaning, repairs, wages); only Ice is seeded as Liquor. Expenses follow their category's
  department (no per-row copy), so fixing a wrong department fixes history too, with a warning. *Alternative:* copy
  the department onto each new expense row so it never moves.
- **D5 — KOT routing. Recommended: a small KOT ledger** (`kot_tickets`) recording what each station was sent.
  Captain orders print BAR + KITCHEN; counter bills send Kitchen lines on F6, on settle and on each peak scan;
  cancelling a sent dish prints a CANCEL ticket; Ancillary prints at the BAR. Nothing is printed twice or missed,
  and a failed print retries. *Alternative:* no ledger — split Captain tickets, and print a counter Kitchen ticket
  only on settle / peak scan (held tabs can't send food early, and a failed print is simply lost).
