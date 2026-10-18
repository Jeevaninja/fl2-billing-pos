# FL2 POS — Frontend State Reference

As of Phase 11 on `main` (Phase 3 dashboard, Phase 4 billing screen, Phase 6 Captain Orders, Phase 7 Day End, Phase 8 Expenses and peak controls, Phase 9 Purchase / GRN, Phase 10 Inventory Catalog and case-based GRN, Phase 11 peak start baseline and Day End sales breakdown, Phase 12 Enter → qty → pay, payment arrow keys and server-side peak undo; plan `docs/ui/phase12-billing-speed-plan.md`, Phase 13 peak end live split, Day End tally adjustments and Day End ⇄ Expenses; plan `docs/ui/phase13-peak-close-tally-plan.md`, Phase 14 bank deposits; plan `docs/ui/phase14-bank-deposits-plan.md`). Backend contract: `backend_state.md`. Billing screen design: `docs/ui/phase4-billing-screen-plan.md`.

- **Stack:** Vite 8, React 19, TypeScript, Tailwind CSS 4 (`@tailwindcss/vite`), Lucide icons, Vitest. No router, no state library.
- **Run:** `npm run api:dev` at the repo root (API on `127.0.0.1:4310`), then `npm run dev` in `frontend/` (http://localhost:5173). Vite proxies `/api` to the API.
- **Check:** `npm test` (Vitest, 111 tests), `npx tsc -b`, `npx oxlint src`, `npm run build`.
- **Money:** `bigint` paise end to end. The API client decodes every `…Paise` JSON string to `bigint` and encodes `bigint` back to strings. Display goes through `formatPaise`; cashier input goes through `parseRupeesToPaise`. No floats.
- **Server is the source of truth:** bills enter screen state only as `BillDetail` responses, so the UI never adds up prices to get a total.

---

## 1. Component tree

```
main.tsx                      StrictMode → <App/>, imports index.css (Tailwind)
└─ App                        view: 'dashboard' | 'billing' | 'captain-orders' | 'day-end' | 'expenses' | 'bank-deposits' | 'purchase' | 'catalog'; holds the Recently Used list
   ├─ Dashboard               module tiles + Recently Used rail + key legend footer
   │  ├─ header               Start peak (F8) button when a day is open and no peak runs
   │  ├─ PeakBanner           amber "PEAK #n running · since · expected drawer total" strip with End peak session (F8)
   │  ├─ day banner           "No business day is open" strip → Day End (context polled 15 s)
   │  ├─ ModuleTile ×8        4 × 2 grid (2 × 4 narrow), equal tiles (Phase 14). Billing, Captain Orders (live "n open" badge,
   │  │                       polled 15 s), Expense (live), Bank Deposit (→ BankDepositScreen), Purchase (→ PurchaseScreen), Inventory Catalog (→ CatalogScreen),
   │  │                       Day End (reads "Open Day" and becomes the primary tile when no day is open), Reports
   │  ├─ RailButton ×≤6       most-recently-used actions
   │  └─ LiveClock, Kbd       (components/ui.tsx)
   └─ BillingScreen           useReducer(billingReducer); serial write queue; all API calls
      ├─ header               ModeBadge (NORMAL / PEAK #n), bill no, cashier, day, LiveClock
      ├─ PeakBanner           while a session runs (PEAK mode, or NORMAL finishing a pre-peak bill); F8 ends it
      ├─ CenterNote           LOADING / OFFLINE (retry) / BLOCKED (no open business day)
      ├─ main (left pane)
      │  ├─ ScanBar           scan buffer display, qty-prefix chip, FlashLine (ok / error)
      │  ├─ ItemsGrid         NORMAL: rows grouped by SKU+price, pending "adding…" rows,
      │  │                    EmptyBill (hint or last-settled receipt with change)
      │  ├─ PeakTicker        PEAK: this visit's scans newest first, undone rows struck out
      │  └─ GridFooter        key legend for the current mode
      ├─ aside (right pane)
      │  ├─ SidePanel         NORMAL: Card(Member F2), Card(Waiter F4, TrustBadge), totals, Start peak (F8), Pay F9
      │  └─ PeakSide          PEAK: session card, expected drawer total, Undo last scan (Ctrl+Z)
      └─ dialogs (one at a time, all built on Modal)
         ├─ PaymentDialog     option radios C/U/S/P/L, rupee input, change / split / credit preview
         ├─ MemberDialog      Picker: debounced member search; Enter on empty = walk-in
         ├─ WaiterDialog      Picker: filter waiters, TrustBadge, outstanding / limit
         └─ abandon confirm   Modal: cancel every line, then close the ₹0 bill
   └─ CaptainOrdersScreen     useReducer(captainOrdersReducer); polls GET /api/captain-orders every 5 s
      ├─ header               "n open", updated-ago / OFFLINE pill, Refresh (R), LiveClock
      ├─ OrderList (left)     #bill · waiter code/name + TrustBadge · handset · bottles · due · age; new orders tinted + beep
      ├─ main (right)         ItemsGrid (selectable lines, custom empty state), FlashLine, receipt banner
      │  └─ OrderActions      waiter card, member card (F2), lines/bottles/paid/due, Settle F9, Remove one (−), Broken (X)
      └─ dialogs              PaymentDialog, MemberDialog (reused unchanged)
   └─ DayEndScreen            useReducer(dayEndReducer); GET /api/day-end polled 10 s (paused in dialogs / once locked)
      ├─ header               day + opened time, BLOCKED (n) / READY TO CLOSE / LOCKED / NO DAY OPEN badge
      ├─ Checklist (left)     open bills (→ Billing / Captain Orders), running peak (End peak…), waiters owing
      │                       (Repayment…); ended peak sessions with their variance
      ├─ CashCount (right)    breakdown (float, normal cash, peak cash, waiter cash, −expenses, −bank deposits, ±tally adjustments,
      │                       EXPECTED, UPI info), "Add expense" (F6 → Expenses) and "Add bank deposit" (→ Bank deposits); Esc on
      │                       either returns with the count kept, counted-cash
      │                       RupeeField, live variance (short / over / exact), Confirm & Lock Day (F9)
      ├─ ClosedDayCard        frozen figures once locked
      ├─ OpenDayPanel         opening float + Enter → POST /api/days (after a lock, or when no day exists)
      └─ dialogs (Modal)      ConfirmLock (Enter), RepayDialog (amount, C/U), PeakEndDialog (shared),
                              TallyDialog (F7: UPI → Cash / Cash → UPI, amount, required reason, live after-figures), void-adjustment confirm
   └─ ExpenseScreen           useReducer(expenseReducer); GET /api/context + /api/expenses polled 15 s
      ├─ form (left)          category chips ×6 (keys 1–6), amount RupeeField (lg), note, "Paid by <till cashier>" (read-only),
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
        adjustments (void on an open day) and "Adjust Cash ⇄ UPI…" (F7).
        components/dayend/TallyDialog.tsx: the tally modal (pure helpers in dayend/tallyForm.ts).
```

| File | Exports |
|---|---|
| `App.tsx` | `App` (view switch) |
| `components/Dashboard.tsx` | `Dashboard({ recent, onUse, onOpenBilling })` |
| `components/dashboard/actions.ts` | `ACTIONS`, `MODULE_TILES`, `DEFAULT_RECENT`, `BILLING_ACTIONS`, `pushRecent`, `runStub`, `PosActionId` |
| `components/ui.tsx` | `Kbd`, `LiveClock` |
| `billing/BillingScreen.tsx` | `BillingScreen({ onExit })` |
| `billing/BillingPanels.tsx` | `ScanBar`, `ItemsGrid`, `GridFooter`, `SidePanel`, `PeakTicker`, `PeakSide`, `SizeChip` |
| `billing/PaymentDialog.tsx` | `PaymentDialog({ detail, busy, onConfirm, onClose })` |
| `billing/PickerDialogs.tsx` | `MemberDialog`, `WaiterDialog`, `TrustBadge` |
| `billing/Modal.tsx` | `Modal({ title, onClose, onKey?, footer?, width? })` |
| `components/CaptainOrdersScreen.tsx` | `CaptainOrdersScreen({ onExit })` |
| `captain/captainOrdersReducer.ts` | `captainOrdersReducer`, `initialCaptainOrdersState`, `selectedOrder`, `editBlock`, `formatAge` |
| `components/DayEndScreen.tsx` | `DayEndScreen({ onExit, onOpenBilling, onOpenCaptainOrders })` |
| `components/ExpenseScreen.tsx` | `ExpenseScreen({ onExit, onOpenDayEnd })` |
| `components/BankDepositScreen.tsx` | `BankDepositScreen({ onExit, onOpenDayEnd, exitLabel? })` |
| `components/PurchaseScreen.tsx` | `PurchaseScreen({ onExit, onOpenDayEnd })` |
| `components/CatalogScreen.tsx` | `CatalogScreen({ onExit })` |
| `components/peak/PeakControls.tsx` | `PeakBanner`, `StartPeakButton`, `PeakStartDialog`, `PeakEndDialog` |
| `components/RupeeField.tsx` | `RupeeField` |
| `components/dayend/SalesBreakdownCard.tsx` | `SalesBreakdownCard({ sales })` |
| `deposit/bankDepositReducer.ts` | `bankDepositReducer`, `initialBankDepositState`, `MAX_REFERENCE`, `formError`, `formPayload`, `overDrawerWarning`, `todayTotals` |
| `expense/expenseReducer.ts` | `expenseReducer`, `initialExpenseState`, `CATEGORIES`, `CATEGORY_LABEL`, `formError`, `formPayload`, `todayTotals` |
| `purchase/purchaseReducer.ts` | `purchaseReducer`, `initialPurchaseState`, `MAX_LINE_QTY`, `lineError`, `submitError`, `submitPayload`, `lineTotal`, `stagedTotals`, `pickFromSearch`, `entryCount`, `bottlesFor`, `mergeCounts`, `countLabel` |
| `catalog/catalogReducer.ts` | `catalogReducer`, `initialCatalogState`, `catalogRows`, `suggestPrefix`, `skuCodePreview`, `formError`, `newProductPayload`, `productPatch`, `addSkuPayload`, `skuPatch`, `deactivates`, `conflictField`, `DEFAULT_CASE_SIZE` |
| `billing/billingReducer.ts` (Phase 12) | adds `cancelPlan` |
| `billing/payment.ts` (Phase 12) | adds `moveOption` |
| `peak/peakMath.ts` | `parseReadings`, `describeVariance`, `compareReading`, `describeBaseline`, `peakSplit` (Phase 13) |
| `dayend/tallyForm.ts` | `EMPTY_TALLY`, `MAX_REASON`, `tallyResult`, `describeShift` |
| `dayend/salesRows.ts` | `salesCard` (rows, repayments, warnings) |
| `dayend/dayEndReducer.ts` | `dayEndReducer`, `initialDayEndState`, `initialDayEndStateFrom` (Phase 13 count draft kept by App), `dayEndView`, `blockerCount`, `openCounterBills`, `countedPaise`, `variancePreview`, `lockBlock` |

Only the Reports tile still calls `runStub`; every other tile (and F1/F2/F9, which open billing) opens its screen.

**Captain Orders screen** (`captainOrdersReducer`, pure and unit-tested):
- **State:** `orders` (server list, oldest first), `selectedId`, `selectedKey` (line), `focus: 'list' | 'detail'`, `seenIds` / `freshIds` (new-order detection; nothing is "new" on the first load), `lastUpdated`, `dialog: 'payment' | 'member' | null`, `receipt`, `flash`.
- **Actions:** `ordersLoaded` (keeps the selection by bill id; a vanished selection moves to the order that took its place, with a note), `ordersFailed`, `orderUpdated` (re-read after an edit; non-OPEN leaves the list), `orderGone` (settled/closed here, sets the receipt), `select`, `selectLine`, `move` (orders or lines, by focused pane), `focus`, `dialog`, `flash`.
- **Polling vs writes:** writes go through a serial queue and bump a sequence number; a poll that straddles a write is discarded, and every write is followed by a refresh. Polling pauses while a dialog is open, so the order being paid can't change underneath it.
- **Keys:** ↑/↓ select · Tab orders ⇄ lines · `−`/Delete cancel one bottle (restock) · `X` cancel one bottle as broken (no restock) · F2 member · F9/Enter settle (or close a ₹0 order) · R refresh · Esc dashboard. Mutating keys ignore auto-repeat. Cancelling is disabled once a part-payment is recorded.

**Day End screen** (`dayEndReducer`, pure and unit-tested):
- **State:** `load` (`loading` / `ready` / `offline` / `none` = no day ever opened), `summary` (the open day, or the last closed one), `counted` (typed rupees), `dialog` (`confirm` / `repay` + waiter id / `endPeak`), `flash`.
- **Selectors:** `dayEndView` → `LOADING | OFFLINE | NO_DAY | OPEN | CLOSED`. `blockerCount` counts each open bill, the running peak (its `PEAK_UNSETTLED` bills count once, with it) and each owing waiter. `variancePreview` = counted − expected, display only; the server freezes its own figure. `lockBlock` gives the reason Confirm & Lock is disabled.
- The typed count survives polls of the same open day and is cleared when another day loads. Every checklist action re-reads the summary afterwards. A failed poll keeps the last summary and flashes the error.
- **Sales breakdown (Phase 11):** Cash / UPI / Credit / Total for Normal bills, Peak sales (UPI from the readings, cash = sales − UPI; credit "—") and Total sales, plus Waiter repayments kept apart as credit collected. Amber notes for a still-running peak and for a negative derived peak cash; each ended peak in the checklist also shows its sales, with the same warning.
- **Keys:** type the count (the field is focused) · Enter or F9 asks to lock · Enter confirms in the modal · F6 add expense (Esc on Expenses returns here) · F7 tally adjustment · Esc dashboard. The repayment dialog takes C/U for the tender; Enter records it.

**Expense screen** (`expenseReducer`, pure and unit-tested):
- **State:** `load` (`loading` / `ready` / `offline` / `noDay`), `till` (cashier name and day for the header), `entries`, the form (`category`, `amount` text, `note`), `submitting`, `confirmVoidId`, `flash`.
- **Selectors:**
  - `formError` checks in order: a category, then an amount, then valid rupees, then more than ₹0, then a note for Other.
  - `formPayload` gives paise, the category, and the trimmed note (null when blank).
  - `todayTotals` excludes voided entries.
- `recorded` clears the amount and note but keeps the category, ready for a run of similar entries. A void confirmation is dropped once the list no longer offers that entry.
- **Keys:** 1–6 pick a category when no text field has focus (and move focus to the amount) · Enter records · Enter confirms a void · Esc dashboard.

**Purchase screen (GRN)** (`purchaseReducer`, pure and unit-tested):
- **State:** `load` (`loading` / `ready` / `offline` / `noDay`), `till`, `receipts` (today's, newest first), `invoiceNo`, `vendorName`, `invoiceError` (set by a PS011 duplicate, cleared on edit), the picker (`query`, `results`, `highlighted`, `picked`), `cases`, `loose` (digits; empty = 0), `cost`, `lines: StagedLine[]` (`sku`, `cases`, `looseBottles`, `caseSize`, `quantity`, `unitCostPaise`), `selectedLine`, `confirming`, `submitting`, `flash`.
- **Picking** a SKU pre-fills `cost` from its `purchasePricePaise` ("210", "1100.50"); with none the field is left empty.
- **Selectors:**
  - `entryCount` = `{ cases, loose, total: cases × sku.caseSize + loose }`.
  - `lineError` checks a picked SKU, then some cases or loose bottles, then loose below one case ("64 loose is a full case of 64 — add it to Cases"), then a total of 1–100,000, then a unit cost in valid rupees (₹0 allowed).
  - `submitError` checks the invoice number, then at least one line. `submitPayload` trims both, blank vendor → null, and sends each line as `{ skuId, cases, looseBottles, caseSize, unitCost }`.
  - `stagedTotals` / `lineTotal` are bigint paise. `pickFromSearch` takes an exact barcode / SKU code match (a scan), else the only result, else the highlighted one.
- **Staging:** re-adding a staged SKU at the same cost adds its cases and loose bottles, carrying a full case of loose into cases (`mergeCounts`; capped at 100,000 bottles); at a different cost it's refused ("already on this invoice at ₹X — remove it first"), and so is a re-add after the case size changed. A server `PS002` (case size changed in the catalog since the line was staged) keeps the lines and flashes the message. An inactive SKU can't be picked. Search results for a stale query are dropped.
- **Posting:** `posted` clears the invoice, vendor and lines; `duplicate` keeps everything, closes the dialog and flags the invoice fields. Once the form is up, a failed poll only flashes (the invoice being keyed in stays).
- **Keys:** Enter moves invoice → vendor → SKU → cases → loose → cost → stage · ↑/↓ in SKU results · F9 asks to post, Enter / F9 confirms · Del removes the selected line (outside text fields) · Esc clears the line being entered; with lines staged, the first Esc warns and a second within 3 s leaves.

**Inventory Catalog screen** (`catalogReducer`, pure and unit-tested):
- **State:** `load` (`loading` / `ready` / `offline`), `products`, `query`, `includeInactive`, `selected` (index into `catalogRows`: each liquor followed by its sizes), `form` (`newProduct` / `editProduct` / `addSku` / `editSku`), `conflict` (`name` / `codePrefix` / `barcode` / `size`), `saveError`, `submitting`, `flash`.
- **Forms:** prices are typed rupees parsed with `parseRupeesToPaise` (sale > ₹0, purchase optional ≥ ₹0), case size digits 1–1000, barcode no spaces. `formError` gives the first problem (prefixed with the SKU code for a size row). Edits send only the changed fields (`productPatch` / `skuPatch`; an empty purchase price or barcode sends `null` to clear it); no change just closes.
- **Results:** `saved` upserts the server's copy of the liquor in name order and selects it; `conflict` keeps the form open with the reason in `saveError` (cleared by the next edit) and the clashing field outlined until it's edited. Results for a stale search are dropped. New sizes start at 0 stock.
- **Keys:** ↑/↓ select · Enter edits the selected liquor or size · Ins new liquor · Esc clears the search, else back to the dashboard · in the form: Enter / F9 save, Esc cancel.

**Billing scan stock note:** each scan's flash now ends with the bottles left (`stockLeft`: "57 left", or "last in stock"), computed from the `lookupSku` taken just before the sale. Stock received in Purchase shows on the very next scan.

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
interface BillingState {
  load: 'loading' | 'ready' | 'offline'; offlineMessage: string | null;
  context: Omit<CounterContext, 'openBill'> | null;   // cashier, business day, running peak session
  bill: BillDetail | null;                            // open NORMAL bill (created on first scan)
  pendingMember: MemberSummary | null; pendingWaiter: WaiterSummary | null;  // chosen before the first scan
  selectedKey: string | null; pending: PendingScan[]; ticker: PeakEntry[];   // ticker capped at 50
  receipt: Receipt | null; dialog: 'payment' | 'member' | 'waiter' | 'abandon' | null; flash: Flash | null;
}
```

- **Actions:** `contextLoaded` (`resume` adopts the server's `openBill`), `contextFailed`, `billLoaded` (`focusSkuId` selects that row), `billFinished`, `pendingMember`, `pendingWaiter`, `scanQueued` / `scanDone`, `peakSale` / `peakUndone`, `select`, `move`, `dialog`, `flash`.
- **Selectors:**
  - `screenMode(state)` → `LOADING | OFFLINE | BLOCKED | NORMAL | PEAK`. It is PEAK only when a peak session is running **and** there is no open NORMAL bill, so a bill started before the peak finishes as NORMAL.
  - `groupItems(items)` → `ItemRow[]`: rows keyed by SKU + unit price, holding remaining quantity, Σ line totals, and `cancelItemId` (the newest line with bottles left).
  - `totals(detail)` → `{ lines, bottles }`.

**`BillingScreen` orchestration**
- **Context.** Fetched on mount and polled every 15 s. The open bill is resumed only on the first successful load, including after a stretch offline.
- **Writes.** Every API write goes through `run(task)`, a promise-chain queue, so scans and edits apply in order.
  - On failure the scan bar flashes the error.
  - `PS007` refreshes the context.
  - Other API errors re-read the bill (`resync`).
- **Synchronous mirrors.** `billRef`, `contextRef` and `stateRef` let queued tasks see the latest bill before React re-renders. Bill changes always go through `setBill` and `finishBill`, which update the ref and dispatch together.
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
| F2 / F4 | Member / waiter dialog (waiter locked after the first tender) | Refused with a message | Swallowed |
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
| `api/client.ts` | `api.*` (`context`, `lookupSku`, `searchMembers`, `listWaiters`, `getBill`, `captainOrders`, `createBill`, `addItem`, `cancelItem` (optional `restock`), `setMember`, `tagWaiter`, `settle`, `settleWaiter`, `closeEmpty`, `reverse`, `peakSale`, `searchSkus`, `listPurchases`, `postPurchase`, `listCatalog`, `createProduct`, `updateProduct`, `addSku`, `updateSku`, `peakBaseline`, `undoLastPeak`, `listBankDeposits`, `addBankDeposit`, `voidBankDeposit`), `ApiError` (`status`, `code`, `constraint` on a 409; `NETWORK` when unreachable or the proxy answers non-JSON 5xx), `reviveJson`, `encodeJson` |
| `api/types.ts` | Frontend mirrors of the API DTOs (`Bill`, `BillDetail`, `CounterContext`, `SkuLookup`, …) with `Paise = bigint`; dates stay ISO strings |
| `billing/payment.ts` | `payOptions(detail)`, `planPayment(detail, input)` → counter tenders or waiter settle steps plus change, credit-limit pre-check, `describePlan` |
| `billing/errors.ts` | `CounterError` (screen-raised), `counterErrorMessage(err)` (PS code → cashier wording) |
| `hooks/scanBuffer.ts` | `scanKey(state, input)` pure state machine; `IDLE_RESET_MS` = 2 s; max 64 chars |
| `lib/money.ts` | `formatPaise` (₹1,00,000.00 Indian grouping, bigint), `parseRupeesToPaise`, `paiseToRupeeInput` (editable "1100.50") |
| `lib/ui.ts` | `FOCUS_RING`, `formatTime`, `keepFocus`, `SIZE_NAME` (Full 750ml, Half 375ml, Quarter 180ml, Beer 650ml / 330ml — labels only), `SIZE_ORDER` |
| `lib/beep.ts` | WebAudio scan feedback; silent if audio is unavailable |

**Tests** (`*.test.ts`, Node environment, no DOM):
- `billingReducer.test.ts` and `payment.test.ts`, with fixtures in `testData.ts`
- `scanBuffer.test.ts`
- `money.test.ts`, which also covers the JSON codec

---

## 6. Known gaps

- The peak ticker holds only this visit's scans, so Ctrl+Z can't undo a scan made before a reload. Server totals are always complete.
- No receipt printing or KOT reprint. No Reports screen (dashboard stub).
- A posted GRN is final: there's no return-to-vendor / void receipt yet, and no stock-adjustment UI.
- The peak banner, the Billing peak side panel, the end dialog and Day End show the **expected drawer total** (`expectedDrawerCashPaise`: start cash + peak sales + in-peak cash − in-peak expenses). Peak bills carry no tender, so a peak sale paid by UPI makes the real drawer lower than this figure; the end-of-session variance still reconciles cash + UPI together.
- Expense entries are stamped with the till's `FL2_CASHIER_ID`; there's no per-person attribution until staff login exists.
- Breakage written off with `X` is a cancel line with `restock: false`; there is no separate breakage/ADJUSTMENT report yet.
- The cashier is fixed by the API's `FL2_CASHIER_ID`; there's no login.
- The headless-Chrome end-to-end scripts used to verify Phases 4, 9 and 10 are not in the repo.
- Catalog edits are open to whoever is at the till (no staff login / role check yet). GRN unit cost is per bottle; there's no per-case price entry.
