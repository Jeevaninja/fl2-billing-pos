# Phase 26 — Revenue Center Bulk-to-Unit Purchase Conversion — Schema + Component Plan

Status: **IMPLEMENTED (2026-10-21)**. D1–D6 were approved as recommended. One migration: `0019_purchase_units`.

Changes from the plan as written:
- **Unit-name defaults.** These come from an insert trigger (`skus_unit_defaults`) instead of column defaults. An
  item created without names (including raw-SQL seeds) takes its brand's first size's names, else Case and
  `pos_default_sale_unit_name` (Bottle for Liquor, Cool Drinks and Water; Unit otherwise).
- **Center summary.** `stockReceipts` lists every receipt today that holds the center's items, with only those
  lines. Receipts posted from the Purchase screen are included.
- **Ledger report.** The ledger report's per-center "drawer" figure is unchanged (it still means supplies only).
  The cash book and Day End carry drawer stock.
- **Purchase screen.** It keeps OUTSIDE. The API accepts `paidFrom` on `POST /api/purchases`, but the screen
  doesn't offer it yet.
- **QA.** Headless Chrome on a scratch database, end to end:
  - Catalog: Gold Flake bought as Packet × 10, sold as Stick.
  - Revenue Centers → Cigarettes: 2 Packets from the drawer gave 20 on hand and expected cash −₹300.
  - Cool Drinks: 1 Case + 6 from outside gave 30 on hand.

Goal: a manager buys Cool Drinks, Cigarettes and Water in bulk units (Case, Packet, Carton) but the till sells and
counts single units. Example: Coca-Cola 300ml is sold as a **Bottle** and bought as a **Case of 24**. Inwarding
**2 Cases** from the Revenue Centers screen adds **48** sellable bottles.

---

## 0. What already exists (and changes the brief)

- **The conversion factor is already in the schema.** Phase 10 (`0009`) added `skus.case_size`: an integer from 1 to
  1000, NOT NULL, on every SKU. The GRN already works out `qty = cases × case_size + loose`. Each GRN line stores
  `cases` and a `case_size` snapshot, and a trigger refuses a stale size (`PS002`). So `units_per_purchase` from the
  brief **is** `case_size`, and the work left is labels plus a new entry point (**D1**).
- **The Catalog already has a "Per case" field** for every item outside Kitchen. The column header is "Case".
- **Stock reaches the shelf only through a GRN line** (`stock_receipt_lines` → `PURCHASE_RECEIPT`). A direct insert
  is refused (`PS009`), so every bottle traces back to an invoice line.
- **The Revenue Centers "New purchase" modal does not touch stock.** It writes `revenue_center_purchases` with
  free-text lines ("5 kg"), and that was deliberate (Phase 22 D2). For a stock-tracked center it shows a hint:
  "Record it in Purchase (GRN)". The center's P&L already counts GRN cost for its items (`stockPurchasesPaise`).
- **A GRN moves no drawer cash and can't be voided.** Revenue-center supply purchases carry `paid_from`
  (DRAWER / OUTSIDE), and DRAWER ones lower Day End's expected cash.

## 1. Migration `0019_purchase_units.sql`

```sql
-- D2: labels only. case_size stays the one conversion factor (D1).
ALTER TABLE skus
  ADD COLUMN purchase_unit_name text NOT NULL DEFAULT 'Case'
    CONSTRAINT skus_purchase_unit_name_shape CHECK (purchase_unit_name ~ '^\S(.{0,18}\S)?$'),
  ADD COLUMN sale_unit_name     text NOT NULL DEFAULT 'Unit'
    CONSTRAINT skus_sale_unit_name_shape CHECK (sale_unit_name ~ '^\S(.{0,18}\S)?$');

-- Backfill the selling unit by center. A manager edits these afterwards.
UPDATE skus k SET sale_unit_name = 'Bottle'
  FROM products p WHERE p.id = k.product_id AND p.department IN ('LIQUOR', 'COOL_DRINKS', 'WATER');

-- How the GRN line was counted, as printed then (like the case_size snapshot). The trigger fills it, not the client.
ALTER TABLE stock_receipt_lines ADD COLUMN purchase_unit_name text;   -- NULL on loose-only / pre-0019 lines

-- D5: who paid for the stock.
ALTER TABLE stock_receipts
  ADD COLUMN paid_from text NOT NULL DEFAULT 'OUTSIDE'
    CONSTRAINT stock_receipts_paid_from_check CHECK (paid_from IN ('DRAWER', 'OUTSIDE')),
  ADD COLUMN department text REFERENCES departments (code);           -- the center that bought it; NULL = Purchase screen
```

- **The GRN line trigger** (`pos_stock_receipt_lines_before_insert`) also sets `NEW.purchase_unit_name :=
  v_sku.purchase_unit_name` when `cases > 0`, and NULL otherwise. The `case_size` rule stays as it is.
- **The receipt-header trigger** refuses a `DRAWER` receipt while a peak runs (`PS007`), the same rule as
  supply purchases.
- **Expected cash.** `pos_day_expected_cash` is re-created to also subtract Σ `qty × unit_cost_paise` of the day's
  `DRAWER` receipts.
- **Outbox.** The new columns ride along on the existing `skus`, `stock_receipts` and `stock_receipt_lines` events.
- **Names.** Both name columns are plain words. The `volume_ml` guard is not affected.

## 2. Backend

**Catalog** (`CatalogService`, `/api/catalog/*`):
- `createItem`, `updateItem`, `addSku` and `updateSku` accept `purchaseUnitName` and `saleUnitName`. Both are
  trimmed and must be 1–20 characters (`RangeError`).
- A new size of an existing brand copies both names from the brand's first size, unless the request gives them.
- `CatalogItem`, `CatalogProduct.skus[]` and `SkuLookup` gain the two names.

**Stock purchase from a center** (new `RevenueCenterService.recordStockPurchase`, which wraps
`PurchaseService.recordReceipt` in the same transaction):

```ts
interface CenterStockPurchaseInput {
  department: DepartmentCode;          // active, stock-tracked, not LIQUOR
  invoiceNo?: string | null;           // D4: blank → auto "COOL_DRINKS-20261021-01"
  vendorName?: string | null;
  paidFrom: 'DRAWER' | 'OUTSIDE';
  lines: Array<{ skuId; cases; looseUnits; caseSize; unitCostPaise }>;   // per selling unit (D6)
}
```

- **Every SKU must belong to that center**, through its brand's department. Otherwise the call fails with `PS002`
  ("Gold Flake is not a Cool Drinks item").
- **Rules from the GRN still apply:** 1–200 lines, no SKU twice, loose below one case, the 100,000-unit cap, and a
  stale `caseSize` fails with `PS002`.
- **The result** is a `StockReceiptDetail` carrying `department` and `paidFrom`.
- **Route:** `POST /api/revenue-centers/stock-purchases` returns **201**. It returns 400, 404 or 409 in the same
  cases as `/api/purchases`.

**Read side:**
- `getSummary` lists the center's stock receipts for the day: invoice, vendor, paid from, lines as
  "2 Cases × 24 = 48", and cost.
- `stockPurchasesPaise` is unchanged, because it already counts these.
- `supplyDrawerPaise` keeps its meaning. A new `stockDrawerPaise` goes alongside it.
- **Day End:** `CashBreakdown` gains `stockPurchasesDrawer`.
- **Reports:** the cash book and the ledger's "drawer" column include drawer GRNs, and the existing to-the-paisa
  assertions are kept.

## 3. Frontend — Catalog (`CatalogScreen.tsx`, `catalogReducer.ts`)

```
│ Sale ₹ [ 20.00 ] per [ Bottle ▾ ]      Purchase ₹ (opt.) [ 15.00 ] per Bottle               │
│ Bought as [ Case ▾ ] of [ 24 ] Bottles        → "1 Case = 24 Bottles"                       │
```

- **Stock-tracked items only.** The existing "Per case" field becomes the **Bought as** row. The rule changes from
  `!kitchen` to `item.tracksStock`, so AC Charges stops showing it too.
- **Unit names.** Quick chips sit beside a free-text field:
  - Bought as: Case, Packet, Carton, Box, Crate.
  - Sold as: Bottle, Stick, Packet, Can, Unit.
  - A new item defaults to Case and the center's usual selling unit (Bottle for Liquor, Cool Drinks and Water;
    Unit otherwise).
- **List column.** "Case" becomes **Bought as**, showing "Case × 24" or "Packet × 10".
- **Reducer.** Each name is 1–20 characters after trimming, and the payload carries both names.

## 4. Frontend — Revenue Centers "New purchase" (`RevenueCentersScreen.tsx` + new `centers/stockPurchase.ts`)

For a **stock-tracked** center, the modal gets a toggle: **[ Stock items ] [ Supplies ]**. Stock items is the
default there. An untracked center (Kitchen, AC Charges) keeps the current Supplies form, and the old "use GRN" hint
is removed.

```
┌ New purchase — Cool Drinks ───────────────────── [ Stock items ] [ Supplies ] ┐
│ Vendor [ Ravi Agencies ]   Bill no. [ (auto) ]   Paid from [ Drawer ][ Outside ] │
│ Item  [ coca▾ Coca-Cola 300ml ]   bought as Case of 24 · 31 on hand              │
│ Cases [ 2 ]  Loose bottles [ 0 ]  = 48 bottles   Cost ₹ [ 15.00 ] /bottle        │
│                                   = ₹360.00 per Case · line ₹720.00  [ Add ↵ ]   │
│ ─────────────────────────────────────────────────────────────────────────────── │
│ Coca-Cola 300ml     2 Cases × 24 = 48 bottles   @ 15.00     720.00   [ × ]       │
│ Thums Up 300ml      1 Case  × 24 + 6 = 30       @ 15.00     450.00   [ × ]       │
│                                         78 bottles in · ₹1,170.00   Save (F9)    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Item search** covers the center's active items only, using `searchSkus` with a department filter.
- **Field labels come from the picked item.** For Gold Flake (Packet × 10, sold as Stick) they read
  "Packets / Loose sticks".
- **Keyboard path:** item ↵ → count ↵ → loose ↵ → cost ↵ stages the line. **F9** saves. This is the same flow
  as the GRN screen.
- **The line math lives in a pure, tested `stockPurchase.ts`.** It reuses `purchaseReducer`'s helpers: units, the
  merge carry, and "loose ≥ one case" refused. Cost pre-fills from the catalog purchase price.
- **After a save:**
  - The flash reads "Cool Drinks: 78 bottles in (2 items)".
  - The summary reloads, so the new receipt appears and the P&L "purchases" card updates.
- **Peak running.** Drawer is disabled, as for supplies.
- **The Purchase (GRN) screen** uses the same dynamic labels: "2 Packets + 3 loose sticks". It keeps OUTSIDE as
  today (D5).

## 5. Tests

**Service** (`test/services/revenue-centers.test.ts`, `purchase.service.test.ts`, `catalog.service.test.ts`):
- **The brief's test:** Gold Flake is set as Packet × 10, sold as Stick, at 0 on hand.
  - Inwarding 2 packets through `recordStockPurchase` raises `sku_stock.on_hand_qty` by **exactly 20**.
  - There is one `PURCHASE_RECEIPT` movement of +20.
  - The line stores `cases 2`, `case_size 10` and `purchase_unit_name 'Packet'`.
- **Cool Drinks:** 2 Cases × 24 adds 48, and 1 Case + 6 adds 30.
- **Refusals that write nothing:**
  - a Cigarettes SKU sent to Cool Drinks gives `PS002`;
  - a LIQUOR, untracked or disabled center is refused;
  - a stale `caseSize` gives `PS002`;
  - loose ≥ case size gives `RangeError`.
- **Money:**
  - A DRAWER stock purchase lowers `pos_day_expected_cash` by Σ qty × cost.
  - A DRAWER stock purchase is refused while a peak runs (`PS007`).
  - An OUTSIDE one leaves the drawer alone.
  - Day End's breakdown and the Reports cash book still balance to the paisa.
- **Labels and invoices:**
  - Renaming the purchase unit afterwards doesn't change the old line's snapshot.
  - An auto invoice number is unique per day, and a second purchase gets `-02`.
- **Migration:** both defaults are in place, Liquor, Cool Drinks and Water become Bottle, and
  `v_invariant_violations` stays empty.

**API** (`test/server/api.test.ts`): `POST /api/revenue-centers/stock-purchases` returns 201, 400, 404 and 409. The
catalog `PATCH` round-trips both names.

**Frontend unit:**
- `stockPurchase.ts`: 2 × 10 = 20, 2 × 24 + 6 = 54, merge carry, per-pack and line totals, and a 0 + 0 line refused.
- `catalogReducer`: name validation and the payload.

**End to end** (`test/e2e/critical-paths.test.ts` and the headless-Chrome pass):
- Catalog: set Gold Flake to Packet × 10.
- Revenue Centers → Cigarettes → New purchase: 2 Packets from the drawer.
- Check that billing shows 20 on hand, then sell 1 and see 19.
- Check that Day End expected cash is lower by the cost.

**Finish:** run `npx vitest run` and `npx tsc --noEmit` at the root, then the frontend test, tsc, lint and build.

## 6. Docs

- `backend_state.md`: the new columns, triggers, the new service method and the route.
- `frontend_state.md`: the catalog row and the stock mode in the purchase modal.
- This plan is marked IMPLEMENTED when the work is done.

## 7. Decisions

- **D1 — The conversion factor.**
  - *Recommended:* reuse `skus.case_size` as "units per purchase unit". The API keeps the name `caseSize`, and the UI
    calls it "Bought as Case of 24". The existing GRN math, snapshot and stale-size trigger already guarantee the
    count, so there is one source of truth.
  - *Alternative:* add a separate `units_per_purchase` column as written in the brief. Liquor would then have two
    factors that can disagree, and the GRN trigger would need to know which one to trust.
- **D2 — Unit labels.**
  - *Recommended:* add `purchase_unit_name` (default "Case") and `sale_unit_name` (default "Unit"; Bottle for
    Liquor, Cool Drinks and Water) per SKU, as free text of up to 20 characters with quick chips. Snapshot the
    purchase unit on GRN lines.
  - *Alternative:* the purchase unit name only, with "units" everywhere on the sale side.
- **D3 — How the center modal adds stock.**
  - *Recommended:* the "Stock items" mode posts a real GRN (`stock_receipts`) tagged with the center. Stock, the
    stock register, the Purchase list and the center's P&L all pick it up with no second path. This replaces the
    Phase 22 hint that sent managers to the GRN screen.
  - *Alternative:* add stock lines to `revenue_center_purchases`. That breaks the rule that every bottle traces to a
    GRN line (`PS009`), and every stock report would need a second source.
- **D4 — Bill / invoice number in the center modal.**
  - *Recommended:* optional. When it is blank, the server assigns `<CENTER>-<yyyymmdd>-NN`, because a packet bought
    at the shop next door has no invoice. The GRN screen still requires a number.
  - *Alternative:* required, as on the GRN screen.
- **D5 — Paying for stock from the drawer.**
  - *Recommended:* add `paid_from` to `stock_receipts`.
    - DRAWER lowers expected cash, is refused during a peak, and shows on Day End and in the cash book.
    - Existing receipts and the Purchase screen stay OUTSIDE.
    - ⚠ **A GRN can't be voided today.** A wrong drawer stock purchase is fixed only by a stock adjustment plus a
      tally adjustment. I suggest a GRN void as a follow-up phase, not part of this one.
  - *Alternative:* the stock mode is OUTSIDE only. That avoids any cash-math change, but cigarettes paid from the
    till would show up as Day End variance.
- **D6 — How cost is entered.**
  - *Recommended:* cost per selling unit, as on the GRN today and pre-filled from the catalog. The modal shows the
    per-pack and line totals live, so there is never a fractional paisa.
  - *Alternative:* cost per purchase unit (₹360 per Case), accepted only when it divides exactly by the units per
    pack. ₹1,000 ÷ 24, for example, would be refused with "enter the per-bottle cost".

**Out of scope:** a GRN void; Liquor in the center modal (it stays on the Purchase screen); selling a whole pack
as one billed line (sell-side packs).
