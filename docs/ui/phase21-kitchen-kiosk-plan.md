# Phase 21 — Kitchen Kiosk, Kitchen P&L & Universal Billing Search — Schema + Component Plan

Status: **IMPLEMENTED (2026-10-19)**. D1–D5 approved as recommended. One migration: `0015_kitchen_purchases`.

**As built, differences from this plan:**
- **Enter fallback:** when the list hasn't answered the typed text yet (very fast typing), Enter fetches the first live
  match instead of saying "Not found".
- **Default paid-from:** a new purchase defaults to Drawer, or to Outside while a peak runs.
- **Dashboard:** Kitchen Kiosk sits after Purchase; on narrow screens the grid is 2 × 5.
- **Search list placement:** it sits inside the scan-bar box, so it lines up with the typed text. No billing-picker
  category tag was added (the department chip is enough).

## 0. What exists (and what this phase has to respect)

- **Billing input is a keyboard-wedge buffer, not an `<input>`** (`hooks/scanBuffer.ts`). Keys typed anywhere on
  the billing screen build the buffer, and Enter commits it to `lookupSku` (exact barcode, then SKU code). Anything
  else is "Not found".
  - **Space** is ignored.
  - **Idle reset:** the buffer clears after **2 s idle**, which is right for a scanner but too short for a human
    typing a name.
  - **↑/↓, +, − and Delete** act on bill rows only while the buffer is empty. With text in the buffer they're free,
    so the search list can use them.
  - **`3*` prefix:** sets the quantity, and Phase 12's Enter → quantity → Pay is unchanged.
- **`searchSkus`** (Purchase picker) already matches an exact barcode, a SKU code prefix, or a name containing the text.
  It includes inactive SKUs (ranked last).
- **Departments (Phase 19):** every bill line snapshots LIQUOR / KITCHEN / ANCILLARY, and Day End's
  `sales.byDepartment` already computes Kitchen sales by the counted-bill rule. Expense categories carry a department
  (Kitchen, or Shared).
- **Requirement 3 is already met, so this phase only adds tests and wording:**
  - A barcode is optional for every item (Phases 10 and 20).
  - The New Item form's department switch sets Liquor / Kitchen / Ancillary for a new brand. An existing brand keeps
    its department, which covers all its sizes (Phase 19 / 20).
- **Dashboard:** a full 4 × 2 grid of eight tiles. Reports is still a stub.

## 1. Migration `0015_kitchen_purchases.sql`

```sql
CREATE TABLE kitchen_purchases (                  -- append-only, outbox
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  business_day_id      uuid        NOT NULL REFERENCES business_days (id),   -- stamped: the open day
  vendor_name          text        CHECK (vendor_name IS NULL OR (btrim(vendor_name) <> '' AND length(vendor_name) <= 80)),
  paid_from            text        NOT NULL CHECK (paid_from IN ('DRAWER', 'OUTSIDE')),   -- D2
  amount_paise         bigint      NOT NULL CHECK (amount_paise <> 0),         -- negative on a void
  note                 text        CHECK (note IS NULL OR length(note) <= 200),
  reverses_purchase_id uuid        UNIQUE REFERENCES kitchen_purchases (id),
  created_by_staff_id  uuid        NOT NULL REFERENCES staff (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((amount_paise < 0) = (reverses_purchase_id IS NOT NULL))
);
CREATE TABLE kitchen_purchase_lines (             -- append-only, outbox
  id           uuid    PRIMARY KEY DEFAULT uuidv7(),
  purchase_id  uuid    NOT NULL REFERENCES kitchen_purchases (id),
  line_no      integer NOT NULL CHECK (line_no >= 1),
  description  text    NOT NULL CHECK (btrim(description) <> '' AND length(description) <= 60),   -- "Chicken"
  quantity     text    CHECK (quantity IS NULL OR length(quantity) <= 20),   -- "5 kg": a label, never arithmetic
  amount_paise bigint  NOT NULL CHECK (amount_paise > 0),
  UNIQUE (purchase_id, line_no)
);
```

- **Insert trigger:**
  - needs an open day (`PS007`), and stamps it;
  - a `DRAWER` purchase is refused while a peak session runs (`PS007`), exactly like bank deposits, so the peak
    math is untouched;
  - **a void** must exactly negate an original of the same day, once, never a void (`PS006`), and copies its
    `paid_from`.
- **A deferred check on commit:** an original's lines must add up to its `amount_paise`, and a void has no lines
  (`PS005`).
- UPDATE / DELETE / TRUNCATE → `PS001`.
- **No stock:** quantities are free text ("5 kg", "2 tins"), so there's no float and no kitchen inventory. Ingredient
  stock with its own units stays a later Kitchen-inventory phase (`docs/roadmap.md`).
- **`pos_day_expected_cash`** subtracts Σ `DRAWER` kitchen purchases of the day, voids included, the same way it
  subtracts bank deposits. Peak functions and the close trigger are unchanged.

## 2. Backend

**`KitchenService` (new):**
- `recordPurchase({ vendorName?, paidFrom, note?, lines: [{ description, quantity?, amountPaise }] }, staffId)`
  - 1–30 lines; texts are trimmed, and a blank vendor or note is null.
  - amounts > 0, total ≤ ₹10,00,000.
- `voidPurchase(id, staffId)` appends the negating row.
- `listPurchases(dayId)` returns originals newest first, with their lines and `voidedAt`.
- `getKitchenSummary(dayId)` → the Kitchen P&L for one day (D5):

  ```ts
  interface KitchenSummary {
    day: { id; businessDate; status };
    salesPaise;            // KITCHEN lines on counted bills — the same figure as Day End's byDepartment KITCHEN
    openTabsPaise;         // KITCHEN lines on bills still open (info: not yet sales)
    expensesPaise;         // Σ petty-cash expenses whose category is Kitchen (voids net out)
    purchasesPaise;        // Σ kitchen purchases (voids net out) …
    purchasesDrawerPaise;  // … of which paid from the drawer
    grossPaise;            // sales − expenses − purchases
    itemsSold: Array<{ skuId; displayName; quantity; amountPaise }>;   // best sellers first
    expenses: ExpenseEntry[];                                          // the Kitchen ones
  }
  ```

  Asserted: `salesPaise` equals Day End's `byDepartment` KITCHEN for the same day.

**Day End:** `CashBreakdown` gains `kitchenPurchasesPaise` (drawer only). It's subtracted in the breakdown and
asserted against `pos_day_expected_cash`, like bank deposits. The peak start baseline gets the same term.

**Universal search:** `searchSkus(query, { activeOnly })` and `GET /api/skus?q=&limit=&active=1`.
- **Matching:**
  - every whitespace-separated word must appear in the display name ("chi 65" → Chicken 65), or the whole text is
    a SKU code prefix, or an exact barcode;
  - ranking: an exact barcode or SKU code first, then names starting with the text, then the rest, by name and size.
- **No typo tolerance:** contains-matching only. A real fuzzy (typo-tolerant) search can come later.

**Routes:**

| Route | Body | → |
|---|---|---|
| `GET /api/kitchen/summary` | | the open day, else the last closed one |
| `GET /api/kitchen/purchases` | | today's purchases |
| `POST /api/kitchen/purchases` | `{ vendorName?, paidFrom, note?, lines: [{ description, quantity?, amount }] }` | 201 |
| `POST /api/kitchen/purchases/:id/void` | `{}` | 201 |
| `GET /api/skus` | `+ &active=1` | billing search |

## 3. Billing — universal type-to-search (D1)

**Scan buffer (pure, unit-tested):**
- A **space** is kept once the buffer has text, so names like "Chicken 65" can be typed.
- **Idle reset:** while the buffer has an open search list, the 2 s idle reset is off; Esc or Enter ends it. A scanner
  never waits, and stray keys that match nothing still clear after 2 s.
- **↑/↓ with text in the buffer** move the list highlight (they move bill rows only when the buffer is empty, as now).
- **Enter** sends `commit` with the highlighted result, if any.

**Screen:**
- **Search list:** typing 2+ characters runs a debounced search (120 ms, active items only, 8 results). A dropdown
  opens under the scan bar, showing each result's name, size chip, department chip (Kitchen / Ancillary), price and
  stock ("not tracked" for Kitchen). The first result is highlighted.
- **Enter resolves in this order:**
  1. an exact barcode or SKU code (`lookupSku`) adds that item at once — scanner speed, unchanged;
  2. otherwise the highlighted result is added (the first, unless ↑/↓ moved it);
  3. no match → "Not found: chix".
- **Quantity and peak:** the `3*` prefix applies, and a peak session adds a peak sale (a Kitchen item prints its KOT,
  as today).
- **Mouse / touch:** tapping a result adds it.
- **Esc** closes the list and clears the buffer.

## 4. Kitchen Kiosk screen

**New dashboard tile, "Kitchen Kiosk" (D4).** The screen has a header with the day and the tile's accent colour, and
three areas:

```
 KITCHEN P&L · 19 Oct                                              (refreshes every 15 s)
 ┌ Kitchen sales ─┐ ┌ Kitchen expenses ┐ ┌ Kitchen purchases ┐ ┌ Kitchen gross ──┐
 │  ₹ 6,350.00    │ │  − ₹ 420.00      │ │  − ₹ 3,200.00     │ │  ₹ 2,730.00     │
 │ +₹380 on open  │ │  petty cash      │ │  ₹1,800 drawer    │ │ sales − costs   │
 └────────────────┘ └──────────────────┘ └───────────────────┘ └─────────────────┘
 Items sold today                       │ Purchases today            [ + New purchase  Ins ]
  Chicken 65 — Full   12   ₹3,840.00    │  10:42 Raju Chicken · drawer   ₹1,800.00   Void
  Masala Peanuts       9   ₹1,080.00    │  12:05 Metro · outside         ₹1,400.00   Void
                                        │ Kitchen expenses (from Expense screen, read-only)
```

- **New purchase (Ins):** a touch-friendly modal (CLAUDE.md: CRUD modals for Expense / PO).
  - Fields: vendor (optional), **Paid from: Drawer / Outside**, and lines (description, quantity text, ₹ amount; Enter
    adds a line). A live total sits above **Save (F9)**.
  - Drawer is disabled with a hint while a peak runs.
- **Void:** with a confirm, and on the purchase's day only.
- **Keys:** Ins new purchase · ↑/↓ purchases · Del void · R refresh · Esc dashboard.
- **Closed day:** shows the last closed day's P&L read-only, like Day End.

## 5. Tests

**Backend:**
- **Migration:** append-only; lines must add up to the amount; a void negates once, same day.
- **Drawer rules:** a drawer purchase lowers `pos_day_expected_cash` and closes with zero variance; an outside one
  doesn't; a drawer purchase is refused during a peak.
- **`getKitchenSummary`:** a day with a typed food item (no barcode), a liquor sale, a Kitchen expense, a Shared
  expense (excluded), and purchases of both kinds. Kitchen sales equal Day End's KITCHEN figure; the liquor sale
  never lands in Kitchen.
- **`searchSkus`:** multi-word, active-only, ranking.

**Frontend:**
- **Scan buffer:** spaces, the idle rule while searching, ↑/↓ highlight, and Enter carrying the pick.
- **Billing search reducer:** results, highlight, a stale response dropped.
- **Kitchen purchase form:** lines, totals in paise, the drawer rule.
- **Kiosk P&L rows.**

**Required end-to-end check (headless Chrome):**
- type "chi", pick **Chicken 65 — Half** with ↓ and Enter — it has no barcode;
- type "1848" and pick the Quarter;
- scan a barcode as before;
- pay;
- on the Kitchen Kiosk, Kitchen sales rise by the dish only;
- record a drawer purchase and see Day End's expected cash drop by it.

## 6. Out of scope

- Kitchen ingredient stock and recipes / consumption.
- A kitchen-side KOT screen.
- A P&L for a date range.
- Allocating Shared overheads.
- Typo-tolerant search.

## 7. Decisions for approval

- **D1 — Enter with several matches. Recommended: Enter adds the highlighted result, and the first is highlighted.**
  Exact barcode / SKU matches always win first, so scanning is unchanged. This is how every autocomplete behaves, and
  the cashier sees which row Enter will add. *Alternative:* with more than one match, Enter does nothing until a row
  is picked with ↑/↓ ("3 matches — pick one"). That's safer, but one key slower on every search.
- **D2 — How a kitchen purchase is paid. Recommended: each purchase says "Drawer" or "Outside"** (owner, bank, credit,
  UPI from the owner's phone). Drawer purchases lower Day End's expected cash and are refused while a peak runs, like
  bank deposits; outside ones only count in the Kitchen P&L. *Alternative:* outside only, with drawer cash for
  ingredients recorded as a petty-cash expense in a Kitchen category. That keeps the drawer math untouched, but
  supplier purchases are then split across two screens.
- **D3 — Purchase detail. Recommended: line items** (description, a free-text quantity like "5 kg", an amount) adding
  up to the total, with no stock tracking. You can see what was bought, and later ingredient stock can build on the
  lines. *Alternative:* one amount and a note per purchase.
- **D4 — Dashboard. Recommended: widen the grid to 5 × 2** (on a narrow screen it stays 2 columns), and add **Kitchen
  Kiosk** after Purchase. That leaves one free slot for HR / Payroll later. *Alternative:* Kitchen Kiosk takes the
  Reports stub's tile, and Reports moves into the Settings menu until it's built.
- **D5 — Kitchen P&L scope. Recommended:**
  - **Day:** the open day (else the last closed one), like Day End.
  - **Sales:** counted by Day End's rule (settled bills and ended peaks), with Kitchen items on still-open tabs shown
    beside it.
  - **Gross:** sales − Kitchen-category expenses − kitchen purchases. Shared overheads stay out.

  *Alternative:* a date-range P&L (from / to) now, instead of with the later Reports module.
