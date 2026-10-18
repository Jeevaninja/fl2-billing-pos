# Phase 15 — Multi-Tab Billing & Waiter Sidebar — Component Plan

Status: **IMPLEMENTED (2026-10-18)**. Approved with the recommended D1–D5, plus a Chrome-style on-screen `+` and a `×` on
each tab (§2). No migration.

**As built, differences from this plan:**
- **No peak block on new tabs:** blocking them would strand a cashier on a held NORMAL bill during a peak, with no
  way back to an empty tab. A new tab during a peak is just an empty tab, which scans to peak. New NORMAL bills
  still can't start in peak. Only "already on a new bill" and the 9-tab limit refuse a new tab.
- **`WaiterDialog` deleted:** `WaiterSidebar` replaces it. `waiterStats.ts` also has `waiterNote`, which flags
  bill-on-bill for an untrusted waiter and a reached credit limit.
- **Screen mirror:** every action goes through `apply`, which folds it into `stateRef` with the same reducer. Queued
  tasks read bills from that mirror, so no separate `billsRef` map was needed.

Note: the request names `purchaseReducer`. Billing state actually lives in `billing/billingReducer.ts`, so that is the
reducer this phase changes. `purchaseReducer` (the GRN screen) is untouched.

## 0. What already exists (and what constrains the design)

- **A bill is created on the server at the first scan.** `BillingScreen` calls `createBill` → `tagWaiter` → `addItem`,
  and every scan, `+`/`−` and quantity edit is a server write. Stock moves at scan time. The UI never adds up prices:
  totals come from `BillDetail`.
- **The DB already allows several OPEN counter bills per cashier.** There is no unique index on it. Nothing in the
  schema has to change for held bills.
- **`/api/context` returns only the cashier's newest open bill** (`openBill`). With held tabs, a reload would bring
  back one tab, and the other held bills would sit OPEN on the server with no tab. They would still block Day End
  close (`PS007`).
- **Browser-reserved keys:** in a normal Chrome window, `Ctrl+T`, `Ctrl+Tab`, `Ctrl+PageUp/PageDown`, `Ctrl+W` and
  `Ctrl+1–9` go to the browser and never reach the page, so `preventDefault` can't claim them. They only reach the
  page in kiosk / `--app` mode.
- **Waiter picking** is `WaiterDialog` (a centered `Picker` modal over `GET /api/waiters`). The counter waiter card
  and F4 open it.

## 1. Backend — `GET /api/waiters/stats`

`CounterQueries.getWaiterStats(businessDayId)`: one aggregate query over the open business day.

```sql
SELECT w.<WAITER_COLUMNS>,
       count(*)              FILTER (WHERE b.status = 'OPEN')                        AS open_bills,
       sum(b.total_paise - coalesce(t.tendered, 0)) FILTER (WHERE b.status = 'OPEN') AS open_due,
       count(*)              FILTER (WHERE b.status = 'SETTLED' AND r.id IS NULL)    AS closed_bills,
       sum(b.total_paise)    FILTER (WHERE b.status = 'SETTLED' AND r.id IS NULL)    AS settled_total
  FROM waiters w
  LEFT JOIN bills b ON b.waiter_id = w.id AND b.business_day_id = $1 AND b.bill_kind = 'SALE'
  LEFT JOIN LATERAL (SELECT sum(amount_paise) AS tendered FROM bill_payments WHERE bill_id = b.id) t ON true
  LEFT JOIN bills r ON r.reverses_bill_id = b.id
 WHERE w.is_active
 GROUP BY w.id
 ORDER BY w.waiter_code
```

- **Scope:** sale bills tagged to the waiter on the open day, from **both** the counter and the Captain app. Peak
  bills can't carry a waiter, so they never appear.
- **Open:** count and **amount to be settled = Σ due** (total − tendered). See **D2**.
- **Closed:** `SETTLED` sale bills that have **not been reversed**. Amount settled = Σ bill totals, whatever the
  tender. A bill put on waiter credit counts as closed.
- **Outstanding credit:** each row also carries the waiter's existing `outstandingPaise` / `creditLimitPaise`
  (`WaiterSummary`), so a trusted waiter's "collect later" balance shows next to the day's figures.
- **Active waiters only**, including those with no bills today (all zeros), so the list matches today's picker.

Response:

```ts
interface WaiterStats extends WaiterSummary {
  openBills: number; openDuePaise: Paise; closedBills: number; settledPaise: Paise
}
interface WaiterStatsResponse {
  businessDayId: string | null   // null: no open day → every waiter at zero
  waiters: WaiterStats[]
  totals: { openBills: number; openDuePaise: Paise; closedBills: number; settledPaise: Paise }
}
```

- **Totals** are summed in TypeScript as `bigint` over the rows, so the footer always equals the rows.
- **Route:** `GET /api/waiters/stats` in `server/app.ts`. It reads the open day from `getCurrentDayId`. It doesn't
  clash with `POST /api/waiters/:waiterId/repayments`.

**`/api/context` change (D1):** add `openBills: BillDetail[]`, all of this cashier's OPEN NORMAL counter bills on the
open day, oldest first. `openBill` stays (it is the newest one) so nothing else breaks.

## 2. Frontend — tabs in `billingReducer`

```ts
interface BillTab {
  id: number                 // stable key
  label: number              // "Bill 1", "Bill 2" … lowest free number when opened
  bill: BillDetail | null    // server OPEN bill; null until the tab's first scan
  pendingMember: MemberSummary | null
  pendingWaiter: WaiterSummary | null
  selectedKey: string | null
  receipt: Receipt | null    // last bill settled in this tab
}
interface BillingState {
  // load, offlineMessage, context, ticker, dialog, flash: unchanged
  tabs: BillTab[]; activeTabId: number; nextTabId: number
  pending: PendingScan[]     // PendingScan gains tabId; the grid shows only the active tab's
}
```

- **Actions:** `billLoaded`, `billFinished`, `pendingMember`, `pendingWaiter` and `select` gain a `tabId`, so a reply
  that arrives after the cashier switched tabs still lands in the right tab.
- **New actions:** `tabOpened`, `tabSwitched { tabId }`, `tabCycled { delta }`.
- **Selector:** `activeTab(state)`. `screenMode` reads the active tab's bill.

**Tab rules (pure, unit-tested):**
- **Limit:** at most **9** tabs. A 10th is refused with a flash.
- **New tab when the active tab is already empty:** no new tab opens. It flashes "Already on a new bill".
- **Empty tabs are dropped:** switching away from an empty tab (no bill, no pending member or waiter) removes it,
  unless it is the only tab. Abandoned new tabs don't pile up.
- **Settling or cancelling a bill** (F9 / F1 abandon / ₹0 close) resets **that tab** to empty, with its receipt
  showing. The cashier stays on it, ready for the next customer. Held tabs are never auto-activated, so a scan can't
  land on someone else's held bill by surprise.
- **Switching** keeps each tab's lines, member, waiter, selected row and receipt.
- **Peak:** while a peak runs, a new tab is refused ("Peak scans aren't held"). Switching still works, so held NORMAL
  bills started before the peak can be finished in NORMAL mode, as today. The tab bar shows during peak only when
  more than one tab exists.
- **Reload:** `contextLoaded` with `resume` builds one tab per entry in `openBills`, and activates the newest.
  Pending-only tabs (a member or waiter picked, nothing scanned) are not on the server, so they are lost on reload.

**`BillingScreen` orchestration:**
- `billRef` becomes `billsRef: Map<tabId, BillDetail>` plus `activeTabRef`, both updated synchronously.
- Every action captures `tabId` **at keypress time** and passes it into its queued task. A scanner burst followed by
  a quick tab switch still adds every bottle to the tab it was scanned on.
- `resync` takes a `tabId`.

**Tab bar UI** (above `ScanBar`), styled like Chrome's tab strip:

```
┌──────────────────────┐┌───────────────────────┐┌─────────────┐
│ Bill 1 · #42  ₹1,240 ×││ Bill 2 · W03  ₹480   × ││ Bill 3  New × │  [ + ]
└──────────────────────┘└───────────────────────┘└─────────────┘
```

- **Tabs:** joined to the bill area below. The active tab is raised and amber-topped, and held tabs are dimmed. Each
  tab shows its label, the server bill number, the waiter code when one is tagged, and the total.
- **`+` button:** always on screen, straight after the last tab, as in Chrome. It opens a new bill tab, the same as
  the keyboard shortcut. At 9 tabs it greys out, with a tooltip saying why.
- **`×` on each tab:**
  - On an empty tab, it closes the tab.
  - On a tab holding a bill, it opens the existing "Cancel bill #n?" confirm (all lines restocked, then the ₹0 bill
    is closed). A bill with a part-payment can't be discarded this way.
  - Closing the last tab leaves one empty "Bill 1".
- **Overflow:** tabs shrink to fit like Chrome's (the label truncates first). Clicking any tab switches to it.
- All controls use `keepFocus`, so clicking never steals the scanner's keys.

## 3. Frontend — `WaiterSidebar`

- **New file `billing/WaiterSidebar.tsx`.** It replaces `WaiterDialog` on the billing screen. `WaiterDialog` stays
  exported but unused (or is deleted, if you prefer).
- **Opening:** F4 or a click on the Waiter card. The existing rules still apply: refused in peak, locked after the
  first tender.
- **Layout:** a right-aligned panel about 480 px wide over a dimmed backdrop. It slides in with a CSS transform
  transition.
- **Keys:** the panel reuses `Modal`'s capture-phase key handling (Esc closes, F-keys swallowed). `Modal` gains a
  `placement: 'center' | 'right'` prop, so the existing dialogs are unchanged.
- **Data:** fetches `api.waiterStats()` on open. A failed fetch shows the error and a Retry button.
- **Filter box** (autofocused): matches code or name. ↑/↓ moves the highlight and Enter assigns.
- **Row:** code + name + `TrustBadge`, then three figure columns:
  - **Open:** `n · ₹due` (amber when n > 0)
  - **Closed:** `n · ₹settled`
  - **Credit:** `₹outstanding / limit` (trusted waiters only)

  The waiter on the active tab is marked "on this bill".
- **Footer:** all-waiter totals for open and closed.
- **Untrusted waiter with an open bill:** gets an amber "bill-on-bill" note. It is informational: counter tagging is
  allowed today and stays allowed.
- **Click or Enter on a row** assigns the waiter to the **active tab** and closes the panel:
  - If the tab has no bill yet, the waiter is held as `pendingWaiter`.
  - Otherwise `tagWaiter` runs.
- **Pure helper `billing/waiterStats.ts`:** `filterWaiters(query)` and `sumStats(rows)`, both unit-tested.

## 4. Decisions for approval

- **D1 — Where held bills live. Recommended: a server OPEN bill per tab, with the tab layout kept in frontend state.**
  Scans keep writing to the server as today: stock is reserved, totals come from the server, and the audit trail
  is kept. The request says held bills stay *entirely* local until settled, which would mean a client-side cart:
  - Prices would be summed in the browser.
  - Stock would not be reserved while a bill is held.
  - A reload or crash would lose every held bill.
  - Scan, qty, `+`/`−` and cancel would all need rewriting.

  The tab arrangement itself (which bill is in which tab, labels, pending member or waiter) **is** local. The server
  only gains `openBills` in `/api/context`, so a reload restores every held tab instead of orphaning them.
- **D2 — "Amount to be settled". Recommended: Σ due (total − tendered).** This differs from Σ total only when a
  trusted waiter has part-paid an open bill, and due is what is actually left to collect.
- **D3 — Tab keys.** `Ctrl+T` / `Ctrl+Tab` can't be captured in a normal Chrome window (§0). **Recommended:**
  - **F3** opens a new tab.
  - **PageDown / PageUp** (empty scan buffer, no dialog) move to the next / previous tab.
  - **Alt+1…9** jump straight to a tab.
  - `Ctrl+T` / `Ctrl+Tab` are also bound, for when the till runs Chrome in kiosk / `--app` mode.
  - The key legend in `GridFooter` lists the active keys.
- **D4 — After settling. Recommended: the settled tab resets to an empty bill in place**, rather than closing and
  jumping to a held tab (§2).
- **D5 — Tab limit. Recommended: 9.**

## 5. Tests (written before the implementation is called done)

**Backend:** `test/services/waiter-stats.test.ts` (PGlite) covers:
- a counter bill held open with a part-payment, which counts its due, not its total
- a settled bill
- a settled-then-reversed bill, which is excluded
- a Captain-app open bill
- a bill on waiter credit, which counts as closed
- an untagged bill and a previous day's bill, which are excluded
- a waiter with no bills, who shows all zeros
- totals that equal the sum of the rows
- no open day

**Backend API:** `test/server/api.test.ts` covers `GET /api/waiters/stats` (paise as strings) and `/api/context`
`openBills` with two held bills.

**Frontend:** `billing/billingReducer.test.ts` covers:
- open, switch and cycle tabs
- isolation: a member, waiter, lines or selection in tab 1 is unchanged after edits in tab 2
- `billLoaded` / `billFinished` aimed at a non-active tab
- an empty tab dropped on switch
- the 9-tab limit
- "already on a new bill"
- a new tab refused during peak
- a resume that builds tabs from `openBills`
- PEAK mode decided by the active tab

`billing/waiterStats.test.ts` covers the filter and totals.

**Verification:** `npx vitest run` and `npx tsc --noEmit` (root), then `npm test`, `npx tsc -b` and `npx oxlint src`
(frontend). Afterwards, update `frontend_state.md` and `backend_state.md`.
