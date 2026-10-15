# Phase 8 — Operations UI: Expenses & Peak Sessions — Component Plan

Status: **IMPLEMENTED (2026-10-15)**. Approved with the recommended choices:
- **A:** a `category` column (migration 0006).
- **B:** the till cashier is shown read-only.
- **C:** record, plus today's list, plus Void.

Goal: the cashier can record petty-cash expenses and start and end peak sessions from the UI. Until now these were API-only (`POST /api/expenses`, `POST /api/peak/sessions`), apart from Day End's End-peak dialog.

---

## 1. Expense screen (`frontend/src/components/ExpenseScreen.tsx`)

Opened from the dashboard's **Expense** tile. It's touch-first (large targets, no hover-only affordances) and also works from the keyboard.

```
┌ FL2 │ EXPENSES │ Day 2026-10-15 · Cashier: Counter 1 │ Today ₹1,240.00 (6)                   │ Esc Dashboard ┐
├──── New expense (left ~45%) ────────────────┬──── Today's expenses (right) ─────────────────────────┤
│ Category  [Ice] [Staff food] [Transport]    │ 14:02  Ice          Bags for the bar       ₹150.00   │
│           [Cleaning] [Repairs] [Other]      │ 13:40  Transport    Auto to supplier        ₹80.00   │
│ Amount    ₹ [ 150          ]                │ 12:15  Staff food   Lunch × 4             ₹400.00  ⓟ │
│ Note      [ Bags for the bar       ]        │ 11:02  Other        Tea   ̶₹̶4̶0̶.̶0̶0̶  voided          │
│ Paid by   Counter 1 (this till)             │                                                       │
│ [ Record expense  (Enter) ]                 │  ⓟ = paid during a peak session                       │
└─────────────────────────────────────────────┴───────────────────────────────────────────────────────┘
```

- **Category:** six large chips (Ice, Staff food, Transport, Cleaning, Repairs, Other); keys 1–6 pick one. Stored in the new `cash_expenses.category` column, which a CHECK limits to that list (migration 0006).
- **Amount:** rupees through `parseRupeesToPaise` (no floats). **Note:** optional text, but required for *Other*.
- **Paid by:** the till's cashier, shown read-only. The server stamps `FL2_CASHIER_ID`; there's no editable field until staff login exists.
- **Today's list:** the open day's expenses, newest first. Entries paid during a peak are marked, and voided entries are struck through. **Void** appends the negating row; voiding is only allowed on the open day.
- **No open day:** the screen says so and links to Day End, since an expense needs an open day (`PS007`).
- **State:** `expenseReducer` (pure, unit-tested) covers category, amount and note entry, validation (`formError`), submit, the list, and void confirmation.

## 2. Peak session controls (shared `frontend/src/components/peak/`)

- **`PeakStartDialog`:** drawer cash and UPI readings at the start (both required, ₹0 allowed) → `POST /api/peak/sessions`.
- **`PeakEndDialog`:** moved out of `DayEndScreen` so all three screens share it. It asks for the closing cash and UPI readings. On confirm it calls `POST /api/peak/sessions/:id/end`, then shows a **result view** inside the same modal: expected, actual (cash and UPI deltas) and **variance** (short / over / exact), and Enter closes it.
- **`PeakBanner`:** a persistent amber strip while a session runs: `PEAK #2 running since 21:04 · expected so far ₹18,450.00 · [End peak (F8)]`. It sits on the **Dashboard** and under the **Billing screen** header.
- **Start control:**
  - Dashboard: a **Start Peak (F8)** button in the header.
  - Billing screen in NORMAL mode: the same button in the side panel, plus F8.
  - F8 toggles the session (start when none is running, end when one is). F8 has no browser default, unlike F6 (address bar) and F7 (caret browsing).
- **Context polling:** the Dashboard already polls `/api/context` every 15 s, and the Billing screen does the same. Both refresh immediately after a start or end.
- Starting a peak with a NORMAL bill open is allowed, as today: the open bill finishes in NORMAL mode, then the counter switches to PEAK.
- `peakReducer`-style logic stays small. Its pure parts (reading validation, describing the result) live in `peak/peakMath.ts` with unit tests.

## 3. Backend additions

| Change | Needed for |
|---|---|
| `DayEndService.listCashExpenses(dayId)` + `GET /api/expenses` (open day) | Today's list (§1) |
| `DayEndService.voidCashExpense(expenseId, staffId)` + `POST /api/expenses/:id/void` | Void: appends the negating row; the original stays, as everywhere else |
| Migration `0006_expense_category`: `category` column (fixed list); the note becomes optional except for OTHER; a void must be on the original's day | Category column, void rule |

## 4. Tests

- **Frontend unit:** `expenseReducer` (category, amount, note rules, submit and reset, void flow) and `peakMath` (reading validation, variance wording).
- **Backend:** list and void (double void refused `PS006`, voiding on a closed day refused `PS007`, the void lowers expected cash), plus the category CHECK.
- **End to end (headless Chrome):**
  - Record two expenses, void one, and check that the list and the Day End expected cash agree.
  - Start a peak from the dashboard and see the banner and PEAK mode in Billing.
  - End it from the Billing banner and see the variance result.
  - F8 toggles from both screens.
