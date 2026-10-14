# FL2 POS — Backend State Reference

As of commit `9b22354` on `main` (Phase 1 schema, Phase 2 service layer, Phase 4 counter queries and local HTTP API). Full design: `docs/db/phase1-core-schema.md`. Billing screen plan: `docs/ui/phase4-billing-screen-plan.md`.

- **Database:** PostgreSQL 18+ (keys default to `uuidv7()`). Migrations: `0001_core_schema`, `0002_core_rules`, `0003_waiter_tagging`.
- **Money:** `BIGINT` whole paise in SQL, `bigint` in TypeScript (`type Paise = bigint`). No floats anywhere.
- **Quantities:** `INTEGER` whole sealed bottles. No ml / peg columns.
- **Append-only:** DELETE and TRUNCATE are blocked on every domain table. Ledger tables also block UPDATE. Corrections are made with reversing records.

---

## 1. Database tables

| Table | Purpose | Foreign keys |
|---|---|---|
| `staff` | Cashiers, managers, admins | — |
| `members` | Member register (optional on bills, no KYC gate) | — |
| `products` | Brand family (category: WHISKY, RUM, BEER…) | — |
| `skus` | One row per sealed size: `FULL`, `HALF`, `QUARTER`, `BEER_650`, `BEER_330` | `product_id → products` |
| `sku_stock` | Cached on-hand bottles, `≥ 0` (trigger-maintained) | `sku_id → skus` (PK) |
| `stock_movements` | Stock ledger: OPENING, PURCHASE_RECEIPT, SALE, SALE_REVERSAL, ADJUSTMENT | `sku_id → skus`, `business_day_id → business_days`, `bill_item_id → bill_items` (unique) |
| `business_days` | Trading day; one OPEN at a time; bill-number counter | `opened_by_staff_id`, `closed_by_staff_id → staff` |
| `peak_sessions` | Peak windows (several per day, one running); start/end cash and UPI; frozen expected and variance | `business_day_id → business_days`, `started_by_staff_id`, `ended_by_staff_id → staff` |
| `waiters` | `is_trusted`, `outstanding_balance` (paise, `≥ 0`, trigger-maintained), optional `credit_limit_paise` | — |
| `waiter_payments` | Repayments against a waiter's account (append-only) | `waiter_id → waiters`, `business_day_id → business_days`, `peak_session_id → peak_sessions`, `reverses_waiter_payment_id → waiter_payments`, `received_by_staff_id → staff` |
| `waiter_ledger_entries` | Waiter running account: BILL_CREDIT, BILL_CREDIT_REVERSAL, PAYMENT, PAYMENT_REVERSAL, MANUAL_ADJUSTMENT | `waiter_id → waiters`, `business_day_id → business_days`, `bill_payment_id → bill_payments`, `waiter_payment_id → waiter_payments`, `created_by_staff_id → staff` |
| `bills` | `billing_mode` NORMAL / PEAK; `status` OPEN → SETTLED or PEAK_UNSETTLED → PEAK_RECONCILED; `bill_kind` SALE / REVERSAL | `business_day_id → business_days`, `peak_session_id → peak_sessions`, `waiter_id → waiters`, `member_id → members`, `reverses_bill_id → bills` (unique), `replaces_bill_id → bills` (unique), `created_by_staff_id`, `settled_by_staff_id → staff` |
| `bill_items` | Lines with SKU / price snapshots; negative lines cancel or reverse | `bill_id → bills`, `sku_id → skus`, `reverses_item_id → bill_items`, `waiter_id → waiters`, `created_by_staff_id → staff` |
| `bill_payments` | Tenders: CASH, UPI, WAITER_CREDIT; negative amounts are refunds | `bill_id → bills`, `business_day_id → business_days`, `peak_session_id → peak_sessions`, `reverses_payment_id → bill_payments` (unique), `received_by_staff_id → staff` |
| `sync_outbox` | Transactional outbox for cloud sync (written by trigger) | — |
| `schema_migrations` | Applied migration versions | — |

**Views:**
- `v_bills_effective`: SALE bills that have not been reversed.
- `v_peak_sessions`: adds `running_expected_paise`.
- `v_invariant_violations`: nightly self-check; it must stay empty.

**SQL functions:** `pos_start_peak(cash, upi, staff)` and `pos_end_peak(session, cash, upi, staff)`.

---

## 2. Error codes

Business-rule violations raise these SQLSTATEs. The services surface them as `PosError` with `.code`. Constraints that encode rules (for example `bills_reverses_unique` or `peak_sessions_one_active_per_day`) are mapped onto the same codes, and `PosError.constraint` names the constraint.

| Code | Constant (`PosErrorCode.*`) | Meaning |
|---|---|---|
| `PS001` | `APPEND_ONLY` | Row is append-only or frozen (settled bill, ended session, closed day, ledger UPDATE / DELETE) |
| `PS002` | `ILLEGAL_TRANSITION` | Invalid state change (status transition, tagging a peak or settled bill, inactive waiter / SKU, price override) |
| `PS003` | `INSUFFICIENT_STOCK` | Stock would go below zero |
| `PS004` | `CREDIT_NOT_ALLOWED` | WAITER_CREDIT for an untrusted waiter, no waiter on the bill, or credit limit exceeded |
| `PS005` | `TENDER_MISMATCH` | Payments don't match the amount due (under / over, bill-on-bill partial, tenders on a peak bill, non-empty bill passed to `closeEmptyBill`) |
| `PS006` | `REVERSAL_RULE` | Reversal rule broken (double void, reversing a reversal, voiding an OPEN bill, incomplete reversal, refund not mirroring the original) |
| `PS007` | `DAY_OR_PEAK_RULE` | No open business day, peak session not running / already running, day close blocked |
| `PS008` | `WAITER_BALANCE` | Waiter balance would go negative (overpayment, credit reversal after repayment) |
| `PS009` | `DERIVED_COLUMN` | Direct write to a trigger-maintained column (totals, balances, stock, bill numbers) |

Other error classes:
- `NotFoundError` (`.entity`, `.id`): a referenced bill, SKU, waiter or session doesn't exist.
- `TypeError` / `RangeError`: invalid arguments (non-bigint money, non-positive amounts or quantities, unknown tender).
- All service methods are `async`, so every error arrives as a rejected promise.

---

## 3. Service API (`src/services/index.ts`)

Each service is constructed with a `SqlDatabase`: a PGlite instance, or `pgDatabase(pool)` from `src/db/pg.ts` for node-postgres:

```ts
interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}
interface SqlDatabase extends SqlClient {
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}
```

### Shared domain types (`src/domain/types.ts`)

```ts
type Paise = bigint;
type BillingMode = 'NORMAL' | 'PEAK';
type BillKind = 'SALE' | 'REVERSAL';
type BillStatus = 'OPEN' | 'SETTLED' | 'PEAK_UNSETTLED' | 'PEAK_RECONCILED';
type BillSource = 'COUNTER' | 'WAITER_APP';
type SizeCode = 'FULL' | 'HALF' | 'QUARTER' | 'BEER_650' | 'BEER_330';
type CounterTender = 'CASH' | 'UPI';
type Tender = CounterTender | 'WAITER_CREDIT';

interface Bill {
  id: string; businessDayId: string; billNo: number; kind: BillKind; mode: BillingMode; status: BillStatus;
  source: BillSource; peakSessionId: string | null; waiterId: string | null; waiterTrustedAtBilling: boolean | null;
  memberId: string | null; totalPaise: Paise; reversesBillId: string | null; replacesBillId: string | null;
  reversalReason: string | null; createdByStaffId: string | null; createdAt: Date; settledAt: Date | null;
  settledByStaffId: string | null; peakReconciledAt: Date | null;
}
interface BillItem {
  id: string; billId: string; lineNo: number; skuId: string; skuCode: string; displayName: string;
  sizeCode: SizeCode; quantity: number; unitPricePaise: Paise; lineTotalPaise: Paise;
  reversesItemId: string | null; restock: boolean;
}
interface BillPayment {
  id: string; billId: string; businessDayId: string; peakSessionId: string | null; tender: Tender;
  amountPaise: Paise; reversesPaymentId: string | null; createdAt: Date;
}
interface PeakSession {
  id: string; businessDayId: string; sessionNo: number; startedAt: Date; startedByStaffId: string;
  startCashPaise: Paise; startUpiPaise: Paise; endedAt: Date | null; endedByStaffId: string | null;
  endCashPaise: Paise | null; endUpiPaise: Paise | null; expectedPaise: Paise | null; variancePaise: Paise | null;
}
interface WaiterPayment {
  id: string; waiterId: string; businessDayId: string; peakSessionId: string | null; tender: CounterTender;
  amountPaise: Paise; reversesWaiterPaymentId: string | null; createdAt: Date;
}
```

### `BillingService` (`src/services/billing.service.ts`)

```ts
class BillingService {
  constructor(db: SqlDatabase);

  createBill(mode: BillingMode, cashierId: string, memberId?: string): Promise<Bill>;
  addItemToBill(billId: string, skuId: string, quantity: number): Promise<BillLine>;
  settleNormalBill(billId: string, payments: readonly CounterPayment[]): Promise<SettledBill>;
  closeEmptyBill(billId: string): Promise<Bill>;
  setBillMember(billId: string, memberId: string | null): Promise<Bill>;
  cancelBillItem(billId: string, itemId: string, quantity: number, options?: { restock?: boolean }): Promise<BillLine>;
  recordPeakSale(sessionId: string, skuId: string, quantity: number, cashierId: string): Promise<BillLine>;
  reverseBill(billId: string, reason: string, staffId: string, options?: ReverseBillOptions): Promise<ReversalResult>;
}

interface CounterPayment { mode: CounterTender; amount: Paise; }
interface BillLine { bill: Bill; item: BillItem; }
interface SettledBill { bill: Bill; payments: BillPayment[]; }
interface ReverseBillOptions {
  restock?: boolean;                    // default true
  creditRefundTender?: CounterTender;   // refund for already-repaid waiter credit; default 'CASH'
  peakRefundTender?: CounterTender;     // refund for a reconciled peak bill; default 'CASH'
}
interface ReversalResult { reversal: Bill; refunds: BillPayment[]; }
```

**Open-bill edits** (OPEN NORMAL sale bills only; settled bills give `PS001`, peak bills `PS002`):
- **`setBillMember`:** attaches, swaps or clears (`null`) the member. Missing member is `NotFoundError`, inactive member `PS002`.
- **`cancelBillItem`:** appends a negative line referencing `itemId`; the original line is never edited. `restock` defaults to true (`false` keeps an opened bottle out of stock). Refused with `PS002` once the bill has any tender. Cancelling more than remains, a negative line, or a line on another bill is `PS006`. Peak bills are corrected with `reverseBill`.

### `PeakSessionService` (`src/services/peak-session.service.ts`)

```ts
class PeakSessionService {
  constructor(db: SqlDatabase);

  startPeakSession(businessDayId: string, declaredCash: Paise, declaredUpi: Paise, staffId: string): Promise<PeakSession>;
  endPeakSession(sessionId: string, countedCash: Paise, countedUpi: Paise, staffId: string): Promise<PeakReconciliation>;
}

interface PeakReconciliation { session: PeakSession; breakdown: PeakBreakdown; }
interface PeakBreakdown {
  peakBillsPaise: Paise;      // Σ peak bills in the session (incl. in-session reversals)
  billCashPaise: Paise;       // CASH tenders on normal bills during the session
  billUpiPaise: Paise;        // UPI tenders on normal bills during the session
  waiterCashPaise: Paise;     // waiter repayments in CASH during the session
  waiterUpiPaise: Paise;      // waiter repayments in UPI during the session
  expectedPaise: Paise;       // sum of the five above
  actualPaise: Paise;         // cashDelta + upiDelta
  cashDeltaPaise: Paise;      // counted cash − declared cash
  upiDeltaPaise: Paise;       // counted UPI − declared UPI
  variancePaise: Paise;       // actual − expected (negative = shortage)
}
```

### `WaiterService` (`src/services/waiter.service.ts`)

```ts
class WaiterService {
  constructor(db: SqlDatabase);

  tagBillToWaiter(billId: string, waiterId: string): Promise<Bill>;
  settleWaiterBill(billId: string, waiterId: string, paymentMode: Tender, amount?: Paise): Promise<WaiterSettlement>;
  recordWaiterRepayment(waiterId: string, amount: Paise, mode: CounterTender, staffId: string): Promise<WaiterRepayment>;
}

interface WaiterSettlement { bill: Bill; payment: BillPayment; remainingDuePaise: Paise; }
interface WaiterRepayment { payment: WaiterPayment; outstandingPaise: Paise; }
```

**Behaviour notes:**
- **`settleWaiterBill`:** `amount` defaults to the full amount due, and the bill settles once nothing is due. Trusted waiters may pay part now and put the rest on `WAITER_CREDIT`. Untrusted waiters get `PS004` for credit and `PS005` for anything but the exact amount due.
- **`tagBillToWaiter`:** works only on OPEN NORMAL sale bills, and only until the first tender is recorded.

### `CounterQueries` (`src/services/counter-queries.ts`)

Read-only; takes any `SqlClient`.

```ts
class CounterQueries {
  constructor(db: SqlClient);

  getCounterContext(cashierId: string): Promise<CounterContext>;   // NotFoundError for an unknown cashier
  lookupSku(code: string): Promise<SkuLookup | null>;              // exact barcode first, then case-insensitive sku_code
  searchMembers(query: string, limit?: number): Promise<MemberSummary[]>; // active; number prefix or name substring; default limit 20
  listWaiters(): Promise<WaiterSummary[]>;                         // active, by waiter_code
  getBillDetail(billId: string): Promise<BillDetail>;              // NotFoundError for a missing bill
}

interface CounterContext {
  cashier: StaffSummary;
  businessDay: BusinessDaySummary | null;   // null = no open day; billing is blocked
  peakSession: PeakSessionView | null;      // running session → counter bills in PEAK mode
  openBill: BillDetail | null;              // this cashier's newest OPEN NORMAL counter bill (resume)
}
interface StaffSummary { id: string; displayName: string; role: 'CASHIER' | 'MANAGER' | 'ADMIN'; }
interface BusinessDaySummary { id: string; businessDate: string /* 'YYYY-MM-DD' */; openedAt: Date; }
interface PeakSessionView extends PeakSession { runningExpectedPaise: Paise; }
interface SkuLookup {
  id: string; skuCode: string; barcode: string | null; displayName: string; sizeCode: SizeCode;
  pricePaise: Paise; onHandQty: number; isActive: boolean;
}
interface MemberSummary { id: string; membershipNo: string; displayName: string; }
interface WaiterSummary {
  id: string; code: string; displayName: string; isTrusted: boolean;
  outstandingPaise: Paise; creditLimitPaise: Paise | null;   // null = no limit
}
interface BillDetailItem extends BillItem { remainingQuantity: number; }  // 0 on negative lines
interface BillDetail {
  bill: Bill; items: BillDetailItem[];      // every line in line order, cancellations included
  payments: BillPayment[]; member: MemberSummary | null; waiter: WaiterSummary | null;
  tenderedPaise: Paise; duePaise: Paise;
}
```

---

## 4. Local HTTP API (`server/`)

A thin JSON bridge from the frontend to the services above. It holds no business rules.

**Running it**

| Command | What it does |
|---|---|
| `npm run api:dev` | Embedded PGlite under `.data/pglite` (git-ignored). On an empty database, seeds demo data (cashier, 8 SKUs with barcodes `8900000000001`–`8900000000008`, waiters W01 trusted / W02 untrusted / W03 trusted with ₹5,000 limit, 3 members, an open business day) and acts as the seeded cashier. |
| `npm run api` | Same server without demo data; `FL2_CASHIER_ID` is required. |

| Variable | Default | Meaning |
|---|---|---|
| `FL2_API_PORT` | `4310` | Port. The server binds to `127.0.0.1` only. |
| `DATABASE_URL` | unset | node-postgres connection string. Unset → PGlite. *Not yet run against a live PostgreSQL server.* |
| `FL2_PGLITE_DIR` | `.data/pglite` | PGlite data directory. |
| `FL2_CASHIER_ID` | seeded cashier | Staff id the counter acts as (until staff login exists). Also used as the staff id for reversals, peak sessions and repayments. |
| `FL2_DEV_SEED` | unset | `1` seeds an empty database with demo data. |

Migrations run on every boot (already-applied ones are skipped).

**Wire format**
- Money is a **decimal string of whole paise** in both directions (`"102050"` = ₹1,020.50). JSON numbers, decimals and negatives are rejected with 400.
- Dates are ISO-8601 strings. Quantities are JSON integers. IDs are UUIDs (anything else is 400).
- Success returns the service result as-is. Errors return `{ "error": { "code", "message", … } }`.

**Status codes**

| Status | `error.code` | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Malformed JSON, missing or mistyped field, non-positive quantity |
| 403 | `FORBIDDEN` | `Host` header is not `localhost`, `127.0.0.1` or `[::1]` (blocks DNS rebinding) |
| 404 | `NOT_FOUND` | Unknown route, or `NotFoundError` (adds `entity`, `id`) |
| 405 | `METHOD_NOT_ALLOWED` | Known path, wrong method |
| 409 | `PS001`–`PS009` | Business-rule violation (adds `constraint` when one fired) |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 64 KB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | POST/PUT without `Content-Type: application/json` (forces a CORS preflight, which is never approved) |
| 500 | `INTERNAL` | Anything else (details only in the server log) |

**Routes** (cashier = `FL2_CASHIER_ID`)

| Method & path | Body / query | Calls | OK |
|---|---|---|---|
| `GET /api/health` | | | 200 `{ ok: true }` |
| `GET /api/context` | | `getCounterContext(cashier)` | 200 |
| `GET /api/skus/lookup` | `?code=` | `lookupSku` (404 if none) | 200 |
| `GET /api/members` | `?q=&limit=` (1–100) | `searchMembers` | 200 |
| `GET /api/waiters` | | `listWaiters` | 200 |
| `GET /api/bills/:billId` | | `getBillDetail` | 200 |
| `POST /api/bills` | `{ mode, memberId? }` | `createBill(mode, cashier, memberId)` | 201 |
| `POST /api/bills/:billId/items` | `{ skuId, quantity }` | `addItemToBill` | 201 |
| `POST /api/bills/:billId/items/:itemId/cancel` | `{ quantity, restock? }` | `cancelBillItem` | 201 |
| `PUT /api/bills/:billId/member` | `{ memberId: uuid \| null }` | `setBillMember` | 200 |
| `PUT /api/bills/:billId/waiter` | `{ waiterId }` | `tagBillToWaiter` | 200 |
| `POST /api/bills/:billId/settle` | `{ payments: [{ mode: 'CASH'\|'UPI', amount }] }` | `settleNormalBill` | 200 |
| `POST /api/bills/:billId/settle-waiter` | `{ waiterId, tender, amount? }` | `settleWaiterBill` | 200 |
| `POST /api/bills/:billId/close-empty` | | `closeEmptyBill` | 200 |
| `POST /api/bills/:billId/reverse` | `{ reason, restock?, creditRefundTender?, peakRefundTender? }` | `reverseBill(…, cashier, …)` | 201 |
| `POST /api/peak/sales` | `{ sessionId, skuId, quantity }` | `recordPeakSale(…, cashier)` | 201 |
| `POST /api/peak/sessions` | `{ businessDayId, declaredCash, declaredUpi }` | `startPeakSession(…, cashier)` | 201 |
| `POST /api/peak/sessions/:sessionId/end` | `{ countedCash, countedUpi }` | `endPeakSession(…, cashier)` | 200 |
| `POST /api/waiters/:waiterId/repayments` | `{ amount, tender: 'CASH'\|'UPI' }` | `recordWaiterRepayment(…, cashier)` | 201 |

The frontend dev server proxies `/api` to `http://127.0.0.1:4310`.
