# Phase 22 — Universal Revenue Centers (Multi-Center P&L Kiosk) — Schema + Component Plan

Status: **IMPLEMENTED (2026-10-19)**. D1–D5 approved as recommended. One migration: `0016_revenue_centers`.

**As built, differences from this plan:**
- **Day End list:** Day End's "By revenue center" lists Liquor always and other centers only when they sold something
  (seven centers at ₹0 were clutter).
- **Settings entry:** the gear menu entry is "Revenue Centers" (between Item Categories and Expense Categories).
- **Chip colours:** the seeded centers have fixed, distinct chip colours; centers the manager adds are hashed into a
  palette.
- **Code generation:** a name that doesn't start with a letter gets a `C_` prefix.
- **Validation:** the catalog, item-category and expense-category services no longer hold a fixed list. They check
  the code's shape, then that the center exists (404) and is active (PS002).

Goal: turn the Kitchen Kiosk into **Revenue Centers**. It tracks sales, purchases and expenses independently for each
non-liquor micro-business (Kitchen, Cigarettes, Cool Drinks, Water Bottles, AC Charges, …), switched by tabs. The
manager can add centers.

## 0. What exists (and what this phase has to respect)

- **Departments (Phase 19) are already the P&L dimension, but a fixed list of three.** LIQUOR, KITCHEN and ANCILLARY
  sit in a `CHECK`.
  - **Bill lines:** every line snapshots its department at sale, so revenue never moves when the catalog changes.
  - **Day End:** splits sales by department.
  - **Expense categories:** map to a department, or Shared.
  - **Brands and categories:** every brand (product) has a department, and item categories pre-select one for new
    brands.
  - **Behaviour:** each department decides the KOT station (Bar / Kitchen) and whether stock is tracked.
- **Kitchen Kiosk (Phase 21) is hard-wired to `'KITCHEN'`:** in its sales, items-sold and expense queries, and in
  `kitchen_purchases`, which has no department column.
- **Stock-tracked goods arrive through Purchase (GRN).** Today the GRN takes Ancillary items such as soda and
  cigarettes. A kitchen purchase never adds stock. So cigarettes recorded only as a Kiosk purchase would never reach
  the shelf count, and recorded both ways they'd be counted twice (D2).
- **Your data:** three non-liquor item categories with no items yet (Cigarettes, Cool Drinks, AC Token), all
  defaulting to Ancillary. FOOD defaults to Kitchen.

## 1. Migration `0016_revenue_centers.sql` (D1: departments become manager-defined revenue centers)

**`departments`: from fixed to managed**
- **Dropped:** the `code IN (…)` CHECK and the UPDATE / DELETE / TRUNCATE guards.
- **Added:**
  - `is_active` (default true);
  - `kot_station` gains **`NONE`** (no ticket; D4);
  - `created_at` / `updated_at`;
  - an `id uuid` (unique, for the outbox).
- **`code`** stays the primary key: every bill line, brand, category and expense category references it.
  - For new centers it's generated from the name (`COOL_DRINKS`), and it can never change: `^[A-Z][A-Z0-9_]{1,29}$`.
  - The name and sort order are editable.
- **Guards** (a trigger):
  - code and id are immutable (`PS001`);
  - LIQUOR can't be disabled, and its station and stock tracking can't change (`PS002`);
  - turning stock tracking **off** while any of the center's items has stock on hand is refused (`PS002`);
  - a center with active items can't be disabled (`PS002`);
  - no DELETE (`PS001`); outbox on change.
- **Seeds (D3):**
  - **CIGARETTES** "Cigarettes", **COOL_DRINKS** "Cool Drinks" and **WATER** "Water Bottles": stock tracked, Bar
    ticket.
  - **AC_CHARGES** "AC Charges": not stock-tracked, no ticket.
  - **ANCILLARY** is renamed **"Other items"**, keeping its code and history.

**`kot_tickets.station`** stays BAR / KITCHEN. A NONE center simply never makes a ticket.

**Purchases: rename + tag**
- `kitchen_purchases` → **`revenue_center_purchases`** and `kitchen_purchase_lines` →
  **`revenue_center_purchase_lines`**. Their constraints and indexes are renamed to match.
- **`department text NOT NULL REFERENCES departments`**: existing rows are KITCHEN (added with a default, then the
  default is dropped). It must be an active, non-LIQUOR center (`PS002`), and a void copies the original's.
- **Functions re-created:** the trigger functions and `pos_day_expected_cash` name the table in their bodies, so
  they're re-created against the new names. The math is identical: drawer purchases are subtracted, and refused
  during a peak.
- **Outbox:** new events carry `aggregate_type = 'revenue_center_purchases'`. Events already queued keep the old name;
  the cloud side maps both.

**Item categories:** no change. FOOD and the user-made categories can point their default at the new centers in
Settings.

## 2. Backend

**`DepartmentService`** (replaces `CatalogService.listDepartments`):
- `list({ includeInactive })` in `sort_order`. Each row carries `itemCount` and Σ on hand.
- `create({ name, kotStation, tracksStock })`: the code is generated from the name, with `_2` added if it's taken.
- `update(code, { name?, kotStation?, tracksStock?, isActive?, move? })`, enforcing the trigger rules.

**`RevenueCenterService`** (replaces `KitchenService`, same logic, parameterised by `department`):
- `getSummary(dayId, department)` returns the same cards, plus the purchase split (D2):

  ```ts
  interface RevenueCenterSummary {
    center: { code; name; tracksStock; kotStation };
    day: { id; businessDate; status };
    salesPaise; openTabsPaise;            // the center's bill lines (counted / not yet), as Phase 21
    expensesPaise;                        // non-voided expenses whose category maps to this center
    purchasesPaise;                       // = stockPurchasesPaise + supplyPurchasesPaise
    stockPurchasesPaise;                  // GRN lines today for items whose brand is in this center (qty × unit cost)
    supplyPurchasesPaise; supplyDrawerPaise;   // the center's own purchase ledger (all / from the drawer)
    grossPaise;                           // sales − expenses − purchases
    itemsSold; expenses; purchases;       // purchases = ledger entries; GRN receipts are listed on the Purchase screen
  }
  ```

  - `salesPaise` is asserted against Day End's `byDepartment` for the same code.
  - The GRN cost uses each item's current brand department: GRN lines carry no department snapshot, and a brand
    rarely changes center.
- `getOverview(dayId)` gives one row per active non-liquor center (sales, purchases, expenses, gross) for an
  **"All centers"** tab.
- `recordPurchase({ department, … })` / `voidPurchase` / `listPurchases(dayId, department?)` work as in Phase 21, plus
  `department`.

**Day End:** `CashBreakdown.kitchenPurchasesPaise` → **`centerPurchasesPaise`**, labelled "Revenue-center purchases
(drawer)". The same rename applies to the peak baseline.

**KOT:** `KotService` routes by the line's center: BAR, KITCHEN, or none for a NONE center, whose items never pend.
The billing line marker reads "Kitchen" only for kitchen lines, as today.

**Routes** (the `/api/kitchen/*` routes are replaced):

| Route | Body | → |
|---|---|---|
| `GET /api/departments` | `?includeInactive=1` | centers (+ counts) |
| `POST /api/departments` | `{ name, kotStation, tracksStock }` | 201 |
| `PATCH /api/departments/:code` | `{ name?, kotStation?, tracksStock?, isActive?, move? }` | 200 |
| `GET /api/revenue-centers/overview` | | all centers, current day |
| `GET /api/revenue-centers/:code/summary` | | one center, current day |
| `POST /api/revenue-centers/purchases` | `{ department, vendorName?, paidFrom, note?, lines }` | 201 |
| `POST /api/revenue-centers/purchases/:id/void` | `{}` | 201 |

## 3. Revenue Centers screen (was Kitchen Kiosk)

```
 REVENUE CENTERS · 19 Oct · open
 [ All centers ] [ Kitchen ] [ Cigarettes ] [ Cool Drinks ] [ Water Bottles ] [ AC Charges ] [ Other items ]  [ + Center ]
 ┌ CIGARETTES SALES ┐ ┌ CIGARETTES EXPENSES ┐ ┌ CIGARETTES PURCHASES ┐ ┌ CIGARETTES GROSS ┐
 │  ₹ 4,200.00      │ │  − ₹ 0.00           │ │  − ₹ 3,100.00        │ │  ₹ 1,100.00      │
 │ +₹200 open bills │ │  petty cash         │ │ ₹3,000 GRN · ₹100 own│ │                  │
 └──────────────────┘ └─────────────────────┘ └──────────────────────┘ └──────────────────┘
  Items sold today                     │ Purchases (Cigarettes)               [ + New purchase  Ins ]
```

- **Tabs:**
  - "All centers" opens first: one row per center with sales, expenses, purchases and gross, plus a total row.
  - **←/→ or 1–9** switch tabs; tapping works too. The last tab is remembered per browser.
  - Card labels use the center name ("CIGARETTES GROSS").
- **New purchase (Ins):** the touch-friendly modal gains a **Center** chip row, defaulting to the active tab. For a
  stock-tracked center a hint says: *"Buying stock to sell (e.g. Gold Flake cartons)? Record it in Purchase (GRN) so
  the shelf count rises; use this for supplies (e.g. ice, packaging)."*
- **"+ Center"** opens the same modal as Settings: name, KOT station, stock tracked.
- **Dashboard tile:** renamed **"Revenue Centers"**.

**Settings → Revenue Centers** (new gear-menu entry, built like Item Categories):
- **List:** name, code, KOT station, stock tracked, item count, active, order.
- **Modal:** name, KOT (Bar / Kitchen / None), stock tracked, active. LIQUOR shows locked fields.

**Everywhere the three fixed departments were hard-coded:**
- Catalog New / Edit item department switch;
- Item Category default department;
- Expense Category department (+ Shared);
- Day End "By department";
- billing search chips.

These all read the center list from `/api/departments`. Chip colours come from a small palette, by sort order.

## 4. Tests

**Backend:**
- **Migration:** seeds; the ANCILLARY rename; the renamed tables keep every row, constraint and trigger; KITCHEN
  back-filled on old purchases.
- **Upgrade from 0015:** expected cash and every Phase 21 summary figure unchanged.
- **Center rules:** generated codes; immutable code; LIQUOR locked; disabling with items refused; stock tracking off
  with stock refused.
- **Per-center P&L:**
  - two cigarette brands sold (one through GRN stock), a cigarette expense category, a supply purchase, and a
    Kitchen sale on the same bill;
  - the Cigarettes figures include only cigarettes, and the Kitchen ones only kitchen;
  - GRN cost counts in stock purchases;
  - the overview's totals add up;
  - Day End's split agrees.
- **KOT:** an AC-charge line prints nothing; a cigarette line goes to the BAR on Captain orders.
- **API:** the new routes; the old `/api/kitchen/*` routes are gone.

**Frontend:** the tab model (order, keys, remembered tab), card labels, the purchase form's center field and GRN hint,
the center form, and the dynamic department chips.

**Verification (headless Chrome):**
1. Add a "Paan" center in Settings.
2. Make Gold Flake (Cigarettes) and AC Charge (AC Charges) items.
3. Receive Gold Flake by GRN.
4. Sell Gold Flake, AC Charge and a dish on one bill.
5. Check that each tab shows only its own figures, and that All centers adds up.
6. Record a Cigarettes supply purchase.

## 5. Out of scope

- A Liquor tab (D5).
- Date ranges.
- Allocating Shared overheads across centers.
- Per-center stock reports.
- Re-tagging historic bill lines: their department snapshot is permanent by design, so ANCILLARY sales made before a
  brand moves to Cigarettes stay under "Other items".

## 6. Decisions for approval

- **D1 — What a revenue center is. Recommended: departments become the manager-defined revenue centers.**
  - Every bill line already carries its department at sale, and so do expense categories, brands, KOT routing and the
    Day End split. A center's P&L is exact from day one, and nothing new has to be stamped on bill lines.
  - *Alternative:* a separate "revenue center" layer under the three fixed departments. That needs a new snapshot on
    every bill line, older lines would have no center, and there'd be two overlapping concepts.
- **D2 — Purchases of goods that are stock-tracked. Recommended: a center's Purchases = GRN receipts of its items +
  its own purchase ledger (supplies),** shown split on the card.
  - Cigarette cartons go in through Purchase (GRN), so the shelf count rises and the cost appears in the Cigarettes
    P&L automatically. The Revenue Centers purchase form is for non-stock supplies (ice, cups, gas, packaging), and
    says so for a stock-tracked center.
  - *Alternative:* only the center's own ledger counts. That's simpler, but stock-tracked goods would then be bought
    twice (GRN for stock, ledger for P&L), or their stock never rises.
- **D3 — Starting centers. Recommended:** seed **Cigarettes, Cool Drinks, Water Bottles** (stock tracked, Bar ticket)
  and **AC Charges** (not tracked, no ticket). Rename **Ancillary → "Other items"** as a catch-all; its history stays.
  - Existing brands stay where they are; the manager moves a brand with the catalog's department switch.
  - After the build I can point your Cigarettes / Cool Drinks / AC Token item categories at the new centers if you
    want.
- **D4 — KOT per center. Recommended: Bar / Kitchen / None.** Cigarettes, water and cool drinks hand over at the Bar;
  AC charges (a service) print no ticket.
- **D5 — Liquor in the kiosk. Recommended: leave it out.** The screen is for the micro-businesses; liquor stays on Day
  End, and a full liquor P&L belongs to Reports. *Alternative:* add a Liquor tab (sales, GRN purchases, Liquor-category
  expenses).
