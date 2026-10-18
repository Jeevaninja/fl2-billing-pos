# Phase 14 — Bank Deposits (Cash Drops) — Schema + Component Plan

Status: **IMPLEMENTED (2026-10-18)**. Approved with the recommended choices D1–D5 (§5). One migration (`0011_bank_deposits`).

**As built, three differences from this plan:**
- **No free 8th tile slot:** the grid was already full, because the Billing tile spanned two rows. Billing is now a normal single tile (it keeps its primary highlight), so the 8 tiles fill the 4×2 grid.
- **Request body:** the deposit body is `{ amount, reference? }`, the same field name as `/api/expenses`.
- **Baseline fix:** `PeakStartBaseline` and `describeBaseline` also gained the Phase 13 `tenderAdjustmentPaise` term, which was missing, so the cash terms add up again.

## 0. What already exists

- **`cash_expenses`** is the only way cash leaves the drawer today. A ₹10,000 RTGS cash drop would have to be keyed as an `OTHER` expense, which inflates operating expenses.
- **`pos_day_expected_cash`** (last replaced in 0010) sums the day's cash terms and is the single source of truth:
  - The close trigger freezes Expected cash and the variance through it.
  - `getDayFigures` rebuilds the same figure term by term and **asserts** that it equals the function.
  - The peak start baseline (`PeakStartBaseline`) also shows its terms.
- **Peak windows:**
  - An expense paid during a running peak is tagged with that `peak_session_id`.
  - It lowers that peak's expected collection and its drawer total.
  - It is kept out of the day formula, because the peak's counted cash delta already holds it.

## 1. Migration `0011_bank_deposits.sql`

A dedicated ledger, separate from `cash_expenses`, so expense totals and reports never see deposits.

```sql
CREATE TABLE bank_deposits (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  business_day_id      uuid        NOT NULL REFERENCES business_days (id),
  amount_paise         bigint      NOT NULL CONSTRAINT bank_deposits_amount_non_zero CHECK (amount_paise <> 0),
  reference            text        CONSTRAINT bank_deposits_reference_present CHECK (reference IS NULL OR btrim(reference) <> ''),
  reverses_deposit_id  uuid        CONSTRAINT bank_deposits_reverses_unique UNIQUE REFERENCES bank_deposits (id),
  created_by_staff_id  uuid        NOT NULL REFERENCES staff (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_deposits_reversal_shape CHECK (
    (amount_paise > 0 AND reverses_deposit_id IS NULL)
    OR (amount_paise < 0 AND reverses_deposit_id IS NOT NULL)
  )
);
CREATE INDEX bank_deposits_day_idx ON bank_deposits (business_day_id, created_at);
```

**The `BEFORE INSERT` trigger:**
- **Open day only:** it calls `pos_require_open_day`, so a closed day gives PS007.
- **No deposits during a running peak:** refused with PS007 ("end the peak session first"). See decision **D2**.
- **Voids:**
  - A void must exactly negate its original (PS006) on the same day (PS007).
  - It can be made only once (the UNIQUE constraint), and voiding a void is refused (PS006).
  - It copies the original's reference.

**Other rules:**
- **Append-only:** no UPDATE, DELETE or TRUNCATE (`pos_forbid_change`).
- **Outbox:** every row goes to the transactional outbox through `pos_outbox_capture`.
- **Errors:** constraint names are mapped in `src/db/errors.ts`. No new error code is needed.

**`pos_day_expected_cash` (CREATE OR REPLACE)** gains `− Σ bank_deposits.amount_paise` for the day.
- The close trigger freezes Expected cash through this function, so the frozen figure and the variance include deposits.
- Days already closed keep their stored figures.

**Peak math is untouched:** with D2, no deposit can fall inside a peak window.
- `pos_peak_expected_paise` and `pos_peak_expected_drawer_cash` are not changed.
- The peak start baseline does pick up deposits automatically, because it reads `pos_day_expected_cash`.

## 2. Backend

- **`DayEndService`** (in the same file as expenses, since both are drawer ledgers):
  - **`recordBankDeposit(amount, reference | null, staffId)`:** the amount must be above ₹0. The reference is trimmed, 0–200 characters, and stored as null when empty.
  - **`listBankDeposits(businessDayId)`:** returns originals only, newest first, each with `voidedAt`.
  - **`voidBankDeposit(depositId, staffId)`:** appends the negating row.
- **`getDayFigures`:**
  - `CashBreakdown` gains `bankDepositsPaise`, and `expectedCashPaise` subtracts it. It is still asserted equal to `pos_day_expected_cash`.
  - **`SalesBreakdown` is not touched:** deposits are not revenue.
- **`PeakStartBaseline`** gains `bankDepositsPaise`, so its expected-cash terms still add up.
- **Routes** (same shape as `/api/expenses`; the staff ID is the till's cashier):
  - `GET  /api/bank-deposits`: lists the open day's deposits. It gives 404 when no day is open.
  - `POST /api/bank-deposits` with `{ amount, reference? }`: returns 201 and the row.
  - `POST /api/bank-deposits/:depositId/void`: returns 201 and the negating row.

## 3. Frontend

- **Dashboard:**
  - **New `bank-deposit` tile** ("Bank Deposit", "Cash drops for bank / RTGS", `Landmark` icon). It is the 8th tile, so the 4×2 grid is now full.
  - **New `BankDepositScreen`:** it uses the same layout as the Expense screen, minus the category chips:
    - Left panel: an Amount field (`RupeeField`) and an optional Reference field (placeholder "e.g. RTGS to Sri Balaji").
    - Record button, with `Enter` as its shortcut.
    - Right panel: today's deposits with Void (confirmation modal), and a header chip showing "Today ₹X (n)".
- **`bankDepositReducer.ts`:** a pure, unit-tested reducer for form state, validation, totals and the void confirmation.
- **Guard rail:** if the amount is greater than the current Expected cash, an amber warning reads "More than the drawer should hold (₹Y)". It still allows the deposit. See **D3**.
- **Running peak:** the form is replaced by "End the peak session before a bank deposit", and the list stays visible.
- **Day End `CashCount` and `ClosedDayCard`:**
  - A new line, **"Bank deposits"** (shown as −₹X), sits directly below "Cash expenses".
  - It always shows, even when it is ₹0, so the cashier sees the line exists.
- **Day End link:**
  - Under the existing "Forgot an expense? F6" button, a matching dashed button "Add bank deposit" opens the deposit screen.
  - Esc returns to Day End with the typed count kept, through the Phase 13 count-draft mechanism.
  - It has no F-key, so the shortcut set stays small.
- **`describeBaseline`** (peak start dialog) gains a `− bank deposits ₹X` term.

## 4. Tests

- **`test/services/bank-deposits.test.ts`:**
  - **₹10,000 deposit:** `breakdown.expectedCashPaise` drops by exactly 1,000,000 paise, and `bankDepositsPaise` = 1,000,000.
  - **Sales unchanged:** `sales` (normal, peak and total) is deep-equal before and after.
  - **Not an expense:** `cashExpensesPaise` is unchanged.
  - **Frozen on close:** closing freezes Expected cash with the deposit included, and the variance is counted − (expected − deposit).
  - **Voids:** a void restores Expected cash. A second void gives PS006, and voiding a void gives PS006.
  - **Refusals:**
    - A closed day gives PS007, and so does a running peak.
    - Zero or negative amounts are refused.
    - A reference longer than 200 characters is refused.
  - **Append-only:** UPDATE and DELETE give PS001.
  - **Outbox:** the insert writes an outbox row.
- **`test/server/api.test.ts`:** the three routes, including 404 with no open day.
- **`peak-session` baseline test:** the deposit appears in the baseline terms, and the terms still add up.
- **Frontend:**
  - `bankDepositReducer.test.ts`: validation, the over-drawer warning, and totals that exclude voided deposits.
  - Updated fixtures for `bankDepositsPaise`.
- **Checks:** `npx vitest run`, `npx tsc --noEmit`, and the frontend build.

## 5. Decisions for approval

| # | Decision | Recommendation |
|---|----------|----------------|
| D1 | Separate `bank_deposits` table vs a generic `cash_movements` with a type | **Separate table.** It mirrors the proven `cash_expenses` shape and leaves expense queries untouched, and there's no third movement type in sight. |
| D2 | Deposit during a running peak | **Refuse (PS007).** Cash drops happen in banking hours, outside the evening peak. Allowing them would mean threading deposits through the peak expected, drawer and derived-split math and its asserts, for no real use. |
| D3 | Deposit larger than Expected drawer cash | **Warn in the UI, don't block in the DB.** The drawer can genuinely hold more than expected (an overage), and a hard block would stop a real deposit. |
| D4 | Placement | **Its own Dashboard tile and screen.** It fills the empty 8th grid slot and keeps deposits visually distinct from expenses, which is the point of the feature. |
| D5 | Reference | **Optional** (as specified), 200 characters at most. |
