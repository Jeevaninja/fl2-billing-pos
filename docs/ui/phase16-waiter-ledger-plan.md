# Phase 16 — Waiter Ledger (Captain Orders) & Strict Day End — Plan

Status: **IMPLEMENTED (2026-10-18)**. Approved with the recommended D1–D4. No migration.

**As built, differences from this plan:**
- **No inline expansion:** the lines of the highlighted bill show in a panel below the open-bill list, so Enter
  settles rather than expands. Tab moves between the waiter list, the bill list and that panel.
- **F9 with nothing ticked** settles the highlighted bill.
- **Day End wording:** the old waiter row now reads "collect-later credit", so it no longer shows green while
  open waiter bills are still owed.

## 0. What already exists

- **Waiter bills** are sale bills with `waiter_id`, from the Captain app or tagged at the counter. They stay `OPEN`
  until settled with `settleWaiterBill` (CASH / UPI / WAITER_CREDIT, one bill at a time).
  - Trusted waiters may part-pay a bill and put the rest on WAITER_CREDIT (collect later).
  - Untrusted waiters are bill-on-bill: exact amount only, no credit.
- **The waiter ledger already exists** (`waiter_ledger_entries`, trigger-maintained `waiters.outstanding_balance`):
  - A WAITER_CREDIT tender posts `BILL_CREDIT` (+).
  - A repayment (`waiter_payments`) posts `PAYMENT` (−).
  - The balance can't go below ₹0 (`PS008`).

  Today the ledger holds only the **credit** part of what a waiter owes. Open bills are owed too, but they live on
  the bills themselves.
- **Day End is already strict on the server.** The close trigger refuses (`PS007`) while any bill of the day is
  OPEN, or any waiter has `outstanding_balance > 0`. The checklist lists open bills and owing waiters (with
  "Repayment…"). What is missing is a single **total** of what waiters owe.
- **Captain Orders today** is an order queue: OPEN Captain-app bills only. You can select an order, edit its lines
  (− remove one bottle, X broken), attach a member, and settle one order at a time with the payment dialog.

## 1. What a waiter "owes" (one definition, used everywhere)

For the open business day:

| Figure | Definition |
|---|---|
| **Billed** | Σ totals of the day's sale bills tagged to the waiter, not reversed (counter and Captain app, open or settled) |
| **Paid** | Σ CASH / UPI tenders on those bills + Σ the day's waiter repayments (net of voids) |
| **Balance** | Σ due on the waiter's OPEN bills (total − tendered) + `outstanding_balance` (credit not yet repaid) |

- **Billed − Paid = Balance** holds by construction for normal flows. The tests assert it for the 3-bill scenario
  in §6.
- Balance is what Day End must see at **₹0**.

## 2. Backend (no schema change)

**Read side, in `CounterQueries`:**
- **`listWaiterLedger(): WaiterLedgerRow[]`:** every waiter with a bill today or a balance above ₹0. Each row has
  `WaiterSummary` plus `billedPaise`, `paidPaise`, `balancePaise`, `openBills` and `newestOpenAt`. Waiters who owe
  come first, largest balance first, then by code.
- **`getWaiterLedger(waiterId): WaiterLedger`:**
  - the row above
  - `openBills: BillDetail[]`, oldest first: the waiter's OPEN bills on any source, with lines
  - `creditPaise` (`outstanding_balance`)
  - `receipts`: today's money from the waiter, newest first. Each receipt has its time, tender, amount and
    allocation (`→ #44 settled`, `→ #45 part, ₹240 left`, `→ credit balance`).

  One lump sum writes several rows in **one transaction**, and they share Postgres `now()`. So a receipt is the
  rows of one waiter with the same tender and timestamp, and no linking column is needed.

**Write side, in `WaiterService`:** both methods are atomic, take a row lock on the waiter, and are refused
(`PS007`) with no open day.
- **`settleWaiterBills(waiterId, billIds, tender, staffId)`** (Mode A):
  - Each selected bill is settled for **exactly** its due, with one tender: CASH, UPI, or WAITER_CREDIT for trusted
    waiters only.
  - Every bill must be OPEN and tagged to the waiter (`PS002`).
  - Works for untrusted waiters too: whole bills are bill-on-bill.
  - Any failure rolls back every bill.
- **`receiveWaiterPayment(waiterId, amount, tender: CASH|UPI, staffId)`** (Mode B):
  - Trusted waiters only (D2).
  - `amount` must be at most the balance. Anything more is refused (`PS008`, "owes only ₹X"), so no change is ever
    owed back by the system.
  - Allocation (D1) goes oldest OPEN bill first. Each bill is settled while the money covers its due; the next bill
    is part-paid (it stays OPEN). Anything left over is a `waiter_payments` repayment against the credit balance.
  - It returns the allocation and the new balance.

**Routes:**

| Route | Body | → |
|---|---|---|
| `GET /api/waiter-ledger` | | `listWaiterLedger` |
| `GET /api/waiter-ledger/:waiterId` | | `getWaiterLedger` |
| `POST /api/waiters/:waiterId/settle-bills` | `{ billIds: string[], tender }` | `settleWaiterBills` · 201 |
| `POST /api/waiters/:waiterId/receive` | `{ amount, tender }` | `receiveWaiterPayment` · 201 |

**Day End, in `day-end.service.ts`:** `DayEndBlockers` gains a waiter-balance total:

```ts
waiterBalance: { totalPaise: Paise; openBillsPaise: Paise; creditPaise: Paise; waiters: number }
```

- `openBillsPaise` is Σ due on OPEN waiter bills, and `creditPaise` is Σ `outstanding_balance`.
- `canClose` also requires `totalPaise === 0n`. The close trigger already enforces both parts, so the DB stays the
  last line of defence and no trigger change is needed.

Peak math is untouched. Bill tenders and repayments taken during a peak already count inside its window.

## 3. Frontend — Captain Orders becomes the Waiter Ledger

The same tile, renamed **"Waiter Ledger"**. The header shows "n waiters owe ₹X" and polls every 5 s, as now. A new
Captain-app order still tints and beeps.

**Left pane: waiter list**
- Each row shows code, name, `TrustBadge`, **Owed** (billed), **Paid**, **Balance** (amber above ₹0, green at ₹0),
  and an "n open" chip.
- ↑/↓ moves through the list. A new order bumps its waiter's row with a dot.

**Right pane: the selected waiter's ledger**
- **Summary strip:** Billed · Paid · **Balance**, plus "of which on credit ₹Y".
- **Open bills** (oldest first):
  - Each row has a checkbox, `#billNo`, source (App / Counter), bottles, time and due.
  - Space toggles a checkbox and A selects all. The footer reads "2 selected · ₹1,850".
  - **Settle Selected (F9)** opens a small confirm with C / U (and L "collect later" for trusted waiters), then
    Enter.
- **Bill detail (D3):** Enter on a bill row expands its lines with today's actions: − remove one bottle (restock),
  X broken, member (F2). They are disabled once the bill has a part-payment, as now.
- **Receive Payment (F7), trusted waiters only:**
  - a `RupeeField` with C / U for the tender, and a live preview of the allocation, e.g. "#44 settled · #45 ₹760 of
    ₹1,000 · balance after ₹1,240"
  - over the balance it shows "owes only ₹X"
  - for an untrusted waiter the box is replaced by "Bill-on-bill: settle whole bills"
- **Today's payments:** receipts newest first, each with time, tender, amount and its allocation lines.

**Pure helpers, unit-tested** (`captain/waiterLedger.ts`):
- `allocate(openBills, amount)`: the same rule as the server, used for the preview.
- `selectionTotal`
- `receiveError` (blank, ≤ ₹0, over the balance, untrusted)
- the list / selection reducer: keep the selection across polls, and move it when a waiter drops out

## 4. Frontend — Day End

- **Checklist:** a new first row, red while the total is above ₹0:
  **"Waiters owe ₹X — All waiter balances must be settled to ₹0 before closing."** Below it: "₹A on open bills ·
  ₹B on credit", and a button **→ Waiter Ledger**.
- **The per-waiter rows stay.** "Repayment…" stays too, as a quick path for credit-only balances.
- **`lockBlock`:** returns that sentence while `waiterBalance.totalPaise > 0n`, before the generic "clear n items".
  Confirm & Lock stays disabled, and F9 / Enter do nothing.

## 5. Decisions for approval

- **D1 — Where a lump sum goes. Recommended: oldest open bills first, then the credit balance.**
  - The money still lands on bills as CASH / UPI tenders. Day End's Normal cash / UPI, the sales breakdown and the
    peak windows keep reading it as sales, and bills close as they are paid off.
  - Each receipt is shown as one payment with its allocation beneath.
  - *Alternative:* first move every open bill onto waiter credit, then post the lump sum as one repayment. That is
    a literal "billed − paid" ledger, but it has three costs. Cash sales would show as credit sales plus credit
    collected. Credit limits would refuse the conversion. And it needs trust, so it fails for untrusted waiters.
- **D2 — Lump sums for trusted waiters only. Recommended.** CLAUDE.md says "untrusted: strict bill-on-bill". An
  untrusted waiter uses Mode A (whole bills, exact amounts).
- **D3 — Keep line editing** (− / X / member) on Captain-app bills inside the ledger. **Recommended**, otherwise
  Phase 6's order editing is lost.
- **D4 — Settling counter-tagged bills here too. Recommended.** The ledger shows **all** of a waiter's bills
  (Captain app and counter-tagged), so the balance is complete. Captain Orders today shows app orders only.

## 6. Tests

**Backend** (`test/services/waiter-ledger.test.ts`, PGlite) runs the requested scenario:
1. Trusted W01 racks up 3 bills.
2. Day End is blocked: `waiterBalance.totalPaise` equals Σ dues, `canClose` is false, and `closeBusinessDay` gives
   PS007.
3. A ₹2,000 lump sum settles #1, part-pays #2, and leaves #3. The balance, Billed − Paid = Balance, and the receipt
   allocation are checked.
4. Day End is still blocked with the reduced total.
5. Mode A settles the rest.
6. The balance is ₹0, and the day closes with expected cash including all of it.

Also covered:
- Mode A is atomic: one foreign or settled bill rolls back all of them.
- WAITER_CREDIT is refused for an untrusted waiter.
- A lump sum is refused for an untrusted waiter, and when it is over the balance.
- A lump sum spills into the credit balance after the open bills.
- A lump sum during a peak lands in the peak window.
- `listWaiterLedger` ordering and figures.

**API:** the four routes, with paise as strings.

**Frontend:** `allocate`, `selectionTotal`, `receiveError`, the ledger reducer, and Day End `lockBlock` /
`blockerCount` with the waiter-balance blocker.

**Verification:** `npx vitest run` and `npx tsc --noEmit` (root), then `npm test`, `npx tsc -b`, `npx oxlint src` and
`npm run build` (frontend). Then a headless-Chrome pass over the ledger and Day End, and an update of the state
docs.
