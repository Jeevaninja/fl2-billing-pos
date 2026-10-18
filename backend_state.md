# FL2 POS — Backend State Reference

Covers Phase 1 schema, Phase 2 service layer, Phase 4 counter queries and local HTTP API, Phase 5 Captain API and KOT printing (commit `991b3a8`), Phase 5b Captain idempotency, bill-on-bill and the Wi-Fi Captain server, Phase 6 `listCaptainOrders`, Phase 7 Day End (`0005_day_end`, `DayEndService`), and Phase 8 expense categories, list and void (`0006_expense_category`) plus the peak expected drawer total (`0007_peak_drawer_cash`), Phase 9 stock receipts / GRN (`0008_stock_receipts`, `PurchaseService`; plan `docs/ui/phase9-purchase-grn-plan.md`), Phase 10 master catalog and case-based inwarding (`0009_catalog_case_size`, `CatalogService`; plan `docs/ui/phase10-catalog-case-grn-plan.md`), Phase 11 peak start baseline and Day End sales breakdown (no migration; plan `docs/ui/phase11-peak-day-end-visibility-plan.md`), Phase 12 server-side peak undo (no migration; plan `docs/ui/phase12-billing-speed-plan.md`), Phase 13 Day End tally adjustments and running peak analytics (`0010_tender_adjustments`; plan `docs/ui/phase13-peak-close-tally-plan.md`), Phase 14 bank deposits / cash drops (`0011_bank_deposits`; plan `docs/ui/phase14-bank-deposits-plan.md`), Phase 15 held bills in `/api/context` and per-waiter day stats (no migration; plan `docs/ui/phase15-billing-tabs-waiter-sidebar-plan.md`), Phase 16 waiter ledger, multi-bill and lump-sum waiter settlement and the Day End waiter-balance blocker (no migration; plan `docs/ui/phase16-waiter-ledger-plan.md`), Phase 17 Orders (bill-wise tracking) and DUPLICATE receipt reprints (no migration; plan `docs/ui/phase17-orders-plan.md`), and Phase 18 custom expense categories (`0012_expense_categories`; plan `docs/ui/phase18-expense-categories-plan.md`). Upcoming phases, not built: `docs/roadmap.md`. Day End design: `docs/ui/phase7-day-end-plan.md`. Full design: `docs/db/phase1-core-schema.md`. Billing screen plan: `docs/ui/phase4-billing-screen-plan.md`.

- **Database:** PostgreSQL 18+ (keys default to `uuidv7()`). Migrations: `0001_core_schema`, `0002_core_rules`, `0003_waiter_tagging`, `0004_captain_orders`, `0005_day_end`, `0006_expense_category`, `0007_peak_drawer_cash`, `0008_stock_receipts`, `0009_catalog_case_size`, `0010_tender_adjustments`, `0011_bank_deposits`, `0012_expense_categories`.
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
| `skus` | One row per sealed size: `FULL`, `HALF`, `QUARTER`, `BEER_650`, `BEER_330`. `price_paise` = default sale price; `case_size` (1–1000, required) and optional `purchase_price_paise` ≥ 0 (0009) | `product_id → products` |
| `sku_stock` | Cached on-hand bottles, `≥ 0` (trigger-maintained) | `sku_id → skus` (PK) |
| `stock_movements` | Stock ledger: OPENING, PURCHASE_RECEIPT, SALE, SALE_REVERSAL, ADJUSTMENT. SALE / SALE_REVERSAL are posted only by `bill_items`, PURCHASE_RECEIPT only by `stock_receipt_lines` (0008) | `sku_id → skus`, `business_day_id → business_days`, `bill_item_id → bill_items` (unique), `receipt_line_id → stock_receipt_lines` (unique, set exactly on PURCHASE_RECEIPT rows; 0008) |
| `stock_receipts` | GRN header: one supplier invoice received on the open day (append-only). `invoice_no` required, `vendor_name` optional; unique per (invoice no, vendor), case- and space-insensitive (0008) | `business_day_id → business_days` (stamped), `received_by_staff_id → staff` |
| `stock_receipt_lines` | GRN lines: `qty` whole bottles > 0 of one SKU at `unit_cost_paise` ≥ 0 (₹0 = scheme / free); one line per SKU per receipt; append-only (0008). `cases` ≥ 0 and the `case_size` snapshot record how the line was counted (NULL / 0 = loose only); `cases × case_size ≤ qty` (0009) | `receipt_id → stock_receipts`, `sku_id → skus` |
| `business_days` | Trading day; one OPEN at a time; bill-number counter; `opening_float_paise` (immutable); on close: `counted_cash_paise`, and trigger-computed `expected_cash_paise` / `cash_variance_paise` (0005) | `opened_by_staff_id`, `closed_by_staff_id → staff` |
| `peak_sessions` | Peak windows (several per day, one running); start/end cash and UPI; frozen expected and variance | `business_day_id → business_days`, `started_by_staff_id`, `ended_by_staff_id → staff` |
| `expense_categories` | Phase 18 (0012). Managed petty-cash categories: `name` (unique, case-insensitive), `is_active`, `note_required`, `sort_order` (Expense picker order), `legacy_code` (the 0006 code it stands for; immutable). Editable master data, no DELETE (disable instead), outbox on change. Seeds: Ice, Staff food, Transport, Cleaning, Repairs & Maintenance (`REPAIRS`), Bata / Daily Wages, Other (`OTHER`, note required) | — |
| `waiters` | `is_trusted`, `outstanding_balance` (paise, `≥ 0`, trigger-maintained), optional `credit_limit_paise` | — |
| `waiter_payments` | Repayments against a waiter's account (append-only) | `waiter_id → waiters`, `business_day_id → business_days`, `peak_session_id → peak_sessions`, `reverses_waiter_payment_id → waiter_payments`, `received_by_staff_id → staff` |
| `waiter_ledger_entries` | Waiter running account: BILL_CREDIT, BILL_CREDIT_REVERSAL, PAYMENT, PAYMENT_REVERSAL, MANUAL_ADJUSTMENT | `waiter_id → waiters`, `business_day_id → business_days`, `bill_payment_id → bill_payments`, `waiter_payment_id → waiter_payments`, `created_by_staff_id → staff` |
| `bills` | `billing_mode` NORMAL / PEAK; `status` OPEN → SETTLED or PEAK_UNSETTLED → PEAK_RECONCILED; `bill_kind` SALE / REVERSAL; Captain orders carry `request_id` (unique idempotency key), `request_fingerprint` and `captain_device_id` (0004) | `business_day_id → business_days`, `peak_session_id → peak_sessions`, `waiter_id → waiters`, `member_id → members`, `reverses_bill_id → bills` (unique), `replaces_bill_id → bills` (unique), `created_by_staff_id`, `settled_by_staff_id → staff` |
| `bill_items` | Lines with SKU / price snapshots; negative lines cancel or reverse | `bill_id → bills`, `sku_id → skus`, `reverses_item_id → bill_items`, `waiter_id → waiters`, `created_by_staff_id → staff` |
| `bill_payments` | Tenders: CASH, UPI, WAITER_CREDIT; negative amounts are refunds | `bill_id → bills`, `business_day_id → business_days`, `peak_session_id → peak_sessions`, `reverses_payment_id → bill_payments` (unique), `received_by_staff_id → staff` |
| `cash_expenses` | Petty-cash payments from the drawer (append-only; a negative row with `reverses_expense_id` voids one); tagged to the open day and running peak by trigger (0005). Phase 18 (0012): new rows carry `category_id → expense_categories` (active category, note when `note_required`); pre-0012 rows keep their legacy text `category` (ICE … OTHER) and are never back-filled — exactly one of the two is set (`cash_expenses_one_category`); a void copies the original's | `business_day_id → business_days`, `peak_session_id → peak_sessions`, `reverses_expense_id → cash_expenses` (unique), `created_by_staff_id → staff` |
| `tender_adjustments` | Day-level Cash ⇄ UPI reclassification of normal-bill revenue (append-only; a negating row with `reverses_adjustment_id` voids one). `cash_delta_paise + upi_delta_paise = 0`; `system_cash_paise` / `system_upi_paise` are the normal-bill tenders when the row was written (trigger-set); `reason` required (0010) | `business_day_id → business_days`, `reverses_adjustment_id → tender_adjustments` (unique), `created_by_staff_id → staff` |
| `bank_deposits` | Cash taken out of the drawer to be banked, e.g. RTGS (append-only; a negative row with `reverses_deposit_id` voids one). Not an expense, not revenue. `reference` optional (0011) | `business_day_id → business_days`, `reverses_deposit_id → bank_deposits` (unique), `created_by_staff_id → staff` |
| `sync_outbox` | Transactional outbox for cloud sync (written by trigger) | — |
| `schema_migrations` | Applied migration versions | — |

**Views:**
- `v_bills_effective`: SALE bills that have not been reversed.
- `v_peak_sessions`: adds `running_expected_paise`, `expected_drawer_cash_paise` (0007), and for a running session `running_sales_paise` and `running_in_window_upi_paise` (0010; NULL once ended).
- `v_invariant_violations`: nightly self-check; it must stay empty.

**SQL functions:** `pos_start_peak(cash, upi, staff)`, `pos_end_peak(session, cash, upi, staff)`, `pos_peak_expected_paise(session)` (0005: subtracts cash expenses paid during the session), `pos_day_expected_cash(day)` and `pos_peak_expected_drawer_cash(session)` (0007).

**Peak expected drawer total (0007):** `v_peak_sessions.expected_drawer_cash_paise` is set for a running session and NULL once it ends. It's the physical cash that should be in the till now:
- start cash
- \+ Σ peak bill totals (peak bills record no tender, so they're counted as cash)
- \+ in-peak CASH bill tenders and CASH waiter repayments
- − in-peak cash expenses

UPI is excluded. A peak sale actually paid by UPI makes the drawer lower by that amount; the session variance, which reconciles cash + UPI together, is unaffected. The UI shows this figure; `running_expected_paise` (the net collection, which can be negative) stays the basis of the variance.

**Day End (0005):**
- `pos_day_expected_cash` = opening float + CASH bill tenders outside peak windows + Σ ended sessions (end cash − start cash) + CASH waiter repayments outside peak windows − cash expenses outside peak windows. Inside a peak window the counted drawer delta already contains every cash movement, so nothing is counted twice and a peak shortage appears once (as that session's variance).
- Close (`status → CLOSED`) is refused with `PS007` while a peak session runs, any bill of the day is `OPEN` / `PEAK_UNSETTLED`, or **any waiter** has `outstanding_balance > 0` (active or not, whichever day the credit is from). It needs `counted_cash_paise` (`PS002`); expected cash and variance are computed by the trigger, overwriting client values, then frozen with the day (`PS001`).
- **Expense voids (0006):** a void copies the original's category and note, must exactly negate it (`PS006`), can happen only once (`PS006`), and must be posted on the original's business day (`PS007`: a closed day's cash has already been counted).
- **Tally adjustments (0010):** `pos_day_expected_cash` adds Σ `tender_adjustments.cash_delta_paise`, so the frozen expected cash and the close variance use the adjusted figures. The insert trigger needs an open day (`PS007`), locks the day row, and refuses a row that would take the day's adjusted normal cash or UPI below ₹0 (`PS002`). A void must exactly negate an adjustment of the same day, once, and never a void (`PS006`). Waiter repayments and peak readings are never adjusted.
- **Bank deposits (0011):** `pos_day_expected_cash` subtracts Σ `bank_deposits.amount_paise`, so the frozen expected cash and the close variance include them. A deposit needs an open day (`PS007`), and is refused while a peak session runs (`PS007`): no deposit ever falls inside a peak window, so the peak math is untouched. A void must exactly negate its original on the same day, once, and never a void (`PS006`; same day `PS007`); it may be posted during a peak (no cash moves).
- The opening float is immutable; the close columns can't be written while the day is open (`PS002`). The `business_days_cash_count_on_close` CHECK is `NOT VALID`, so days closed before 0005 keep NULL counts.

**Stock receipts / GRN (0008):**
- Inserting a `stock_receipt_lines` row posts one `PURCHASE_RECEIPT` movement (`qty_delta = qty`, the header's day and staff, `receipt_line_id = line.id`), which raises `sku_stock`. A direct `PURCHASE_RECEIPT` insert is refused (`PS009`), so a receipt is the only way to inward stock and every inwarded bottle traces back to an invoice line.
- The header needs an open business day (`PS007`). A line for an inactive SKU is `PS002`.
- No stored totals: line total = `qty × unit_cost_paise`, summed in queries. No tax fields, no drawer-cash effect.
- `stock_movements_receipt_line_link` is `NOT VALID` (no PURCHASE_RECEIPT rows existed before 0008).
- A posted receipt is final. Corrections (return / void receipt) are a later phase.

**Catalog & case-based inwarding (0009):**
- `skus.case_size` was backfilled by size (FULL 12, HALF 32, QUARTER 64, BEER_650 12, BEER_330 24) and is then `NOT NULL`. `purchase_price_paise` starts NULL (no default cost).
- `products` and `skus` stay mutable master rows (UPDATE goes to the outbox; DELETE is still `PS001`). Bill lines snapshot price, code, name and size, so a catalog edit never changes a line already billed.
- GRN line trigger (extended): a supplied `case_size` must equal the SKU's current one, else `PS002` ("case size for X is now N — re-check the line"). `PurchaseService` also share-locks the SKUs, so a catalog edit can't land mid-receipt.
- Loose bottles are not stored: `qty − cases × case_size`. `qty` stays the only number the ledger sees.
- Duplicate product name (case-insensitive), SKU code, barcode or size per product → `PS012`.

**Captain orders (0004):**
- `bills_request_id_unique` (partial unique index) is the idempotency guarantee.
- CHECKs:
  - key and fingerprint go together;
  - both, and the handset, appear only on `WAITER_APP` bills;
  - fingerprint is 64 lowercase hex;
  - handset id matches `^[a-z0-9][a-z0-9_-]{0,62}$`.
- Trigger `bills_waiter_app_before_insert`:
  - New `WAITER_APP` bills need `request_id` and `captain_device_id` (`PS002`).
  - It locks the waiter row, so orders for one waiter run one at a time.
  - It refuses an untrusted waiter who has any `OPEN` sale bill (`PS010`), whether an app order or a counter bill tagged to them. Counter tagging is not affected.
- Trigger `bills_request_immutable`: the key, fingerprint and handset never change (`PS001`).
- Bills created before 0004 keep NULL keys.
- Design: `docs/db/phase5-captain-idempotency-plan.md`.

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
| `PS007` | `DAY_OR_PEAK_RULE` | No open business day, peak session not running / already running, day close blocked (running peak, open bills, waiter balances), a day already open or a business date already traded at Day Open |
| `PS008` | `WAITER_BALANCE` | Waiter balance would go negative (overpayment, credit reversal after repayment) |
| `PS009` | `DERIVED_COLUMN` | Direct write to a trigger-maintained column (totals, balances, stock, bill numbers) |
| `PS010` | `BILL_ON_BILL` | Captain order for an untrusted waiter who still has an `OPEN` bill |
| `PS011` | `DUPLICATE_RECEIPT` | Stock receipt with an invoice number already received from the same vendor (`stock_receipts_invoice_unique`) |
| `PS012` | `DUPLICATE_CATALOG_ENTRY` | Catalog duplicate: product name (`products_name_unique`), SKU code (`skus_sku_code_unique`), barcode (`skus_barcode_unique`) or a size the product already has (`skus_product_size_unique`) |

Other error classes:
- `NotFoundError` (`.entity`, `.id`): a referenced bill, SKU, waiter or session doesn't exist.
- `InactiveError` (`.entity`, `.id`): a referenced waiter, member or SKU exists but is deactivated. Raised by `CaptainService.placeOrder`, `PurchaseService.recordReceipt` and `CatalogService` (adding or reactivating a size under an inactive product); the counter methods still report inactive rows as `PS002`.
- `IdempotencyConflictError` (`.requestId`): a Captain `requestId` was reused for a different order, or from a different handset.
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
  undoLastPeakSale(cashierId: string): Promise<PeakUndoResult>;   // Phase 12: { reversal, undone: { billId, billNo, sessionNo, displayName, sizeCode, quantity, totalPaise } }
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

- **`undoLastPeakSale` (Phase 12):** locks the running peak session row, then reverses this cashier's newest peak SALE bill in it that has no reversal yet (`reverseInTx`, the body shared with `reverseBill`). Repeated calls walk back one scan at a time and never reach an ended session. The till's cashier id stands for the terminal: Captain handsets never create peak bills.

**Open-bill edits** (OPEN NORMAL sale bills only; settled bills give `PS001`, peak bills `PS002`):
- **`setBillMember`:** attaches, swaps or clears (`null`) the member. Missing member is `NotFoundError`, inactive member `PS002`.
- **`cancelBillItem`:** appends a negative line referencing `itemId`; the original line is never edited. `restock` defaults to true (`false` keeps an opened bottle out of stock). Refused with `PS002` once the bill has any tender. Cancelling more than remains, a negative line, or a line on another bill is `PS006`. Peak bills are corrected with `reverseBill`.

### `PeakSessionService` (`src/services/peak-session.service.ts`)

```ts
class PeakSessionService {
  constructor(db: SqlDatabase);

  getStartBaseline(businessDayId: string): Promise<PeakStartBaseline>;   // Phase 11, read-only
  startPeakSession(businessDayId: string, declaredCash: Paise, declaredUpi: Paise, staffId: string): Promise<PeakSession>;
  endPeakSession(sessionId: string, countedCash: Paise, countedUpi: Paise, staffId: string): Promise<PeakReconciliation>;
}

interface PeakReconciliation { session: PeakSession; breakdown: PeakBreakdown; }
interface PeakStartBaseline {
  businessDayId: string;
  openingFloatPaise; normalCashPaise; waiterCashPaise;   // cash outside peak windows
  peakCashPaise;                                         // Σ earlier ended peaks' counted cash delta
  cashExpensesPaise;
  expectedCashPaise: Paise;                              // = pos_day_expected_cash (same as Day End)
  billUpiPaise; waiterUpiPaise;                          // UPI tenders / repayments (outside a running window)
  peakUpiPaise;                                          // Σ earlier peaks' UPI attributed to peak sales
  expectedUpiPaise: Paise;                               // = Day End breakdown.upiTotalPaise
}
interface PeakBreakdown {
  peakBillsPaise: Paise;      // Σ peak bills in the session (incl. in-session reversals)
  billCashPaise: Paise;       // CASH tenders on normal bills during the session
  billUpiPaise: Paise;        // UPI tenders on normal bills during the session
  waiterCashPaise: Paise;     // waiter repayments in CASH during the session
  waiterUpiPaise: Paise;      // waiter repayments in UPI during the session
  cashExpensesPaise: Paise;   // cash expenses paid during the session (0005)
  expectedPaise: Paise;       // sum of the five above − cashExpensesPaise
  actualPaise: Paise;         // cashDelta + upiDelta
  cashDeltaPaise: Paise;      // counted cash − declared cash
  upiDeltaPaise: Paise;       // counted UPI − declared UPI
  variancePaise: Paise;       // actual − expected (negative = shortage)
}
```

### `DayEndService` (`src/services/day-end.service.ts`)

```ts
class DayEndService {
  constructor(db: SqlDatabase);

  getCurrentDayId(): Promise<string | null>;                              // open day, else the last closed one
  getDayEndSummary(businessDayId: string): Promise<DayEndSummary>;        // NotFoundError for an unknown day
  closeBusinessDay(businessDayId: string, countedCash: Paise, staffId: string): Promise<DayEndSummary>;
  openBusinessDay(openingFloat: Paise, staffId: string, businessDate?: string /* default: today, Asia/Kolkata */): Promise<DaySummary>;
  recordCashExpense(amount: Paise, description: string | null, staffId: string, categoryId: string): Promise<CashExpense>;   // Phase 18: a managed category
  listCashExpenses(businessDayId: string): Promise<ExpenseEntry[]>;        // originals only, newest first, with voidedAt
  voidCashExpense(expenseId: string, staffId: string): Promise<CashExpense>; // appends the negating row
  adjustTenderSplit(businessDayId: string, cashDelta: Paise /* ≠ 0; + = UPI → Cash */, reason: string, staffId: string): Promise<TenderAdjustment>;
  voidTenderAdjustment(adjustmentId: string, staffId: string): Promise<TenderAdjustment>; // appends the negating row
  recordBankDeposit(amount: Paise, reference: string | null, staffId: string): Promise<BankDeposit>;   // Phase 14
  listBankDeposits(businessDayId: string): Promise<BankDepositEntry[]>;     // originals only, newest first, with voidedAt
  voidBankDeposit(depositId: string, staffId: string): Promise<BankDeposit>; // appends the negating row
}

type LegacyExpenseCategory = 'ICE' | 'STAFF_FOOD' | 'TRANSPORT' | 'CLEANING' | 'REPAIRS' | 'OTHER';  // EXPENSE_CATEGORIES: pre-0012 rows only
// CashExpense.category: { id, name } — resolved by id, else through expense_categories.legacy_code.
interface ExpenseEntry extends CashExpense { voidedAt: Date | null; }

interface DaySummary {
  id: string; businessDate: string; status: 'OPEN' | 'CLOSED'; openedAt: Date; openingFloatPaise: Paise;
  closedAt: Date | null; countedCashPaise: Paise | null; expectedCashPaise: Paise | null; cashVariancePaise: Paise | null;
}
interface DayEndSummary {
  day: DaySummary;
  blockers: {
    openBills: OpenBillBlocker[];             // OPEN + PEAK_UNSETTLED bills of the day: billId, billNo, source, status, waiter, duePaise, createdAt
    runningPeakSession: PeakSessionView | null;
    waitersOwing: OwingWaiter[];              // WaiterSummary & { isActive }, any balance > 0
    waiterBalance: WaiterBalanceBlocker;      // Phase 16: { totalPaise, openBillsPaise (Σ due on OPEN waiter bills), creditPaise (Σ outstanding_balance), waiters }
  };                                          // canClose also requires waiterBalance.totalPaise = 0 (the close trigger already enforces both parts)
  canClose: boolean;
  breakdown: CashBreakdown;                   // openingFloat, normalCash, peakCash, waiterCash, cashExpenses, tenderAdjustment (13), bankDeposits (14), expectedCash, upiTotal (info)
  sales: SalesBreakdown;                      // Phase 11
  peakSessions: PeakSessionCash[];            // ended sessions: cash / UPI deltas, frozen variance, salesPaise, inWindowUpiPaise, peakUpiPaise, peakCashPaise
  tenderAdjustments: TenderAdjustmentEntry[]; // Phase 13: originals, newest first, with voidedAt
}
interface SalesBreakdown {                    // ended peak sessions only; a running window's tenders appear once it ends
  normal: { cashPaise; upiPaise; creditPaise; totalPaise; systemCashPaise; systemUpiPaise }; // cash / upi include tally adjustments; system* as recorded
  peak: { salesPaise; cashPaise; upiPaise; sessionCount; runningSessionNo: number | null };
  waiterRepayments: { cashPaise; upiPaise };                     // credit collected, not sales
  total: { cashPaise; upiPaise; creditPaise; salesPaise };
}
interface BankDeposit { id; businessDayId; amountPaise /* negative on a void */; reference: string | null; reversesDepositId: string | null; createdByStaffId; createdAt; }
interface CashExpense { id; businessDayId; peakSessionId: string | null; amountPaise; reversesExpenseId: string | null; category: ExpenseCategory; description: string | null; createdByStaffId; createdAt; }
```

- **Sales breakdown (Phase 11), per ended peak session:** `peakUpi = upiDelta − in-window UPI` (UPI bill tenders and UPI waiter repayments taken during the peak, which moved the reading too); `peakCash = sales − peakUpi`. The variance therefore lands in peak cash. `getDayFigures` (shared with the peak baseline) asserts `peakCash = cashDelta − in-window cash tenders − in-window waiter cash + in-window expenses − variance` and `total.upi + waiterRepayments.upi = breakdown.upiTotalPaise`, throwing on drift. Normal-bill tenders taken inside a peak count under `normal` here but stay inside the peak's cash delta in `CashBreakdown`. A negative derived peak cash (UPI readings above sales) is reported, not clamped.
- **`closeBusinessDay`:** locks the day row first, so a sale racing the close either commits before it (and is counted) or fails `PS007`. The database re-checks every blocker. The returned breakdown is checked against the frozen expected figure.
- **`openBusinessDay`:** refuses a second open day and a date that has already traded (`PS007`). A business date trades once, so closing and reopening on the same calendar day is refused.
- **`recordCashExpense`:**
  - The amount must be above ₹0, and the note is trimmed (blank → null), at most 200 characters.
  - An unknown `categoryId` is a `NotFoundError`.
  - The insert trigger refuses (`PS002`) a disabled category, a missing note on a `note_required` category, and a legacy code on a new row.
  - Day End and peak math only sum amounts, so they are unchanged by categories.
- **`voidCashExpense`:** `NotFoundError` for an unknown id; double void or voiding a void row is `PS006`; an expense from a closed day is `PS007`.
- **`recordBankDeposit` (Phase 14):** amount > 0; the reference is trimmed (blank → null), at most 200 characters (`RangeError`). `CashBreakdown.bankDepositsPaise` is subtracted from expected cash (asserted against `pos_day_expected_cash`); `SalesBreakdown` and `cashExpensesPaise` never include deposits. `PeakStartBaseline` gains `tenderAdjustmentPaise` and `bankDepositsPaise`, so its cash terms add up to `expectedCashPaise`. **`voidBankDeposit`:** `NotFoundError` for an unknown id, otherwise the trigger's void rules.
- **`adjustTenderSplit` (Phase 13):** `upiDelta` is always `−cashDelta`, so total revenue can't change; `normal.totalPaise` and `total.salesPaise` are asserted unchanged. Reason trimmed, 1–200 characters (`RangeError`). **`voidTenderAdjustment`:** `NotFoundError` for an unknown id, otherwise the trigger's void rules.

### `WaiterService` (`src/services/waiter.service.ts`)

```ts
class WaiterService {
  constructor(db: SqlDatabase);

  tagBillToWaiter(billId: string, waiterId: string): Promise<Bill>;
  settleWaiterBill(billId: string, waiterId: string, paymentMode: Tender, amount?: Paise): Promise<WaiterSettlement>;
  recordWaiterRepayment(waiterId: string, amount: Paise, mode: CounterTender, staffId: string): Promise<WaiterRepayment>;
  settleWaiterBills(waiterId: string, billIds: readonly string[], tender: Tender, staffId: string): Promise<WaiterBillsSettlement>;   // Phase 16 Mode A
  receiveWaiterPayment(waiterId: string, amount: Paise, tender: CounterTender, staffId: string): Promise<WaiterReceipt>;            // Phase 16 Mode B
}

interface WaiterSettlement { bill: Bill; payment: BillPayment; remainingDuePaise: Paise; }
interface WaiterRepayment { payment: WaiterPayment; outstandingPaise: Paise; }
interface WaiterBillsSettlement { bills: Bill[]; totalPaise: Paise; balancePaise: Paise; }
type ReceiptAllocation =
  | { kind: 'BILL'; billId: string; billNo: number; amountPaise: Paise; settled: boolean; remainingDuePaise: Paise }
  | { kind: 'CREDIT'; amountPaise: Paise };
interface WaiterReceipt { tender: CounterTender; amountPaise: Paise; allocations: ReceiptAllocation[]; balancePaise: Paise; }
```

**Behaviour notes:**
- **`settleWaiterBill`:** `amount` defaults to the full amount due, and the bill settles once nothing is due. Trusted waiters may pay part now and put the rest on `WAITER_CREDIT`. Untrusted waiters get `PS004` for credit and `PS005` for anything but the exact amount due.
- **`tagBillToWaiter`:** works only on OPEN NORMAL sale bills, and only until the first tender is recorded.
- **Waiter balance (Phase 16)** = Σ due on the waiter's OPEN sale bills + `outstanding_balance`. Both methods below lock the waiter row first (one money movement per waiter at a time) and need an open day (`PS007`).
- **`settleWaiterBills` (Mode A):** each listed bill is paid exactly its due with one tender (₹0 bills just settle), all or nothing. A bill that isn't this waiter's gives `PS002`, and one that isn't OPEN gives `PS001`. `WAITER_CREDIT` needs a trusted waiter (`PS004`). An empty or duplicate list is a `RangeError`.
- **`receiveWaiterPayment` (Mode B):** trusted waiters only (`PS004`); `amount` must be ≤ the balance (`PS008`). The amount pays the oldest OPEN bill first (by `created_at`, bill no), settling each bill it covers and part-paying the next with CASH / UPI bill tenders. Anything left is a `waiter_payments` repayment against the credit. Day End's sales breakdown and the peak windows therefore see bill tenders as before.

### `CounterQueries` (`src/services/counter-queries.ts`)

Read-only; takes any `SqlClient`.

```ts
class CounterQueries {
  constructor(db: SqlClient);

  getCounterContext(cashierId: string): Promise<CounterContext>;   // NotFoundError for an unknown cashier
  lookupSku(code: string): Promise<SkuLookup | null>;              // exact barcode first, then case-insensitive sku_code
  searchSkus(query: string, limit?: number): Promise<SkuLookup[]>; // exact barcode, code prefix or name substring; barcode first,
                                                                   // inactive last, then product name and size FULL→QUARTER, 650→330; default 20
  searchMembers(query: string, limit?: number): Promise<MemberSummary[]>; // active; number prefix or name substring; default limit 20
  listWaiters(): Promise<WaiterSummary[]>;                         // active, by waiter_code
  getWaiterStats(): Promise<WaiterStatsReport>;                    // Phase 15: open day's figures per active waiter
  listWaiterLedger(): Promise<WaiterLedgerRow[]>;                  // Phase 16: waiters with a bill / payment today or a balance; biggest balance first
  getWaiterLedger(waiterId: string): Promise<WaiterLedger>;        // Phase 16: NotFoundError for an unknown waiter
  getBillDetail(billId: string): Promise<BillDetail>;              // NotFoundError for a missing bill
  listCaptainOrders(): Promise<BillDetail[]>;                      // OPEN WAITER_APP sale bills, oldest first (any day)
}

interface CounterContext {
  cashier: StaffSummary;
  businessDay: BusinessDaySummary | null;   // null = no open day; billing is blocked
  peakSession: PeakSessionView | null;      // running session → counter bills in PEAK mode
  openBill: BillDetail | null;              // this cashier's newest OPEN NORMAL counter bill (resume)
  openBills: BillDetail[];                  // Phase 15: all of them, oldest first (held billing tabs)
}
interface WaiterDayTotals {
  openBills: number; openDuePaise: Paise;   // OPEN sale bills of the day; Σ due (total − tendered)
  closedBills: number; settledPaise: Paise; // SETTLED and not reversed; Σ total, any tender (waiter credit included)
}
type WaiterStats = WaiterSummary & WaiterDayTotals;
interface WaiterStatsReport { businessDayId: string | null; waiters: WaiterStats[]; totals: WaiterDayTotals }
interface WaiterLedgerRow extends WaiterSummary {           // Phase 16, open day; billed − paid = balance in normal flows
  billedPaise: Paise;      // Σ totals of the day's non-reversed sale bills tagged to the waiter
  paidPaise: Paise;        // Σ CASH / UPI tenders on those bills + Σ the day's waiter_payments (net of voids)
  balancePaise: Paise;     // Σ due on OPEN waiter bills + outstanding_balance
  openBills: number; openDuePaise: Paise; newestOpenAt: Date | null;
}
interface WaiterLedger {
  waiter: WaiterLedgerRow; creditPaise: Paise;
  openBills: BillDetail[];                 // OPEN sale bills, oldest first
  receipts: LedgerReceipt[];               // today, newest first; rows of one transaction (same now()) + tender form one receipt
}
interface LedgerReceipt { at: Date; tender: 'CASH' | 'UPI'; amountPaise: Paise; allocations: LedgerAllocation[] }  // BILL (settled?, remainingDuePaise) | CREDIT | VOID
interface StaffSummary { id: string; displayName: string; role: 'CASHIER' | 'MANAGER' | 'ADMIN'; }
interface BusinessDaySummary { id: string; businessDate: string /* 'YYYY-MM-DD' */; openedAt: Date; }
interface PeakSessionView extends PeakSession { runningExpectedPaise: Paise; expectedDrawerCashPaise: Paise; }  // drawer total: see 0007
interface SkuLookup {
  id: string; skuCode: string; barcode: string | null; displayName: string; sizeCode: SizeCode;
  pricePaise: Paise; purchasePricePaise: Paise | null; caseSize: number; onHandQty: number; isActive: boolean;
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

### `ExpenseCategoryService` (`src/services/expense-category.service.ts`, Phase 18)

```ts
class ExpenseCategoryService {
  listCategories(opts?: { includeInactive?: boolean }): Promise<ExpenseCategory[]>;  // sort_order, then name
  createCategory(input: { name: string; noteRequired?: boolean }): Promise<ExpenseCategory>;  // appended last; PS012 duplicate (any case)
  updateCategory(id: string, patch: { name?; noteRequired?; isActive?; move?: 'up' | 'down' }): Promise<ExpenseCategory>;
}
interface ExpenseCategory { id; name; isActive; noteRequired; sortOrder; legacyCode: string | null; usedCount: number }
```

- **Names:** `cleanCategoryName` trims and collapses spaces. A blank name or one over 40 characters is a `RangeError`.
- **Disabling:** refused for the last active category (`PS002`).
- **Order:** `move` swaps `sort_order` with the neighbour, under a table lock.
- **Renames:** relabel history, because past expenses resolve by id or by legacy code.

### `OrdersQueries` (`src/services/orders.queries.ts`, Phase 17)

Read-only.
- **`listOrders(): OrderSummary[]`** returns the open day's SALE bills, newest first (`[]` with no open day). One
  query covers status, tender sums, lines and bottles.
- **`getOrder(billId): OrderDetail`** works on any day: `NotFoundError` for an unknown or REVERSAL bill.
- **`receiptFor(order, reprintedAt)`** builds the customer `ReceiptTicket`.

```ts
type OrderStatus = 'OPEN' | 'SETTLED' | 'CANCELLED' | 'VOIDED' | 'PEAK_PENDING' | 'PEAK_RECONCILED';
// VOIDED = a REVERSAL bill points at it (peak undo included); CANCELLED = SETTLED at ₹0; REVERSAL bills are never rows.
interface OrderSummary {
  billId; billNo; createdAt; settledAt; status; mode; source; waiter: { id; code; displayName } | null;
  member: { membershipNo; displayName } | null; peakSessionId; peakSessionNo; createdByStaffId;
  lines; bottles;                          // after same-bill cancellations (a void doesn't change them)
  totalPaise; cashPaise; upiPaise; creditPaise; duePaise /* OPEN only */; voidedAt;
}
interface OrderDetail {
  summary: OrderSummary; detail: BillDetail; cashier: string;
  payments: Array<{ id; tender; amountPaise; at; receiptTotalPaise: Paise | null }>;   // receiptTotal: the waiter payment this tender was a slice of
  settledVia: 'COUNTER' | 'WAITER' | 'PEAK' | null;                                    // WAITER = the bill carries a waiter
  peakSession: { sessionNo; endedAt } | null;
  reversal: { billNo; at; reason; refunds: Array<{ tender; amountPaise /* < 0 */ }> } | null;
}
```

**Printer (`printer.service.ts`):** `formatReceipt` / `ReceiptPrinter` / `PrinterService.printReceipt`.
- The receipt is fixed-width (48 / 32 columns), ASCII via `asciiText`, with money via `receiptMoney` (`Rs 1,23,456.78`).
- It carries no tax lines, and a reprint prints `*** DUPLICATE ***` and a reprint stamp.
- Reprints are stateless (not logged).
- `ApiConfig.printer` defaults to the console stub, like KOT.

### `PurchaseService` (`src/services/purchase.service.ts`)

```ts
class PurchaseService {
  constructor(db: SqlDatabase);

  recordReceipt(input: ReceiptInput, staffId: string): Promise<StockReceiptDetail>;  // one transaction
  listReceipts(businessDayId: string): Promise<StockReceipt[]>;                      // newest first
  getReceipt(receiptId: string): Promise<StockReceiptDetail>;                        // NotFoundError for an unknown id
}

interface ReceiptInput { invoiceNo: string; vendorName?: string | null; lines: ReceiptLineInput[]; }
type ReceiptLineInput = { skuId: string; unitCostPaise: Paise } &
  ({ cases: number; looseBottles: number; caseSize: number }   // Phase 10: qty = cases × caseSize + looseBottles
   | { quantity: number });                                    // loose only (cases 0, case_size NULL)
interface StockReceipt {
  id; businessDayId; invoiceNo; vendorName: string | null; receivedByStaffId; receivedBy: string /* staff name */; createdAt: Date;
  lineCount: number; bottles: number; totalCostPaise: Paise;
}
interface StockReceiptLine {
  id; lineNo; skuId; skuCode; displayName; sizeCode: SizeCode; quantity: number;
  cases: number; caseSize: number | null; looseBottles: number; unitCostPaise: Paise; lineTotalPaise: Paise;
}
interface StockReceiptDetail { receipt: StockReceipt; lines: StockReceiptLine[]; }
```

- **`recordReceipt`:** trims the invoice (required, ≤ 60 chars) and vendor (blank → null, ≤ 100 chars).
  - Lines: 1–200 (`MAX_RECEIPT_LINES`); each a whole quantity of 1–100,000 bottles (`MAX_RECEIPT_QTY`) and a cost ≥ 0 paise; no SKU twice. Case lines: whole `cases` and `looseBottles` ≥ 0, `caseSize` 1–1000, loose below one case, total ≥ 1. Breaking any of these is a `RangeError`.
  - Unknown SKU → `NotFoundError`, inactive SKU → `InactiveError`, no open day → `PS007`, same invoice and vendor already received → `PS011`, `caseSize` no longer the catalog's → `PS002`. Any failure writes nothing.
  - Lines are numbered in input order. Stock rises by trigger in the same transaction.

### `CatalogService` (`src/services/catalog.service.ts`)

```ts
class CatalogService {
  constructor(db: SqlDatabase);

  listCatalog(filter?: { q?: string; includeInactive?: boolean }): Promise<CatalogProduct[]>;
  getProduct(productId: string): Promise<CatalogProduct>;                       // NotFoundError
  createProduct(input: NewProductInput): Promise<CatalogProduct>;               // product + 1–5 sizes, one transaction
  updateProduct(productId: string, patch: ProductPatch): Promise<CatalogProduct>;
  addSku(productId: string, input: NewSkuInput & { codePrefix?: string }): Promise<CatalogProduct>;
  updateSku(skuId: string, patch: SkuPatch): Promise<CatalogProduct>;           // returns the whole product
}

interface CatalogSku extends SkuLookup { productId: string; }
interface CatalogProduct { id; name; category: ProductCategory; isActive: boolean; skus: CatalogSku[] /* FULL → 330 */; }
interface NewSkuInput { sizeCode: SizeCode; salePricePaise: Paise; purchasePricePaise?: Paise | null; caseSize: number; barcode?: string | null; }
interface NewProductInput { name: string; category: ProductCategory; codePrefix: string; skus: NewSkuInput[]; }
interface ProductPatch { name?: string; category?: ProductCategory; isActive?: boolean; }
interface SkuPatch { salePricePaise?: Paise; purchasePricePaise?: Paise | null; caseSize?: number; barcode?: string | null; isActive?: boolean; }  // null clears
```

- **Derived names:** `sku_code` = `PREFIX-F / -H / -Q / -650 / -330`; `display_name` = `Name — Full / Half / Quarter / 650 / 330` (same as the seed). A rename re-derives every size's display name; `sku_code` and `size_code` never change.
- **Validation (`RangeError`):** name 1–80 chars (whitespace collapsed), category one of `PRODUCT_CATEGORIES`, prefix 2–10 A–Z/0–9 (upper-cased), 1–5 distinct sizes, sale price > 0, purchase price ≥ 0, case size 1–1000, barcode ≤ 40 chars with no spaces (blank → null).
- **Active flags:** deactivating a product deactivates its sizes; reactivating it leaves them as they are. Adding a size to, or reactivating a size of, an inactive product → `InactiveError`.
- **List:** products by name; without `includeInactive`, inactive products and sizes are left out. `q` matches the name (contains), any SKU code (prefix) or barcode (exact) and returns the whole product.
- New SKUs start at 0 stock (stock comes only from a GRN). Constants: `DEFAULT_CASE_SIZE`, `MAX_CASE_SIZE`, `SIZE_CODES`, `PRODUCT_CATEGORIES`, `skuCodeFor`, `displayNameFor`.

### `CaptainService` (`src/services/captain.service.ts`)

Waiter (Captain app) flows. Constructed with a `SqlDatabase` and a `KotPrinter`.

```ts
class CaptainService {
  constructor(db: SqlDatabase, printer: KotPrinter);

  getWaiterProfile(waiterId: string): Promise<WaiterProfile>;            // NotFoundError; inactive waiters are returned with isActive: false
  listOpenBills(waiterId: string): Promise<BillDetail[]>;                // OPEN sale bills tagged to the waiter (app or counter), by bill_no
  placeOrder(request: OrderRequest): Promise<PlacedOrder>;
}

interface WaiterProfile extends WaiterSummary { isActive: boolean; creditHeadroomPaise: Paise | null; } // max(limit − outstanding, 0); null = no limit
interface OrderLine { skuId: string; quantity: number; }
interface OrderRequest { requestId: string; deviceId: string; waiterId: string; memberId?: string; items: readonly OrderLine[]; }
interface PlacedOrder {
  bill: Bill; items: BillItem[]; waiter: WaiterSummary; member: MemberSummary | null;
  kot: KotStatus | null;   // null on a replay (never reprints)
  replayed: boolean;
}
function orderFingerprint(request: Omit<OrderRequest, 'requestId'>): string;   // sha256 hex of handset, waiter, member, lines (ids case-insensitive)
interface KotStatus { station: 'COUNTER'; printed: boolean; printedAt: Date | null; error: string | null; }
const MAX_ORDER_LINES = 50;
```

**`placeOrder`** is idempotent on `requestId`:
1. **Look up the key.** If it exists with the same fingerprint, the order is **replayed**:
   - no writes and no print;
   - `items` are the bill's first *N* lines, so later counter edits are excluded.

   If the fingerprint differs, it throws `IdempotencyConflictError`.
2. **Write, in one transaction:**
   - Check the waiter, the optional member and every SKU. A missing one is `NotFoundError`; an inactive one is `InactiveError`.
   - Insert a `NORMAL` / `OPEN` / `WAITER_APP` bill with `waiter_id`, `request_id`, `request_fingerprint` and `captain_device_id` set, and `created_by_staff_id` NULL. The trust snapshot is taken by trigger, and so is bill-on-bill (`PS010`).
   - Add one line per order line, in order, with the usual stock checks (`PS003`).
3. **On a collision with a concurrent attempt** (the unique key, or `PS010` from its own committed order), look the key up again and replay or report the conflict.

Any failure saves nothing and leaves the key unused, and bill numbers stay gap-free. The KOT prints **after** commit: a printer error is reported in `kot` (`printed: false`) and never undoes the order. Orders are allowed while a peak session runs, because waiter bills are always NORMAL.

### `PrinterService` (`src/services/printer.service.ts`)

A stub for the ESC/POS network thermal printer. It implements `KotPrinter`.

```ts
interface KotPrinter { printKOT(ticket: KotTicket): Promise<KotPrintResult>; }
interface KotTicket {
  kotNo: number /* = bill number */; billId: string; station: 'COUNTER';
  waiter: { code: string; displayName: string }; member: { membershipNo: string; displayName: string } | null;
  lines: Array<{ skuCode: string; displayName: string; sizeCode: SizeCode; quantity: number }>; createdAt: Date;
}
interface KotPrintResult { station: 'COUNTER'; printedAt: Date; text: string; }

function formatKot(ticket: KotTicket, format?: { width?: number /* 48 = 80 mm, 32 = 58 mm */; timeZone?: string /* 'Asia/Kolkata' */ }): string;
class PrinterService implements KotPrinter {
  constructor(options?: { sink?: (text: string) => void /* default console.log */; width?: number; timeZone?: string });
}
```

- Tickets show quantities and sizes, never prices.
- Every product category is liquor, so every KOT routes to the `COUNTER` station.
- Not yet built: the real printer (TCP to port 9100, ESC/POS init and cut), and a code-page mapping for non-ASCII characters in item names (for example `—`).

---

## 4. Local HTTP API (`server/`)

Two servers in one process (`npm run api` / `npm run api:dev`), sharing `server/routing.ts`:
- **Counter API** (`server/app.ts`): `127.0.0.1:4310`, loopback `Host` only, for the POS frontend.
- **Captain API** (`server/captain-server.ts`): Wi-Fi-facing, `0.0.0.0:4311`, only `/api/captain/*`, with device-token auth (§4.2). It starts only when at least one handset is paired.

Neither server holds business rules.

**Running it**

| Command | What it does |
|---|---|
| `npm run api:dev` | Embedded PGlite under `.data/pglite` (git-ignored). On an empty database, seeds demo data (cashier, 8 SKUs with barcodes `8900000000001`–`8900000000008`, purchase prices and case sizes 12 / 32 / 64 (beer 12 / 24), waiters W01 trusted / W02 untrusted / W03 trusted with ₹5,000 limit, 3 members, an open business day) and acts as the seeded cashier. |
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
| 400 | `INACTIVE` | Captain order or stock receipt references an inactive waiter, member or SKU (adds `entity`, `id`) |
| 401 | `UNAUTHORIZED` | Captain server: missing, unknown or revoked device token |
| 403 | `FORBIDDEN` | `Host` header is not `localhost`, `127.0.0.1` or `[::1]` (blocks DNS rebinding) |
| 404 | `NOT_FOUND` | Unknown route, or `NotFoundError` (adds `entity`, `id`) |
| 405 | `METHOD_NOT_ALLOWED` | Known path, wrong method |
| 409 | `PS001`–`PS012` | Business-rule violation (adds `constraint` when one fired) |
| 409 | `IDEMPOTENCY_CONFLICT` | Captain `requestId` reused for a different order or handset (adds `requestId`) |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 64 KB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | POST/PUT/PATCH without `Content-Type: application/json` (forces a CORS preflight, which is never approved) |
| 500 | `INTERNAL` | Anything else (details only in the server log) |

**Routes** (cashier = `FL2_CASHIER_ID`)

| Method & path | Body / query | Calls | OK |
|---|---|---|---|
| `GET /api/health` | | | 200 `{ ok: true }` |
| `GET /api/context` | | `getCounterContext(cashier)` | 200 |
| `GET /api/skus/lookup` | `?code=` | `lookupSku` (404 if none) | 200 |
| `GET /api/skus` | `?q=&limit=` (1–50) | `searchSkus` (empty `q` → `[]`) | 200 `SkuLookup[]` |
| `GET /api/members` | `?q=&limit=` (1–100) | `searchMembers` | 200 |
| `GET /api/waiters` | | `listWaiters` | 200 |
| `GET /api/waiters/stats` | | `getWaiterStats` (Phase 15) | 200 |
| `GET /api/captain-orders` | | `listCaptainOrders` (cashier's settle queue; not on the Wi-Fi server) | 200 `BillDetail[]` |
| `GET /api/bills/:billId` | | `getBillDetail` | 200 |
| `POST /api/bills` | `{ mode, memberId? }` | `createBill(mode, cashier, memberId)` | 201 |
| `POST /api/bills/:billId/items` | `{ skuId, quantity }` | `addItemToBill` | 201 |
| `POST /api/bills/:billId/items/:itemId/cancel` | `{ quantity, restock? }` | `cancelBillItem` (works on Captain orders too) | 201 |
| `PUT /api/bills/:billId/member` | `{ memberId: uuid \| null }` | `setBillMember` | 200 |
| `PUT /api/bills/:billId/waiter` | `{ waiterId }` | `tagBillToWaiter` | 200 |
| `POST /api/bills/:billId/settle` | `{ payments: [{ mode: 'CASH'\|'UPI', amount }] }` | `settleNormalBill` | 200 |
| `POST /api/bills/:billId/settle-waiter` | `{ waiterId, tender, amount? }` | `settleWaiterBill` | 200 |
| `POST /api/bills/:billId/close-empty` | | `closeEmptyBill` | 200 |
| `POST /api/bills/:billId/reverse` | `{ reason, restock?, creditRefundTender?, peakRefundTender? }` | `reverseBill(…, cashier, …)` | 201 |
| `POST /api/peak/sales` | `{ sessionId, skuId, quantity }` | `recordPeakSale(…, cashier)` | 201 |
| `POST /api/peak/undo-last` | `{}` | `undoLastPeakSale(cashier)`: PS007 with no running session, 404 when nothing is left | 201 |
| `GET /api/peak/baseline` | | `getStartBaseline(open day)`; 404 when no day is open | 200 |
| `POST /api/peak/sessions` | `{ businessDayId, declaredCash, declaredUpi }` | `startPeakSession(…, cashier)` | 201 |
| `POST /api/peak/sessions/:sessionId/end` | `{ countedCash, countedUpi }` | `endPeakSession(…, cashier)` | 200 |
| `POST /api/waiters/:waiterId/repayments` | `{ amount, tender: 'CASH'\|'UPI' }` | `recordWaiterRepayment(…, cashier)` | 201 |
| `GET /api/orders` | | `listOrders` (Phase 17) | 200 |
| `GET /api/orders/:billId` | | `getOrder` (Phase 17) | 200 |
| `POST /api/orders/:billId/reprint` | `{}` | `printer.printReceipt(receiptFor(order, now))` → `{ printedAt, text }` (Phase 17) | 201 |
| `GET /api/waiter-ledger` | | `listWaiterLedger` (Phase 16) | 200 |
| `GET /api/waiter-ledger/:waiterId` | | `getWaiterLedger` (Phase 16) | 200 |
| `POST /api/waiters/:waiterId/settle-bills` | `{ billIds: string[], tender }` | `settleWaiterBills(…, cashier)` (Phase 16) | 201 |
| `POST /api/waiters/:waiterId/receive` | `{ amount, tender: 'CASH'\|'UPI' }` | `receiveWaiterPayment(…, cashier)` (Phase 16) | 201 |
| `GET /api/day-end` | | `getDayEndSummary(getCurrentDayId())`: the open day, else the last closed one; 404 before any day. Carries `sales` (Phase 11) | 200 |
| `POST /api/days` | `{ openingFloat }` | `openBusinessDay(…, cashier)` | 201 |
| `POST /api/days/:dayId/close` | `{ countedCash }` | `closeBusinessDay(…, cashier)` | 200 |
| `GET /api/expenses` | | `listCashExpenses(open day)`; 404 when no day is open | 200 |
| `POST /api/expenses` | `{ amount, categoryId, description? }` (Phase 18; `categoryId` required) | `recordCashExpense(…, cashier, categoryId)` | 201 |
| `GET /api/expense-categories` | `?includeInactive=1` | `listCategories` (picker order; `usedCount` per category) | 200 |
| `POST /api/expense-categories` | `{ name, noteRequired? }` | `createCategory` (appended last; PS012 duplicate) | 201 |
| `PATCH /api/expense-categories/:categoryId` | `{ name?, noteRequired?, isActive?, move?: 'up'\|'down' }` | `updateCategory` (PS002 for disabling the last active one) | 200 |
| `POST /api/expenses/:expenseId/void` | | `voidCashExpense(…, cashier)` | 201 |
| `POST /api/days/:dayId/tender-adjustments` | `{ cashDelta, reason }` (`cashDelta` signed paise string, ≠ 0) | `adjustTenderSplit(…, cashier)` | 201 |
| `POST /api/tender-adjustments/:adjustmentId/void` | | `voidTenderAdjustment(…, cashier)` | 201 |
| `GET /api/bank-deposits` | | `listBankDeposits(open day)`; 404 when no day is open | 200 |
| `POST /api/bank-deposits` | `{ amount, reference? }` | `recordBankDeposit(…, cashier)`; PS007 while a peak runs | 201 |
| `POST /api/bank-deposits/:depositId/void` | | `voidBankDeposit(…, cashier)` | 201 |
| `GET /api/purchases` | | `listReceipts(open day)`; 404 when no day is open | 200 `StockReceipt[]` |
| `GET /api/purchases/:receiptId` | | `getReceipt` | 200 `StockReceiptDetail` |
| `POST /api/purchases` | `{ invoiceNo, vendorName?, lines: [{ skuId, cases, looseBottles?, caseSize, unitCost }] }` or the loose-only `{ skuId, quantity, unitCost }` (`unitCost` in paise, `"0"` allowed) | `recordReceipt(…, cashier)` | 201 `StockReceiptDetail` |
| `GET /api/catalog` | `?q=&includeInactive=true` | `listCatalog` | 200 `CatalogProduct[]` |
| `POST /api/catalog/products` | `{ name, category, codePrefix, skus: [{ sizeCode, salePrice, purchasePrice?, caseSize, barcode? }] }` | `createProduct` | 201 `CatalogProduct` |
| `PATCH /api/catalog/products/:productId` | `{ name?, category?, isActive? }` | `updateProduct` | 200 `CatalogProduct` |
| `POST /api/catalog/products/:productId/skus` | `{ sizeCode, salePrice, purchasePrice?, caseSize, barcode?, codePrefix? }` | `addSku` | 201 `CatalogProduct` |
| `PATCH /api/catalog/skus/:skuId` | `{ salePrice?, purchasePrice? (null clears), caseSize?, barcode? (null clears), isActive? }` | `updateSku` | 200 `CatalogProduct` |

The frontend dev server proxies `/api` to `http://127.0.0.1:4310`.

### 4.2 Captain API (Wi-Fi, `server/captain-server.ts`)

**Auth.**
- Every request needs `Authorization: Bearer <token>` from an active paired handset. That includes unknown paths, since auth runs before routing.
- A missing, malformed, unknown or revoked token all get the same response: `401 UNAUTHORIZED` with `WWW-Authenticate: Bearer realm="fl2-captain"`.
- Counter routes don't exist on this server (404 after auth).

**Paired handsets** (`server/captain-devices.ts`):
- Each handset gets a random 256-bit token. The server stores only its SHA-256, in `FL2_CAPTAIN_DEVICES` (default `.data/captain-devices.json`, mode 0600, git-ignored).
- Tokens are compared in constant time.
- The running server re-reads the file when it changes, so pairing and revoking need no restart.
- Revoked records are kept for audit, and their ids stay reserved.

| Command | Effect |
|---|---|
| `npm run captain:devices -- pair <id> "<label>"` | Pairs a handset (`id` like `handset-01`) and prints its token **once** |
| `npm run captain:devices -- revoke <id>` | Token stops working on the next request |
| `npm run captain:devices -- list` | Active and revoked handsets |

| Variable | Default | Meaning |
|---|---|---|
| `FL2_CAPTAIN_HOST` | `0.0.0.0` | Bind address (all interfaces, so handsets can reach it) |
| `FL2_CAPTAIN_PORT` | `4311` | Port |
| `FL2_CAPTAIN_DEVICES` | `.data/captain-devices.json` | Devices file |

**Transport.** It's plain HTTP, so tokens cross the Wi-Fi in clear text. Run it on a staff-only WPA2/WPA3 network; TLS is a follow-up. The KOT printer is `CaptainServerConfig.printer` (default `new PrinterService()`, stdout).

**Routes** (`server/captain-api.ts`; same JSON conventions as the counter API)

| Method & path | Body | Calls | OK | Errors |
|---|---|---|---|---|
| `GET /api/captain/health` | | | 200 `{ ok, deviceId }` | 401 |
| `GET /api/captain/waiter/:waiterId` | | `getWaiterProfile` | 200 `WaiterProfile` | 400 malformed id, 404 unknown waiter |
| `GET /api/captain/waiter/:waiterId/bills` | | `listOpenBills` | 200 `BillDetail[]` | 400, 404 |
| `POST /api/captain/kot` | `{ requestId: uuid, waiterId, memberId?: uuid \| null, items: [{ skuId, quantity }] }` (1–50 items) | `placeOrder` (handset from the token) | **201** new order · **200** `replayed: true` | 400 `BAD_REQUEST` / `INACTIVE`, 404 unknown waiter / member / SKU, 409 `PS003` out of stock, 409 `PS010` bill-on-bill, 409 `IDEMPOTENCY_CONFLICT` |

**`requestId` contract for the app:**
- Generate one UUID per order when the waiter taps send, and reuse it on every retry of that order.
- A 200 replay means the order already went through.
- `IDEMPOTENCY_CONFLICT` means the app reused a key for a different order, which is a client bug.
