# Phase 7 — Day End & Cash Reconciliation: Schema + Component Plan

Status: **APPROVED (2026-10-15)** with the recommended choices: peak cash = counted cash delta per session; `cash_expenses` table + API built now; Repayment and End-peak dialogs in the checklist.

Goal: from the dashboard's Day End tile, the cashier clears every blocker, counts the drawer, sees the expected cash and variance, and locks the day. With no open day, the app asks for a new Day Open with an opening float.

---

## 1. What already exists (reused, not rebuilt)

`0002_core_rules` already enforces most of "lock the day":

| Rule | Where | Error |
|---|---|---|
| Can't close while a peak session is running | `business_days_before_update` | `PS007` |
| Can't close while any bill is `OPEN` or `PEAK_UNSETTLED` (counter **and** Captain) | same | `PS007` |
| A CLOSED day is frozen (no column changes) | same | `PS001` |
| Every bill, line, tender, repayment and peak session needs the open day (`pos_require_open_day`) | posting triggers | `PS007` |
| At most one OPEN day | `business_days_one_open` | — |

Missing: opening float, cash count, expected cash and variance; the waiter-balance blocker; expenses; and any way to open a day besides the dev seed.

## 2. Migration `0005_day_end` (proposed)

**`business_days` gains:**

| Column | Type | Rule |
|---|---|---|
| `opening_float_paise` | `bigint NOT NULL DEFAULT 0`, `≥ 0` | Set at Day Open; immutable (joins the identity-column check) |
| `counted_cash_paise` | `bigint`, `≥ 0` | Required when closing |
| `expected_cash_paise` | `bigint` | **Computed by the close trigger**; client values are overwritten (as with peak sessions) |
| `cash_variance_paise` | `bigint` | Computed: `counted − expected` (negative = shortage) |

- CHECK: the three close columns are all NULL while OPEN and all set when CLOSED. Days closed before 0005 keep NULLs, so the CHECK is added `NOT VALID`, and the tests that close a day with raw SQL now pass `counted_cash_paise`.
- **New blocker in the close trigger:** any waiter with `outstanding_balance > 0` → `PS007` (`'cannot close business day: N waiter(s) still owe …'`). It sits in the database alongside the existing blockers, so no client can skip it.
- `pos_day_expected_cash(day_id)`: SQL function used by the trigger and by the preview (formula in §3).

**New table `cash_expenses`** (append-only, same pattern as `waiter_payments`):

```
id uuid PK · business_day_id → business_days (auto: open day) · peak_session_id → peak_sessions (auto: running session)
amount_paise bigint ≠ 0 · reverses_expense_id → cash_expenses UNIQUE (negative amount = correction)
description text NOT NULL (non-blank) · created_by_staff_id → staff · created_at
```

The outbox trigger, plus DELETE/UPDATE blocked. Only the table, service and API are built now; the touch-friendly Expense CRUD screen stays its own phase.

**Day Open:** `INSERT INTO business_days (business_date, opening_float_paise, opened_by_staff_id)`. `business_date` = today in `Asia/Kolkata`. Reopening a date that has already traded fails on the existing unique key, which surfaces as `PS007 'business date already traded'`.

## 3. Expected cash formula

```
expected_cash = opening float
              + normal cash sales      Σ CASH bill tenders taken OUTSIDE peak windows (refunds are negative)
              + peak cash              Σ over ended sessions (peak_end_cash − peak_start_cash)
              + waiter cash repayments Σ CASH waiter_payments OUTSIDE peak windows
              − cash expenses          Σ cash_expenses OUTSIDE peak windows
```

Why peak cash is the **counted cash delta of each session**:
- Peak bills record no tenders: a peak bill is settled by the session's combined cash and UPI count, so there is no "peak cash sales" figure to sum.
- Inside a window, the drawer delta already includes any normal-bill cash, waiter repayments or expenses taken during the session. That's why those three terms only count what happened outside peak windows; otherwise they'd be counted twice.
- Any shortage during a peak is reported once, as that session's peak variance, and isn't repeated in the day variance.

The preview also shows the day's UPI total for information. UPI isn't counted into the drawer, so it doesn't enter the cash variance.

## 4. Service: `DayEndService` (`src/services/day-end.service.ts`)

```ts
class DayEndService {
  constructor(db: SqlDatabase);
  getDayEndSummary(businessDayId: string): Promise<DayEndSummary>;      // read-only preview
  closeBusinessDay(businessDayId: string, countedCash: Paise, staffId: string): Promise<ClosedDay>;
  openBusinessDay(openingFloat: Paise, staffId: string): Promise<BusinessDaySummary>;
  recordCashExpense(amount: Paise, description: string, staffId: string): Promise<CashExpense>;
}

interface DayEndBlockers {
  openBills: Array<{ billId; billNo; source: 'COUNTER' | 'WAITER_APP'; status; waiter: WaiterSummary | null; duePaise }>;
  runningPeakSession: PeakSessionView | null;
  waitersOwing: WaiterSummary[];          // outstanding_balance > 0, any day
}
interface CashBreakdown {
  openingFloatPaise; normalCashPaise; peakCashPaise; waiterCashPaise; cashExpensesPaise; expectedCashPaise;
  upiTotalPaise;                           // information only
}
interface DayEndSummary { day: BusinessDaySummary; blockers: DayEndBlockers; canClose: boolean; breakdown: CashBreakdown; }
interface ClosedDay { day: BusinessDaySummary & { closedAt; countedCashPaise; expectedCashPaise; cashVariancePaise }; breakdown: CashBreakdown; }
```

`staffId` is added to `closeBusinessDay` because `closed_by_staff_id` is required. `closeBusinessDay` locks the day row (`FOR UPDATE`), so a sale racing the close either commits first and is counted, or fails `PS007`. It then performs the UPDATE; the trigger re-checks every blocker and computes expected cash and variance. `PS007` errors come back to the UI with the blocker list.

**API (loopback counter server):**

| Route | Body | Calls |
|---|---|---|
| `GET /api/day-end` | | `getDayEndSummary(open day)`; 404 when no day is open |
| `POST /api/days/:dayId/close` | `{ countedCash }` | `closeBusinessDay(…, cashier)` |
| `POST /api/days` | `{ openingFloat }` | `openBusinessDay(…, cashier)` → 201 |
| `POST /api/expenses` | `{ amount, description }` | `recordCashExpense` → 201 |
| `POST /api/peak/sessions/:id/end`, `POST /api/waiters/:id/repayments` | existing | used by the checklist actions (§5) |

## 5. UI: `DayEndScreen` (`frontend/src/components/DayEndScreen.tsx`)

```
┌ FL2 │ DAY END │ Day 2026-10-15 · opened 11:02 │ BLOCKED (2) / READY                        │ Esc Dashboard ┐
├──── Checklist (left ~45%) ─────────────────┬──── Cash count (right) ──────────────────────────────┤
│ ✘ 2 open bills                              │ Opening float              ₹2,000.00                 │
│     #14 Captain · W02 Manoj   ₹660.00  →    │ Normal cash sales         ₹18,450.00                 │
│     #17 Counter               ₹220.00  →    │ Peak cash (counted)        ₹9,200.00                 │
│ ✘ Peak session #2 running  [End peak…]      │ Waiter cash repayments     ₹1,500.00                 │
│ ✘ 1 waiter owes money                       │ Cash expenses               −₹600.00                 │
│     W01 Suresh  ₹1,200.00  [Repayment…]     │ EXPECTED CASH             ₹30,550.00                 │
│ ✔ Stock: nothing to do                      │ UPI today (info)          ₹12,300.00                 │
│                                             │ Counted cash  ₹ [ 30,500.00      ]                  │
│                                             │ VARIANCE                     −₹50.00  (short)        │
│                                             │ [ Confirm & Lock Day  (F9) ]  disabled until ready   │
└─────────────────────────────────────────────┴──────────────────────────────────────────────────────┘
```

- **Left, checklist:**
  - Each blocker is a red row; a green ✔ shows when it's clear.
  - Open Captain bills link to the Captain Orders screen. Open counter bills just name the bill (the cashier resumes it from the Billing screen).
  - **Repayment…** opens a small dialog (Cash/UPI, amount, defaulting to the full balance) that calls the existing repayment API.
  - **End peak…** opens a dialog for the end cash and UPI counts and calls the existing end-session API. Its frozen variance is shown afterwards.
- **Right, cash count:**
  - Breakdown from `getDayEndSummary`, polled every 10 s and re-read after each checklist action.
  - Counted cash is entered as rupees with `parseRupeesToPaise`; no floats.
  - The variance is previewed live as `counted − expected`. That is display only; the server recomputes it when locking.
- **Confirm & Lock Day** (F9): enabled only when `canClose` is true and an amount has been entered. It opens a confirmation modal ("This freezes 2026-10-15. Variance −₹50.00.") with Enter to lock.
- **After locking:** a frozen summary card is shown, then the **Open new day** form (opening float, Enter).
- **No open day** (on any screen): the Day End screen opens directly on the Open new day form. The dashboard shows a "Day closed — open a new day" banner, and the Day End tile reads "Open Day". Billing already shows its BLOCKED state.
- `dayEndReducer` (pure, unit-tested): load / blockers / count-entry / confirm / closed / open-day transitions.

## 6. Tests

- **Backend, closing:**
  - Refused with an OPEN counter bill, an OPEN Captain bill, a `PEAK_UNSETTLED` bill, a running peak, or any waiter balance above zero.
  - Allowed once each blocker is cleared.
  - The expected-cash formula: float, cash outside peaks, peak deltas, waiter cash, expenses, with refunds and corrections signed correctly. Cash taken inside a peak is not counted twice.
  - The variance sign. Client-supplied expected or variance values are overwritten.
- **Backend, after closing:**
  - A closed day rejects new bills, tenders, repayments, expenses and peak sessions.
  - Opening a new day: float stored, one OPEN day only, a date that has already traded is refused.
- **Frontend:** `dayEndReducer` transitions and variance preview.
- **End to end (headless Chrome):** blockers shown → clear them (settle a Captain order, record a repayment, end a peak) → count → lock → dashboard banner → open a new day → bill again.

## 7. Out of scope

Denomination counting, UPI settlement matching, printing the Z-report, the Expense CRUD screen, staff login / manager-only close, and stock counts at day end.
