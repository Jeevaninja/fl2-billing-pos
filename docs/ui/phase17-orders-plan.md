# Phase 17 — Orders Screen (Bill-Wise Tracking) — Plan

Status: **IMPLEMENTED (2026-10-18)**. D1 was changed by the user (see below); D2–D4 are as recommended. **No migration.**

**As built, differences from this plan:**
- **ASCII receipts:** text is folded to ASCII (`asciiText`: em dash → "-", accents dropped), because thermal code
  pages are ASCII-only.
- **No size suffix:** item lines print the catalog name only, since it already includes the size.
- **Waiter lump sums:** a tender that was one slice of a lump sum carries `receiptTotalPaise`, so the settlement
  reads "₹600 UPI from a ₹2,000 waiter payment (Waiter Ledger)".
- **Settled filter:** it includes reconciled peak bills, shown under their session row.

**D1 as approved:** Inventory Catalog leaves the module grid and moves into a **Settings** gear menu in the
dashboard header. **Orders** takes the Catalog tile's slot, so the grid stays 4×2 and keeps the Reports stub. The
Settings menu is also where the custom expense categories UI will go (`docs/roadmap.md`).

## 0. What exists

- **Bills on the open day:**
  - NORMAL counter bills (OPEN → SETTLED; a ₹0 bill closed after cancelling every line is SETTLED at ₹0)
  - Captain-app bills (same statuses)
  - PEAK bills: one bill per scan, `PEAK_UNSETTLED` while the session runs, `PEAK_RECONCILED` after it ends
- **A void** is a linked REVERSAL bill (`reverses_bill_id`) with negative lines and refund tenders. The peak undo
  (Ctrl+Z) also writes one.
- **Tenders:** `bill_payments` rows (CASH / UPI / WAITER_CREDIT). Waiter-ledger lump sums land there as ordinary
  tenders, written in one transaction.
- **Printing:** only a KOT formatter (`formatKot`) and a stub sink (console). There is no receipt format or receipt
  printer yet.
- **Dashboard:** 8 tiles in a full 4×2 grid. **Reports** is still a stub.
- **Billing tabs (Phase 15):** this till's open NORMAL counter bills are restored as tabs from
  `/api/context.openBills`.

## 1. Bill status shown on the Orders screen (derived, never stored)

| Status | Rule |
|---|---|
| **Open** | `OPEN` (a part-paid bill shows its due) |
| **Settled** | `SETTLED`, total > ₹0, not reversed |
| **Cancelled** | `SETTLED` at ₹0 (every line cancelled, then closed) |
| **Voided** | Has a REVERSAL bill (any mode). Shows the void time, the reason, and the refunds |
| **Peak · pending** | `PEAK_UNSETTLED`: the session is still running |
| **Peak · reconciled** | `PEAK_RECONCILED`: counted with its session's cash and UPI at session end |

REVERSAL bills are not rows of their own: each one is folded into the bill it voids.

## 2. Backend

**`OrdersQueries`** (new, `src/services/orders.queries.ts`, read-only) has two methods.

**`listOrders(): OrderSummary[]`** returns the open day's SALE bills, newest first. One aggregate query covers bills,
lines, tenders and the reversal; no per-bill round trips.

```ts
interface OrderSummary {
  billId: string; billNo: number; createdAt: Date; settledAt: Date | null
  status: 'OPEN' | 'SETTLED' | 'CANCELLED' | 'VOIDED' | 'PEAK_PENDING' | 'PEAK_RECONCILED'
  mode: 'NORMAL' | 'PEAK'; source: 'COUNTER' | 'WAITER_APP'
  waiter: { id; code; displayName } | null; member: { membershipNo; displayName } | null
  peakSessionNo: number | null; createdByStaffId: string
  lines: number; bottles: number
  totalPaise; cashPaise; upiPaise; creditPaise; duePaise   // tender sums, refunds left out
  voidedAt: Date | null
}
```

**`getOrder(billId): OrderDetail`** returns:
- the bill's `BillDetail` (lines, payments, member, waiter)
- `peakSession` (`sessionNo`, `endedAt`)
- `reversal` (`billNo`, `at`, `reason`, `refunds[]`)
- `settledVia`: `'COUNTER' | 'WAITER' | 'PEAK' | null`

A bill counts as settled `WAITER` when it carries a waiter and was paid through the waiter flows (Waiter Ledger /
settle-waiter); otherwise it is `COUNTER`.

**Routes:**

| Route | → |
|---|---|
| `GET /api/orders` | `listOrders` (open day; `[]` when none) |
| `GET /api/orders/:billId` | `getOrder` (404 for an unknown bill) |
| `POST /api/orders/:billId/reprint` | D3: formats a **DUPLICATE** receipt, sends it to the printer sink, returns the text |

**Receipt formatter:** `formatReceipt` in `printer.service.ts`. It is pure and unit-tested, in the same fixed-width
style as `formatKot` (48 / 32 columns). It prints:
- the bill no and time, the waiter and member
- the lines: qty × name, size, amount
- the total, the tenders, and any due
- "DUPLICATE" and the reprint time

There is no GST line (CLAUDE.md: no tax engine).

## 3. Frontend — `OrdersScreen`

- **Tile:** "Orders", in Inventory Catalog's old grid slot (D1 as approved). App view `'orders'`; Esc returns to the dashboard. Inventory Catalog opens from the header **Settings** gear menu.
- **Top bar (filters):** chips **All (A)**, **Open (O)**, **Settled (S)**, **Peak (P)** and **Voided (V)**, then a
  **Waiter** picker (W). The picker is a small list of the waiters with bills today, plus "Any waiter".
  - Typing digits jumps to a bill number (`#57`, Enter).
  - Counts sit on each chip: "Open 4", "Peak 132".
  - **Settled** includes Cancelled. **Voided** is a fifth chip, because a void is worth finding fast.
- **Left pane (master list):** newest first. Each row shows bill no, time, who (waiter name, or Counter, or handset,
  or Peak #n), bottles, total, and a status chip. Peak bills are summarised per D2.
- **Right pane (detail):**
  - header: bill no, status chip, time, source, cashier, member
  - **itemised receipt:** SKU code, item, size, qty, price, amount. Cancelled lines are struck through, so the
    audit trail is visible.
  - **settlement breakdown**, one sentence each, from a pure helper:
    - "Paid ₹1,200.00 by UPI · 20:41"
    - "₹2,000 cash in a waiter lump sum (Waiter Ledger)"
    - "₹650 on W01's collect-later credit"
    - "Unsettled · ₹310.00 due"
    - "Peak sale — reconciled with Peak #2's cash/UPI count"
    - "Voided 21:05 · wrong bottle · refunded ₹220 cash"
- **Actions:**
  - **Reprint (F8, D3)** shows the receipt text in a modal and sends it to the printer sink.
  - **Jump to bill (Enter / F9), Open bills only** (D4).
- **Polling:** every 10 s, keeping the selection and filter. ↑/↓ moves through the list.

**Pure, unit-tested helpers** (`orders/ordersView.ts`):
- `filterOrders(orders, filter, waiterId)`
- `chipCounts`
- `groupPeak` (D2)
- `whoLabel`
- `settlementLines(detail)`
- `jumpTarget(order, cashierId)`

## 4. Jump to Bill

`jumpTarget` decides where an Open bill goes:

| Open bill | Goes to |
|---|---|
| This till's NORMAL counter bill (tagged to a waiter or not) | **Billing** with `focusBillId`. On load, its tab becomes active. A new reducer action `focusBill` picks the tab that holds that bill after resume. |
| Captain-app bill | **Waiter Ledger**, with that waiter and that bill highlighted (`focus` prop). |
| Another till's counter bill | Disabled: "Held on another till". With one fixed cashier per till this can't happen today, but the rule covers it. |

## 5. Decisions for approval

- **D1 — Where the tile goes. Recommended: replace the Reports stub with Orders**, which keeps the 4×2 grid.
  Reports comes back when it is built. *Alternative:* a 9th tile, with the grid changed to 3×3.
- **D2 — Peak bills in the list. Recommended: one summary row per peak session** in All / Settled / Voided, e.g.
  "Peak #2 · 18:00–20:30 · 132 bills · 214 btl · ₹48,200 · reconciled". Enter or a click expands it into its
  bills. The **Peak** filter lists every peak bill individually. A voided peak scan still shows as its own row
  under **Voided**. *Alternative:* every peak bill always gets its own row (long lists on busy nights).
- **D3 — Reprint. Recommended: stateless DUPLICATE reprint**, which is a preview plus a send to the printer sink.
  Today that sink is the console stub, like KOT; the ESC/POS printer plugs in later. *Alternative:* an append-only
  `bill_reprints` audit log (migration 0012) with "DUPLICATE #n" and a reprint count on the bill. That is useful
  against reprint misuse, but it is a schema change.
- **D4 — Jump targets as in §4. Recommended.** Captain-app orders open in the Waiter Ledger, because they are never
  billing tabs.

## 6. Tests

**Backend** (`test/services/orders.queries.test.ts`, PGlite) builds one day with:
- an open bill, a part-paid bill, a cash-settled bill, a UPI-settled bill
- a ₹0 cancelled bill
- a voided bill (reversal with refund)
- a Captain-app bill settled through the Waiter Ledger lump sum
- a waiter-credit bill
- peak bills in a running session and in an ended session, including one undone with Ctrl+Z

It asserts:
- each status
- the tender sums, due and bottles
- newest-first order
- REVERSAL bills folded into their original
- `settledVia`
- a previous day's bills left out

`formatReceipt` gets a fixed-text test. The API test covers the three routes, with paise as strings.

**Frontend** (`orders/ordersView.test.ts`):
- each filter and waiter filter, including Settled ⊇ Cancelled and Peak listing every peak bill individually
- chip counts
- peak grouping and its totals
- `settlementLines` wording for every case
- `jumpTarget`

Billing reducer: `focusBill` after a resume activates the right tab.

**Verification:** `npx vitest run` and `npx tsc --noEmit` (root), then `npm test`, `npx tsc -b`, `npx oxlint src` and
`npm run build` (frontend). Then a headless-Chrome pass (filters, detail, reprint preview, jump into a billing tab),
and an update of the state docs.
