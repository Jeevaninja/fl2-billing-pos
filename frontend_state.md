# FL2 POS — Frontend State Reference

As of Phase 11 on `main` (Phase 3 dashboard, Phase 4 billing screen, Phase 6 Captain Orders, Phase 7 Day End, Phase 8 Expenses and peak controls, Phase 9 Purchase / GRN, Phase 10 Inventory Catalog and case-based GRN, Phase 11 peak start baseline and Day End sales breakdown, Phase 12 Enter → qty → pay, payment arrow keys and server-side peak undo; plan `docs/ui/phase12-billing-speed-plan.md`, Phase 13 peak end live split, Day End tally adjustments and Day End ⇄ Expenses; plan `docs/ui/phase13-peak-close-tally-plan.md`, Phase 14 bank deposits; plan `docs/ui/phase14-bank-deposits-plan.md`, Phase 15 multi-tab billing and the waiter sidebar; plan `docs/ui/phase15-billing-tabs-waiter-sidebar-plan.md`, Phase 16 Waiter Ledger (replaces the Captain Orders queue) and the strict Day End waiter-balance blocker; plan `docs/ui/phase16-waiter-ledger-plan.md`, Phase 17 Orders screen, the header Settings menu and Jump to bill; plan `docs/ui/phase17-orders-plan.md`, Phase 18 custom expense categories (Settings screen + Expense picker); plan `docs/ui/phase18-expense-categories-plan.md`, Phase 19 departments: catalog / expense-category departments, Kitchen KOTs (F6) and the Day End department split; plan `docs/ui/phase19-departments-plan.md`, Phase 20 item categories (Settings screen) and the flat, category-grouped Inventory Catalog; plan `docs/ui/phase20-item-categories-plan.md`, Phase 21 universal type-to-search billing, the Kitchen Kiosk (Kitchen P&L, kitchen purchases) and the 5 × 2 dashboard; plan `docs/ui/phase21-kitchen-kiosk-plan.md`, Phase 22 Revenue Centers (tabs per center, Settings → Revenue Centers, live center lists everywhere); plan `docs/ui/phase22-revenue-centers-plan.md`, Phase 23 Settings → Reports (ledger balances, sales / stock registers, payments; CSV and print); plan `docs/ui/phase23-reports-plan.md`, Phase 24 the eight-tab reporting suite (Sales + member-wise, Orders, TN FL2 Stock with ML summary, Expenses, Purchases, Bank deposits, Day End, Full Report) and catalog bottle ml / excise group; plan `docs/ui/phase24-reporting-suite-plan.md`). Upcoming phases (not built): `docs/roadmap.md`. Backend contract: `backend_state.md`. Billing screen design: `docs/ui/phase4-billing-screen-plan.md`.

- **Stack:** Vite 8, React 19, TypeScript, Tailwind CSS 4 (`@tailwindcss/vite`), Lucide icons, Vitest. No router, no state library.
- **Run:** `npm run api:dev` at the repo root (API on `127.0.0.1:4310`), then `npm run dev` in `frontend/` (http://localhost:5173). Vite proxies `/api` to the API.
- **Check:** `npm test` (Vitest, 237 tests), `npx tsc -b`, `npx oxlint src`, `npm run build`.
- **Money:** `bigint` paise end to end. The API client decodes every `…Paise` JSON string to `bigint` and encodes `bigint` back to strings. Display goes through `formatPaise`; cashier input goes through `parseRupeesToPaise`. No floats.
- **Server is the source of truth:** bills enter screen state only as `BillDetail` responses, so the UI never adds up prices to get a total.

---

## 1. Component tree

```
main.tsx                      StrictMode → <App/>, imports index.css (Tailwind)
└─ App                        view: 'dashboard' | 'billing' | 'captain-orders' | 'day-end' | 'expenses' | 'bank-deposits' | 'purchase' | 'catalog' | 'orders' | 'expense-categories'; holds the Recently Used list and the one-shot Jump-to-bill targets (billingFocus, ledgerFocus)
   ├─ Dashboard               module tiles + Recently Used rail + key legend footer
   │  ├─ header               Start peak (F8) button when a day is open and no peak runs; Settings gear menu (Phase 17): Inventory Catalog, Item Categories (Phase 20), Expense Categories (Phase 18)
   │  ├─ PeakBanner           amber "PEAK #n running · since · expected drawer total" strip with End peak session (F8)
   │  ├─ day banner           "No business day is open" strip → Day End (context polled 15 s)
   │  ├─ ModuleTile ×8        4 × 2 grid (2 × 4 narrow), equal tiles (Phase 14). Billing, Waiter Ledger (live "n open" Captain-order badge,
   │  │                       polled 15 s), Expense (live), Bank Deposit (→ BankDepositScreen), Purchase (→ PurchaseScreen), Orders (→ OrdersScreen; Phase 17, in Inventory Catalog's old slot — Catalog moved to the header Settings menu),
   │  │                       Day End (reads "Open Day" and becomes the primary tile when no day is open), Reports
   │  ├─ RailButton ×≤6       most-recently-used actions
   │  └─ LiveClock, Kbd       (components/ui.tsx)
   └─ BillingScreen           useReducer(billingReducer); serial write queue; all API calls
      ├─ header               ModeBadge (NORMAL / PEAK #n), bill no, cashier, day, LiveClock
      ├─ PeakBanner           while a session runs (PEAK mode, or NORMAL finishing a pre-peak bill); F8 ends it
      ├─ CenterNote           LOADING / OFFLINE (retry) / BLOCKED (no open business day)
      ├─ main (left pane)
      │  ├─ BillTabs          Phase 15, Chrome-style held bills: "Bill n · #billNo · waiter code · total", × per tab, + (F3);
      │  │                    shown in NORMAL, and in PEAK while more than one tab exists
      │  ├─ ScanBar           scan buffer display, qty-prefix chip, FlashLine (ok / error)
      │  ├─ ItemsGrid         NORMAL: rows grouped by SKU+price, pending "adding…" rows, Phase 19 KITCHEN chip with
      │  │                    "KOT pending n" / "Cancel pending n" / "KOT ✓" on Kitchen lines,
      │  │                    EmptyBill (hint or last-settled receipt with change)
      │  ├─ PeakTicker        PEAK: this visit's scans newest first, undone rows struck out
      │  └─ GridFooter        key legend for the current mode
      ├─ aside (right pane)
      │  ├─ SidePanel         NORMAL: Card(Member F2), Card(Waiter F4, TrustBadge), totals, Send KOT to kitchen (F6; Phase 19,
      │  │                    only while Kitchen lines are pending), Start peak (F8), Pay F9
      │  └─ PeakSide          PEAK: session card, expected drawer total, Undo last scan (Ctrl+Z)
      └─ dialogs (one at a time, all built on Modal)
         ├─ PaymentDialog     option radios C/U/S/P/L, rupee input, change / split / credit preview
         ├─ MemberDialog      Picker: debounced member search; Enter on empty = walk-in
         ├─ WaiterSidebar     Phase 15 (F4 / Waiter card): right-hand slide-in Modal with today's figures per waiter
         │                    (GET /api/waiters/stats): open · Σ due, closed · Σ settled, credit owed / limit, "On this bill",
         │                    bill-on-bill / credit-limit notes, footer totals; filter + ↑/↓ + Enter tags the current tab
         └─ abandon confirm   Modal: cancel every line, then close the ₹0 bill (and the tab, when opened from its ×)
   └─ WaiterLedgerScreen      Phase 16 (the 'captain-orders' view): useReducer(waiterLedgerReducer); polls GET /api/waiter-ledger
      │                       + the selected waiter's GET /api/waiter-ledger/:id every 5 s (paused in dialogs)
      ├─ header               "n owe ₹X" / ALL SETTLED, updated-ago / OFFLINE pill, Refresh (R), LiveClock
      ├─ WaiterList (left)    code, name, TrustBadge, "n open", Owed (billed) · Paid · Balance; a new Captain order tints the row + beep
      ├─ main (right)         waiter strip (Billed · Paid · Balance), FlashLine
      │  ├─ OpenBills         checkbox rows (#bill, counter / handset, member, part-paid, bottles, age, due), tick-all header
      │  ├─ bill lines        ItemsGrid of the highlighted bill + member button (F2), Remove one (−) / Broken (X)
      │  └─ aside             Settle selected / Settle bill (F9), Receive payment (F7, trusted) or bill-on-bill note, credit note,
      │                       Today's payments (receipts with their allocation lines)
      └─ dialogs              SettleDialog (C / U / L for trusted, Enter), ReceiveDialog (RupeeField, C / U, live allocation preview), MemberDialog
   └─ OrdersScreen            Phase 17: GET /api/orders (+ /api/context for the till's cashier) polled 10 s; GET /api/orders/:id for the selected bill
      ├─ filter bar           chips All (A) · Open (O) · Settled (S) · Peak (P) · Voided (V) with counts, waiter filter (W → WaiterMenu),
      │                       typed bill number (#57 + Enter), FlashLine
      ├─ OrderList (left)     newest first: bill no, time, who, bottles, total (due for part-paid open bills), status chip; in All / Settled
      │                       each peak session is one row (⚡ Peak #n · bills · voided) that expands with Enter / → / click
      ├─ BillPanel (right)    bill header + status, itemised lines (cancellation lines struck through, broken = not restocked), totals,
      │                       Settlement sentences, Reprint (F8), Jump to bill / Open in Waiter Ledger (F9 / Enter, open bills only)
      ├─ PeakGroupPanel       a selected session row: time span, bills, bottles, total, voided scans, show / hide its bills
      └─ dialogs              WaiterMenu, reprint preview (Modal with the exact receipt text)
   └─ DayEndScreen            useReducer(dayEndReducer); GET /api/day-end polled 10 s (paused in dialogs / once locked)
      ├─ header               day + opened time, BLOCKED (n) / READY TO CLOSE / LOCKED / NO DAY OPEN badge
      ├─ Checklist (left)     Phase 16 first row: "Waiters owe ₹X — All waiter balances must be settled to ₹0 before closing."
      │                       (open-bill / credit split, → Waiter Ledger); open bills (→ Billing, or Waiter Ledger for waiter bills),
      │                       running peak (End peak…), collect-later credit (Repayment…); ended peak sessions with their variance
      ├─ CashCount (right)    breakdown (float, normal cash, peak cash, waiter cash, −expenses, −bank deposits, ±tally adjustments,
      │                       EXPECTED, UPI info), "Add expense" (F6 → Expenses) and "Add bank deposit" (→ Bank deposits); Esc on
      │                       either returns with the count kept, counted-cash
      │                       RupeeField, live variance (short / over / exact), Confirm & Lock Day (F9)
      ├─ ClosedDayCard        frozen figures once locked
      ├─ OpenDayPanel         opening float + Enter → POST /api/days (after a lock, or when no day exists)
      └─ dialogs (Modal)      ConfirmLock (Enter), RepayDialog (amount, C/U), PeakEndDialog (shared),
                              TallyDialog (F7: UPI → Cash / Cash → UPI, amount, required reason, live after-figures), void-adjustment confirm
   └─ ExpenseScreen           useReducer(expenseReducer); GET /api/context + /api/expenses + /api/expense-categories polled 15 s
      ├─ form (left)          Phase 18: category search box (focused; type to filter, ↑/↓, Enter) over the matching category chips
      │                       (first nine in the manager's order show keys 1–9), amount RupeeField (lg), note (required when the
      │                       category says so), "Paid by <till cashier>" (read-only),
      │                       Record expense (Enter); keeps the category for the next entry
      ├─ list (right)         today's expenses newest first: time, category, note, ⚡ = during a peak, amount, Void /
      │                       VOIDED (struck through); header shows today's live total and count
      └─ void confirm         Modal: Enter appends the negating row
   └─ BankDepositScreen       useReducer(bankDepositReducer); GET /api/context + /api/bank-deposits + /api/day-end polled 15 s
      ├─ form (left)          amount RupeeField (lg, focused), "Expected in the drawer now", amber over-drawer warning (not a block),
      │                       reference (optional), "Taken by <till cashier>", Record deposit (Enter); replaced by a notice while a peak runs
      ├─ list (right)         today's deposits newest first: time, reference, amount, Void / VOIDED (struck through); header total and count
      └─ void confirm         Modal: Enter appends the negating row
   └─ PurchaseScreen          useReducer(purchaseReducer); GET /api/context + /api/purchases polled 15 s
      ├─ header               day, "Received by <till cashier>", "Today n receipts · m btl"
      ├─ invoice strip        Invoice no (focused on load) → Enter → Vendor (optional) → Enter → SKU; both turn red on a duplicate
      ├─ Add line (left)      SKU combobox (scan or type; debounced GET /api/skus; ↑/↓ + Enter; results show SizeChip, case size, on-hand),
      │                       picked note "code · Quarter 180ml · case of 64 · n on hand · sells at ₹…",
      │                       Cases → Enter → Loose bottles → Enter (live "= 131 bottles") → Unit cost RupeeField (pre-filled from
      │                       the catalog purchase price, editable; ₹0 = free) → Enter stages the line and refocuses SKU
      ├─ This invoice (right) staged lines (#, SKU + code, size, bottles with "2 cs + 3 · case 64", unit / FREE, line total, × remove;
      │                       click selects, Del removes),
      │                       FlashLine, footer: lines · bottles · invoice total, Post GRN (F9)
      ├─ Today's receipts     time, invoice, vendor, lines · bottles, total cost
      └─ confirm              Modal: vendor, lines ("2 cs + 3 = 131 × ₹180.00"), bottles, total; Enter / F9 posts
   └─ CatalogScreen           useReducer(catalogReducer); GET /api/catalog (debounced on search / "Show inactive"; re-read after a save)
      ├─ header               "n liquors · m sizes"
      ├─ toolbar              search (name, SKU code, barcode; focused on load), Show inactive, FlashLine, + New liquor (Ins)
      ├─ list                 liquor rows (name, category, inactive badge, + Size, Edit) each followed by its sizes (code, Full 750ml …
      │                       + barcode, sale, purchase or —, case, on hand, active / inactive, edit); ↑/↓ selection, click opens the editor
      └─ CatalogFormModal     Modal (Enter / F9 saves, Esc cancels), one of:
                              New liquor: name, code prefix (suggested from the name until edited), category chips, size grid
                                (tick · SKU code preview · sale · purchase · case · barcode; ticking or typing pre-fills the case size)
                              Edit liquor: name, category, active · Add size: missing sizes as chips + price / case / barcode fields
                              Edit size: sale, purchase, case, barcode, active (code and size read-only)
                              Footer shows the live validation hint or the server's refusal; deactivating turns Save into
                              "Deactivate & save" with a warning. A PS012 duplicate keeps the form and outlines the clashing field.

Shared: components/peak/PeakControls.tsx: PeakBanner, StartPeakButton, PeakStartDialog (expected cash / UPI from
        /api/peak/baseline with their terms, then cash + UPI readings with a live short / over / matches hint → start),
        PeakEndDialog (re-reads /api/context on open; closing readings with a live derived peak UPI / cash split and
        variance preview (`peakSplit`, display only) → end → result view: expected, cash/UPI change, actual, variance; Enter closes).
        Each screen gives the end dialog a session snapshot, so it outlives the session to show the result.
        components/RupeeField.tsx: rupee input shared by Day End, Expenses and the peak dialogs.
        components/dayend/SalesBreakdownCard.tsx: Day End sales table (above the cash count on an open day, under the
        closed-day card otherwise). Phase 13: adjusted Normal cash / UPI with "system ₹X" notes, the day's tally
        adjustments (void on an open day) and "Adjust Cash ⇄ UPI…" (F7). Phase 19: a "By department" block
        (Liquor / Kitchen / Ancillary, "On bills still open" when not ₹0, Total = Total sales), info only.
        components/dayend/TallyDialog.tsx: the tally modal (pure helpers in dayend/tallyForm.ts).
```

| File | Exports |
|---|---|
| `App.tsx` | `App` (view switch) |
| `components/Dashboard.tsx` | `Dashboard({ recent, onUse, onOpenBilling })` |
| `components/dashboard/actions.ts` | `ACTIONS`, `MODULE_TILES`, `SETTINGS_ACTIONS` (Phase 17), `DEFAULT_RECENT`, `BILLING_ACTIONS`, `pushRecent`, `runStub`, `PosActionId` |
| `components/ui.tsx` | `Kbd`, `LiveClock` |
| `billing/BillingScreen.tsx` | `BillingScreen({ onExit })` |
| `billing/BillingPanels.tsx` | `ScanBar`, `ItemsGrid`, `GridFooter`, `SidePanel`, `PeakTicker`, `PeakSide`, `SizeChip` |
| `billing/PaymentDialog.tsx` | `PaymentDialog({ detail, busy, onConfirm, onClose })` |
| `billing/PickerDialogs.tsx` | `MemberDialog`, `TrustBadge` (Phase 15: `WaiterDialog` replaced by `WaiterSidebar`) |
| `billing/Modal.tsx` | `Modal({ title, onClose, onKey?, footer?, width?, placement? })` (`placement: 'right'` = slide-in panel) |
| `billing/BillTabs.tsx` | `BillTabs({ tabs, activeTabId, newBlock, onSwitch, onClose, onNew })` |
| `billing/WaiterSidebar.tsx` | `WaiterSidebar({ currentWaiterId, onPick, onClose })` |
| `billing/waiterStats.ts` | `filterWaiters`, `waiterNote`, `sumStats` |
| `components/OrdersScreen.tsx` | `OrdersScreen({ onExit, onJump })` (Phase 17) |
| `orders/ordersView.ts` | `FILTERS`, `filterOrders`, `chipCounts`, `waitersInOrders`, `orderRows`, `peakKey`, `moveKey`, `whoLabel`, `STATUS_LABEL`, `settlementLines`, `jumpTarget`, `findByNumber` |
| `components/WaiterLedgerScreen.tsx` | `WaiterLedgerScreen({ onExit })` (Phase 16; replaces `CaptainOrdersScreen`) |
| `captain/waiterLedgerReducer.ts` | `waiterLedgerReducer`, `initialWaiterLedgerState`, `selectedWaiter`, `openBills`, `cursorBill`, `billsToSettle`, `selectionTotal`, `allocate`, `receiveError`, `editBlock`, `formatAge` |
| `components/DayEndScreen.tsx` | `DayEndScreen({ onExit, onOpenBilling, onOpenCaptainOrders })` |
| `components/ExpenseScreen.tsx` | `ExpenseScreen({ onExit, onOpenDayEnd })` |
| `components/ExpenseCategoriesScreen.tsx` | `ExpenseCategoriesScreen({ onExit })` (Phase 18, Settings) |
| `components/ItemCategoriesScreen.tsx` | `ItemCategoriesScreen({ onExit })` (Phase 20, Settings) |
| `components/RevenueCentersScreen.tsx` | `RevenueCentersScreen({ onExit })` (Phase 22, Revenue Centers tile; the Kitchen Kiosk until Phase 21) |
| `components/RevenueCentersSettingsScreen.tsx` | `RevenueCentersSettingsScreen({ onExit })` (Phase 22, Settings) |
| `components/ReportsScreen.tsx` | `ReportsScreen({ onExit })` (Phase 23, Settings → Reports; the dashboard tile is gone) |
| `components/centers/CenterModal.tsx` | `CenterModal` — add / edit a center, used by both screens above |
| `components/settings/SettingsControls.tsx` | `Toggle`, `IconButton`, `CenterNote` shared by the Settings category screens |
| `settings/expenseCategoryForm.ts` | `NEW_CATEGORY`, `MAX_NAME`, `formFor`, `cleanName`, `categoryFormError`, `categoryPatch`, `visibleCategories`, `quickKeyFor` |
| `components/BankDepositScreen.tsx` | `BankDepositScreen({ onExit, onOpenDayEnd, exitLabel? })` |
| `components/PurchaseScreen.tsx` | `PurchaseScreen({ onExit, onOpenDayEnd })` |
| `components/CatalogScreen.tsx` | `CatalogScreen({ onExit })` |
| `components/peak/PeakControls.tsx` | `PeakBanner`, `StartPeakButton`, `PeakStartDialog`, `PeakEndDialog` |
| `components/RupeeField.tsx` | `RupeeField` |
| `components/dayend/SalesBreakdownCard.tsx` | `SalesBreakdownCard({ sales })` |
| `deposit/bankDepositReducer.ts` | `bankDepositReducer`, `initialBankDepositState`, `MAX_REFERENCE`, `formError`, `formPayload`, `overDrawerWarning`, `todayTotals` |
| `expense/expenseReducer.ts` | `expenseReducer`, `initialExpenseState`, `QUICK_KEYS`, `selectedCategory`, `pickerMatches`, `quickKey`, `categoryForKey`, `formError`, `formPayload`, `todayTotals` |
| `purchase/purchaseReducer.ts` | `purchaseReducer`, `initialPurchaseState`, `MAX_LINE_QTY`, `lineError`, `submitError`, `submitPayload`, `lineTotal`, `stagedTotals`, `pickFromSearch`, `entryCount`, `bottlesFor`, `mergeCounts`, `countLabel` |
| `catalog/catalogReducer.ts` | `catalogReducer`, `initialCatalogState`, `catalogRows`, `suggestPrefix`, `skuCodePreview`, `formError`, `newProductPayload`, `productPatch`, `addSkuPayload`, `skuPatch`, `deactivates`, `conflictField`, `DEFAULT_CASE_SIZE` |
| `billing/billingReducer.ts` (Phase 12) | adds `cancelPlan`; Phase 15 adds `activeTab`, `findTab`, `isEmptyTab`, `newTabBlock`, `MAX_TABS`, `BillTab` |
| `billing/payment.ts` (Phase 12) | adds `moveOption` |
| `peak/peakMath.ts` | `parseReadings`, `describeVariance`, `compareReading`, `describeBaseline`, `peakSplit` (Phase 13) |
| `dayend/tallyForm.ts` | `EMPTY_TALLY`, `MAX_REASON`, `tallyResult`, `describeShift` |
| `dayend/salesRows.ts` | `salesCard` (rows, departments (Phase 19), repayments, warnings) |
| `dayend/dayEndReducer.ts` | `dayEndReducer`, `initialDayEndState`, `initialDayEndStateFrom` (Phase 13 count draft kept by App), `dayEndView`, `blockerCount`, `openCounterBills`, `countedPaise`, `variancePreview`, `lockBlock`, `waiterBalanceBlock` (Phase 16) |

Only the Reports tile still calls `runStub`; every other tile (and F1/F2/F9, which open billing) opens its screen.

**Orders screen** (`orders/ordersView.ts` helpers, pure and unit-tested; Phase 17):
- **Filters:**
  - Settled = SETTLED + CANCELLED + PEAK_RECONCILED.
  - Peak and Voided list every bill individually, so a voided peak scan is always findable.
  - The waiter filter drops peak bills, which never carry a waiter.
- **Rows:** `orderRows` folds peak bills into one row per session in All and Settled, placed where its newest bill
  sits. Group totals skip voided scans.
- **Selection:** derived during render; it falls back to the first row when the selected one isn't shown.
- **`jumpTarget`:** applies to open bills only.
  - This till's counter bills go to Billing with `focusBillId`. After resuming the held tabs, the billing reducer's
    `focusBill` activates that tab and flashes "Bill n · #no — continue billing".
  - Captain-app orders go to the Waiter Ledger with `focus { waiterId, billId }`. The reducer's `pendingFocus` selects
    the waiter, then highlights the bill once its ledger loads.
  - Another till's counter bill is disabled.
- **Keys:** ↑/↓ moves · A / O / S / P / V filter · W waiter · digits + Enter bill number · Enter jumps (or expands a
  peak row) · → / ← expand / collapse · F8 reprint · F9 jump · R refresh · Esc clears typed digits, else back to the
  dashboard.

**Waiter Ledger screen** (`waiterLedgerReducer`, pure and unit-tested; Phase 16):
- **State:** `waiters` (server order), `selectedWaiterId`, `ledger` (that waiter's account), `checked` (ticked bill ids), `cursorBillId` (highlighted bill), `selectedKey` (its line), `focus: 'waiters' | 'bills' | 'lines'`, `seenNewest` / `freshWaiterIds` (new-order detection from `newestOpenAt`; nothing is new on the first load), `lastUpdated`, `dialog: 'settle' | 'receive' | 'member' | null`, `flash`.
- **Actions:** `listLoaded` (a selected waiter who drops out is replaced by the row in its place), `listFailed`, `ledgerLoaded` (dropped if it belongs to a waiter the cashier already left; keeps ticks and the cursor on bills still open, and a settled cursor moves to the bill in its place), `selectWaiter`, `cursor`, `toggleCheck`, `checkAll` (toggles all / none), `clearChecks`, `selectLine`, `move` (by focused pane), `focus`, `cycleFocus`, `dialog`, `flash`.
- **Selectors:** `billsToSettle` gives the ticked bills, or the highlighted bill when none are ticked. `allocate(openBills, credit, amount)` previews the server's lump-sum rule: oldest bill first, part-pay the next, then credit, plus `overPaise`. `receiveError` checks a waiter is picked, then trusted, then owing, then the amount (blank / rupees / > ₹0 / ≤ balance).
- **Polling vs writes:** same as before. Writes run through a serial queue and bump a sequence number, any read that straddles a write is dropped, and every write is followed by a refresh.
- **Keys:**
  - Movement: ↑/↓ moves · Tab cycles waiters → bills → lines · Enter on waiters focuses bills.
  - Settling: Space ticks the highlighted bill · A ticks all / none · F9 (or Enter in bills or lines) settles · F7 receives a payment.
  - Line edits: `−`/Delete removes one bottle (restock) · X marks one broken.
  - Other: F2 member on the highlighted bill · R refresh · Esc dashboard.
  - Mutating keys ignore auto-repeat, and line edits are locked once a bill is part-paid.

**Day End screen** (`dayEndReducer`, pure and unit-tested):
- **State:** `load` (`loading` / `ready` / `offline` / `none` = no day ever opened), `summary` (the open day, or the last closed one), `counted` (typed rupees), `dialog` (`confirm` / `repay` + waiter id / `endPeak`), `flash`.
- **Selectors:** `dayEndView` → `LOADING | OFFLINE | NO_DAY | OPEN | CLOSED`. `blockerCount` counts each open bill, the running peak (its `PEAK_UNSETTLED` bills count once, with it) and each owing waiter. `variancePreview` = counted − expected, display only; the server freezes its own figure. `lockBlock` gives the reason Confirm & Lock is disabled. Phase 16: `waiterBalanceBlock` ("Waiters owe ₹X — All waiter balances must be settled to ₹0 before closing.") comes first while `blockers.waiterBalance.totalPaise > 0`.
- The typed count survives polls of the same open day and is cleared when another day loads. Every checklist action re-reads the summary afterwards. A failed poll keeps the last summary and flashes the error.
- **Sales breakdown (Phase 11):** Cash / UPI / Credit / Total for Normal bills, Peak sales (UPI from the readings, cash = sales − UPI; credit "—") and Total sales, plus Waiter repayments kept apart as credit collected. Amber notes for a still-running peak and for a negative derived peak cash; each ended peak in the checklist also shows its sales, with the same warning.
- **By department (Phase 19):** the same sales split by each bill line's department, every department listed, then "On bills still open" (part-paid open bills / bills settled in a running peak; never at close) and the total, which equals Total sales. The cash count and Expected cash stay one combined figure.
- **Keys:** type the count (the field is focused) · Enter or F9 asks to lock · Enter confirms in the modal · F6 add expense (Esc on Expenses returns here) · F7 tally adjustment · Esc dashboard. The repayment dialog takes C/U for the tender; Enter records it.

**Expense screen** (`expenseReducer`, pure and unit-tested):
- **State:** `load` (`loading` / `ready` / `offline` / `noDay`), `till` (cashier name and day for the header), `entries`, `categories` (active, the manager's order), the form (`categoryId`, `query` search text, `highlighted`, `amount` text, `note`), `submitting`, `confirmVoidId`, `flash`.
- **Categories (Phase 18):**
  - `categories` replaces the list. A picked category that was disabled meanwhile is dropped.
  - `pickerMatches` returns all categories while the search is blank or still reads the picked name; otherwise the
    names containing the typed text.
  - `quickKey` / `categoryForKey` map keys 1–9 to the first nine categories.
- **Selectors:**
  - `formError` checks in order: a category, then an amount, then valid rupees, then more than ₹0, then a note when the category requires one.
  - `formPayload` gives paise, the `categoryId`, and the trimmed note (null when blank).
  - `todayTotals` excludes voided entries.
- `recorded` clears the amount and note but keeps the category, ready for a run of similar entries. A void confirmation is dropped once the list no longer offers that entry.
- **Keys:** type in the category box (↑/↓, Enter picks and moves to the amount) · 1–9 pick a category when no text field has focus · Enter records · Enter confirms a void · Esc dashboard.

**Expense Categories screen** (Settings, Phase 18; helpers in `settings/expenseCategoryForm.ts`):
- **List:** active categories in picker order, with their 1–9 key, a Note required badge, and "Used on n expenses".
  "Show disabled" lists disabled ones after them. Each active row has ↑ / ↓ buttons.
- **Modal** (touch-friendly; Enter / F9 saves): name, a Note required switch, and an Active switch when editing.
  - Disabling turns Save into "Disable & save" and warns that past expenses keep the name.
  - A rename warns that it relabels the category's history.
  - `categoryFormError` catches a blank, too-long or duplicate name (with a "disabled — enable it instead" hint) and
    the last active category. The server's refusal is shown and outlines the field.
- **Department (Phase 19):** each row shows its department badge (Liquor / Kitchen / Ancillary / Shared). The modal has a
  four-way switch (Shared = overheads, the default for a new category). Changing a used category's department warns
  "Moves its n past expenses from X to Y" (`departmentMoveNote`): expenses follow their category.
- **Keys:** ↑/↓ select · Alt+↑ / Alt+↓ reorder · Enter edit · Ins new · Esc dashboard.

**Item Categories screen** (Settings, Phase 20; helpers in `settings/itemCategoryForm.ts`):
- **List:** active categories in report order with their department badge, item count, bottles on hand (not for Kitchen) and default size; ↑ / ↓ buttons; "Show disabled".
- **Modal** (touch-friendly; Enter / F9 saves): name (shown upper-case), default size chips (or "Ask each time"), default department for new brands, and Active when editing. `itemCategoryFormError` catches a blank, too-long (30) or duplicate name and disabling a category that still has active items; `itemCategoryPatch` sends only what changed.
- **Keys:** ↑/↓ select · Alt+↑ / Alt+↓ reorder · Enter edit · Ins new · Esc dashboard.

**Revenue Centers screen** (Phase 22; the Kitchen Kiosk in Phase 21; helpers in `centers/purchaseForm.ts`, `centers/centerForm.ts`):
- **Data:** `api.centersOverview()`, `api.listDepartments(true)`, `api.context()` (peak running?) and, on a center tab, `api.centerSummary(code)`; polled every 15 s while no modal is open. A reply for a tab the cashier already left is dropped; a remembered center that was disabled falls back to the overview.
- **Tabs (`centerTabs`, `stepTab`):** "All centers" then each active non-liquor center; ←/→ (wrapping), 1–9 or a tap switch; the last tab is remembered per browser (`localStorage`, guarded). "+ Center" opens `CenterModal` and jumps to the new center.
- **All centers:** one row per center (sales, expenses, purchases, gross; click opens its tab) and a total row.
- **A center (`pnlCards`):** "CIGARETTES SALES / EXPENSES / PURCHASES / GROSS"; purchases note the GRN stock and supply split and the drawer part. Panels: items sold, the center's expenses (read-only), its supply purchases (+ a note of today's GRN stock), void per purchase.
- **New purchase (Ins):** the center chips (default: the open tab, else the first center), a GRN hint for stock-tracked centers, vendor, Drawer / Outside (Drawer disabled during a peak), lines with free-text quantities, F9 saves. `purchaseFormError` / `purchasePayload` carry `department`.
- **Keys:** ←/→ or 1–9 tabs · Ins new purchase · ↑/↓ select · Del void · R refresh · Esc dashboard.

**Settings → Revenue Centers** (Phase 22): the list in display order with code, Core badge for Liquor, KOT (Bar / Kitchen / No ticket), stock tracked and on hand, item count, ↑/↓ reorder and "Show disabled". `CenterModal`: name, KOT station, Stock tracked, Active; Liquor's behaviour is locked. `centerFormError` checks blank / long / duplicate names, the Liquor lock, disabling with active items and dropping stock tracking with stock on hand; `centerPatch` sends only what changed.

**Settings → Reports** (Phase 23; helpers in `reports/dateRange.ts`, `reports/registerView.ts`, `reports/csv.ts`): the first gear-menu entry. Presets Today / Yesterday / Last 7 days / This month / Last month count from `api.reportAnchor()` (the current business date); Custom shows two date fields, checked by `rangeError` like the server (≤ 366 days). The preset, custom range and tab are remembered per browser. Tabs **1–4** or **←/→**: Ledger balances (Sales / Purchase / Expense cards with totals, Contra line), Sales register (search by bill no., item or waiter; 200 rows a page on screen, every row on paper; voids struck through / red; open-tab count), Stock register (grouped by item category with subtotals; "Hide items with no stock and no movement"), Payments (sales by tender, normal / peak split, waiter ledger, money received, per-day table). An amber banner names the open day when the range includes it. **R** reloads (reports are cached per tab and range), **CSV** downloads the tab (`paiseCsv`: rupees with two decimals from bigint; formula-safe cells; UTF-8 BOM), **Print** uses `print:` styles (white page, range header).

**Live center lists (Phase 22):** the Catalog (`CatalogState.departments`, loaded with the items), Item Categories and Expense Categories (`useDepartments`) build their department pickers from the server list (active centers, plus the current value); `lib/departments.ts` gives `departmentChip` (fixed colours for the seeded centers, a palette for new ones), `departmentName` and `prettyCode`. Billing search chips use `SkuLookup.departmentName`. Day End's block is "By revenue center" (Liquor always, other centers with sales).

**Purchase screen (GRN)** (`purchaseReducer`, pure and unit-tested):
- **State:** `load` (`loading` / `ready` / `offline` / `noDay`), `till`, `receipts` (today's, newest first), `invoiceNo`, `vendorName`, `invoiceError` (set by a PS011 duplicate, cleared on edit), the picker (`query`, `results`, `highlighted`, `picked`), `cases`, `loose` (digits; empty = 0), `cost`, `lines: StagedLine[]` (`sku`, `cases`, `looseBottles`, `caseSize`, `quantity`, `unitCostPaise`), `selectedLine`, `confirming`, `submitting`, `flash`.
- **Picker:** Kitchen SKUs (`tracksStock: false`) are filtered out of the results (Phase 19); the server refuses them too.
- **Picking** a SKU pre-fills `cost` from its `purchasePricePaise` ("210", "1100.50"); with none the field is left empty.
- **Selectors:**
  - `entryCount` = `{ cases, loose, total: cases × sku.caseSize + loose }`.
  - `lineError` checks a picked SKU, then some cases or loose bottles, then loose below one case ("64 loose is a full case of 64 — add it to Cases"), then a total of 1–100,000, then a unit cost in valid rupees (₹0 allowed).
  - `submitError` checks the invoice number, then at least one line. `submitPayload` trims both, blank vendor → null, and sends each line as `{ skuId, cases, looseBottles, caseSize, unitCost }`.
  - `stagedTotals` / `lineTotal` are bigint paise. `pickFromSearch` takes an exact barcode / SKU code match (a scan), else the only result, else the highlighted one.
- **Staging:** re-adding a staged SKU at the same cost adds its cases and loose bottles, carrying a full case of loose into cases (`mergeCounts`; capped at 100,000 bottles); at a different cost it's refused ("already on this invoice at ₹X — remove it first"), and so is a re-add after the case size changed. A server `PS002` (case size changed in the catalog since the line was staged) keeps the lines and flashes the message. An inactive SKU can't be picked. Search results for a stale query are dropped.
- **Posting:** `posted` clears the invoice, vendor and lines; `duplicate` keeps everything, closes the dialog and flags the invoice fields. Once the form is up, a failed poll only flashes (the invoice being keyed in stays).
- **Keys:** Enter moves invoice → vendor → SKU → cases → loose → cost → stage · ↑/↓ in SKU results · F9 asks to post, Enter / F9 confirms · Del removes the selected line (outside text fields) · Esc clears the line being entered; with lines staged, the first Esc warns and a second within 3 s leaves.

**Inventory Catalog screen** (`catalogReducer`, pure and unit-tested; Phase 20 flat layout):
- **Data:** `api.listItems()` (every item, inactive included) and `api.listItemCategories(true)`, loaded together; search and the inactive filter run client-side (`filterItems`: brand / display name contains, SKU code prefix, exact barcode).
- **Rows (`catalogRows`):** a sticky header per category in report order (name, department chip, item count, Σ on hand, "+ Item"), then its items: code, brand name (+ barcode), size, sale, purchase, case, on hand ("not tracked" for Kitchen), status. Categories with nothing to show drop out. `selectedItem` is derived (first shown when the selected one is filtered out); ↑/↓ skip headers.
- **New item (Ins / "+ Item"):** opens in the highlighted (or clicked) category with its default size, case size and department. Category chips, name, code prefix (suggested; read-only `1848-F` when the brand exists), size chips only where `sizeChoices` gives a choice (no default, beer 650 / 330, Kitchen plates), a department switch for new brands only, then sale, purchase, per case and opening stock (hidden for Kitchen), barcode. `existingBrand` notes "Adds a Full to 1848 … it already has Quarter" and blocks a size the brand already has. `newItemPayload` sends paise, the prefix and department only for a new brand, and `openingQty` only when > 0.
- **Edit item (Enter / click):** name (with a note when it moves the item to another brand, or renames the brand on a case-only change), category, sale, purchase, case, barcode, active; size, SKU code, department and stock are shown read-only. `itemPatch` sends only the changed fields.
- **Results:** `saved` upserts the server's item in report order and selects it, then the list reloads (brand renames touch other rows). A PS012 marks the clashing field (`conflictField`: name, code prefix, barcode, size).
- **Keys:** ↑/↓ select · Enter edits · Ins new item in the highlighted category · Esc clears the search, else back · in the form: Enter / F9 save, Esc cancel.

**Billing scan stock note:** each scan's flash now ends with the bottles left (`stockLeft`: "57 left", or "last in stock"), computed from the `lookupSku` taken just before the sale. Stock received in Purchase shows on the very next scan. A Kitchen item's flash says "Kitchen — F6 sends the KOT" instead.

**Type-to-search (Phase 21; `billing/skuSearch.ts`, scan buffer changes):**
- The scan buffer keeps single spaces once it has text, sends `highlight` effects for ↑/↓ while text is typed (rows still move when it's empty), and skips the 2 s idle reset while the screen shows results for the text (`useScanBuffer`'s `searchOpen(text)`); Esc clears.
- `searchView(state, buffer)` derives the query (2+ characters, tidied, lower-case) during render; a debounced (120 ms) `api.searchActiveSkus` fills the results for that query only, so a stale answer is ignored. The list under the scan bar shows name, size chip, Kitchen / Ancillary chip, stock ("no stock" for Kitchen) and price; the first row is highlighted.
- **Enter** (`resolveSku`, D1): an exact barcode / SKU code (`lookupSku`) first — scanner speed unchanged; else `highlightedFor` (the highlighted result for this text); else the first live search hit; else "Not found". A tapped result is added at once. The `N*` prefix and peak mode apply as for a scan.

**Kitchen KOTs (Phase 19):** `kitchenKotPending(items)` = `{ send, cancel }` from each Kitchen line's `remainingQuantity − kotSentQuantity`; `groupItems` carries `department` and `kotPending` per row. F6 (`api.sendKot`) prints them, and is refused with a hint when nothing is pending or in peak. Settling (counter or waiter), a peak scan, cancelling a sent dish and Ctrl+Z all print server-side; `kotMessage(kots, billNo)` appends "Kitchen KOT #12/2 sent · 3 items, 1 cancelled" to the flash, or an error ("not printed (…) — F6 retries").

**Peak controls:** F8 toggles on the Dashboard and the Billing screen: it starts a session when none is running and ends the running one otherwise. Both screens disable their other shortcuts while a peak dialog is open, and re-read `/api/context` once a session starts or ends. `parseReadings` needs both readings (₹0 allowed); `describeVariance` words the result as short, over or exact. The start dialog fetches `api.peakBaseline()` on open: "Expected cash in drawer" and "Expected UPI so far" with `describeBaseline` terms (₹0 terms dropped), and `compareReading` under each field (display only). A failed fetch shows "Expected figures unavailable" and the peak can still start.

---

## 2. Hooks

| Hook | File | What it does |
|---|---|---|
| `useGlobalShortcuts(map, enabled = true)` | `hooks/useGlobalShortcuts.ts` | Binds `F1`, `F2`, `F4`, `F9` on `window` (bubble phase). Prevents the browser default and ignores auto-repeat. Handlers are read through a ref, so a fresh map each render does not re-subscribe. |
| `useScanBuffer(enabled, onEffect)` | `hooks/useScanBuffer.ts` | Keyboard-wedge scanner capture on `window` (**capture** phase). Feeds keys to the pure `scanKey` state machine and returns `ScanState` for display. Skips editable targets (`isEditableTarget`) and does nothing while `enabled` is false. |
| `useReducer(billingReducer)` | `billing/BillingScreen.tsx` | All billing screen state (§3). |
| Built-in only | | `useState` / `useEffect` (clock, dialogs, member search debounce), `useRef` (synchronous mirrors, write queue), `useMemo`, `useCallback`. No custom context providers. |

`Modal` also installs a window capture-phase `keydown` listener while it's open. Esc closes it, `onKey` gets first refusal, and F-keys are swallowed. This keeps dialog shortcuts working even after the focused field unmounts.

---

## 3. Billing state (`billing/billingReducer.ts`)

```ts
interface BillTab {                                   // Phase 15: one held or current customer
  id: number; label: number;                          // "Bill n": lowest free number when opened
  bill: BillDetail | null;                            // the tab's open NORMAL bill (created on its first scan)
  pendingMember: MemberSummary | null; pendingWaiter: WaiterSummary | null;  // chosen before the first scan
  selectedKey: string | null; receipt: Receipt | null;
}
interface BillingState {
  load: 'loading' | 'ready' | 'offline'; offlineMessage: string | null;
  context: Omit<CounterContext, 'openBill' | 'openBills'> | null;   // cashier, business day, running peak session
  tabs: BillTab[]; activeTabId: number; nextTabId: number;
  pending: PendingScan[];                             // each carries its tabId; the grid shows the current tab's
  ticker: PeakEntry[];                                // capped at 50
  dialog: 'payment' | 'member' | 'waiter' | 'abandon' | null; flash: Flash | null;
}
```

- **Actions:** `contextLoaded` (`resume` adopts every server `openBills` entry not already in a tab: empty tabs first, then new tabs; lands on the newest unless the current tab holds a bill), `contextFailed`, `billLoaded` / `billFinished` / `pendingMember` / `pendingWaiter` (all take a `tabId`; a `billLoaded` for a vanished tab re-creates one, so a server bill is never lost), `scanQueued` / `scanDone`, `peakSale` / `peakUndone`, `select`, `move`, `tabOpened`, `tabSwitched`, `tabCycled`, `tabClosed`, `dialog`, `flash`.
- **Tab rules:**
  - At most `MAX_TABS` = 9. `newTabBlock` refuses a new tab on an already-empty tab or at the limit; during a peak a new tab is simply an empty one that scans to peak.
  - Leaving an empty tab (no bill, no pending member or waiter, no scan on its way) drops it.
  - `tabClosed` closes only empty tabs; the last one resets to an empty "Bill 1".
  - Settling or cancelling a bill empties **that** tab in place (with its receipt); held tabs are never auto-activated.
- **Selectors:**
  - `screenMode(state)` → `LOADING | OFFLINE | BLOCKED | NORMAL | PEAK`. It is PEAK only when a peak session is running **and** the current tab has no open NORMAL bill, so a bill started before the peak finishes as NORMAL.
  - `activeTab`, `findTab`, `isEmptyTab`, `newTabBlock`.
  - `groupItems(items)` → `ItemRow[]`: rows keyed by SKU + unit price, holding remaining quantity, Σ line totals, and `cancelItemId` (the newest line with bottles left).
  - `totals(detail)` → `{ lines, bottles }`.

**`BillingScreen` orchestration**
- **Context.** Fetched on mount and polled every 15 s. The open bill is resumed only on the first successful load, including after a stretch offline.
- **Writes.** Every API write goes through `run(task)`, a promise-chain queue, so scans and edits apply in order.
  - On failure the scan bar flashes the error.
  - `PS007` refreshes the context.
  - Other API errors re-read the bill (`resync`).
- **Synchronous mirror (Phase 15).** Every action goes through `apply(action)`, which folds it into `stateRef` with the same pure reducer and dispatches it, so queued tasks always read the newest tabs (`billOf(tabId)`). `contextRef` mirrors the context.
- **Tab capture.** Each action reads the current `tabId` when the key is pressed and passes it into its queued task (and to `run` for `resync`), so a scanner burst followed by a quick tab switch still lands on the tab it was scanned on. Enter → qty → pay opens Payment only if that tab is still current.
- **First NORMAL scan.** The screen calls `createBill` (with any pending member), then `tagWaiter` (if a waiter is pending), then `getBill` to start tracking the bill, then `addItem`. The bill is tracked before the first line is added, so a failed line leaves no orphan bill.
- **PEAK scan.** `peakSale` adds a ticker entry and refreshes the context, which updates the expected-so-far total.

---

## 4. Keyboard model

| Key | NORMAL | PEAK | In a dialog |
|---|---|---|---|
| Printable chars + Enter | Scan / typed SKU code → add | Scan → one peak bill | Typed into the field |
| Enter (empty buffer) | Edit the selected row's quantity: digits (1–99, first replaces), `+`/`−`, Backspace, Esc; Enter sets it and opens Payment. A 3rd digit or any other character turns the edit into a scan | — | Confirm |
| `N*` | Quantity prefix (1–99) | Same | — |
| ↑ / ↓ | Select row (empty buffer) | — | Move picker highlight |
| `+` / `−` / Delete | Add / cancel one bottle on the selected row (empty buffer) | — | — |
| F1 | New bill (close an empty bill or confirm abandon) | — | Swallowed |
| F3 (or the on-screen +) | Hold this bill, open a new tab | Same (an empty tab scans to peak) | Swallowed |
| PageDown / PageUp | Next / previous tab (wraps) | Same | — |
| Alt+1…9 | Jump to tab n | Same | — |
| Ctrl+T / Ctrl+Tab | New tab / cycle — only when Chrome runs in kiosk / `--app` mode (a normal window keeps these keys) | Same | — |
| F2 / F4 | Member dialog / waiter sidebar (waiter locked after the first tender) | Refused with a message | Swallowed |
| F9 | Pay (closes a ₹0 bill instead) | Refused: peak bills reconcile at session end | Confirm (payment) |
| Ctrl+Z | — | `POST /api/peak/undo-last`: voids this till's newest un-voided scan (works after a reload; auto-repeat ignored) | — |
| Esc | Clear buffer, else back to the dashboard | Same | Close dialog |
| C / U / S / P / L | — | — | Payment option |
| ← → ↑ ↓ | — | — | Payment: move in the 2-column option grid, no wrap (`moveOption`); ←/→ move the caret while an amount is typed |
| Digits / Backspace | — | — | Payment, Cash highlighted: type the tendered amount without focusing the field (`amountKey`). The field is optional and never auto-focused, so Enter settles the exact amount; Split / Partial focus their required amount field |

No element needs focus for scanning. Screen buttons use `keepFocus` (`onMouseDown` preventDefault), so a click doesn't move focus. Enter with an empty buffer is left alone (so a focused button still works) unless a row is selected in NORMAL mode, when it opens the quantity edit. The edit lives in the scan buffer (`ScanState.qtyEdit`), not an `<input>`, so a scanner can't type into a field; the grid shows it as an amber box in the row's Qty cell. `setQuantity` adds bottles, or cancels them newest line first (`cancelPlan`), then opens Payment.

---

## 5. API client and pure modules

| File | Contents |
|---|---|
| `api/client.ts` | `api.*` (`context`, `lookupSku`, `searchMembers`, `listWaiters`, `getBill`, `captainOrders`, `createBill`, `addItem`, `cancelItem` (optional `restock`), `setMember`, `tagWaiter`, `settle` (returns `kots`), `sendKot` (Phase 19), `settleWaiter`, `closeEmpty`, `reverse`, `peakSale`, `searchSkus`, `listPurchases`, `postPurchase`, `listDepartments` (Phase 19), `listItemCategories`, `createItemCategory`, `updateItemCategory`, `listItems`, `createItem`, `updateItem` (Phase 20), `searchActiveSkus` (Phase 21), `centersOverview`, `centerSummary`, `recordCenterPurchase`, `voidCenterPurchase`, `listDepartments(includeInactive)`, `createDepartment`, `updateDepartment` (Phase 22), `reportAnchor`, `reportLedger`, `reportSales`, `reportStock`, `reportPayments` (Phase 23), `peakBaseline`, `undoLastPeak`, `listBankDeposits`, `addBankDeposit`, `voidBankDeposit`, `waiterStats` (Phase 15), `waiterLedger`, `waiterLedgerDetail`, `settleWaiterBills`, `receiveWaiterPayment` (Phase 16), `orders`, `order`, `reprintOrder` (Phase 17)), `ApiError` (`status`, `code`, `constraint` on a 409; `NETWORK` when unreachable or the proxy answers non-JSON 5xx), `reviveJson`, `encodeJson` |
| `api/types.ts` | Frontend mirrors of the API DTOs (`Bill`, `BillDetail`, `CounterContext`, `SkuLookup`, …) with `Paise = bigint`; dates stay ISO strings |
| `billing/payment.ts` | `payOptions(detail)`, `planPayment(detail, input)` → counter tenders or waiter settle steps plus change, credit-limit pre-check, `describePlan` |
| `billing/errors.ts` | `CounterError` (screen-raised), `counterErrorMessage(err)` (PS code → cashier wording) |
| `hooks/scanBuffer.ts` | `scanKey(state, input)` pure state machine; `IDLE_RESET_MS` = 2 s; max 64 chars |
| `lib/money.ts` | `formatPaise` (₹1,00,000.00 Indian grouping, bigint), `parseRupeesToPaise`, `paiseToRupeeInput` (editable "1100.50") |
| `lib/ui.ts` | `FOCUS_RING`, `formatTime`, `keepFocus`, `SIZE_NAME` (Full 750ml, Half 375ml, Quarter 180ml, Beer 650ml / 330ml, Unit — labels only), `sizeNameFor` (Kitchen: Full plate / Half plate / Single size), `SIZE_ORDER`, `DEPARTMENT_NAME` / `DEPARTMENT_ORDER` / `DEPARTMENT_CHIP` (Phase 19) |
| `lib/beep.ts` | WebAudio scan feedback; silent if audio is unavailable |

**Tests** (`*.test.ts`, Node environment, no DOM):
- Phase 21: scan-buffer spaces / highlight / idle rule (`scanBuffer.test.ts`), `billing/skuSearch.test.ts`
- Phase 22: `centers/purchaseForm.test.ts` (center payloads, card labels, GRN / supply split, tabs), `centers/centerForm.test.ts`, `lib/departments.test.ts`
- Phase 23: `reports/dateRange.test.ts` (presets across month / year / leap ends, range checks), `reports/registerView.test.ts` (tabs, labels, search, paging, stock grouping), `reports/csv.test.ts` (paise → rupees, quoting, ledger and register layout)
- Phase 20: grouping, search, selection, New / Edit item payloads and existing-brand rules (`catalogReducer.test.ts`), `settings/itemCategoryForm.test.ts`
- Phase 19: expense-category departments and the move warning, `kitchenKotPending` / `kotMessage` / row `kotPending` (`billingReducer.test.ts`), and the Day End department rows (`salesRows.test.ts`)
- `expense/expenseReducer.test.ts` (Phase 18: server categories, picker filter and highlight, quick keys 1–9, note rule, disabled-meanwhile) and `settings/expenseCategoryForm.test.ts`
- `orders/ordersView.test.ts` (Phase 17: filters and waiter filter, chip counts, peak grouping and expansion, moves, labels, jump targets, settlement wording)
- `captain/waiterLedgerReducer.test.ts` (Phase 16: selection, ticks across refreshes, panes, new-order flag, `allocate`, `receiveError`; Phase 17 jump focus)
- `billingReducer.test.ts` (Phase 15: tab isolation, replies to a non-current tab, drop / close / cycle / limit, resume into tabs, peak per tab), `payment.test.ts` and `waiterStats.test.ts`, with fixtures in `testData.ts`
- `scanBuffer.test.ts`
- `money.test.ts`, which also covers the JSON codec

---

## 6. Known gaps

- The peak ticker holds only this visit's scans, so Ctrl+Z can't undo a scan made before a reload. Server totals are always complete.
- No receipt printing on settle (reprints only) and no KOT reprint. The real ESC/POS bar and kitchen printers are still console stubs. 
- A posted GRN is final: there's no return-to-vendor / void receipt yet, and no stock-adjustment UI.
- The peak banner, the Billing peak side panel, the end dialog and Day End show the **expected drawer total** (`expectedDrawerCashPaise`: start cash + peak sales + in-peak cash − in-peak expenses). Peak bills carry no tender, so a peak sale paid by UPI makes the real drawer lower than this figure; the end-of-session variance still reconciles cash + UPI together.
- Expense entries are stamped with the till's `FL2_CASHIER_ID`; Phase 25 sign-in unlocks the terminal but doesn't change attribution (per-cashier shift login is a later phase).
- Breakage written off with `X` is a cancel line with `restock: false`; there is no separate breakage/ADJUSTMENT report yet.
- The cashier is fixed by the API's `FL2_CASHIER_ID`. The Phase 25 Super Admin sign-in gates the whole UI; Day Open is attributed to the PIN holder.
- Held tabs that only have a member or waiter picked (nothing scanned) live in the browser only, so a reload drops them; tabs holding a bill are restored from `openBills`. A bill opened in another browser window shows up only on the next resume (first load or after being offline).
- The headless-Chrome end-to-end scripts used to verify Phases 4, 9, 10 and 25 are not in the repo. Phase 25's API-level journeys are in `test/e2e/`.
- Catalog edits are open to any signed-in admin (Phase 25); there are no per-role permissions below that. GRN and center stock-purchase unit cost is per selling unit (Phase 26 D6); the per-pack figure is shown, never entered.

## Phase 24 — Reporting suite (Settings → Reports)

`components/ReportsScreen.tsx` (shell: range presets, tabs **1–8** / ←→, CSV, Print, signature lines on paper) with views in `components/reports/`: `SalesSummaryView` (By item ⇄ Member-wise), `OrdersView`, `StockSummaryView`, `LedgerViews` (Expenses and Purchases with a center filter, Bank deposits, Day End, Full Report), `parts.tsx` (Card, Line, MlTable, CenterFilter, Variance). Pure helpers: `reports/registerView.ts` (tab model, KOT / tag labels, grouping, stock totals, ml / litre formatting), `reports/csv.ts` (one CSV per module; nested reports flattened), `reports/format.ts`. Cached per tab + range (+ center filter). Print: A4 landscape, header repeats, provisional box. The Phase 23 ledger / payments tabs are folded into Full Report and Day End; their API routes remain. Catalog edit has "Bottle ml (excise)" and an "Excise ML group" picker (`volumeMl`, `exciseGroup`).

## Phase 25 — Sign-in, Day Open PIN, dashboard and polish

Plan and QA log: `docs/ui/phase25-auth-polish-qa-plan.md`.

**Sign-in**
- `main.tsx` renders `<AuthGate><App/></AuthGate>`.
- `auth/AuthGate.tsx` moves through `auth/authState.ts`: checking → offline (Retry) | `LoginScreen` | the app.
  `useAuth()` (`auth/AuthContext.ts`) provides `{ staff, signOut }`.
- The API client's `setUnauthenticatedHandler` returns any 401 `UNAUTHENTICATED` to sign-in with "Your session
  ended…". A network blip never signs a till out.
- `auth/LoginScreen.tsx` has a split brand / form layout, reveal-password, a shake and refocus on refusal, a
  lockout countdown (429 `retryAfterSeconds`), and a CLI setup hint while `adminConfigured` is false.

**Day Open PIN**
- `auth/PinPadDialog.tsx` (state in `auth/pinPad.ts`): pick a PIN holder (keys 1–9; skipped when there is only
  one), then 4–6 digits on a touch keypad or typed. Enter submits.
- A wrong PIN shakes the dots and shows the attempts left. A lock disables the pad with an m:ss countdown.
- Day End's `OpenDayPanel` takes the float, then this dialog calls `api.openDay(float, staffId, pin)`.

**Staff & PINs**
- `components/StaffScreen.tsx` (Settings → Staff & PINs; form rules in `settings/staffForm.ts`): add a cashier or
  manager (with an optional first PIN), rename, switch role, deactivate, set / reset / clear a PIN.
- Status chips show PIN set / No PIN / PIN locked m:ss / Signs in as … / Inactive.
- Keys: ↑↓, Enter edit, P PIN, Ins add, Esc.

**Dashboard (D7)**
- `MODULE_TILES` is 9 tiles; `HERO_TILE = 'billing'` spans two rows of the 5 × 2 grid (2 × 5 below `lg`,
  where the grid scrolls).
- Reports moved from the Settings menu to the last tile. The Settings menu is Catalog, Item Categories, Revenue
  Centers, Expense Categories, Staff & PINs.
- The header has the day chip, the signed-in admin and Sign out. The Recently Used rail shows from `xl`.

**Design system (D8)**
- `index.css` `@theme`:
  - `zinc-850` surface; `zinc-500` retuned for AA (print restores it)
  - `shadow-tile` / `-tile-hover` / `-glow-amber` / `-dialog`
  - `animate-fade-in` / `pop-in` / `shake`, and a quint ease-out
- A base layer gives every control 120 ms transitions, a 1 px press, pointer cursors and thin scrollbars.
  `prefers-reduced-motion` turns motion off.
- `lib/ui.ts`: `buttonClass(variant, size)`, `badgeClass(tone)`, `CARD`, `EYEBROW`. `components/ui.tsx`:
  `Button`, `Badge`, `BrandMark`, and a refined `Kbd`.
- `Modal` has a blurred backdrop, a pop-in and a footer band.

**Code splitting**
- `lib/lazyScreen.tsx` lazy-loads every back-office screen. Dashboard and Billing stay in the 359 kB startup
  chunk.

## Phase 26 — Bulk-to-unit purchase units (Catalog, Revenue Centers, Purchase)

Plan: `docs/ui/phase26-bulk-unit-purchase-plan.md`.

**Catalog** (`components/CatalogScreen.tsx`, `catalog/catalogReducer.ts`)
- For stock-tracked items, the old "Per case" field became the **Purchase unit** block: Bought as
  (Case / Packet / Carton / Box / Crate chips, or free text), *N {sold units} per {unit}* (= `caseSize`), and
  Sold as (Bottle / Stick / Packet / Can / Unit). A live hint reads "1 Packet = 10 Sticks — buying 2 Packets adds
  20 sticks to stock."
- Untracked centers (Kitchen, AC Charges) no longer show a case size.
- New-item unit names follow an existing brand (its first size's) or the center (Case + Bottle for Liquor, Cool
  Drinks and Water; Case + Unit otherwise) until the operator edits them (`unitsTouched`). Each name is 1–20
  characters. The sale price label reads "Sale ₹ per Stick".
- The list column is "Bought as": `Packet × 10`.

**Revenue Centers → New purchase** (`components/RevenueCentersScreen.tsx`, `components/centers/StockPurchaseModal.tsx`,
pure `centers/stockPurchase.ts`)
- A **Stock items | Supplies** switch (`PurchaseModeToggle`). Ins opens Stock items for a stock-tracked center and
  Supplies otherwise; switching keeps the center, vendor and payer.
- Stock items: center chips (stock-tracked centers only; changing center clears the lines), vendor, an optional
  Bill no. (blank → `CIGARETTES-20261021-01`), Drawer / Outside (Drawer disabled during a peak).
- Item search uses `api.searchSkus(q, department)` (debounced 150 ms).
- Keyboard: item ↵ → {Packets} ↵ → loose {sticks} ↵ → cost ↵ stages a line; F9 saves.
- The live line reads "= 20 sticks into stock · ₹150.00 per packet · line ₹300.00". Staged lines read
  "2 Packets × 10 = 20 Sticks". The same item at the same cost merges, carrying loose units into packs.
- Saving calls `api.recordCenterStockPurchase`. The flash reads "Cigarettes: 20 sticks into stock (1 item, ₹300.00,
  bill …) · paid from the drawer".
- The center tab's purchases panel lists today's **stock receipts** (STOCK chip, bill no., drawer / outside) above
  the supply purchases. The P&L purchases hint now counts drawer stock in "from the drawer".

**Elsewhere**
- Purchase (GRN): field labels and totals follow the picked item's units ("Packets", "Loose sticks",
  "= 13 sticks").
- Day End and the peak start baseline show a "Stock bought from the drawer" row when it is non-zero.
- `lib/ui.ts` `unitLabel(name, count)` makes light plurals (Case → Cases, Box → Boxes).

