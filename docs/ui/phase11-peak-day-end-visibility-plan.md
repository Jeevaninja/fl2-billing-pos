# Phase 11 — Peak Start Baseline & Day End Sales Breakdown — Component Plan

Status: **IMPLEMENTED (2026-10-17)**. Approved with the recommended choices A–D (§4). No schema change; no migration.

Changes from the plan as written:
- **Service shape:** `getDayFigures(db, day)` in `day-end.service.ts` builds the cash breakdown, the sales breakdown and the per-peak split; `DayEndService.getDayEndSummary` and `PeakSessionService.getStartBaseline` both call it.
- **Running window:** tenders and repayments taken inside a still-running peak are left out of the sales card (and the baseline UPI) until it ends, so the UPI identity holds mid-peak too.
- **Day End pane:** on an open day the right-hand pane is titled "Sales & cash count".

Goal:
1. The **Start a peak session** dialog shows the till's expected cash and UPI *before* the cashier types the readings.
2. **Day End** gains a **Sales breakdown** card that shows how the day's revenue was collected: normal bills by tender, and peak sales split into derived cash and UPI.

The existing **Cash count** block and its maths, `pos_day_expected_cash` and the frozen close figures are all left as they are.

---

## 0. What already exists

- **`pos_day_expected_cash(day)`** is the drawer figure Day End reconciles against:
  - opening float
  - \+ CASH bill tenders outside peak windows
  - \+ Σ ended peaks' (end cash − start cash)
  - \+ CASH waiter repayments outside peaks
  - − expenses outside peaks
- **`DayEndService.summarise`** rebuilds that figure term by term in `CashBreakdown` and checks it against the SQL. It also reports `upiTotalPaise`: bill UPI + waiter UPI outside peaks + Σ peak UPI deltas.
- **A peak session's own variance** reconciles cash and UPI together:
  - **expected** = peak bill totals + every CASH/UPI tender and waiter repayment taken inside the window − expenses inside it
  - **actual** = cash Δ + UPI Δ
- **Normal bills** carry tenders (`CASH | UPI | WAITER_CREDIT`, with refunds negative). **Peak bills** carry none.
- **`PeakStartDialog`** (`components/peak/PeakControls.tsx`) is opened from the Dashboard and Billing screens. It shows only the two reading fields.

## 1. Backend

### 1.1 One shared "day collections" query (`day-end.service.ts`)

The sums query inside `summarise` moves into an exported helper, `dayCollections(db, dayId)`:
- It returns the per-tender sums **inside and outside** peak windows, together with the ended sessions' readings and sales.
- Day End and the new peak baseline both read from it, so the two screens can't disagree.

### 1.2 Peak start baseline (Requirement 1)

`PeakSessionService.getStartBaseline(businessDayId)` → `PeakStartBaseline`:

| field | value |
|---|---|
| `openingFloatPaise` | day float |
| `normalCashPaise` | CASH bill tenders outside peaks |
| `waiterCashPaise` | CASH waiter repayments outside peaks |
| `peakCashPaise` | Σ earlier ended peaks' counted cash Δ |
| `cashExpensesPaise` | expenses outside peaks |
| **`expectedCashPaise`** | = `pos_day_expected_cash(day)` (asserted equal to the sum of the above) |
| `billUpiPaise` | UPI bill tenders, whole day |
| `waiterUpiPaise` | UPI waiter repayments, whole day |
| `peakUpiPaise` | Σ earlier peaks' UPI attributed to peak sales (see 1.3) |
| **`expectedUpiPaise`** | sum of the three; equals Day End's `upiTotalPaise` |

- **Route:** `GET /api/peak/baseline` reads the open day. With no day open it returns 404, the same way `/api/expenses` handles it.
- **Read-only.** Nothing is stored on the session, because the cashier's declared readings stay the record.

### 1.3 Sales breakdown (Requirement 2)

`DayEndSummary` gains `sales: SalesBreakdown`, and every `PeakSessionCash` row gains the per-session figures.

```ts
interface SalesBreakdown {
  normal: { cashPaise; upiPaise; creditPaise; totalPaise }  // all tenders on normal bills today, refunds included
  peak:   { salesPaise; cashPaise; upiPaise; sessionCount; runningSessionNo: number | null }
  waiterRepayments: { cashPaise; upiPaise }                 // credit collected — money in, not sales
  total:  { cashPaise; upiPaise; creditPaise; salesPaise }  // normal + peak
}
// PeakSessionCash gains: salesPaise, inWindowUpiPaise, peakUpiPaise, peakCashPaise
```

**How each ended session is derived:**

- `salesPaise` = Σ `bills.total_paise` of the session's peak bills. In-session reversals are included and are negative.
- `peakUpiPaise` = UPI Δ − UPI recorded inside the window (bill UPI tenders + waiter UPI repayments). **Decision A**
- `peakCashPaise` = `salesPaise − peakUpiPaise`, as specified.

**What the session totals cover:**
- Only **ended** sessions are counted. A running session is named in `runningSessionNo` and appears once it ends; it already blocks the close.
- Normal-bill tenders taken *during* a peak count under **Normal** in this card, because their tender is known. In the Cash count they still sit inside the peak's cash Δ, so the two blocks' "normal cash" lines can differ by exactly those tenders. That difference is correct, and the card's footnote explains it.

**Balance identities, asserted in the service and covered by tests:**
1. Per session: `peakCash + peakUpi = sales`.
2. Per session: `peakCash = cashΔ − in-window cash tenders − in-window waiter cash + in-window expenses − variance`. In other words, the variance lands in cash, and the cash count is unaffected.
3. `total.upi + waiterRepayments.upi = breakdown.upiTotalPaise`. Day End's existing UPI line and the new card always agree.
4. With every bill of the day settled or reconciled: `total.salesPaise = Σ total_paise of the day's bills`.

Rule 4 runs only in the tests; the other rules also run in the service. A broken rule throws, just as the existing breakdown-vs-SQL check does.

## 2. Frontend

### 2.1 `PeakStartDialog`

On mount it calls `api.peakBaseline()`. Above the two fields it shows two read-only figure blocks:

```
Expected cash in drawer        ₹12,450.00
  float 2,000 + cash sales 9,800 + waiter cash 1,000 + earlier peaks 0 − expenses 350
Expected UPI so far             ₹6,200.00
  bills 5,700 + waiter 500 + earlier peaks 0
─────────────────────────────────────────
Cash in the drawer now   [ 12,400 ]   ₹50.00 short of expected      ← Decision D
UPI reading now          [  6,200 ]   matches expected
```

- **While loading:** the figures show "…".
- **If the request fails:** the dialog shows "Expected figures unavailable", and the cashier can still start the peak.
- **Keys:** keyboard flow is unchanged (Enter: cash → UPI → start).
- **Pure helper:** `peakMath.compareReading(typed, expected)` returns `short | over | match | none`, with tests.

### 2.2 Day End: `SalesBreakdown` card

**Open day:** the card goes at the top of the right-hand pane, above the Cash count.
**Closed day:** it goes under `ClosedDayCard` in the left pane.

```
SALES BREAKDOWN                    Cash        UPI     Credit      Total
Normal bills                   9,800.00   5,700.00   1,500.00  17,000.00
Peak sales (2 sessions)        7,300.00   4,100.00          —  11,400.00
───────────────────────────────────────────────────────────────────────
Total sales                   17,100.00   9,800.00   1,500.00  28,400.00
Waiter repayments              1,000.00     500.00   (credit collected, not sales)
```

- **Footnote:** "Peak UPI is the UPI reading's movement less UPI taken on bills and repayments during the peak. Peak cash = peak sales − peak UPI; any peak variance stays in the cash count."
- **Running session:** the hint reads "Peak #3 is still running — its sales appear once it ends."
- **Peak drill-down:** the per-session list in the checklist gains a sales column next to the cash Δ, UPI Δ and variance it already shows.
- **Warning:** if a session's derived peak cash is below zero (its UPI readings exceed its sales), that row shows an amber "check the UPI readings" note.
- **Pure helper:** `dayend/salesRows.ts` builds the table rows, with tests.

## 3. Tests

**Backend** (`test/services/day-end.service.test.ts`, `peak-session.service.test.ts`, `test/server/…`):
- **Baseline:**
  - `expectedCash` equals `pos_day_expected_cash`.
  - `expectedUpi` equals the day's `upiTotalPaise`.
  - It covers a day with an earlier ended peak.
- **Sales breakdown scenario:**
  - Normal cash, UPI and credit bills.
  - A waiter repayment.
  - Two peaks, with these inside one window: a normal-bill UPI tender, a waiter cash repayment, an expense, a peak reversal, and a deliberate variance.
  - All four identities from §1.3 are asserted.
- **Edge cases:** a running session is excluded; a day with no peaks; negative derived peak cash is reported, not clamped.
- **API:** `GET /api/peak/baseline` returns 200 with an open day and an error without one. `/api/day-end` carries `sales`.

**Frontend:** `compareReading` and `salesRows`.

**Verification:** `npx vitest run`, `npx tsc --noEmit`, and frontend test, `tsc -b`, lint and build. Then a headless E2E: start a peak, read the baseline, end the peak, check the Day End card.

## 4. Decisions

- **A. How peak UPI is derived.** *Recommended:* UPI Δ **minus the UPI that was recorded inside the window** (normal-bill UPI tenders and waiter UPI repayments taken during the peak). Those payments move the GPay reading too. Taking Σ UPI Δ as it stands would count them twice, once under Normal and again under Peak. *Alternative:* the literal Σ UPI Δ.
- **B. What "Expected UPI so far" covers.** *Recommended:* **all UPI recorded today**, which is bill UPI + waiter UPI repayments + earlier peaks' UPI. That is the figure the GPay business app's day total should show, and it matches Day End's existing UPI line. *Alternative:* UPI from normal bills only, as the spec reads.
- **C. Earlier peaks in "Expected cash in drawer".** *Recommended:* include the counted cash Δ of earlier ended peaks, which is exactly `pos_day_expected_cash`. Without it, the second peak of the evening would start from a figure that is too low by the whole first peak's takings.
- **D. Live comparison at peak start.** *Recommended:* yes. Under each field, show "₹50.00 short of / over expected" or "matches" as the cashier types. It is display only, and nothing is stored or blocked.
