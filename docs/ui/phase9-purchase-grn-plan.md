# Phase 9 — Purchase & Inventory Inwarding (GRN) — Schema + Component Plan

Status: **IMPLEMENTED (2026-10-15)**. Approved with the recommended choices (§6):
- **A:** no correction of a posted GRN in this phase.
- **B:** a unique (invoice no, vendor) pair, refused as 409.
- **C:** "N left" in the Billing scan flash.
- **D:** unit cost required, ₹0 allowed.

Changes from the plan as written: the duplicate-receipt code is **PS011** (PS010 was already BILL_ON_BILL). `stock_movements_receipt_line_link` is `NOT VALID`, because no PURCHASE_RECEIPT rows existed before. There's a per-line cap of 100,000 bottles. With lines staged, the first Esc warns and a second Esc leaves.

Goal: the dashboard's **Purchase** tile opens a stock-inwarding screen. The operator enters a supplier invoice (a Goods Receipt Note), and stock rises at once. That makes the whole lifecycle testable on a fresh till: receive, sell, close the day.

---

## 0. What already exists (no change needed)

- `stock_movements` is the single stock ledger. `sku_stock.on_hand_qty` is a cached balance that only the ledger's triggers write.
- `movement_type` already includes `PURCHASE_RECEIPT`, and a CHECK forces its `qty_delta` to be positive.
- Every non-OPENING movement needs an **open business day** (`pos_require_open_day`, `PS007`). A GRN therefore needs an open day, just like an expense.
- `v_invariant_violations` already checks that the cached stock matches the ledger.

What's missing is a **document** for each receipt (invoice no, vendor, unit cost) and a **hard link** from each `PURCHASE_RECEIPT` movement back to the invoice line it came from. Today such a movement can be inserted with no source at all.

## 1. Migration `0008_stock_receipts.sql`

```sql
-- GRN header: one row per supplier invoice received. Append-only.
CREATE TABLE stock_receipts (
  id                    uuid        PRIMARY KEY DEFAULT uuidv7(),
  business_day_id       uuid        NOT NULL REFERENCES business_days (id),   -- stamped: the open day
  invoice_no            text        NOT NULL CONSTRAINT stock_receipts_invoice_present CHECK (btrim(invoice_no) <> ''),
  vendor_name           text                 CONSTRAINT stock_receipts_vendor_present  CHECK (vendor_name IS NULL OR btrim(vendor_name) <> ''),
  received_by_staff_id  uuid        NOT NULL REFERENCES staff (id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- Decision B: the same invoice from the same vendor can't be received twice (this also blocks a double-submit).
CREATE UNIQUE INDEX stock_receipts_invoice_unique
  ON stock_receipts (upper(btrim(invoice_no)), lower(btrim(coalesce(vendor_name, ''))));
CREATE INDEX stock_receipts_day_idx ON stock_receipts (business_day_id, created_at);

-- GRN lines: whole sealed bottles of one SKU at one unit cost. Append-only.
CREATE TABLE stock_receipt_lines (
  id               uuid    PRIMARY KEY DEFAULT uuidv7(),
  receipt_id       uuid    NOT NULL REFERENCES stock_receipts (id),
  line_no          integer NOT NULL CONSTRAINT stock_receipt_lines_line_no_positive CHECK (line_no >= 1),
  sku_id           uuid    NOT NULL REFERENCES skus (id),
  qty              integer NOT NULL CONSTRAINT stock_receipt_lines_qty_positive CHECK (qty > 0),
  unit_cost_paise  bigint  NOT NULL CONSTRAINT stock_receipt_lines_cost_non_negative CHECK (unit_cost_paise >= 0),  -- Decision D
  CONSTRAINT stock_receipt_lines_sku_once  UNIQUE (receipt_id, sku_id),
  CONSTRAINT stock_receipt_lines_no_unique UNIQUE (receipt_id, line_no)
);

-- Trace: each PURCHASE_RECEIPT movement points at exactly one receipt line, and only those movements do.
ALTER TABLE stock_movements
  ADD COLUMN receipt_line_id uuid CONSTRAINT stock_movements_receipt_line_unique UNIQUE REFERENCES stock_receipt_lines (id),
  ADD CONSTRAINT stock_movements_receipt_line_link CHECK ((movement_type = 'PURCHASE_RECEIPT') = (receipt_line_id IS NOT NULL));
```

**Triggers** (they mirror `bill_items` → `SALE`):
- `stock_receipts` BEFORE INSERT: `business_day_id := pos_require_open_day(...)`.
- `stock_receipt_lines` BEFORE INSERT: the SKU must be active.
- `stock_receipt_lines` AFTER INSERT: posts a `PURCHASE_RECEIPT` movement with `qty_delta = qty`, `receipt_line_id = NEW.id`, the header's day and the header's staff. The existing ledger triggers then raise `sku_stock`.
- `stock_movements` BEFORE INSERT is extended so that `PURCHASE_RECEIPT` is accepted only from that trigger (`pg_trigger_depth() >= 2`, `PS009`), just as `SALE` is today. The only way to inward stock is a receipt.
- No UPDATE, DELETE or TRUNCATE on either new table (`PS001`), and both get outbox capture triggers.
- No stored totals. The line total (`qty × unit_cost_paise`, a bigint) and the invoice total are summed in queries.

**Errors:** a new code, `PS011 duplicate receipt`, mapped from `stock_receipts_invoice_unique` in `src/db/errors.ts`. The API returns it as **409**.

What a GRN does *not* do:
- It doesn't touch drawer cash. Paying the vendor is not recorded here.
- It has no tax or GST fields. Unit cost is the per-bottle figure the operator types.
- It doesn't change the sale price.

## 2. Backend

**`PurchaseService`** (`src/services/purchase.service.ts`)

| Method | Notes |
|---|---|
| `recordReceipt({ invoiceNo, vendorName?, lines: [{ skuId, quantity, unitCostPaise }] }, staffId) → StockReceiptDetail` | Runs in one transaction: the header, then lines 1..n. The triggers post the movements. If any line fails (unknown or inactive SKU, bad qty), nothing is written. Up front it checks for at least one line, no duplicate SKUs, whole-number quantities and bigint paise. |
| `listReceipts(businessDayId) → StockReceiptSummary[]` | The day's receipts, newest first: invoice, vendor, time, lines, bottles, total cost. |
| `getReceipt(id) → StockReceiptDetail` | Header plus lines (SKU code, name, size, qty, unit cost, line total). |

**`CounterQueries.searchSkus(q, limit)`**: finds SKUs by exact barcode, by code prefix, or by name containing the text. Each result carries its size and `onHandQty`. Barcode matches rank first, then name, then size in FULL → HALF → QUARTER order.

**Routes** (`server/app.ts`)

| Route | Body / query |
|---|---|
| `GET /api/skus?q=&limit=` | SKU search |
| `GET /api/purchases` | the open day's receipts |
| `GET /api/purchases/:id` | one receipt |
| `POST /api/purchases` | `{ invoiceNo, vendorName?, lines: [{ skuId, quantity, unitCost }] }`, where `unitCost` is a paise string as everywhere else; returns 201 |

## 3. Frontend — `frontend/src/components/PurchaseScreen.tsx`

```
┌ FL2 │ PURCHASE · GRN │ Day 2026-10-15 · Counter 1 │ Today 3 receipts · 96 bottles │ Esc Dashboard ┐
├─ Invoice no [ INV-4471      ]   Vendor [ Sri Balaji Distributors   ] (optional) ─────────────────┤
├── Add line (left ~40%) ─────────────────┬── Staging list (right) ──────────────────────────────────┤
│ SKU  [ house wh▌        ] scan or type  │  #  SKU                     Size  Qty   Unit     Line    │
│  ▸ House Whisky — Full    FULL  48 left │  1  House Whisky — Full     FULL   12  1,100.00 13,200.00│
│    House Whisky — Half    HALF  48 left │  2  House Rum — Quarter     QTR    48    210.00 10,080.00│
│    House Whisky — Quarter QTR   48 left │                                           [Del] remove   │
│ Qty  [ 12 ]   Unit cost ₹ [ 1100.00 ]   │ ─────────────────────────────────────────────────────── │
│ [ Add line  (Enter) ]                   │ 2 lines · 60 bottles · Invoice total ₹23,280.00          │
│                                         │ [ Post GRN  (F9) ]                                       │
├─────────────────────────────────────────┴──────────────────────────────────────────────────────────┤
│ Today: 14:02 INV-4471 · Sri Balaji · 2 lines · 60 btl · ₹23,280.00 │ 11:30 INV-0912 · — · …          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Keyboard path:** type or scan in SKU, choose with ↑/↓, Enter, then Qty, Enter, then Unit cost, Enter. The line is staged and focus returns to SKU.
  - An exact barcode scan picks the SKU directly.
  - F9 posts the invoice, Esc goes back to the dashboard, and Del removes the selected staged line.
  - All targets are touch-sized.
- **Sizes:** each result carries a FULL / HALF / QUARTER chip (the existing `SizeChip`). Typing a product name lists every size, so the operator picks the exact SKU.
- **Staging:**
  - Re-adding a staged SKU at the same cost adds to its qty.
  - Re-adding it at a different cost is refused with "already on this invoice at ₹X — remove it first".
  - Totals are bigint paise, and rupee input goes through `parseRupeesToPaise`. No floats.
- **Post:** a confirm modal shows the invoice, vendor, lines, bottles and total; Enter confirms.
  - On success the form clears, today's list refreshes, and the flash reads "GRN INV-4471 posted · 60 bottles in stock".
  - A 409 duplicate keeps the staged lines and highlights the invoice field.
- **No open day:** the screen says so and links to Day End, the same as the Expense screen.
- **State:** `purchase/purchaseReducer.ts` is pure and unit-tested. It covers search results, line entry and validation, staging (add, merge, refuse, remove), totals, and the submit / reset / error states.
- **Wiring:**
  - `App` gets `view: 'purchase'`, and the Dashboard tile and rail open it instead of `runStub`.
  - The tile hint becomes "Stock inwarding (GRN)".
  - The client gets `searchSkus`, `listPurchases` and `postPurchase`, with types added to `api/types.ts`.

**Billing screen stock count (Decision C):** billing currently never shows how much stock is on hand. Each scan already does a fresh `lookupSku`, so the scan flash will read "+1 House Whisky — Full · 57 left". Stock received a moment earlier then shows on the very next scan.

## 4. Tests

- **DB / service:**
  - A receipt raises `sku_stock` by each line's qty.
  - Every movement traces back: `receipt_line_id` → line → receipt (invoice, vendor, staff, day).
  - Atomicity: when the 3rd line has an inactive SKU, no header, lines or movements are written and stock is unchanged.
  - Rejections: a duplicate invoice per vendor (`PS011`, compared case- and space-insensitively), a closed or missing day (`PS007`), a direct `PURCHASE_RECEIPT` insert (`PS009`), and UPDATE or DELETE on a receipt or line (`PS001`).
  - Outbox rows are written and `v_invariant_violations` stays empty.
  - Validation: zero or negative qty, a non-integer qty, a negative cost, no lines, and the same SKU twice.
- **API:**
  - `POST /api/purchases` returns 201, 400 on a bad body, and 409 on a duplicate. `GET /api/purchases` and `GET /api/skus?q=` work.
  - Lifecycle: GRN 10 × House Whisky Full, after which `GET /api/skus/lookup` shows +10. Selling 1 then shows +9.
- **Frontend unit:** `purchaseReducer`, covering staging math, merge and refuse, validation and reset.
- **End to end (headless Chrome):**
  - Open Purchase, scan HWHS-F, enter qty 10 at ₹1,100, and post.
  - Open Billing, scan HWHS-F, and see "… · 57 left" (48 + 10 − 1).
  - Finish with `npx vitest run` and `npx tsc --noEmit` at the root, and the frontend's test, tsc, lint and build.

## 5. Docs

`backend_state.md` gets the tables, PS011, `PurchaseService`, `searchSkus` and the routes. `frontend_state.md` gets the tree, the files and the Purchase flow. This plan is marked IMPLEMENTED once it's done.

## 6. Decisions

- **A. Correcting a posted GRN.** *Recommended:* not in Phase 9. A posted receipt is final; the confirm modal and the staging review guard against mistakes, and a wrong GRN is fixed later by a reversing "return / void receipt" (its own phase, since the stock may already be sold). *Alternative:* build a same-day Void now. It would need a reversing receipt plus a negative purchase movement type, and it fails with `PS003` if the bottles were already sold.
- **B. Duplicate invoice guard.** *Recommended:* a unique (invoice no, vendor) pair returning 409. *Alternative:* allow duplicates and only warn.
- **C. Stock count on Billing.** *Recommended:* "N left" in the scan flash. *Alternative:* that, plus a stock-check search dialog in Billing.
- **D. Unit cost.** *Recommended:* required, with ₹0 allowed for free or scheme bottles. *Alternative:* must be more than ₹0.
