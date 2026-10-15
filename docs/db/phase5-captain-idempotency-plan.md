# Phase 5b — Captain Order Idempotency (+ Bill-on-Bill) Schema Plan

Status: **APPROVED and implemented** in `migrations/0004_captain_orders.sql`.

Changes since the draft, both following the approval of the device column and the Wi-Fi server:
- `bills.captain_device_id` was added (with `bills_device_waiter_app` and `bills_device_id_format` CHECKs) and is part of the fingerprint.
- Because every Captain order now arrives through the authenticated Wi-Fi server, the insert trigger requires `captain_device_id` as well as `request_id` on new `WAITER_APP` bills.
- The Captain routes moved off the loopback counter API.

Covers Decision 2 (idempotency key) and the database half of Decision 3 (bill-on-bill for untrusted waiters). The two share a trigger and interact on retries, so they ship in one migration.

---

## 1. Problem

The Captain app sends `POST /api/captain/kot` over weak bar Wi-Fi. If the response is lost after the server commits, the app retries, which creates a **second bill**, deducts stock twice and prints a second KOT. The fix: the app attaches a client-generated `request_id` to every order. Any repeat of that id returns the original order instead of creating a new one.

## 2. Design choice: columns on `bills`, not a new table

| | **A. Columns on `bills` (recommended)** | B. Separate `captain_requests` table |
|---|---|---|
| Atomicity | Key and bill are written by the same INSERT | Needs a second insert plus an FK, or a deferred FK |
| Cloud sync | Rides the existing `bills_outbox` trigger | Needs a new outbox trigger plus `id`, or stays local |
| Append-only | Covered by the existing `bills_no_delete` / `no_truncate`; add a guard for the new columns | Needs its own no-delete / no-update triggers |
| Replay lookup | One indexed read on `bills` | Join to `bills` |

One order makes exactly one bill, so the key belongs on the bill.

## 3. DDL

```sql
ALTER TABLE bills
  ADD COLUMN request_id          uuid,
  ADD COLUMN request_fingerprint text,
  ADD CONSTRAINT bills_request_pairing     CHECK ((request_id IS NULL) = (request_fingerprint IS NULL)),
  ADD CONSTRAINT bills_request_waiter_app  CHECK (request_id IS NULL OR source = 'WAITER_APP'),
  ADD CONSTRAINT bills_request_fingerprint CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$');

-- The idempotency guarantee itself. Partial: counter bills have no key.
CREATE UNIQUE INDEX bills_request_id_unique ON bills (request_id) WHERE request_id IS NOT NULL;
```

| Column | Type | Null | Meaning |
|---|---|---|---|
| `request_id` | `uuid` | yes | Client-generated id (UUID v4 or v7), one per order attempt *intent*; reused on every retry of that order |
| `request_fingerprint` | `text` | yes | SHA-256 hex of the canonical request `{ waiterId, memberId, items: [{ skuId, quantity }] }` (in item order). It detects a key reused for a *different* order. |

**Why the columns are nullable:** counter bills never carry a key, and the WAITER_APP bills created before this migration have none.

### Triggers

```sql
-- BEFORE INSERT ON bills, fires after bills_before_insert (alphabetical), so the
-- waiter_trusted_at_billing snapshot is already set.
CREATE TRIGGER bills_waiter_app_before_insert BEFORE INSERT ON bills
  FOR EACH ROW WHEN (NEW.source = 'WAITER_APP') EXECUTE FUNCTION pos_waiter_app_bill_guard();
```

`pos_waiter_app_bill_guard()`:
1. **Requires a key on new app bills:** `request_id IS NULL` raises `PS002`. A trigger is used instead of a CHECK so the existing dev and test WAITER_APP rows stay valid.
2. **Serialises orders per waiter:** `SELECT … FROM waiters WHERE id = NEW.waiter_id FOR UPDATE`. Two handsets ordering for the same waiter at once can't both pass step 3.
3. **Bill-on-bill (Decision 3):** if `NEW.waiter_trusted_at_billing` is false and the waiter has **any** `OPEN` sale bill (app order or counter bill tagged to them), raise the new code **`PS010 BILL_ON_BILL`**, for example `waiter W02 has unpaid bill #12; settle it before a new order`.

```sql
-- BEFORE UPDATE ON bills: the key is identity, never edited.
CREATE TRIGGER bills_request_immutable BEFORE UPDATE ON bills
  FOR EACH ROW WHEN ((NEW.request_id, NEW.request_fingerprint) IS DISTINCT FROM (OLD.request_id, OLD.request_fingerprint))
  EXECUTE FUNCTION pos_forbid_change();   -- existing PS001 helper
```

This is a separate trigger rather than an edit to the `0003` bills guard, so no existing function body is copied or changed.

**Scope of bill-on-bill:**
- It applies only to bills the Captain API creates (`source = 'WAITER_APP'`), as decided.
- Counter tagging (`tagBillToWaiter`) is unchanged: a cashier can still tag a counter bill to an untrusted waiter who has an open bill.

## 4. Service flow (`CaptainService.placeOrder`)

```
fingerprint = sha256(canonical request)
1. SELECT * FROM bills WHERE request_id = $key
   ├─ found, fingerprint equal    → REPLAY (no writes, no print)            → 200 { …order, replayed: true }
   └─ found, fingerprint differs  → IdempotencyConflictError                 → 409 IDEMPOTENCY_CONFLICT
2. transaction: validate refs → INSERT bill (key + fingerprint) → lines
   ├─ unique violation on bills_request_id_unique ─┐  a concurrent attempt with the same key
   ├─ PS010 BILL_ON_BILL ──────────────────────────┤  committed first (its bill is the "open bill")
   │                                               └→ re-run step 1: replay / conflict; if still
   │                                                  no row, surface the original error
   └─ commit → print KOT                                                     → 201 { …order, replayed: false }
```

- **Why the retry check runs before bill-on-bill.** Take an untrusted waiter whose first attempt committed but whose response was lost. Their retry would find "an open unpaid bill", which is the order itself. Looking up the key first, and re-checking it after `PS010`, makes that retry replay the order instead of being refused.
- **Bill numbers stay gap-free.** A duplicate or blocked attempt rolls back its whole transaction, including the `next_bill_no` bump in `bills_before_insert`. For the same reason, `INSERT … ON CONFLICT DO NOTHING` is deliberately **not** used: the trigger would still bump the counter and leave a gap in the excise bill sequence.
- **Replay payload.**
  - `bill`: the current state of the bill.
  - `items`: its first *N* lines, where *N* is the number of request lines. Order lines are inserted first and in order, so later counter edits never leak in.
  - `kot: null`: no reprint.
  - `replayed: true`, with HTTP **200** instead of 201.
  - Reprinting a KOT whose original print failed is a separate endpoint, out of scope here.

## 5. API contract change

`POST /api/captain/kot` body gains **required** `requestId` (UUID).

| Status | `error.code` | When |
|---|---|---|
| 201 | — | New order created |
| 200 | — | `replayed: true`: same key and same payload as an earlier order |
| 400 | `BAD_REQUEST` | `requestId` missing or not a UUID |
| 409 | `IDEMPOTENCY_CONFLICT` | Same key, different payload |
| 409 | `PS010` | Untrusted waiter has an open bill |

`PosErrorCode.BILL_ON_BILL = 'PS010'` is added to `src/db/errors.ts`. `IdempotencyConflictError` is a new error class mapped to 409.

## 6. Data and rollout

- **Existing rows:** no backfill. Earlier WAITER_APP bills (dev and test data only; no production data exists) keep `NULL` keys.
- **Cloud sync:** both columns appear in `bills.insert` outbox payloads automatically.
- **Retention:** keys live with their bill forever (append-only), so a retry arriving days later still replays.
- **Invariants view:** no new check is needed. The unique index and triggers enforce everything.

## 7. Tests (written with the migration)

- **Schema:**
  - pairing, waiter-app-only and fingerprint-format CHECKs
  - unique index
  - key required on new WAITER_APP inserts, not on counter bills
  - key immutable (PS001)
- **Bill-on-bill:**
  - untrusted waiter blocked by an open app bill and by an open counter-tagged bill
  - unblocked after settlement
  - trusted waiters never blocked
- **Idempotency:**
  - a replay returns the same bill, with no new stock movement, bill number or print
  - a different payload returns 409
  - an untrusted waiter's retry replays instead of returning PS010
  - a failed attempt (out of stock) leaves the key unused, so the retry can succeed
- **API:** 200 vs 201, `replayed` flag, `requestId` validation.
- **Not covered:** the concurrent in-flight race can't be exercised on single-connection PGlite. It is covered by the unique index and lock design, and should be added to the node-postgres integration suite once a live PostgreSQL 18 is wired.

## 8. Open question

**Device column (ties to Decision 1).** Add `bills.captain_device_id text` now, as the paired handset id from the device-token config, NULL until the Wi-Fi server exists? It would also go into the fingerprint, so a key reused from a different handset is a conflict. Recommended: **yes**. It avoids a `0005` migration as soon as Decision 1 lands, and records which handset placed each order.
