# Phase 27 — EA Scanner Waiter Order Flow & Local POS Integration — Schema + Component Plan

Status: **IN PROGRESS (2026-10-22)**. D1–D8 were approved as recommended.

**Built:**
- migration `0020_captain_rounds`
- the `CaptainService` additions and the five handset routes
- the mobile app's Captain Mode (`FL2 Club Mobile ERP/mobile-app`, commit `d2d00ab`): POS settings with the waiter
  picker, Active Bills, Order Entry and bill detail, checked live against this server on a scratch database

**Still to build:**
- the counter's "Settle requested" badge (§2; the API already returns `settleRequestedAt`)
- the end-to-end check on a device

Changes from the plan as written:
- **Member lookup** is `GET /api/captain/members/lookup?code=…`, not `/members/by-code/:code`. The router passes
  path params through undecoded because they are always UUIDs, and a card number isn't one.
- **POS settings** store the waiter's POS UUID plus their code and name. A free-text waiter left over from the
  uncommitted 2026-10-15 build reads as unset. Changing the server address clears the waiter.
- **Member link (D3):** a code the POS doesn't know stops the send with a message instead of sending without a member;
  the waiter fixes the code or clears it. Only a new bill takes a member: a round has no member field.
- **A round prints everything pending** at the BAR and KITCHEN for that bill. That includes any liquor line the
  counter added to the same waiter bill without a KOT.

This phase touches two repos:
- **POS** (`fl2-billing-pos`): new Captain API routes, plus one migration (`0020_captain_rounds`).
- **Mobile** (`FL2 Club Mobile ERP/mobile-app`, Expo SDK 57, Expo Router, Jest): the ordering screens.

Goal: a waiter's handset (the EA Scanner app in Captain Mode) does four things over the club's Wi-Fi:
- browse the live catalog
- send orders that print as KOTs at the bar and kitchen
- see the waiter's running bills and add rounds to them
- ask the counter to settle a bill

---

## 0. What already exists (and changes the brief)

**POS server — most of the order back end is already built (Phases 5, 6, 16, 19, 21).**
- `server/captain-server.ts` is a separate Wi-Fi-facing server on **port 4311** (`FL2_CAPTAIN_PORT`). It serves
  only `/api/captain/*`, and every request must carry `Authorization: Bearer <device token>`. Tokens come from
  `npm run captain:devices -- pair handset-01 "Captain 1"`, and the server stores only their SHA-256. The server
  starts only once at least one handset is paired.
- Captain routes today (`server/captain-api.ts`):
  - `GET /api/captain/health`
  - `GET /api/captain/waiter/:waiterId`: profile, trusted flag, credit headroom
  - `GET /api/captain/waiter/:waiterId/bills`: the waiter's OPEN sale bills as `BillDetail`
  - `POST /api/captain/kot`: **opens a new bill**. Body `{ requestId, waiterId, memberId?, items: [{ skuId, quantity }] }`.
- `CaptainService.placeOrder` does all of the following:
  - It is idempotent on `requestId` (migration `0004`). A replay returns 200 `replayed: true`; a key reused for a
    different order is a conflict.
  - It refuses a short-stock line (`PS003`), and it saves nothing if any line fails.
  - It enforces **bill-on-bill** for untrusted waiters (`PS010`: no second open bill).
  - It splits KOTs by station, BAR or KITCHEN (Phase 19), and prints after commit. A printer failure never undoes
    the order.
- **The KOT and Waiter Ledger parts of requirement 3 are already done.** Bills are tagged to the waiter, and the
  Phase 16 ledger and Phase 6 Captain Orders screen already pick them up.
- **What's missing:**
  - a catalog route
  - a waiter list or lookup by code (routes take the waiter's **UUID**)
  - a member lookup
  - **adding items to an existing bill**
  - any settlement request

  Adding items matters most. Without it, an untrusted waiter can't add a second round at all, because bill-on-bill
  blocks a new bill.
- Money crosses the API as **decimal paise strings** (no floats). Errors look like `{ error: { code, message } }`.

**Mobile app — requirement 1 is already half-built, but it isn't committed (files dated 2026-10-15).**
- `src/captain/posSettings.ts` stores the host IP in AsyncStorage and the device token in **SecureStore**. The port
  is fixed at 4311. IPv4 is validated.
- `src/app/captain/settings.tsx` has Save and Test connection. `src/app/captain/index.tsx` is a placeholder. A
  Captain Mode button sits on the counter header.
- `app.json` adds `expo-build-properties` with `usesCleartextTraffic` (needed for plain http on the LAN).
- `src/auth/posApi.ts` is a client whose shapes are marked "assumed", and **they do not match the server**:

  | Mobile client calls | Server actually serves |
  |---|---|
  | `GET /bills/open?waiter_id=` | `GET /waiter/:waiterId/bills` |
  | `POST /orders` | `POST /kot` |
  | `request_id`, `sku_id` (snake_case) | `requestId`, `skuId` (camelCase) |
  | Waiter ID "W07" (free text) | Waiter UUID |
  | `total: number` | `totalPaise` as a string |

- The app already has the pieces this phase reuses:
  - a `QrScanner` component (it reads member codes such as `CHN01-0042`)
  - a UI kit (`Screen`, `Card`, `SearchField`, `Chip`, `Button`, `StateView`, `StatusBadge`)
  - `newId()` for request keys
  - a Jest setup

**Constraints that shape the brief:**
- **"Table ID".** CLAUDE.md says *no table mapping or restaurant layouts*, and bills have no table column → **D1**.
- **"Member-directory calls remain on Supabase".** The cloud directory is keyed by `uniqueMemberCode`, and POS bills
  need the POS `members.id`. Linking a member is optional and must never block an order (*no mandatory member
  gates*) → **D3**.

---

## 1. Migration `0020_captain_rounds.sql` (POS)

Both tables are append-only (CLAUDE.md: no destructive ops). Both get an UPDATE/DELETE-refusing trigger, the same
way the other ledgers do.

```sql
-- One row per "add items" request on an existing bill. The first order of a bill keeps using
-- bills.request_id (0004), so that path is unchanged.
CREATE TABLE captain_order_rounds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id         uuid NOT NULL CONSTRAINT captain_order_rounds_request_unique UNIQUE,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  bill_id            uuid NOT NULL REFERENCES bills(id),
  waiter_id          uuid NOT NULL REFERENCES waiters(id),
  captain_device_id  text NOT NULL CHECK (captain_device_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  first_line_no      integer NOT NULL CHECK (first_line_no >= 1),
  line_count         integer NOT NULL CHECK (line_count BETWEEN 1 AND 50),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX captain_order_rounds_bill ON captain_order_rounds (bill_id);

-- "Please settle this bill": a flag the counter acts on. It moves no money.
CREATE TABLE bill_settle_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id           uuid NOT NULL REFERENCES bills(id) CONSTRAINT bill_settle_requests_bill_unique UNIQUE,
  waiter_id         uuid NOT NULL REFERENCES waiters(id),
  captain_device_id text NOT NULL,
  requested_at      timestamptz NOT NULL DEFAULT now()
);
```

The `UNIQUE (bill_id)` constraint makes a repeated request harmless: the server returns the existing row.

## 2. Backend (POS)

**`CaptainService`:**
- `listWaiters()`: active waiters only. Fields: id, code, name, trusted.
- `getCatalog()`: every active SKU as a trimmed `SkuLookup`. Fields: id, skuCode, displayName, sizeCode,
  pricePaise, onHandQty, tracksStock, department, itemCategory, saleUnitName. It covers the whole catalog, not the
  50-row `searchSkus` page.
- `findMemberByCode(code)`: matches `members.membership_no` exactly and returns `MemberSummary`, or 404.
- `addToBill({ requestId, deviceId, waiterId, billId, items })` does the following:
  - It is idempotent through `captain_order_rounds`, using the same fingerprint scheme with a `fl2-round-v1` tag.
  - It locks the bill `FOR UPDATE`. The bill must be OPEN and SALE, and tagged to this waiter (`PS002` otherwise).
    The waiter must be active, and every SKU active.
  - Lines go through the existing `insertSaleLine`, so stock rules (`PS003`) and department snapshots are
    unchanged.
  - It is all or nothing.
  - After commit it calls `kots.sendPending(billId, { deviceId }, { stations: ['BAR','KITCHEN'] })`. That prints
    only the quantities not yet sent, which here means just this round.
- `requestSettlement({ deviceId, waiterId, billId })`: same ownership and OPEN checks. It inserts or returns the
  `bill_settle_requests` row.
- `listOpenBills` gains `settleRequestedAt` on each bill. So does `CounterQueries.getBillDetail`, so the counter can
  see it too.

**Routes (`captain-api.ts`), using the existing JSON conventions:**

| Route | Purpose |
|---|---|
| `GET /api/captain/waiters` | waiter picker in Settings (D2) |
| `GET /api/captain/catalog` | order grid |
| `GET /api/captain/members/by-code/:code` | optional member link (D3) |
| `POST /api/captain/bills/:billId/items` | add a round: `{ requestId, waiterId, items }` → `{ bill, items, kots, replayed }` |
| `POST /api/captain/bills/:billId/settle-request` | `{ waiterId }` → `{ bill, requestedAt, alreadyRequested }` |

The existing `/kot` and `/waiter/:id/bills` routes are kept as they are.

**Counter UI (small change):** the Captain Orders screen (Phase 6) shows a **"Settle requested"** badge and lists
those bills first. It settles through the existing settle and settle-waiter flows, so no payment logic changes.

## 3. Mobile — structure (`mobile-app/src`)

Routes stay under `src/app/`, and logic lives outside it (AGENTS.md).

```
src/app/captain/
  _layout.tsx        (exists) adds the order and bill/[billId] screens
  index.tsx          Active Bills: this waiter's open bills, plus a "New order" button
  order.tsx          Order Entry: grid and cart; ?billId=… means "add to this bill"
  bill/[billId].tsx  Bill detail: lines with KOT sent/pending, total, Add items, Request settlement
  settings.tsx       (exists) Waiter ID free text becomes a picker loaded from the POS (D2)
src/captain/
  posApi.ts          moved from src/auth/ (it isn't auth); rewritten to match the server contract in §2
  posSettings.ts     (exists) stores waiterId (UUID) and waiterCode/name for display
  money.ts           paise strings → "₹1,234.00" with integer string maths, no floats
  cart.ts            pure reducer: add, increment, decrement, remove, clear; stock validation; payload builder
  useCatalog.ts      loads the catalog on focus and pull-to-refresh; in-memory search by name, code, category
  useOpenBills.ts    open bills: on focus, on pull-to-refresh, and a 15 s poll while focused (D8)
  memberLink.ts      QR scan or typed code → POS lookup by code; failure → "order without member"
src/components/captain/
  ItemGrid.tsx       FlatList numColumns=3, category Chips, big touch tiles showing price and stock left
  CartBar.tsx        sticky bottom bar (items · ₹total · Send KOT) that expands into a cart sheet
  BillCard.tsx       bill no · member · total · age · "Settle requested" badge
```

**Order Entry flow:**
1. Search or tap category chips. Tapping a tile adds 1, and a long-press opens a stepper.
2. Optionally link a member with "Scan member", which reuses `QrScanner`.
3. Tap **Send KOT**.

What Send KOT does:
- It creates `requestId` **once**, when tapped, and reuses it on every retry. A timeout on the club Wi-Fi doesn't
  mean the order was lost, and a fresh key on retry would print the KOT twice.
- With no `billId`, it calls `POST /kot`.
- With a `billId`, it calls `POST /bills/:billId/items`.
- On success the cart clears, the KOT outcome for each station shows (printed or "printer offline, ask the
  counter"), and the app moves to the bill.

**Client-side stock validation (`cart.ts`, requirement 2):**
- `available(sku) = tracksStock ? onHandQty − qtyInCart(sku) : ∞`.
- A tile with `available ≤ 0` is greyed out and can't be tapped, and the stepper stops at `onHandQty`.
- Inactive SKUs never come back from the catalog.
- Integers only, at most 50 lines (the server's `MAX_ORDER_LINES`), and quantities ≥ 1.
- The server stays authoritative, because another handset or the counter can sell the last bottle first. On
  `PS003` the app refreshes the catalog, marks the short lines red, and keeps the cart.

**Active Bills (requirement 4):** the list shows each bill's total, line count and how old it is.
- **Add items** opens Order Entry with that `billId`.
- **Request settlement** asks for confirmation, then calls the settle-request route. The badge then shows on the
  handset and at the counter.
- An untrusted waiter who taps "New order" while a bill is open is sent to that bill to add items, rather than
  getting a `PS010` error. The profile route says whether the waiter is trusted.

**Error copy:** `describePosError` is extended with:
- PS003: "Only N left"
- PS010: "Settle bill #N first"
- PS002: "This bill isn't yours"
- PS001: "Bill already settled"
- 401: "Re-pair this phone"
- the existing "unreachable" and "not configured" messages

## 4. Tests

**POS (Vitest, `test/captain-rounds.test.ts` and the server route tests):**
- **addToBill:** a round appends lines and prints KOTs for only the new quantities at each station.
- **Idempotency:** a replay with the same key returns the same lines and doesn't reprint. The same key with
  different lines is a conflict.
- **Refusals:** another waiter's bill gives PS002. A settled bill gives PS001 and saves nothing. A short line
  (PS003) saves nothing and leaves the key unused. An inactive SKU gives 400 INACTIVE.
- **Untrusted waiter:** the second `/kot` fails PS010, but appending to the open bill succeeds.
- **settle-request:** the request is idempotent, it is refused on a settled bill, and it appears in `listOpenBills`
  and the counter's bill detail.
- **Append-only:** UPDATE and DELETE on both new tables are refused.
- **Routes:** check that `/waiters`, `/catalog` and `/members/by-code` return the documented shapes, and that a
  bad token gives 401.

**Mobile (Jest):**
- `cart.test.ts`: stock caps, Kitchen items are unlimited, decrementing to 0 removes the line, the 50-line cap, and
  the payload shape.
- `money.test.ts`: string paise formatting, including large values, with no floats.
- `posApi.test.ts` (mocked `fetch`):
  - the paths, camelCase bodies and Bearer header are correct
  - a retry reuses the same `requestId`
  - the error mapping is correct, including timeout → unreachable
- `posSettings.test.ts`: the waiter picker values are stored, and the token stays in SecureStore.

No payment logic changes in this phase, so the existing Peak and waiter partial-payment tests stay as they are.

## 5. Verification

- **POS:** `npx vitest run` and `npx tsc --noEmit`, plus an HTTP end-to-end run on a scratch database. That run
  pairs a handset, then sends catalog → order → round → settle-request through port 4311, and checks the counter's
  Captain Orders screen in headless Chrome.
- **Mobile:** `npm test`, `npx tsc --noEmit` and `npx expo lint`. I'll check the Expo SDK 57 docs before touching
  any Expo API, as AGENTS.md requires.
- **Needs you:** a run on a real Android handset on the club's Wi-Fi with a development build. I can't drive a phone
  from here. The cleartext setting needs a native rebuild, so it won't work in Expo Go.

## 6. Decisions

| # | Question | Recommended | Alternative |
|---|---|---|---|
| **D1** | "Table ID" in the payload | **Drop it.** A bill is identified by its bill no and the member (CLAUDE.md bans table mapping). | An optional free-text "where" label (e.g. "Sofa 3"). This needs your explicit waiver of the constraint. |
| **D2** | How the handset knows its waiter | **A picker in POS Settings**, loaded from `GET /captain/waiters` and stored on the phone (the waiter can be changed per shift). | Bind the waiter to the device in `captain-devices.json`, or ask for a waiter PIN on each order (there's no waiter PIN in the schema today, so that's a later phase). |
| **D3** | Linking a member | **Optional and never blocking.** Scan the QR or type a code, and the POS resolves it by `membership_no`. If it's not found, the order goes without a member. No Supabase call in the order flow. | Look the member up in the Supabase directory and push the member to the POS (a second sync path, with a schema to match). |
| **D4** | Idempotency for adding items | **New append-only `captain_order_rounds` table** (§1). | A `request_id` column on `bill_items`. This is harder to replay as a group and touches a hot table. |
| **D5** | What "settlement request" does | **Flag only.** The counter sees "Settle requested" and takes payment through the existing flows. The handset moves no money. | Trusted waiters put the bill on WAITER_CREDIT from the handset ("collect later"). That moves money with only a device token, so it should wait for D2's PIN. |
| **D6** | Adding items after a settle request | **Allowed.** The flag stays, and the counter settles the live total. | Block appends once a request exists. |
| **D7** | The uncommitted mobile captain work from 2026-10-15 | **Fold it into Phase 27.** Keep the settings and storage, fix the API contract, and move `posApi.ts` into `src/captain/`. | Commit it separately first, as it is. |
| **D8** | Refreshing open bills | **On focus, on pull-to-refresh, and a 15 s poll while the screen is focused.** | Manual refresh only, or SSE (the server has no push support). |

**Order of work once approved:**
1. migration and `CaptainService` additions, with tests
2. routes and the counter badge
3. the mobile `posApi`, cart and money modules, with Jest tests
4. the screens
5. end-to-end verification and docs (`backend_state.md`, `frontend_state.md`, the mobile `CLAUDE.md`)
