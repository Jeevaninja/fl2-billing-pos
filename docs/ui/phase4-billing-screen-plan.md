# Phase 4 — BillingScreen Component Plan

Status: **DRAFT, awaiting approval.** No component code written yet.

Grounded in `backend_state.md` (commit `e323693`) and the service source. Section 5 lists the backend gaps the screen needs filled.

---

## 1. State management: NORMAL vs PEAK

**The mode is decided by the server, not by a toggle on the screen.** If the open business day has a running peak session, the screen is in PEAK mode. Otherwise it is in NORMAL mode. Peak sessions start and end in Day End (`startPeakSession` / `endPeakSession`), not on this screen. The screen re-reads the counter context (§5) when it mounts, after every committed action, and every 15 s, so it notices when a peak starts.

All screen state lives in one `useReducer`, typed as a discriminated union. The reducer is a pure function, so its transitions can be unit-tested (CLAUDE.md protocol 2).

```ts
type BillingState =
  | { mode: 'NORMAL'; phase: 'idle'; pendingMember: Member | null }            // no bill in the DB yet
  | { mode: 'NORMAL'; phase: 'building'; bill: Bill; items: BillItem[]; selected: number }
  | { mode: 'NORMAL'; phase: 'paying'; bill: Bill; items: BillItem[]; draft: TenderDraft }
  | { mode: 'NORMAL'; phase: 'settled'; bill: Bill; payments: BillPayment[] }  // receipt, then back to idle
  | { mode: 'PEAK'; session: PeakSessionView; ticker: BillLine[] }             // newest first, capped at 50
// alongside: context (day, cashier), inflight scan queue, lastError, scanBuffer
```

Rules:
- **The server holds the totals.** After every call, the reducer copies in the `Bill` the server returned, so `totalPaise` always comes from the database. The client never adds up prices. The only client-side arithmetic is in bigint paise: change due, and the UPI part of a cash/UPI split.
- **The NORMAL bill is created on the first scan, not on F1.** This avoids using up bill numbers on empty bills. If F2 (Member) is pressed before the first scan, the member is held as `pendingMember` and passed to `createBill`.
- **An open NORMAL bill stays NORMAL if a peak starts.** The backend lets it settle with tenders, and those tenders are counted in that session's peak breakdown. The screen finishes that bill in NORMAL mode, then switches to PEAK.
- **Scans run one at a time.** A scanner burst goes into a promise queue, so lines are added in order and stock checks never race each other. Each queued scan appears as a greyed "adding…" row until it is committed.
- **Resume after a crash.** On mount, if this cashier has an OPEN NORMAL bill, the screen goes straight back to `building` with it.

---

## 2. UI layout

The layout targets a 1366×768 screen. It uses the same dark, high-contrast styling and amber accent as the dashboard.

```
┌ FL2 │ BILLING │ [NORMAL]/[PEAK #2] │ Bill #0142 │ Cashier: Ravi │ 19:42:10 │ Esc Dashboard ┐
├──────────────────────────── left ~64% ─────────────┬──────── right ~36% ───────────────┤
│ ▌SCAN  3 × 8901234567890▏      ✓ Added: Old Monk Q  │ MEMBER (F2)   Walk-in / M-0042 Anil │
├────────────────────────────────────────────────────┤ WAITER (F4)   — / Suresh [TRUSTED]  │
│ #  SKU        Item                 Size  Qty  Price  Amount│        Outstanding ₹1,200 / ₹5,000│
│ 1  OM-Q       Old Monk             QTR    3   ₹220   ₹660 │───────────────────────────────────│
│ 2▶ KF-650     Kingfisher Strong    650    2   ₹180   ₹360 │ Lines 2   Bottles 5                │
│ …                                                         │ TOTAL           ₹1,020.00          │
│                                                           │───────────────────────────────────│
├───────────────────────────────────────────────────────────┤ [F9 PAY]                          │
│ ↑↓ select  + add one  − remove one  F1 new  F2 member     │ [C Cash exact] [U UPI exact]      │
│ F4 waiter  F9 pay  Esc back                                │ [S Split]  [L Collect later*]     │
└───────────────────────────────────────────────────────────┴───────────────────────────────────┘
```

### Left pane
- **Scan bar.** A read-only display of the scan buffer. It is not a real `<input>` (see §3). It shows the quantity prefix and the result of the last scan: a green ✓ with the item, or a red error such as "Out of stock: Old Monk QTR (0 left)".
- **Items grid.** Columns: `#`, `SKU` (code), `Item`, `Size` (FULL/HALF/QTR/650/330 chip), `Qty`, `Price` (unit), `Amount`.
  - Rows are grouped by SKU. The backend adds a new line on every scan, so the grid shows one row per SKU with the quantities summed.
  - `−` cancels one bottle from the SKU's newest line that still has bottles (`cancelBillItem`, §5). Cancelled lines are not shown. The audit trail keeps them in the DB.
  - Money is formatted from bigint paise as `₹1,020.00`. No floats are used.

### Right pane (NORMAL)
- **Member card (F2).** Shows "Walk-in" by default. Billing never requires a member (no KYC gate). F2 opens a search dialog by membership number or name. "Clear" detaches the member.
- **Waiter card (F4).** Shows "—" by default. F4 opens a waiter picker showing each waiter's name, a TRUSTED/UNTRUSTED badge, and their outstanding balance against their credit limit. A waiter can only be tagged before the first tender. After that the card is locked.
- **Totals card.** Lines, Bottles and **TOTAL** (large). There are no tax rows.
- **Payment quick-keys.** These change with the waiter tag:

| Bill | Keys shown |
|---|---|
| No waiter | **C** Cash exact, **U** UPI exact, **S** Split cash+UPI, cash-tendered keypad that shows change |
| Untrusted waiter | **C** Cash exact, **U** UPI exact only. Any other amount is rejected with PS005, so split and partial are hidden. |
| Trusted waiter | **C**, **U**, **P** Partial (pay part now, rest on credit), **L** Collect later (all on credit) |

### PEAK layout
- **Left pane.** A ticker of the session's scans, newest first: bill number, item, quantity, amount, time. Each scan commits a bill at once.
- **Right pane.** Session number, start time, declared start cash and UPI, the running expected total (`running_expected_paise`), and **Ctrl+Z Undo last scan**.
- **No payment screen.** Member and waiter are disabled, because peak bills are counter-only.

---

## 3. Keyboard and focus: scanning with no input field

**Approach: a global "keyboard-wedge" scan buffer, not a focused input.** USB/Bluetooth barcode scanners type the code as keystrokes and then press Enter. A `useScanBuffer` hook mounted at the `BillingScreen` root listens for `keydown` on `window` and handles them as follows:

1. Printable characters are appended to the buffer, which the scan bar displays.
2. `Enter` commits the buffer. Pressing Enter with an empty buffer does nothing.
3. `*` turns the digits typed so far into a quantity prefix, so `3*` then a scan adds 3 bottles. Values from 1 to 99 are accepted.
4. `Backspace` edits the buffer. `Esc` clears it, or goes back to the dashboard if it is already empty and the screen is idle.
5. The buffer is cleared if no key arrives for 2 s, so a half-typed code doesn't get prepended to the next scan.

The committed text is first looked up as a **barcode** and then as an **SKU code**. A cashier can therefore also type `OM-Q` and press Enter, with no mouse needed.

**Why not a hidden input that keeps refocusing itself:**
- Refocusing on every blur steals focus from dialogs.
- It can trigger the on-screen keyboard on touch terminals.
- It breaks when the operator clicks anywhere.

A window-level listener needs no focus at all. Focus can't get lost, because nothing depends on it.

**Hand-off to dialogs.** The scan listener ignores events when:
- a dialog is open (tracked by a ref in screen state), or
- `event.target` is an editable element: the member search box or the cash-tendered amount field.

Closing the dialog hands keys back automatically. Nothing needs to be refocused.

**Function keys.** The existing `useGlobalShortcuts` hook is extended to bind:

| Key | Action |
|---|---|
| F1 | New bill. If the current bill has lines, ask "Abandon?" and cancel every line, then `closeEmptyBill`. |
| F2 | Member |
| F4 | Waiter |
| F9 | Pay |
| ↑ / ↓ | Select a row |
| + / − | Add or remove one bottle on the selected row |
| Ctrl+Z | Peak only: undo the last scan |

In the payment dialog, `C/U/S/P/L` pick the tender, digits type the amount, and `Enter` confirms. F4 is an addition beyond the F1/F2/F9 listed in CLAUDE.md.

**Feedback.** A short beep plays on a good scan and a lower buzz on an error, using WebAudio with no assets. The scan bar flashes green or red.

---

## 4. Backend integration: calls during the billing lifecycle

| Step | Call | Notes / errors shown to the cashier |
|---|---|---|
| Screen mount / poll | `getCounterContext()` §5 | Open day, running peak with `running_expected_paise`, and this cashier's OPEN bill to resume. No open day blocks billing with "Open the business day in Day End". |
| Scan → resolve | `lookupSku(code)` §5 | Unknown code: "Not found: 8901…". Inactive SKU: PS002. |
| First NORMAL scan | `BillingService.createBill('NORMAL', cashierId, pendingMember?.id)` then `addItemToBill(bill.id, skuId, qty)` | PS007: no open business day. |
| Later NORMAL scans, `+` | `BillingService.addItemToBill(billId, skuId, qty)` | PS003: "Out of stock". The bill is unchanged. |
| `−` on a row | `BillingService.cancelBillItem(billId, itemId, 1)` §5 (new) | PS006 if the line has no bottles left to cancel. |
| F2 member | `searchMembers(q)` §5, then `createBill(…, memberId)` if idle, else `BillingService.setBillMember(billId, memberId \| null)` §5 (new) | `member_id` is not in the bill's immutable columns, so a member can be set on an OPEN bill without a migration. |
| F4 waiter | `listWaiters()` §5, then `WaiterService.tagBillToWaiter(billId, waiterId)` | PS002 once a tender exists or the bill isn't OPEN NORMAL. |
| Pay, no waiter | `BillingService.settleNormalBill(billId, [{mode, amount}, …])` | Cash exact: `[{CASH, total}]`. Split: `[{CASH, x}, {UPI, total−x}]`. If more cash is tendered, the change is shown on screen only and the CASH tender is the amount due. PS005 if the tenders don't add up to the amount due. |
| Pay, untrusted waiter | `WaiterService.settleWaiterBill(billId, waiterId, 'CASH' \| 'UPI')` | Full amount due only. |
| Pay, trusted: collect later | `WaiterService.settleWaiterBill(billId, waiterId, 'WAITER_CREDIT')` | PS004 if over the credit limit. The card shows headroom first. |
| Pay, trusted: partial | `settleWaiterBill(billId, waiterId, 'CASH' \| 'UPI', part)` then `settleWaiterBill(billId, waiterId, 'WAITER_CREDIT')` for `remainingDuePaise` | Two calls, so the dialog shows the remaining amount after the first. Ideally this becomes a single atomic call (§5 option). |
| F1 with an empty or fully cancelled bill | `BillingService.closeEmptyBill(billId)` | Only for ₹0 bills. |
| PEAK scan | `BillingService.recordPeakSale(sessionId, skuId, qty, cashierId)` | One scan is one PEAK_UNSETTLED bill. No tender. PS007: peak not running (the screen re-reads context and drops to NORMAL). |
| PEAK Ctrl+Z | `BillingService.reverseBill(lastBillId, 'Undo scan', cashierId)` | In-session reversal: stock is restored and there is no refund. |

Not called from this screen: `startPeakSession` / `endPeakSession` (Day End), `recordWaiterRepayment` (a separate waiter-account screen), and `reverseBill` on settled NORMAL bills (manager void flow, later phase).

**Error handling.** The API returns `{ code: 'PS003', message }`. A single `posErrorMessage(code, ctx)` turns the code into wording for the cashier. Unknown errors show a generic "Couldn't save, try again" and are logged.

---

## 5. Gaps that need backend work first (part of approval)

1. **Transport.** The services run in Node against PostgreSQL. A browser can't call them directly.
   - Proposal: a small local HTTP API in `server/` (Node, `node:http` or Fastify), bound to `127.0.0.1`. It is a thin wrapper around the existing services.
   - Paise are sent in JSON as decimal **strings** and parsed back into `bigint` on both sides. Dates are sent as ISO strings.
   - The Vite dev server proxies `/api` to it.
   - Electron or Tauri can wrap this later without changing the UI.
2. **Read queries.** None exist today:
   - `getCounterContext(cashierId)`
   - `lookupSku(code)`: barcode first, then `sku_code`; returns stock on hand
   - `searchMembers(q)`
   - `listWaiters()`: trust, outstanding, credit limit
   - `getBill(billId)` with items
3. **New write methods.** The database already allows both of these. Each comes with Vitest coverage.
   - `BillingService.setBillMember(billId, memberId | null)`: OPEN NORMAL bills only.
   - `BillingService.cancelBillItem(billId, itemId, quantity)`: inserts a negative line with `reverses_item_id`. The existing trigger already enforces the remaining-quantity rule.
4. **Cashier identity.** There is no login yet. Until a staff-login phase, `cashierId` comes from server config as a seeded staff row.
5. *(Optional)* **`WaiterService.settleWaiterBillSplit(billId, waiterId, paid, creditRest)`.** This would make the trusted partial payment a single atomic call, instead of two calls that could leave a bill half-paid if the terminal dies in between. Two calls are safe as they are, because the bill just stays OPEN with a remaining amount due, so this is a nice-to-have.

---

## 6. Files

```
server/                        # §5.1 local API (backend side, Vitest-tested)
frontend/src/
  api/client.ts, api/types.ts  # fetch wrapper; DTO ↔ domain (string ↔ bigint)
  lib/money.ts                 # formatPaise, parseRupeesToPaise (string parsing, no floats)
  billing/
    BillingScreen.tsx          # root: reducer, hooks, layout switch NORMAL/PEAK
    billingReducer.ts          # pure state machine
    ItemsGrid.tsx  ScanBar.tsx  PeakTicker.tsx
    SidePanel.tsx              # MemberCard, WaiterCard, TotalsCard, PaymentKeys
    PaymentDialog.tsx  MemberDialog.tsx  WaiterDialog.tsx
    posErrorMessage.ts
  hooks/useScanBuffer.ts       # wedge buffer + qty prefix
  App.tsx                      # view switch dashboard ↔ billing (no router dependency yet)
```

## 7. Tests (written before the components are marked done)

Frontend Vitest, run in plain Node with no DOM:
- **`billingReducer`:**
  - idle → building on the first scan
  - building ↔ paying
  - settled → idle
  - NORMAL bill kept when a peak starts mid-bill
  - PEAK ticker cap
  - Undo removes the newest entry
- **Payment routing:**
  - no waiter → `settleNormalBill`
  - untrusted → exact only (split/partial unavailable)
  - trusted partial → two calls, with the remaining due carried between them
  - split math: UPI = total − cash, in bigint
  - change due
- **`useScanBuffer` parser:** qty prefix, Enter commit, idle reset, editable-target bypass.
- **`money`:** `parseRupeesToPaise('1,020.5') === 102050n`; rejects 3+ decimals and negatives; formatting.

Backend Vitest: the new read queries, `setBillMember`, `cancelBillItem`, and the HTTP handlers' bigint string round-trip.

Verification: `npx vitest run` and `npx tsc --noEmit` at the root, and `npm run build` in `frontend/`.
