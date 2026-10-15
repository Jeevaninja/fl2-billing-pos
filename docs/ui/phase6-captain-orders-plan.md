# Phase 6 — Captain Orders Screen: Component Plan

Status: **APPROVED (2026-10-15), with one change: counter edits are allowed** (see §6). No component code written yet.

Goal: the cashier sees a live list of every OPEN bill created by the Captain app, opens one, and settles it through the standard payment flow.

---

## 1. Placement: a dedicated screen, not the billing screen

**Recommended: a new `CaptainOrdersScreen`, opened from the dashboard's KOTs tile (renamed "Captain Orders").**

Why not load captain bills into `BillingScreen`:
- Its state is built around the cashier's *own* bill: it creates the bill on the first scan, resumes it after a reload, and switches to Peak mode when no bill is open.
- Swapping a waiter's bill into that slot would orphan an open counter bill.
- It would also mix two lifecycles in one reducer.

A separate screen reuses the same building blocks without that coupling: `PaymentDialog`, `payment.ts` routing, `ItemsGrid`, `Modal`, the API client and money helpers.

```
App  view: 'dashboard' | 'billing' | 'captain-orders'
├─ Dashboard               KOTs tile → "Captain Orders" + live count badge (open orders)
├─ BillingScreen           unchanged
└─ CaptainOrdersScreen
   ├─ header               FL2 · CAPTAIN ORDERS · n open · "updated 3s ago" · Esc Dashboard
   ├─ OrderList (left)     one row per open order, oldest first:
   │                       #bill · waiter code/name + TrustBadge · handset · items/bottles · due · age
   │                       new orders flash once; ↑/↓ select; selection survives refreshes
   ├─ OrderDetail (right)  ItemsGrid (read-only) · member · waiter outstanding/limit · paid/due
   │                       [F9 Pay]  (PaymentDialog, unchanged)
   └─ PaymentDialog        existing component; options come from payOptions(detail)
```

Layout sketch at 1366×768:

```
┌ FL2 │ CAPTAIN ORDERS │ 3 open │ updated 2s ago                         │ Esc Dashboard ┐
├──────────── OrderList ~45% ─────────────┬──────────── OrderDetail ~55% ─────────────────┤
│ ▶ #14  W02 Manoj [UNTRUSTED] handset-01  │ Bill #14 · Manoj (W02, untrusted)            │
│        3 bottles · ₹660.00 · 6 min        │ SKU      Item              Size Qty  Amount  │
│   #17  W01 Suresh [TRUSTED]  handset-02   │ HLAG-650 House Lager — 650 650   3  ₹660.00  │
│        1 bottle  · ₹1,800.00 · 2 min      │                                              │
│   #18  W03 Prakash [TRUSTED] handset-01   │ Member: Walk-in      Paid ₹0.00              │
│        5 bottles · ₹2,360.00 · new        │ DUE                     ₹660.00              │
│                                          │ [ F9  Pay ]   Exact Cash or UPI only          │
├──────────────────────────────────────────┴──────────────────────────────────────────────┤
│ ↑↓ select · F9 pay · R refresh · Esc dashboard                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Settlement: the existing flow, unchanged

Captain bills always have a waiter, so `payOptions` / `planPayment` already route them correctly:

| Waiter (trust snapshot on the bill) | Options | API |
|---|---|---|
| Untrusted | Cash or UPI, exact (change shown on screen) | `settleWaiterBill(bill, waiter, CASH\|UPI)` |
| Trusted | Cash, UPI, Partial (part now, rest on credit), Collect later | `settleWaiterBill` step(s), as on the billing screen |

`settleNormalBill` stays the path for counter bills with no waiter. It isn't used here, because every Captain bill has a waiter and trust-aware settlement is what enforces bill-on-bill and credit limits. After a successful settle, the screen shows the same receipt banner (total, how it was paid, change), and the order leaves the list on the next refresh, which happens immediately.

## 3. Live updates

- Poll `GET /api/captain-orders` every **5 s** while the screen is mounted, and immediately after every settle. The dashboard badge polls every 15 s.
- Polling is simple, works through the Vite proxy, and costs a few small local requests per minute. Server-Sent Events can replace it later without changing the screen.
- **Diffing:** the list is replaced wholesale, and the selection is kept by bill id. An order seen for the first time gets a one-shot highlight and the scan beep. If the selected order vanishes (settled at another terminal), the selection moves to the next row with a note.

## 4. Backend additions (small)

| Change | Where |
|---|---|
| `CounterQueries.listCaptainOrders(): BillDetail[]`: OPEN sale bills with `source = 'WAITER_APP'`, oldest first | `src/services/counter-queries.ts` |
| `GET /api/captain-orders` on the **loopback counter API** (cashier-facing, so not on the Wi-Fi server) | `server/app.ts` |
| Frontend `Bill` type gains `source` and `captainDeviceId` | `frontend/src/api/types.ts` |
| `counterErrorMessage` learns `PS010` | `frontend/src/billing/errors.ts` |

## 5. State and keyboard

`captainOrdersReducer` (pure, unit-tested):
- **State:** `{ orders: BillDetail[]; selectedId; seenIds: Set; lastUpdated; load: 'loading' | 'ready' | 'offline'; dialog: 'payment' | null; receipt; flash }`
- **Actions:** `ordersLoaded` (keep selection, mark new ids), `select` / `move`, `dialog`, `settled(receipt)`, `failed`.

| Key | Action |
|---|---|
| ↑ / ↓ | Select an order (or a line, when the detail grid has focus; see §6) |
| F9 or Enter | Pay the selected order (`PaymentDialog`) |
| R | Refresh now |
| `−` / Delete, F2 | Cancel one bottle / member (§6) |
| Esc | Close the dialog, or go back to the dashboard |

There is no scan buffer on this screen: nothing is scanned here.

## 6. Counter edits before settling (approved)

The cashier can correct a Captain order before settling it, for example when a bottle is out of stock or dropped.

| Key | Action | API |
|---|---|---|
| ↑ / ↓ on the detail grid | Select a line (Tab moves focus between the order list and the detail grid) | — |
| `−` / Delete | Cancel one bottle of the selected line (restocks by default) | `cancelBillItem` → `POST /api/bills/:id/items/:itemId/cancel` |
| F2 | Attach, swap or clear the member (`MemberDialog`, reused) | `setBillMember` → `PUT /api/bills/:id/member` |

Rules already enforced by the backend:
- Lines can't be cancelled once any tender is recorded (`PS002`), for example after a trusted waiter's partial payment.
- Settled bills are frozen (`PS001`).

The UI disables `−` in those cases and shows the reason. Cancelling every line leaves a ₹0 bill, which the screen offers to close with `closeEmptyBill`.

Still out of scope: adding new lines at the counter, reprinting a KOT, and per-handset filters.

Additional tests:
- Reducer: the selected line survives a refresh.
- End to end: cancel a line of a Captain order and see the total and stock change, attach a member, then settle.

## 7. Tests and verification

- **Unit (frontend Vitest):** `captainOrdersReducer` covers keeping the selection across refreshes, new-order detection, a vanished selection, and the settle/receipt transition. Payment routing is already covered.
- **Backend:** `listCaptainOrders` and the route test that only OPEN `WAITER_APP` bills appear, oldest first, and that settled and counter bills are excluded.
- **End to end:** restart `npm run api:dev` and `npm run dev`, then pair a dev handset into `.data/captain-devices.json`. In headless Chrome (real keys):
  - Place orders through the Captain server with the token, and confirm they appear within one poll.
  - Settle an untrusted order with exact cash and a trusted one with collect later, then confirm both leave the list and the waiter balances are right.
  - Confirm the dashboard badge count.
