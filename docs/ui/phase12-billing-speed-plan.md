# Phase 12 — High-Speed Billing UX & Peak Undo — Component Plan

Status: **IMPLEMENTED (2026-10-17)**. Approved with the recommended choices A–D (§5). No schema change; no migration.

Changes from the plan as written:
- **Toast:** "Last scan voided: [item] ×N (peak bill #B)". It names the bill number, since the session number is already on the banner.
- **Scan bar:** during a quantity edit it reads "Qty · [item]" with a compact "Enter pay · +/− · Esc cancel" hint.
- **Quantity box placement:** the quantity edit is shown in the grid's Qty cell. No separate billing-reducer state was needed, because the edit lives in `ScanState.qtyEdit`, so the tests are in `scanBuffer.test.ts`.

## 0. What already exists

- **Peak undo already exists on the client, with a gap.**
  - **How it works now:** Ctrl+Z in PEAK mode and the "Undo last scan" button in the peak side panel take the newest entry from the screen's **in-memory ticker** and call `POST /api/bills/:id/reverse`.
  - **What that reverse does:** it appends a PEAK-mode REVERSAL bill that negates every line, restocks the bottles and lowers the session's expected figures.
  - **The gap:** the ticker only knows scans made since the Billing screen was opened. After a reload, a trip to the Dashboard or a crash, Ctrl+Z does nothing even though the last scan still exists.
  - **Wording:** the toast reads "Peak #N undone".
- **Double-undo protection:** the DB already allows a bill to be reversed **at most once**, and a reversal can't itself be reversed.
- **Normal billing:**
  - Scans go through a window-level **scan buffer** (`hooks/scanBuffer.ts`, a pure state machine). Enter commits a code, `N*` sets a quantity, and ↑/↓/+/−/Delete act on the selected row while the buffer is empty.
  - **Enter on an empty buffer currently does nothing.**
  - No `<input>` ever needs focus.
- **Payment dialog:** the options sit in a 2-column grid: Cash, UPI and Split (no waiter), or Cash, UPI, Partial and Collect later (trusted waiter). Letter keys C/U/S/P/L pick an option, and Enter/F9 settles with the highlighted one. **Arrow keys do nothing.**

## 1. Peak instant undo (server-side "last scan")

**Service:** `BillingService.undoLastPeakSale(cashierId)` runs in one transaction:
1. Lock the running peak session row (`FOR UPDATE`), so two fast Ctrl+Z presses are serialised. No running session → `PS007` "no peak session is running".
2. Pick this cashier's newest peak **SALE** bill in that session that has no reversal yet (`ORDER BY bill_no DESC LIMIT 1`). None → `NotFoundError` "no peak scan left to undo".
3. Reverse it through the existing reversal path, refactored into a `reverseInTx` helper shared with `reverseBill`. That means the same lines, restock and in-session PEAK reversal, and the expected cash drops by the bill total.
4. Return `{ reversal, undone: { billId, billNo, displayName, sizeCode, quantity, totalPaise } }`.

**Route:** `POST /api/peak/undo-last` → 201, using the till's cashier id.

**Meaning of "this terminal":** each till runs the API with its own `FL2_CASHIER_ID`, and Captain handsets never create peak bills. So "bills created by this cashier in the running session" is exactly this till's scans.

**Frontend:**
- **Ctrl+Z and the button:** in PEAK mode both call `api.undoLastPeak()` through the existing serial write queue, so an undo never overtakes a scan still being saved.
- **Auto-repeat:** a held-down Ctrl+Z is ignored (`event.repeat`), so one press voids at most one scan.
- **Toast:** "Last scan voided: Hayward's Fine — Quarter ×1 (peak #12)".
- **Ticker:** if the entry is in the ticker it is struck through. The banner's expected total refreshes from `/api/context`.
- **Undo button:** it is enabled whenever a peak is running, and the server decides. "Nothing left to undo" shows as an error toast.

## 2. Normal billing: Enter → Quantity → Enter → Pay

Everything stays inside the window-level scan buffer, so there is no focused `<input>` and a barcode scanner can't be swallowed by a text field.

**Scan buffer additions** (pure, unit-tested):
- **Context:** `scanKey(state, input, { qtyTarget })` takes the selected row's current quantity, or `null` when nothing is editable (PEAK mode, empty bill).
- **Entering edit mode:** **Enter on an empty buffer** with a target switches to `qty` edit mode. The text starts as the row's quantity (1 for a fresh scan) and is marked *fresh*, so the first digit typed replaces it.
- **Keys while editing:**

  | key | effect |
  |---|---|
  | digits | up to 2 digits (1–99, the same cap as `N*`) |
  | `+` / `−` | ±1 |
  | Backspace | edit |
  | Esc | cancel |
  | ↑ / ↓ | leave edit mode and move the selection |
  | **Enter** | emits `{ type: 'setQty', quantity }` |

- **Scanner safety:** a **3rd digit or any non-digit character** ends edit mode and turns everything typed so far into an ordinary scan buffer. A barcode fired mid-edit therefore still commits as a scan; it is never read as a quantity of 89.

**Screen (`BillingScreen`)** on `setQty N` for the selected row (current quantity Q):
- **N = Q:** open the Payment dialog straight away, exactly as F9 does.
- **N > Q:** `addItem(N − Q)`.
- **N < Q:** cancel Q − N bottles from the row's newest lines (restocked, append-only cancellation lines). Then reload the bill and open Payment.
- **N = 0:** refused with "Quantity must be at least 1 — use − to remove the line". Edit mode stays open.
- **A failed add** (out of stock, for example) flashes the error and **does not** open Payment.

**UI:**
- **Grid:** the selected row's Qty cell becomes an amber, outlined box showing the typed value and a caret.
- **Scan bar:** it reads "Qty for Hayward's Fine — Enter to pay · Esc cancel · +/− adjust".
- **Footer hint:** gains `Enter` Qty → Pay.

## 3. Payment dialog: arrow keys

**Spatial movement in the 2-column grid, no wrap-around (Decision C):**

| key | moves |
|---|---|
| ← / → | to the option on the left / right |
| ↑ / ↓ | to the option above / below (±2) |

Arrows that would move outside the grid do nothing.

**When the amount field has text:**
- ↑/↓ still switch options.
- ←/→ move the text cursor instead, so a typed "2000" isn't wiped by a stray arrow.
- With the field empty (the normal case: blank = exact cash), ←/→ switch.

**Enter:** it already settles with the highlighted option, and that is unchanged. The amount field is focused automatically for Cash, Split and Partial, as today.

**Pure helper:** `payment.ts → moveOption(options, current, key)`, with tests.

**Resulting flow** for one bottle paid in exact cash: **scan → Enter → Enter → Enter** (quantity 1 kept, Payment opens on Cash, settled).

## 4. Tests

- **Backend** (`test/services/billing.service.test.ts` / API):
  - The undo picks the newest of *this cashier's* scans, skips scans already undone and another cashier's scans, restocks, and lowers the session's running expected figure.
  - Repeated undos walk back.
  - The errors: no session (PS007) and nothing left (404).
  - An undo racing the end of the session is refused.
- **Frontend:**
  - `scanBuffer`: entering qty mode, fresh-replace, ±, 2-digit cap, the scanner flipping to a scan buffer, Esc, ↑/↓, and no qty mode without a target.
  - `moveOption` for the 3-, 2- and 4-option grids.
  - A reducer test for the quantity-edit display state.
- **Verification:** `npx vitest run`, `npx tsc --noEmit`, and frontend tests, `tsc -b`, lint and build. Then a headless E2E: a peak scan, a reload, Ctrl+Z voiding it, then normal scan → Enter → 2 → Enter → ↓ → Enter.

## 5. Decisions

- **A. How far Ctrl+Z reaches.** *Recommended:* each press voids this till's newest **not-yet-voided** scan in the running session, so repeated presses walk back one scan at a time. Auto-repeat is ignored, and the reach ends at the session boundary. *Alternative:* only the single last scan; a second press says "already undone".
- **B. Quantity entry happens inside the scan buffer, not in a real `<input>`.** *Recommended*, because it keeps the existing "no focus needed" design and the scanner safety rule above. With a real input, a barcode scanned while the field was focused would be typed into it.
- **C. Arrow movement in the Payment dialog.** *Recommended:* spatial movement in the 2-column grid as shown. *Alternative:* linear order (←/↑ previous, →/↓ next, wrapping round).
- **D. Quantity limits.** *Recommended:* 1–99 (the same as `N*`), and 0 is refused with a hint to use −.
