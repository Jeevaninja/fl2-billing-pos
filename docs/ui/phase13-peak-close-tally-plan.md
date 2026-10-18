# Phase 13 — Peak Closing Analytics & Day End Tally Adjustment — Schema + Component Plan

Status: **IMPLEMENTED (2026-10-17)**. Approved with the recommended choices A–E (§5). One migration (`0010_tender_adjustments`).

## 0. What already exists

- **`PeakEndDialog`** shows the start figures and the expected drawer total, then the two reading fields. After ending it shows expected, cash Δ, UPI Δ, actual and variance. It gets its session from a `/api/context` snapshot, which can be up to 15 s old on the Dashboard.
- **Phase 11's derived split** for ended sessions is `peakUpi = UPI Δ − UPI recorded in the window` and `peakCash = sales − peakUpi`. For a *running* session, `v_peak_sessions` exposes only the running expected figure and the drawer total. It does not expose sales or the UPI recorded in the window.
- **Day End reloads on mount and polls every 10 s**, so a newly added expense already reaches Expected cash and the variance preview.
  - **The typed count is lost:** leaving the screen (Esc → Dashboard → Expense → back) unmounts it, so the cashier has to re-type it.
  - **No shortcut from Day End:** reaching the Expense screen takes three steps, and the Expense screen's Esc goes to the Dashboard, not back to Day End.
- **No way to reclassify tenders:** if a bill was keyed as UPI but paid in cash, the only fix is a bill reversal plus re-billing.

## 1. Migration `0010_tender_adjustments.sql`

```sql
-- Day-level Cash ⇄ UPI reclassification of normal-bill revenue. Append-only; a mistake is voided by
-- a negating row. Total revenue can't change: every row moves money between the two tenders.
CREATE TABLE tender_adjustments (
  id                      uuid        PRIMARY KEY DEFAULT uuidv7(),
  business_day_id         uuid        NOT NULL REFERENCES business_days (id),
  cash_delta_paise        bigint      NOT NULL CONSTRAINT tender_adjustments_non_zero CHECK (cash_delta_paise <> 0),
  upi_delta_paise         bigint      NOT NULL,
  -- Snapshot taken by the trigger (never client-supplied): normal-bill tenders before this row.
  system_cash_paise       bigint      NOT NULL,
  system_upi_paise        bigint      NOT NULL,
  reason                  text        NOT NULL CONSTRAINT tender_adjustments_reason_present CHECK (btrim(reason) <> ''),
  reverses_adjustment_id  uuid        CONSTRAINT tender_adjustments_reverses_unique UNIQUE REFERENCES tender_adjustments (id),
  created_by_staff_id     uuid        NOT NULL REFERENCES staff (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tender_adjustments_revenue_locked CHECK (cash_delta_paise + upi_delta_paise = 0)
);
```

**The `BEFORE INSERT` trigger:**
- **Open day only:** it calls `pos_require_open_day`, so a closed day gives PS007.
- **Snapshot:** it fills `system_cash_paise` and `system_upi_paise` from the day's normal-bill CASH / UPI tenders. Client-supplied values are overwritten.
- **Floor at zero:** it refuses (PS002) a row that would take the day's adjusted normal cash or normal UPI below ₹0. For example, ₹10,000 can't be moved out of UPI when only ₹6,000 of UPI was taken.
- **Voids:** a void must exactly negate its original, on the same day, and only once (the UNIQUE constraint). Voiding a void is refused (PS006), the same as expenses.

**Other rules:**
- **Append-only:** no UPDATE, DELETE or TRUNCATE (PS001 triggers). Every insert writes to the outbox, like `cash_expenses`.
- **Errors:** PS codes are reused, so no new error code is needed.

**`pos_day_expected_cash` (CREATE OR REPLACE)** gains `+ Σ tender_adjustments.cash_delta_paise` for the day. The close trigger freezes expected cash through this function, so **the frozen expected cash and the variance include the adjustments**. Days already closed keep their stored figures.

**`v_peak_sessions` (CREATE OR REPLACE)** gains two running figures, both NULL once the session has ended:
- `running_sales_paise`: Σ peak bill totals.
- `running_in_window_upi_paise`: UPI bill tenders + UPI waiter repayments taken inside the window.

## 2. Backend

- **`DayEndService.adjustTenderSplit(businessDayId, cashDelta, reason, staffId)`**
  - `upiDelta` is always `−cashDelta`. The API doesn't accept a UPI figure at all, so the constraint is structural as well as checked by the DB.
  - `cashDelta ≠ 0`, the reason is 1–200 characters, and it returns the row.
- **`DayEndService.voidTenderAdjustment(id, staffId)`** appends the negating row.
- **`getDayFigures`:**
  - `CashBreakdown` gains `tenderAdjustmentPaise` (Σ cash deltas), and `expectedCashPaise` includes it. This is still asserted equal to `pos_day_expected_cash`.
  - `upiTotalPaise` includes Σ UPI deltas.
  - `SalesBreakdown.normal` gains `systemCashPaise` / `systemUpiPaise` (as recorded on the bills) next to `cashPaise` / `upiPaise` (adjusted). **`normal.totalPaise` and `total.salesPaise` are untouched by construction**, and that is asserted.
  - `DayEndSummary` gains `tenderAdjustments: TenderAdjustmentEntry[]`: originals with `voidedAt`, newest first.
- **Routes:**

  | Route | Body |
  |---|---|
  | `POST /api/days/:dayId/tender-adjustments` | `{ cashDelta, reason }` |
  | `POST /api/tender-adjustments/:id/void` | — |

- **`PeakSessionView`** gains `runningSalesPaise` and `runningInWindowUpiPaise`.

## 3. Frontend

### 3.1 Peak End dialog: live analytics

```
Started with cash ₹2,000.00 · UPI ₹1,300.00
Total peak sales                           ₹11,400.00
─────────────────────────────────────────────────────
Cash in the drawer now   [ 9,700 ]
UPI reading now          [ 5,400 ]
Derived peak UPI    ₹4,100.00   (5,400 − 1,300 − 0 recorded in window)
Derived peak cash   ₹7,300.00   (sales − derived UPI)
Variance preview    ₹0.00 · exact          ← Decision D
```

- **Fresh figures on open:** the dialog re-reads `/api/context` when it opens, so sales and expected are never a stale snapshot.
- **Derived lines:** the derived UPI and cash appear once the UPI reading is typed, and the variance line once both readings are typed.
- **Pure helper:** `peakMath.peakSplit(session, cashText, upiText)` → `{ upi, cash, variance } | partial`, with tests that assert `cash + upi = sales`.
- **Result view** after ending adds the same three lines, using the server's frozen breakdown.

### 3.2 Day End ⇄ Expenses

- **Shortcut:** an **"Add expense" button (F6)** on the Cash count opens the Expense screen in *return-to-Day-End* mode. There, Esc (or the header back button) returns to Day End instead of the Dashboard.
- **Count survives the trip:** the typed count is kept in App-level state keyed by day id, so leaving for the Expense screen and coming back doesn't lose it.
- **Recalculation on return:** Day End reloads on mount, as it already does, so Expected cash and the variance preview include the new expense immediately.

### 3.3 Tally / Adjust tender split

- **Opening it:** the Sales breakdown card gets an **"Adjust Cash ⇄ UPI…" (F7)** button, shown on an open day only.
- **The modal:**
  - It shows the system figures ("Cash ₹9,800 · UPI ₹5,700 as recorded on bills").
  - A direction toggle (**UPI → Cash** / **Cash → UPI**, ←/→), an amount, and a **required reason**.
  - Live "after" figures, with a fixed line: "Total sales ₹17,000.00 — unchanged".
  - A warning when moving Cash → UPI: "Lowers expected drawer cash by ₹X — check the GPay statement shows this UPI".
  - Enter saves. Validation uses the same floor-at-zero rule as the database, with the server as final check.
- **On the card after an adjustment:**
  - Normal Cash and UPI show the adjusted figures, with a small "system ₹X" note under each changed cell.
  - An **Adjustments** list shows each row's time, direction, amount and reason, and lets it be **voided** (with a confirm step).
- **Cash count** gains a "Tender adjustments ±₹X" row whenever it is non-zero, and **Expected cash** includes it.
- **Closed-day card:** the same row is shown, and the adjustment list is read-only.

## 4. Tests

- **DB / service:**
  - **Revenue locked:** `cash_delta + upi_delta = 0` (a raw insert of 100 / −90 is refused).
  - **Snapshot:** `system_*` comes from the trigger, and a client value is overwritten.
  - **Floor:** moving more UPI than was taken is refused.
  - **Day rules:** closed day → PS007; append-only (UPDATE / DELETE refused); a void negates exactly, only once, and never a void.
  - **Expected cash:** `pos_day_expected_cash` and the frozen close figures include adjustments, and the close variance uses them.
  - **Sales totals:** `normal.totalPaise` and `total.salesPaise` are identical before and after any sequence of adjustments and voids. UPI today moves by −cash delta.
- **Peak view:** `runningSales` / `runningInWindowUpi` for a running session, NULL once ended. For a scenario, the dialog's derived split equals what Day End shows after ending.
- **API:**
  - The adjust and void routes.
  - A `cashDelta` of 0 or a missing reason gets 400.
  - An extra `upiDelta` field is ignored.
- **Frontend:**
  - `peakSplit`.
  - The adjustment form reducer: direction, amount, reason, the floor, and that the total is unchanged.
  - The Day End count survives a remount.
- **Checks:** `npx vitest run`, `npx tsc --noEmit`, and frontend tests, `tsc -b`, lint and build. Then a headless E2E:
  - **Peak end:** end a peak and watch the live split.
  - **Late expense:** at Day End, F6 → add an expense → Esc back. The typed count is kept, and Expected cash and the variance have changed.
  - **Adjustment:** F7 to adjust ₹500 UPI → Cash. Total sales are unchanged and Expected cash rises by ₹500.
  - **Close:** lock the day, and the frozen variance uses the adjusted figure.

## 5. Decisions

- **A. Shape of the audit log.** *Recommended:* an **append-only `tender_adjustments` table**, with any number of rows per day and mistakes voided by a negating row. This matches expenses and CLAUDE.md's no-destructive-ops rule, and the history is never overwritten. *Alternative:* one set of columns on `business_days`, overwritten on each edit.
- **B. Controls.**
  - *Recommended:* a **mandatory reason**, the staff id, and the trigger-taken snapshot of the system figures.
  - Adjusted Cash and UPI can't go below ₹0.
  - The adjustment is visible on the Day End and closed-day cards.
  - Only allowed while the day is open.
  - **Note:** moving Cash → UPI lowers expected cash, so it can hide a drawer shortage. The only real check is the GPay statement, so the modal says so. There are no staff logins yet, so the adjustment can't be restricted to a manager.
- **C. Scope.** *Recommended:* **normal-bill tenders only**, as specified. Peak cash / UPI stays derived from the readings, and waiter repayments are untouched.
- **D. Peak End extras.** *Recommended:* re-read the session on open, and show a live **variance preview** next to the derived split. These are display only; the server still freezes the real figures.
- **E. Day End ⇄ Expenses.** *Recommended:* **F6 "Add expense"** from Day End, with Esc returning there, and the typed count kept across the trip. *Alternative:* only make sure the reload happens; that already works.
