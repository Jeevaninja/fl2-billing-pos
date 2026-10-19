# Phase 24 — Master Reporting Suite & FL2 Statutory Reports — Component Plan

Status: **IMPLEMENTED (2026-10-19) with Revision 1 (Tamil Nadu FL2 statutory format), which overrides §1.1, §1.4 and
D2/D3 where they differ.** D1 is unchanged: member sales come from real tags only. There is no `autoAssignBills` and
no synthesized entry / exit times.

**As built, differences from this plan:**
- **Snapshot test:** PGlite is single-connection, so §3's "bill settled on a second connection" test isn't possible. The
  snapshot is the transaction mode; every cross-module total is still asserted.
- **Cash book:** expenses paid inside a still-running peak window are shown as a separate "not yet counted" note. They
  aren't in the identity, which is Day End's.
- **A negative overnight gap** (the next float is higher than the previous count) prints as "Cash added between days".
- **Schema guard:** `test/inventory-and-schema.test.ts` now allows exactly one ml column, `skus.volume_ml` (integer).
- **Item names:** Sales Summary rows use the current catalog name; the Order Summary keeps each bill line's snapshot
  name.

## Revision 1 — Tamil Nadu FL2 statutory upgrades (approved)

### R1. Stock register columns (replaces the §1.4 / D3 columns)

`Item Name | Op.Stk | Purch | Total | Sale | Closing | P.Rate | SRate | Clo.Purch Val | Clo.Sales Val | Sales Total`

- **Op.Stk:** stock before the start date, plus the opening counts of items created inside the range. This is the
  item's opening stock.
- **Purch:** GRN receipts. **Total** = Op.Stk + Purch.
- **Sale:** bottles out of stock, net of restocked returns. A void that isn't restocked (a broken bottle) stays out.
- **Adj. (conditional):** an extra column, shown only when some row in the range has a signed `ADJUSTMENT` movement.
  No screen posts these today. **Closing** = Total − Sale (+ Adj.), exact on every row.
- **P.Rate:** the D2 rate as of the end date: last non-zero GRN cost, else the catalog purchase price, else "—".
- **SRate:** the SKU's current selling price.
- **Clo.Purch Val** = Closing × P.Rate. **Clo.Sales Val** = Closing × SRate. **Sales Total** = Sale × SRate.

  All three are integer paise, as the format defines them. Actual billed takings are the Sales Summary's amounts.
- **Totals:** a total per category group (FULL, HALF, QUARTER, BEER, …, in item-category report order), and a grand
  total.

### R2. ML / Unit Details (bottom of the Stock and the Sales tabs)

- **Migration `0017_sku_volume`** adds two columns to `skus`:
  - `volume_ml integer` (`> 0`, NULL for non-bottle items);
  - `excise_group text`: one of `LIQUOR`, `BEER`, `TIN_BEER`, `WINE`, or NULL for non-liquor centers.
- **These are fixed labels on a sealed SKU, not ml tracking.** Stock stays whole bottles, so there is no peg or
  open-bottle tracking (CLAUDE.md).
- **Back-fill and new-SKU defaults** come from the structured size code, not from display names:

  | Size code | Volume |
  |---|---|
  | FULL | 750 |
  | HALF | 375 |
  | QUARTER | 180 |
  | BEER_650 | 650 |
  | BEER_330 | 330 |
  | UNIT | NULL |

- **Excise group default (liquor-center items only):**
  - BEER_650 → BEER;
  - BEER_330 → TIN_BEER;
  - otherwise WINE when the item category or brand is wine;
  - else LIQUOR.
- **Both columns can be edited** on the catalog item, for example for a 500 ml tin or a 1000 ml bottle.
- **The summary:**
  - grouped by excise group (LIQUOR, BEER, TIN BEER, WINE), one line per bottle volume, with group and grand totals;
  - columns: Sale units, Sale ML, Closing units, Closing ML;
  - volume is integer ml, with litres shown alongside;
  - figures come from the stock ledger (the same Sale and Closing as R1), so the two tabs show identical figures.

### R3. Sales Summary is aggregated per SKU

- **One row per SKU:** `Item | Qty | SRate | Amount`, for example "Old Monk Full | 10 | ₹1,800 | ₹18,000".
- **No bill lines are listed.** Voids and cancels are netted in.
- **SRate** is the billed unit price. If the price changed inside the range, the cell shows "Mixed" and Amount is
  still the exact billed total.
- **Grouping:** by revenue center, then item category.
- **Bill-wise detail** lives only in the Order Summary tab.

Goal: grow Settings → Reports from four tabs into eight auditor-ready modules. All of them are driven by one date
range, and every one has CSV and Print. **There is no net-profit or gross-profit figure anywhere**, only grouped ledger
totals.

## 0. What exists, and what each module reuses

Phase 23 (`ReportService`, `ReportsScreen`) already provides:
- the business-date range and its presets;
- the provisional flag for the open day;
- the ledger (sales, purchases and expenses by center, plus contra);
- the bill-wise sales register;
- the stock register (opening / inward / sales / other / closing);
- the payment split, taken from Day End's own `getDayFigures`.

Phase 24 builds on those rules. It doesn't re-derive them a second way.

| # | Module | Built from | New work |
|---|---|---|---|
| 1 | Sales Summary | `bill_items` (center snapshot) | by-SKU and by-center grouping; member-wise sub-report |
| 2 | Order Summary | Phase 23 sales register | cashier, peak session #, KOT numbers, VOID / CANCEL tags |
| 3 | Stock Summary | Phase 23 stock register | outward split, rate, closing (and opening) valuation |
| 4 | Expenses Summary | `cash_expenses` + `expense_categories` | itemised entries under each category, center filter |
| 5 | Purchase Summary | `stock_receipts` + `revenue_center_purchases` | invoice-level ledger, separated by center |
| 6 | Bank Deposits | `bank_deposits` | chronological log, voids shown |
| 7 | Day End & Variance | `business_days` + `getDayFigures` + `peak_sessions` | one row per day, peak variances |
| 8 | Full Report | modules 1, 3–7 | cash book (opening → closing), stock valuation |

What the data **does not** hold, so Phase 24 can't report it (see D1, D3):
- **Member entry and exit times.** `members` holds only the membership number and name, and nothing records a visit.
  No scanner integration exists.
- **Breakage.** No screen posts `ADJUSTMENT` stock movements, so breakage is never recorded today.

## 1. Backend — `ReportService` additions (`src/services/report.service.ts`, split into `src/services/reports/*`)

The service already has 545 lines and would roughly triple, so it splits into one file per module:
- `reports/range.ts`: `checkRange` and the day lookup, unchanged;
- one file per report;
- `report.service.ts`, which stays as the façade the routes call.

Every method takes `{ startDate, endDate, center? }` and returns the Phase 23 header (`range`, `days`,
`provisional`).

**Consistency (D6):** each report runs in **one `READ ONLY` `REPEATABLE READ` transaction**. Every table is then read
from the same snapshot, so a bill settled mid-report can't appear in the totals but not in the rows. The transaction
takes no locks that block billing.

**Speed:** every query starts from the range's `business_day_id`s, which are already indexed on each table:
- `bills_day_status_idx`, `stock_movements_day_idx`, `bank_deposits_day_idx`, `stock_receipts_day_idx`;
- `cash_expenses` and center purchases are indexed by day too.

No new indexes are added unless `EXPLAIN` on a seeded year of data shows a sequential scan on bills or bill items.

### 1.1 `getSalesSummary(range)`

```ts
interface SalesSummary extends ReportHeader {
  byCenter: Array<{ code; name; qty; salesPaise }>;
  bySku: Array<{ skuId; skuCode; name; sizeLabel; categoryName; centerCode; qty; salesPaise }>;  // net of voids / cancels
  totalPaise;                          // = Σ byCenter = Σ bySku = Order Summary net (asserted)
}
```

The bill-inclusion rule is the Phase 23 register's:
- SETTLED and PEAK bills are included, and so are reversals, as negatives;
- OPEN tabs are left out.

### 1.2 `getMemberSales(range)` (D1)

```ts
interface MemberSales extends ReportHeader {
  members: Array<{
    memberId; membershipNo; name;
    visits: Array<{                    // one per business date the member was billed
      businessDate; firstBillAt; lastBillAt; billNos: number[];
      items: Array<{ name; sizeLabel; qty }>; totalPaise;
    }>;
    totalQty; totalPaise;
  }>;
  untagged: { billCount; qty; totalPaise };   // bills with no member: shown as its own line, never hidden or spread
  totalPaise;                                 // Σ members + untagged = Sales Summary total (asserted)
}
```

### 1.3 `getOrderSummary(range)`

This is the Phase 23 `SalesRegisterRow` with four additions:
- `cashierName`: the bill's `created_by` staff member, or the waiter's name for Captain bills;
- `settledByName`;
- `peakSessionNo`: `#1`, `#2`, … for peak bills;
- `kots`: for example `["BAR 12", "KITCHEN 12/2"]`, from `kot_tickets`.

Tags:
- `VOID of #n` on reversal bills, as today;
- `CANCEL` when the bill had lines cancelled before settlement (negative `bill_items`), showing the cancelled
  quantity.

### 1.4 `getStockSummary(range)` (D2, D3)

Phase 23's opening and closing math is unchanged (effective business date, NULL-day openings dated forward). The rows
change as follows:

```ts
interface StockSummaryRow {
  ...identity; categoryName;           // grouped by item category (FULL, HALF, QUARTER, BEER, … in report order)
  openingQty; inwardQty;
  outwardSalesQty;                     // −(SALE + SALE_REVERSAL)
  adjustmentQty;                       // ADJUSTMENT (breakage / write-off, signed); 0 until an adjustment screen exists
  openingCountQty;                     // OPENING movements in range (new items)
  closingQty;
  ratePaise: number | null;            // D2 valuation rate as of endDate
  rateSource: 'GRN' | 'CATALOG' | null;
  closingValuePaise: number | null;    // closingQty × rate (integer); null when unrated
  openingValuePaise: number | null;    // openingQty × rate as of the day before startDate
}
// + per-category and grand totals; unratedCount with their qty (valuation total excludes them, and says so)
```

### 1.5 `getExpenseSummary(range, center?)`

`center` takes one of three values:
- `undefined`: all expenses;
- a center code: that center's categories;
- `'SHARED'`: the categories mapped to no center.

```ts
interface ExpenseSummary extends ReportHeader {
  byCategory: Array<{ categoryId; name; centerName | null; amountPaise; count;
                      entries: Array<{ businessDate; at; description; amountPaise; voided: boolean; byName }> }>;
  byCenter: Array<{ code | 'SHARED'; name; amountPaise }>;
  totalPaise;                          // unfiltered total = Full Report expenses = Phase 23 ledger (asserted)
}
```

A voided entry and its void both appear in the itemised list (struck through) and net to ₹0 in the totals. The
legacy-category rule is Phase 23's.

### 1.6 `getPurchaseSummary(range, center?)`

```ts
interface PurchaseSummary extends ReportHeader {
  centers: Array<{
    code; name;
    grn: Array<{ businessDate; invoiceNo; vendorName; lines: Array<{ name; sizeLabel; qty; unitCostPaise }>; amountPaise }>;
    supplies: Array<{ businessDate; vendorName; paidFrom: 'DRAWER' | 'OUTSIDE'; note; lines: Array<{ description; quantity; amountPaise }>;
                      amountPaise; voided }>;
    grnPaise; suppliesPaise; totalPaise;
  }>;
  totalPaise;                          // = Phase 23 ledger purchases total (asserted)
}
```

- **Liquor GRNs** fall under the Liquor center.
- **Raw-material and ancillary purchases** each fall under their own center.
- **A GRN invoice** is split across centers by line, using the brand's current center, which is the Phase 23 rule.

### 1.7 `getBankDeposits(range)`

```ts
rows: Array<{ businessDate; at; amountPaise; reference | null; depositorName; voidOf: string | null }>;
totalPaise;                            // net of voids = ledger contra (asserted)
```

"Depositor" is the staff member who recorded the deposit at the till. The system doesn't store who carried the cash
to the bank.

### 1.8 `getDayEndLog(range)`

```ts
rows: Array<{
  businessDate; status: 'OPEN' | 'CLOSED';
  openingFloatPaise; expectedCashPaise; countedCashPaise | null; variancePaise | null;  // stored close-time figures
  peakVariancePaise;                   // Σ that day's peak session variances (already inside expected cash)
  cashSalesPaise; upiPaise; waiterCreditPaise; totalSalesPaise;   // getDayFigures, so it equals the Z report
  closedAt | null; closedByName | null; closedByRole | null;
}>;
totals: { expected; counted; variance (short / over); upi; sales };
```

### 1.9 `getFullReport(range)` (D4)

```ts
interface FullReport extends ReportHeader {
  cash: {
    openingBalancePaise;               // first day's opening float
    cashSalesPaise;                    // cash tenders incl. peak cash (Day End split) and tally adjustments
    waiterCashRepaidPaise;
    cashExpensesPaise; drawerPurchasesPaise; bankDepositsPaise;   // out
    variancePaise;                     // Σ close variances (short is negative)
    betweenDaysPaise;                  // Σ (day d counted − day d+1 opening float): cash taken out (or added) overnight
    closingBalancePaise;               // last closed day's counted cash; the open day's expected cash (provisional)
  };                                   // opening + in − out + variance − between = closing (asserted, to the paisa)
  sales:      { byCenter; unallocatedPaise; totalPaise };
  payments:   { cashPaise; upiPaise; waiterCreditPaise };       // how sales were paid (from Phase 23 payments)
  expenses:   { byCenter /* + Shared */; totalPaise };
  purchases:  { byCenter; totalPaise };
  bankDepositsPaise;
  stock:      { openingValuePaise; closingValuePaise; unratedCount };
}
```

Any difference between a closed day's stored expected cash and the recomputed flows gets its own **"Unreconciled
(stored Day End)"** line. This can only happen for a day closed before a later migration changed the formula. The
report never forces the identity to balance silently.

### 1.10 Routes (`server/app.ts`)

The new routes are all `GET`, take `startDate`, `endDate` and an optional `center`, and send money as paise strings,
the same as Phase 23:
- `/api/reports/sales-summary`
- `/api/reports/member-sales`
- `/api/reports/orders`
- `/api/reports/stock-summary`
- `/api/reports/expenses`
- `/api/reports/purchases`
- `/api/reports/bank-deposits`
- `/api/reports/day-end`
- `/api/reports/full`

The Phase 23 routes stay, so nothing that calls them breaks.

## 2. Reports screen (Settings → Reports)

```
 REPORTS                                                                         [ Esc  Back ]
 [Today] [Yesterday] [Last 7 days] [This month] [Last month] [Custom 01-10-2026 → 19-10-2026]
 19 days · 18 closed · 1 open (provisional)                                    [ CSV ] [ Print ]
 [1 Sales] [2 Orders] [3 Stock] [4 Expenses] [5 Purchases] [6 Bank] [7 Day End] [8 Full Report]
```

- **Range and tabs:**
  - one range drives all eight tabs: switching tabs keeps it, and each tab fetches lazily and caches per range;
  - the tabs are reached with `1`–`8` or `←/→`;
  - the provisional banner and range presets are unchanged.
- **The four Phase 23 tabs are folded in (D5):**
  - Ledger becomes the Full Report;
  - Sales register becomes Orders;
  - Stock register becomes Stock;
  - Payments' card goes into the Full Report, and its per-day table goes into Day End.
- **Sales:**
  - a center chip row, then the SKU table grouped by center and category;
  - a segmented toggle, `By item | Member-wise`;
  - Member-wise shows each member with collapsible visit rows, then the "Not tagged to a member" line, then the
    total.
- **Stock:**
  - category header rows;
  - the columns Opening · Inward · Sales · Adj. · New · Closing · Rate · Value;
  - an unrated rate shows as "—" with a footer count;
  - the "hide no movement" toggle is kept.
- **Expenses and Purchases:** a center filter (`All · Liquor · Kitchen · … · Shared`), category or center groups that
  expand to entries, and a total per group.
- **Day End:** variance is red when short, green when over; the totals row is pinned.
- **Full Report:** a single printable page:
  - the Cash Book (the opening → closing ladder);
  - Sales, Expenses and Purchases by center in three columns;
  - Payments;
  - Bank deposits;
  - Stock valuation.

**Export (D7):**
- **CSV:** every tab, written from integer paise to `"1234.50"`.
- **CSV for nested tabs** (Members, Expenses, Purchases): one flat row per entry, carrying its group columns, so a
  spreadsheet can pivot it.
- **CSV for the Full Report:** a two-column `Head, Amount` sheet.
- **Print:**
  - a print stylesheet per tab, giving the report title, the range, "Printed at …", and a provisional watermark when
    the open day is included;
  - category groups don't split across pages;
  - the footer has "Prepared by / Checked by / Manager" signature lines.

## 3. Tests

**Backend** (real PostgreSQL, `test/services/reports-suite.test.ts`). The Phase 23 fixture (two closed days and one
open day) is extended with:
- a member billed on two days and a walk-in bill;
- a cancelled line;
- KOTs;
- two GRNs at different costs, so the rate is the last non-zero one;
- a ₹0 scheme line;
- a SKU with only a catalog price, and an unrated SKU;
- a center-filtered expense;
- a voided deposit;
- a day whose float differs from the previous day's count.

Asserted:
- **Sales:** Σ bySku = Σ byCenter = Order Summary net = ledger sales (closed days); member totals + untagged = total.
- **Orders:** the cashier, peak session #, KOT labels and CANCEL / VOID tags are correct; the rows are in date order.
- **Stock:**
  - row arithmetic;
  - the valuation rate as of the date: a GRN after `endDate` is ignored, and ₹0 scheme lines are skipped;
  - integer value;
  - unrated SKUs are excluded and counted;
  - the opening value of day 2 equals the closing value of day 1 (same rate).
- **Expenses:** the unfiltered total equals the ledger; the per-center filters add up to the unfiltered total; a
  void nets to 0.
- **Purchases:** the center totals equal the ledger; a mixed-center GRN is split by line.
- **Bank deposits:** the total equals the ledger contra.
- **Day End:** each row equals `getDayEndSummary` for that day.
- **Full Report:** the cash identity holds to the paisa over 1, 2 and 3-day ranges, including the between-days line;
  the sections equal their modules.
- **Snapshot:** a bill settled on a second connection mid-report doesn't split the report.
- **Validation and empty ranges:** the same as Phase 23.

**Frontend:**
- CSV flattening for each module;
- the tab model with 8 tabs;
- member and expense grouping helpers;
- the valuation footer text.

**Verification:**
1. Run `npx vitest run` and `npx tsc --noEmit` on the backend and the frontend.
2. In Chrome, open each tab on seeded data.
3. Check the Full Report against Day End for one day.
4. Print a preview of the Full Report and the Stock tab.
5. Export a CSV from each tab.

## 4. Out of scope

- **No profit figure** of any kind: no net P&L, and no gross margin (sales − cost of goods).
- **Automatic member assignment (`autoAssignBills`):** see D1.
- **A breakage / stock-adjustment entry screen:** the column exists, but recording breakage is a separate phase.
- **Excise-format forms** (F.Ac.2 layout, Form-specific registers): these need the exact statutory layout first.
- **Tally XML export.**
- **Charts.**

## 5. Decisions for approval

- **D1 — Member-wise sales: real tags only.**
  - **Recommended:**
    - the report lists the bills the cashier actually tagged to a member (F2);
    - every untagged bill sits on its own "Not tagged to a member" line;
    - instead of entry / exit times it shows **first bill and last bill time per visit**, labelled exactly that.
  - **Not built:**
    - **synthesized entry / exit times;**
    - **the CLAUDE.md `autoAssignBills` step**, which randomly attaches walk-in bills to members.

    This register is meant for excise officers. Writing members' names against purchases they didn't make, or
    inventing their visit times, would make it a false statutory record.
  - **If every sale has to be a member's:** that is enforced at the counter, for example an optional "tag a member?"
    nudge at F9 (no hard KYC gate, per CLAUDE.md).
  - **If the club has a gate scanner:** a later phase can record real check-in / check-out scans and add true
    entry / exit columns.
- **D2 — Stock valuation rate.**
  - **Recommended:** the **last non-zero GRN unit cost on or before the date**. Failing that, the catalog purchase
    price. Failing that, the item is **unrated**: shown as "—", left out of the total and counted.
  - This rate is historical (a later price change doesn't revalue an old closing), deterministic and integer.
  - *Alternatives:* weighted-average cost, which adds rounding and needs a rule for it; or the catalog purchase price
    only, which is current rather than historical, so old reports would change.
- **D3 — Outward column.**
  - **Recommended:** split Phase 23's "Other" into **Sales**, **Adj.** (breakage / write-off, signed) and **New**
    (opening counts for items added mid-range), so every row's arithmetic stays exact.
  - Adj. will read 0 until a breakage screen exists.
- **D4 — Cash book and the overnight gap.** Each day opens with a float typed at Day Open, not with the previous
  count.
  - **Recommended:** a **"Cash taken out between days"** line (count − next float), so that opening + in − out ±
    variance − between = closing, exact to the paisa.
  - *Alternative:* show the Full Report only per single day, which loses the range view.
- **D5 — Tabs.**
  - **Recommended:** the 8 requested tabs replace the 4 Phase 23 tabs, which fold in as described in §2.
  - *Alternative:* keep Ledger and Payments as tabs 9 and 0.
- **D6 — Accuracy and speed.**
  - **Recommended:** one read-only repeatable-read snapshot per report, queries keyed by business-day ids, and
    cross-module totals asserted in tests.
  - No caching tables and no new indexes unless `EXPLAIN` shows the need.
- **D7 — Export.**
  - **Recommended:** CSV and Print on all 8 tabs as in §2.
  - Print uses the browser's Save-as-PDF, so no PDF library is added.
