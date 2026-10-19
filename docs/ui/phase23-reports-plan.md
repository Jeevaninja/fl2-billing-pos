# Phase 23 — Master Reporting Engine & Ledger Balances (Tally Prep) — Component Plan

Status: **IMPLEMENTED (2026-10-19)**. D1–D6 approved as recommended. No migration: every figure is read from tables that already exist.

**As built, differences from this plan:**
- **Expenses:** a category whose entries net to ₹0 (all voided) is left out of Expense Accounts.
- **Stock register search:** the stock tab also has an item / code search next to the "Hide items with no stock and no movement" toggle (on by default).
- **Print:** the sales register prints every row; on screen it pages 200 at a time.
- **Legacy expense rows:** resolved through `legacy_code`, the same rule Day End uses. Not covered by a Phase 23 test: a pre-0012 row can't be inserted on the current schema, so the test would need an upgrade-from-0011 database.

Goal: a date-ranged Reports screen under the Settings gear. It gives grouped ledger totals for manual Tally entry, a
bill-wise sales register, a stock register, and a payment-mode split. **No net-profit figure anywhere.**

## 0. What exists (and what this phase has to respect)

- **Every money and stock row is tagged with a business day:** bills, bill payments, waiter payments, cash
  expenses, GRN receipts, center purchases, bank deposits, tender adjustments, and stock movements. The one exception
  is an OPENING movement posted while no day was open (`business_day_id` NULL; D4). `business_days.business_date` is
  unique, so a date range is a set of trading days.
- **Bill numbers restart every day** (`bills_bill_no_unique (business_day_id, bill_no)`), so a bill is identified by
  date + number.
- **Day End owns the payment math:**
  - `getDayFigures` splits peak bills (which carry no tender) into cash and UPI from the peak readings, with any
    variance landing in peak cash;
  - it applies tally adjustments;
  - it gives the split by revenue center (`byDepartment`);
  - it asserts all of this against expected cash.

  Re-deriving any of it a second way would let Reports disagree with a Z report.
- **Revenue centers (Phase 22):** every bill line snapshots its center, and expense categories map to a center or
  Shared. Center purchases = GRN of the center's items + its supply ledger. GRN lines have no center snapshot, so
  they use the brand's current center.
- **Stock ledger:** `stock_movements` is append-only, with OPENING, PURCHASE_RECEIPT, SALE, SALE_REVERSAL and
  ADJUSTMENT rows. `sku_stock` is the cached sum. Untracked centers (Kitchen, AC Charges) post no movements.
- **Reports today** is a placeholder dashboard tile ("Sales, stock and F.Ac.2") that does nothing.

## 1. Backend — `ReportService` (`src/services/report.service.ts`)

Read-only. Every method takes `{ startDate, endDate }` as `YYYY-MM-DD` business dates. Validation:
- the date shape;
- `start ≤ end`;
- a span of at most 366 days.

Each failure is a `RangeError`, which the server answers with 400. Every response carries `range` and `days`:
`{ id, businessDate, status }[]` for the trading days found. When any day in the range is still OPEN, `provisional:
true` is set (D2).

### 1.1 `getLedger(range)` — Master Ledger Balances

```ts
interface LedgerReport {
  range; days; provisional;
  sales: {                                   // Sales Accounts
    byCenter: Array<{ code; name; salesPaise }>;   // Σ Day End byDepartment over the days, every center with ≠ 0, display order
    unallocatedPaise;                        // open day only: tenders not yet split (D2); 0 for closed days
    totalPaise;                              // = Σ byCenter + unallocated = Payments total sales (asserted)
  };
  purchases: {                               // Purchase Accounts
    liquorGrnPaise;                          // GRN lines of LIQUOR brands (qty × unit cost)
    byCenter: Array<{ code; name; grnPaise; suppliesPaise; suppliesDrawerPaise; totalPaise }>;  // non-liquor centers
    totalPaise;
  };
  expenses: {                                // Expense Accounts (petty cash)
    byCategory: Array<{ categoryId; name; centerName: string | null /* null = Shared */; amountPaise; count }>;
    totalPaise;                              // voids net out; pre-0012 rows resolve through legacy_code
  };
  contra: { bankDepositsPaise };             // D5: cash → bank, not an expense
}
```

### 1.2 `getSalesRegister(range)` — Detailed Sales Report

The bills in chronological order (business date, then bill number):

```ts
interface SalesRegisterRow {
  billId; businessDate; billNo; createdAt; settledAt;
  kind: 'SALE' | 'REVERSAL'; reversesBillNo: number | null;
  mode: 'NORMAL' | 'PEAK'; status;           // SETTLED / PEAK_UNSETTLED / PEAK_RECONCILED
  paidBy: string;                            // "Cash", "UPI", "Cash + UPI", "Waiter credit", "Peak" …
  waiterName: string | null;
  items: Array<{ name; sizeLabel; qty; lineTotalPaise }>;   // net per SKU (cancelled lines folded out)
  totalPaise;                                // negative on a reversal
}
// + totals: { billCount, reversalCount, salesPaise, reversalsPaise, netPaise }, openBillCount (excluded, D2)
```

- **Reversals** appear as their own rows ("VOID of #12"), so the register shows every number issued.
- **Empty bills** (closed with no lines) are listed at ₹0, so the numbering has no gaps.
- **OPEN tabs are left out:** they aren't sales yet. Their count is shown under the table.
- `netPaise` equals the ledger's sales total for closed days (asserted).

### 1.3 `getStockRegister(range)` — Master Stock Report (D4)

Every SKU in a stock-tracked center (Liquor, Cigarettes, Cool Drinks, …) that is active, has stock, or moved in the
range. Rows are grouped by item category in report order (Phase 20), then brand, then size.

```ts
interface StockRegisterRow {
  skuId; skuCode; name; sizeLabel; categoryName; centerName; isActive;
  openingQty;                                // Σ qty_delta of movements dated before startDate
  inwardQty;                                 // PURCHASE_RECEIPT in range (GRN)
  salesQty;                                  // −(SALE + SALE_REVERSAL) in range: bottles out, net of restocked returns
  otherQty;                                  // OPENING + ADJUSTMENT in range (new-item opening counts, corrections)
  closingQty;                                // opening + inward − sales + other
}
```

**Opening stock for any historical date:**
- **Dating a movement:** each movement gets an *effective date*, which is its day's `business_date`.
- **Movements with no day:** a NULL-day OPENING (an item created between days) is dated to the first business day
  opened after it was created. If no later day exists, it's dated after the range.
- **Opening** = Σ `qty_delta` with effective date `< startDate`.
- **Closing** = Σ `qty_delta` with effective date `≤ endDate`.

All of this is one set-based query: a `SUM … FILTER` per column, grouped by SKU.

**Self-checks:**
- the row arithmetic must hold;
- when `endDate` is on or after the latest business day, `closingQty` must equal `sku_stock.on_hand` for every SKU;
- a range's closing equals the next range's opening.

### 1.4 `getPayments(range)` — Payment Bifurcation (D3)

```ts
interface PaymentsReport {
  range; days; provisional;
  revenue: { cashPaise; upiPaise; waiterCreditPaise; totalSalesPaise };   // Σ Day End total.* — how each rupee of sales was paid
  split: {                                   // where the cash / UPI came from
    normal: { cashPaise; upiPaise };         // counter + Captain tenders, after tally adjustments
    peak: { cashPaise; upiPaise; sessionCount };   // from the peak readings; variance sits in peak cash
  };
  waiterLedger: { creditGivenPaise; repaidCashPaise; repaidUpiPaise; outstandingChangePaise };
  received: { cashPaise; upiPaise };          // money actually taken in: revenue cash / UPI + waiter repayments
  byDay: Array<{ businessDate; cashPaise; upiPaise; waiterCreditPaise; totalSalesPaise }>;
}
```

- **Source:** the payments figures and `sales.byCenter` come from Day End's own `getDayFigures` for each day,
  summed over the range. A range therefore always equals the sum of its Z reports, and a test asserts it.
- **Everything else** (purchases, expenses, the sales register, the stock register) is set-based SQL over the day
  ids.

### 1.5 Routes (`server/app.ts`)

| Route | Query | → |
|---|---|---|
| `GET /api/reports/ledger` | `startDate`, `endDate` | `LedgerReport` |
| `GET /api/reports/sales` | `startDate`, `endDate` | `SalesRegister` |
| `GET /api/reports/stock` | `startDate`, `endDate` | `StockRegister` |
| `GET /api/reports/payments` | `startDate`, `endDate` | `PaymentsReport` (a fourth route for the fourth tab) |
| `GET /api/reports/range-presets` | | `{ currentBusinessDate, firstBusinessDate }`: the anchor for the preset buttons (D1) |

Money goes over the wire as a paise string, as on every other route.

## 2. Reports screen (Settings → Reports)

```
 REPORTS                                                                       [ Esc  Back ]
 [ Today ] [ Yesterday ] [ Last 7 days ] [ This month ] [ Last month ] [ Custom: 01-10-2026 → 19-10-2026 ]
 19 days · 18 closed · 1 open (provisional)                                  [ CSV ] [ Print ]
 [ 1 Ledger balances ] [ 2 Sales register ] [ 3 Stock register ] [ 4 Payments ]
 ┌ SALES ACCOUNTS ─────────────────┐ ┌ PURCHASE ACCOUNTS ───────────────────┐ ┌ EXPENSE ACCOUNTS ─────────┐
 │ Liquor Sales        ₹ 8,42,300  │ │ Liquor purchases (GRN)  ₹ 6,10,000   │ │ Ice           ₹ 12,400    │
 │ Kitchen Sales       ₹ 1,12,450  │ │ Cigarettes  GRN ₹40,000 + ₹0 = …     │ │ Staff food    ₹  8,200    │
 │ Cigarettes Sales    ₹   48,200  │ │ Kitchen     GRN ₹0 + ₹62,300 supplies│ │ Transport     ₹  3,000    │
 │ ─────────────────────────────── │ │ ──────────────────────────────────── │ │ ───────────────────────── │
 │ Total               ₹10,02,950  │ │ Total                   ₹ 7,12,300   │ │ Total         ₹ 23,600    │
 └─────────────────────────────────┘ └──────────────────────────────────────┘ └───────────────────────────┘
  Contra: Cash deposited to bank  ₹ 5,00,000
```

- **Entry point:**
  - "Reports" moves into the Settings gear menu, as the first entry;
  - the dashboard's Reports tile is removed;
  - the `reports` action keeps its id, so a keyboard shortcut still reaches it.
- **Date picker** (`frontend/src/reports/dateRange.ts`, pure):
  - **Presets:** Today, Yesterday, Last 7 days, This month and Last month, all counted from the **current business
    date** (D1).
  - **Custom:** two date fields.
  - **Shared:** one range drives all four tabs, and switching tabs keeps it. The last preset is remembered in this
    browser.
- **Tabs:** `1`–`4` or `←/→`, the same model as Revenue Centers.
- **Provisional banner:** when the range includes the open day, an amber line reads *"Today is still open — its
  figures will change until Day End."*
- **Ledger:** three cards, a total under each, and the Contra line. Amounts use the Indian grouping already in
  `lib/money`.
- **Sales register:**
  - a dense table: Date · Bill No · Time · Items (`2× 1848 Q, 1× Chicken 65`) · Paid by · Total;
  - reversal rows are struck through and red;
  - the footer has the totals;
  - a search box filters by bill number or item;
  - 200 rows per page, client-side.
- **Stock register:**
  - category header rows, then Item · Size · Opening · Inward · Sales · Other · Closing;
  - a "Hide items with no movement" toggle (on by default);
  - the column totals sit under each category.
- **Payments:**
  - the revenue card (Cash / UPI / Waiter credit = Total sales);
  - the normal / peak split;
  - the waiter ledger card;
  - the "Received" card;
  - a per-day table below.
- **Export (D6):**
  - **CSV:** downloads the current tab for the range. Amounts are written as rupees with two decimals, from integer
    paise; no float is ever made.
  - **Print:** a print stylesheet prints the current tab with the range in the header.

## 3. Tests

**Backend** (`test/reports.test.ts`, real PostgreSQL like the other suites). Two closed days and one open day, with:
- normal Cash / UPI / split bills;
- a peak session with a variance;
- a waiter credit bill repaid in cash the next day;
- a reversal, restocked and not restocked;
- a tally adjustment;
- a GRN for liquor and one for cigarettes, and a Kitchen supply purchase;
- expenses in a legacy category, a managed category and a voided one;
- a bank deposit;
- an item created with opening stock while no day was open.

Asserted:
- **Payments:** totals = Σ `getDayEndSummary` for each day; revenue cash + UPI + credit = total sales; credit given
  over a closed range = repayments.
- **Ledger:** Σ sales by center = payments total (closed days); liquor vs cigarette GRN is split by the brand's center;
  the expense void nets out; the legacy category resolves; the bank deposit appears only under contra.
- **Sales register:** chronological; the reversal is its own row; the empty bill is listed; OPEN tabs are left out;
  net = the ledger total.
- **Stock register:**
  - the arithmetic holds on every row;
  - the opening for day 2 = the closing for day 1;
  - the closing to today = `sku_stock`;
  - the un-restocked reversal leaves stock unchanged;
  - the NULL-day opening is dated to the next day;
  - Kitchen items don't appear.
- **Validation:** a bad date, `start > end` and a span of more than 366 days return 400; an empty range (no trading
  days) returns zeros, not an error.
- **Upgrade safety:** no migration, so nothing to back-fill. The existing suites must stay green.

**Frontend:**
- the preset math (`dateRange.test.ts`, with a fixed business date, across month and year ends);
- the tab model;
- CSV formatting (paise → `"84230.00"`, negatives, quoting item names that contain commas);
- the stock "no movement" filter;
- the sales register search.

**Verification:** `npx vitest run` and `npx tsc --noEmit` (backend and frontend), then headless Chrome:
1. Open Settings → Reports and check each preset.
2. Check that the ledger totals match Day End for today.
3. Check that the stock closing matches the catalog's on-hand count.
4. Export a CSV from each tab.

## 4. Out of scope

- **No net P&L / profit figure** (requested).
- **F.Ac.2 and member-wise registers:** the member assignment step in CLAUDE.md (`autoAssignBills`) isn't part of
  this phase.
- **Tally XML / direct import:** these are figures for manual entry.
- **Cases + loose display in the stock register:** bottles only for now.
- **Supplier-wise purchase ledger.**
- **Waiter-wise collection report:** the Waiter Ledger screen covers this.
- **Charts.**
- **Stock valuation:** no cost layers exist.

## 5. Decisions for approval

- **D1 — What a date means. Recommended: the business (trading) date, not the clock.**
  - A bill rung at 1:30 am belongs to the evening it was sold in, which is how Day End and the Z report already count
    it.
  - The presets count from the current business date: the open day, else the latest closed one. "Today" at 1 am
    therefore still means tonight's trading day.
  - *Alternative:* calendar timestamps. After-midnight sales would split across two dates, and no range would match
    the Z reports.
- **D2 — The open day. Recommended: include it, marked provisional.**
  - Bills still OPEN are left out of the register.
  - Tenders Day End can't split yet (a running peak, part-paid tabs) show as "Unallocated" under Sales Accounts.
  - *Alternative:* closed days only, so figures never change after you see them, but "Today" would always be empty.
- **D3 — Payment bifurcation. Recommended: three tenders that add up to sales, plus a waiter ledger card.**
  - The tenders are Cash, UPI and **Waiter credit** (sales settled "collect later" through the waiter ledger), and
    they total sales.
  - Under them, the waiter ledger card shows credit given, repaid in cash and repaid in UPI.
  - "Received" adds the repayments to cash and UPI, which is what reached the drawer and the bank.
  - Peak bills split into cash and UPI from the peak readings, exactly as Day End does (variance in cash).
  - Because Day End can't close with a waiter balance, over closed days credit given = repaid.
- **D4 — Stock columns. Recommended:** Opening · Inward (GRN) · Sales (net of restocked returns) · **Other** (new-item
  opening counts and adjustments) · Closing, for every stock-tracked center, not only liquor.
  - The "Other" column keeps every row's arithmetic exact. Without it, an item added mid-month would show closing ≠
    opening + in − out.
  - An opening count entered between days is dated to the next trading day.
- **D5 — Bank deposits. Recommended: show them as one "Contra" line** under the ledger, since Tally needs that cash →
  bank entry. They are never mixed into expenses. *Alternative:* leave them out, as the brief lists only Sales /
  Purchase / Expense.
- **D6 — Export. Recommended: CSV and Print on every tab.** You'd be copying figures into Tally and handing stock and
  sales registers to the excise office; both need the data off the screen. *Alternative:* on-screen only.
