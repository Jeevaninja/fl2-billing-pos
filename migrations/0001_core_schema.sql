-- FL2 POS · Phase 1 core schema: tables, constraints, indexes.
-- Design reference: docs/db/phase1-core-schema.md
--
-- Money:      BIGINT whole paise (₹1 = 100). No NUMERIC / REAL / DOUBLE anywhere.
-- Quantities: INTEGER whole sealed bottles. No ml / peg / open-bottle columns.
-- Keys:       UUIDv7 (time-ordered, generated locally, sync-safe). Requires PostgreSQL 18+.
-- Behaviour (append-only rules, state transitions, derived balances) lives in 0002_core_rules.sql.

-- ─────────────────────────────────────────────────────────────────────────────
-- Supporting master data
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE staff (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  display_name  text        NOT NULL,
  role          text        NOT NULL CONSTRAINT staff_role_valid CHECK (role IN ('CASHIER', 'MANAGER', 'ADMIN')),
  pin_hash      text,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Minimal member register: the FK target for bills.member_id. Optional at billing (no KYC gate).
CREATE TABLE members (
  id             uuid        PRIMARY KEY DEFAULT uuidv7(),
  membership_no  text        NOT NULL CONSTRAINT members_membership_no_unique UNIQUE,
  display_name   text        NOT NULL,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Inventory
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE products (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  name        text        NOT NULL,
  category    text        NOT NULL CONSTRAINT products_category_valid
                CHECK (category IN ('WHISKY', 'RUM', 'VODKA', 'BRANDY', 'GIN', 'WINE', 'BEER', 'OTHER')),
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_name_unique ON products (lower(name));

-- One row per sellable sealed bottle size. size_code is a label only; no volume is stored.
CREATE TABLE skus (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  product_id    uuid        NOT NULL REFERENCES products (id),
  sku_code      text        NOT NULL CONSTRAINT skus_sku_code_unique UNIQUE,
  barcode       text        CONSTRAINT skus_barcode_unique UNIQUE,
  size_code     text        NOT NULL CONSTRAINT skus_size_code_valid
                  CHECK (size_code IN ('FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330')),
  display_name  text        NOT NULL,
  price_paise   bigint      NOT NULL CONSTRAINT skus_price_positive CHECK (price_paise > 0),
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skus_product_size_unique UNIQUE (product_id, size_code)
);
CREATE INDEX skus_product_id_idx ON skus (product_id);

-- Cached on-hand balance. Written only by triggers on stock_movements.
CREATE TABLE sku_stock (
  sku_id       uuid        PRIMARY KEY REFERENCES skus (id),
  on_hand_qty  integer     NOT NULL DEFAULT 0 CONSTRAINT sku_stock_non_negative CHECK (on_hand_qty >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Business day & peak sessions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE business_days (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  business_date       date        NOT NULL CONSTRAINT business_days_date_unique UNIQUE,
  status              text        NOT NULL DEFAULT 'OPEN' CONSTRAINT business_days_status_valid CHECK (status IN ('OPEN', 'CLOSED')),
  next_bill_no        integer     NOT NULL DEFAULT 1 CONSTRAINT business_days_next_bill_no_positive CHECK (next_bill_no >= 1),
  opened_at           timestamptz NOT NULL DEFAULT now(),
  opened_by_staff_id  uuid        NOT NULL REFERENCES staff (id),
  closed_at           timestamptz,
  closed_by_staff_id  uuid        REFERENCES staff (id),
  CONSTRAINT business_days_closed_meta CHECK (
    (status = 'CLOSED') = (closed_at IS NOT NULL)
    AND (status = 'CLOSED') = (closed_by_staff_id IS NOT NULL)
  )
);
-- At most one trading day is open at a time.
CREATE UNIQUE INDEX business_days_one_open ON business_days (status) WHERE status = 'OPEN';

-- A business day may contain several peak windows; each is reconciled on its own.
CREATE TABLE peak_sessions (
  id                        uuid        PRIMARY KEY DEFAULT uuidv7(),
  business_day_id           uuid        NOT NULL REFERENCES business_days (id),
  session_no                integer     NOT NULL CONSTRAINT peak_sessions_session_no_positive CHECK (session_no >= 1),
  started_at                timestamptz NOT NULL DEFAULT now(),
  started_by_staff_id       uuid        NOT NULL REFERENCES staff (id),
  peak_start_cash           bigint      NOT NULL CONSTRAINT peak_sessions_start_cash_non_negative CHECK (peak_start_cash >= 0),
  peak_start_upi            bigint      NOT NULL CONSTRAINT peak_sessions_start_upi_non_negative CHECK (peak_start_upi >= 0),
  ended_at                  timestamptz,
  ended_by_staff_id         uuid        REFERENCES staff (id),
  peak_end_cash             bigint      CONSTRAINT peak_sessions_end_cash_non_negative CHECK (peak_end_cash >= 0),
  peak_end_upi              bigint      CONSTRAINT peak_sessions_end_upi_non_negative CHECK (peak_end_upi >= 0),
  -- Frozen at session end (computed by trigger; see pos_peak_expected_paise).
  peak_expected_paise       bigint,
  peak_variance_paise       bigint,
  CONSTRAINT peak_sessions_session_no_unique UNIQUE (business_day_id, session_no),
  CONSTRAINT peak_sessions_end_fields_together CHECK (
    (ended_at IS NULL) = (ended_by_staff_id IS NULL)
    AND (ended_at IS NULL) = (peak_end_cash IS NULL)
    AND (ended_at IS NULL) = (peak_end_upi IS NULL)
    AND (ended_at IS NULL) = (peak_expected_paise IS NULL)
    AND (ended_at IS NULL) = (peak_variance_paise IS NULL)
  ),
  CONSTRAINT peak_sessions_end_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- Only one peak window can be running per day.
CREATE UNIQUE INDEX peak_sessions_one_active_per_day ON peak_sessions (business_day_id) WHERE ended_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Waiters
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE waiters (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  waiter_code          text        NOT NULL CONSTRAINT waiters_code_unique UNIQUE,
  display_name         text        NOT NULL,
  phone                text,
  pin_hash             text,
  is_trusted           boolean     NOT NULL DEFAULT false,
  -- Paise owed to the house. Derived from waiter_ledger_entries; written only by trigger.
  outstanding_balance  bigint      NOT NULL DEFAULT 0 CONSTRAINT waiters_outstanding_non_negative CHECK (outstanding_balance >= 0),
  credit_limit_paise   bigint      CONSTRAINT waiters_credit_limit_non_negative CHECK (credit_limit_paise IS NULL OR credit_limit_paise >= 0),
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Money a waiter hands to the counter against their running account.
CREATE TABLE waiter_payments (
  id                          uuid        PRIMARY KEY DEFAULT uuidv7(),
  waiter_id                   uuid        NOT NULL REFERENCES waiters (id),
  business_day_id             uuid        NOT NULL REFERENCES business_days (id),
  peak_session_id             uuid        REFERENCES peak_sessions (id),
  tender_type                 text        NOT NULL CONSTRAINT waiter_payments_tender_valid CHECK (tender_type IN ('CASH', 'UPI')),
  amount_paise                bigint      NOT NULL CONSTRAINT waiter_payments_amount_non_zero CHECK (amount_paise <> 0),
  reverses_waiter_payment_id  uuid        CONSTRAINT waiter_payments_reverses_unique UNIQUE REFERENCES waiter_payments (id),
  upi_ref                     text,
  received_by_staff_id        uuid        NOT NULL REFERENCES staff (id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waiter_payments_reversal_shape CHECK (
    (amount_paise > 0 AND reverses_waiter_payment_id IS NULL)
    OR (amount_paise < 0 AND reverses_waiter_payment_id IS NOT NULL)
  )
);
CREATE INDEX waiter_payments_waiter_idx ON waiter_payments (waiter_id, created_at);
CREATE INDEX waiter_payments_peak_session_idx ON waiter_payments (peak_session_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Billing
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE bills (
  id                         uuid        PRIMARY KEY DEFAULT uuidv7(),
  business_day_id            uuid        NOT NULL REFERENCES business_days (id),
  bill_no                    integer     NOT NULL,
  bill_kind                  text        NOT NULL DEFAULT 'SALE' CONSTRAINT bills_kind_valid CHECK (bill_kind IN ('SALE', 'REVERSAL')),
  billing_mode               text        NOT NULL CONSTRAINT bills_mode_valid CHECK (billing_mode IN ('NORMAL', 'PEAK')),
  status                     text        NOT NULL CONSTRAINT bills_status_valid
                               CHECK (status IN ('OPEN', 'SETTLED', 'PEAK_UNSETTLED', 'PEAK_RECONCILED')),
  source                     text        NOT NULL CONSTRAINT bills_source_valid CHECK (source IN ('COUNTER', 'WAITER_APP')),
  peak_session_id            uuid        REFERENCES peak_sessions (id),
  waiter_id                  uuid        REFERENCES waiters (id),
  waiter_trusted_at_billing  boolean,
  member_id                  uuid        REFERENCES members (id),
  -- Σ bill_items.line_total_paise; maintained by trigger.
  total_paise                bigint      NOT NULL DEFAULT 0,
  reverses_bill_id           uuid        CONSTRAINT bills_reverses_unique UNIQUE REFERENCES bills (id),
  replaces_bill_id           uuid        CONSTRAINT bills_replaces_unique UNIQUE REFERENCES bills (id),
  reversal_reason            text,
  created_by_staff_id        uuid        REFERENCES staff (id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  settled_at                 timestamptz,
  settled_by_staff_id        uuid        REFERENCES staff (id),
  peak_reconciled_at         timestamptz,
  CONSTRAINT bills_bill_no_unique UNIQUE (business_day_id, bill_no),
  CONSTRAINT bills_mode_status_pairing CHECK (
    (billing_mode = 'NORMAL' AND status IN ('OPEN', 'SETTLED'))
    OR (billing_mode = 'PEAK' AND status IN ('PEAK_UNSETTLED', 'PEAK_RECONCILED'))
  ),
  CONSTRAINT bills_peak_session_pairing CHECK ((billing_mode = 'PEAK') = (peak_session_id IS NOT NULL)),
  CONSTRAINT bills_peak_counter_only CHECK (billing_mode = 'NORMAL' OR (source = 'COUNTER' AND waiter_id IS NULL)),
  CONSTRAINT bills_waiter_app_needs_waiter CHECK (source <> 'WAITER_APP' OR waiter_id IS NOT NULL),
  CONSTRAINT bills_trust_snapshot CHECK ((waiter_id IS NULL) = (waiter_trusted_at_billing IS NULL)),
  CONSTRAINT bills_reversal_shape CHECK ((bill_kind = 'REVERSAL') = (reverses_bill_id IS NOT NULL)),
  CONSTRAINT bills_reversal_reason CHECK (bill_kind = 'SALE' OR btrim(coalesce(reversal_reason, '')) <> ''),
  CONSTRAINT bills_total_sign CHECK (
    (bill_kind = 'SALE' AND total_paise >= 0) OR (bill_kind = 'REVERSAL' AND total_paise <= 0)
  ),
  CONSTRAINT bills_no_self_reference CHECK (reverses_bill_id <> id AND replaces_bill_id <> id),
  CONSTRAINT bills_replacement_is_sale CHECK (replaces_bill_id IS NULL OR bill_kind = 'SALE'),
  CONSTRAINT bills_settled_meta CHECK ((status = 'SETTLED') = (settled_at IS NOT NULL)),
  CONSTRAINT bills_reconciled_meta CHECK ((status = 'PEAK_RECONCILED') = (peak_reconciled_at IS NOT NULL))
);
CREATE INDEX bills_day_status_idx ON bills (business_day_id, status);
CREATE INDEX bills_waiter_status_idx ON bills (waiter_id, status) WHERE waiter_id IS NOT NULL;
CREATE INDEX bills_peak_session_idx ON bills (peak_session_id) WHERE peak_session_id IS NOT NULL;
CREATE INDEX bills_created_at_idx ON bills (created_at);

CREATE TABLE bill_items (
  id                     uuid        PRIMARY KEY DEFAULT uuidv7(),
  bill_id                uuid        NOT NULL REFERENCES bills (id),
  line_no                integer     NOT NULL CONSTRAINT bill_items_line_no_positive CHECK (line_no >= 1),
  sku_id                 uuid        NOT NULL REFERENCES skus (id),
  sku_code_snapshot      text        NOT NULL,
  display_name_snapshot  text        NOT NULL,
  size_code_snapshot     text        NOT NULL,
  qty                    integer     NOT NULL CONSTRAINT bill_items_qty_non_zero CHECK (qty <> 0),
  unit_price_paise       bigint      NOT NULL CONSTRAINT bill_items_price_non_negative CHECK (unit_price_paise >= 0),
  line_total_paise       bigint      NOT NULL GENERATED ALWAYS AS (qty::bigint * unit_price_paise) STORED,
  reverses_item_id       uuid        REFERENCES bill_items (id),
  restock                boolean     NOT NULL DEFAULT true,
  waiter_id              uuid        REFERENCES waiters (id),
  created_by_staff_id    uuid        REFERENCES staff (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bill_items_line_no_unique UNIQUE (bill_id, line_no),
  CONSTRAINT bill_items_reversal_shape CHECK (
    (qty > 0 AND reverses_item_id IS NULL) OR (qty < 0 AND reverses_item_id IS NOT NULL)
  ),
  CONSTRAINT bill_items_restock_only_on_negative CHECK (qty < 0 OR restock)
);
CREATE INDEX bill_items_reverses_item_idx ON bill_items (reverses_item_id) WHERE reverses_item_id IS NOT NULL;

CREATE TABLE bill_payments (
  id                    uuid        PRIMARY KEY DEFAULT uuidv7(),
  bill_id               uuid        NOT NULL REFERENCES bills (id),
  business_day_id       uuid        NOT NULL REFERENCES business_days (id),
  -- Peak window during which the money moved (set by trigger); drives peak reconciliation.
  peak_session_id       uuid        REFERENCES peak_sessions (id),
  tender_type           text        NOT NULL CONSTRAINT bill_payments_tender_valid CHECK (tender_type IN ('CASH', 'UPI', 'WAITER_CREDIT')),
  amount_paise          bigint      NOT NULL CONSTRAINT bill_payments_amount_non_zero CHECK (amount_paise <> 0),
  reverses_payment_id   uuid        CONSTRAINT bill_payments_reverses_unique UNIQUE REFERENCES bill_payments (id),
  upi_ref               text,
  received_by_staff_id  uuid        REFERENCES staff (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bill_payments_reversal_shape CHECK (amount_paise < 0 OR reverses_payment_id IS NULL)
);
CREATE INDEX bill_payments_bill_idx ON bill_payments (bill_id);
CREATE INDEX bill_payments_peak_session_idx ON bill_payments (peak_session_id) WHERE peak_session_id IS NOT NULL;

-- Waiter running account. + = waiter owes more, − = waiter owes less.
CREATE TABLE waiter_ledger_entries (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  waiter_id            uuid        NOT NULL REFERENCES waiters (id),
  business_day_id      uuid        NOT NULL REFERENCES business_days (id),
  entry_type           text        NOT NULL CONSTRAINT waiter_ledger_type_valid CHECK (entry_type IN (
                         'BILL_CREDIT', 'BILL_CREDIT_REVERSAL', 'PAYMENT', 'PAYMENT_REVERSAL', 'MANUAL_ADJUSTMENT')),
  amount_paise         bigint      NOT NULL CONSTRAINT waiter_ledger_amount_non_zero CHECK (amount_paise <> 0),
  balance_after_paise  bigint      NOT NULL CONSTRAINT waiter_ledger_balance_non_negative CHECK (balance_after_paise >= 0),
  bill_payment_id      uuid        CONSTRAINT waiter_ledger_bill_payment_unique UNIQUE REFERENCES bill_payments (id),
  waiter_payment_id    uuid        CONSTRAINT waiter_ledger_waiter_payment_unique UNIQUE REFERENCES waiter_payments (id),
  reason               text,
  created_by_staff_id  uuid        REFERENCES staff (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waiter_ledger_sign_by_type CHECK (
    (entry_type IN ('BILL_CREDIT', 'PAYMENT_REVERSAL') AND amount_paise > 0)
    OR (entry_type IN ('BILL_CREDIT_REVERSAL', 'PAYMENT') AND amount_paise < 0)
    OR entry_type = 'MANUAL_ADJUSTMENT'
  ),
  CONSTRAINT waiter_ledger_bill_payment_link CHECK (
    (entry_type IN ('BILL_CREDIT', 'BILL_CREDIT_REVERSAL')) = (bill_payment_id IS NOT NULL)
  ),
  CONSTRAINT waiter_ledger_waiter_payment_link CHECK (
    (entry_type IN ('PAYMENT', 'PAYMENT_REVERSAL')) = (waiter_payment_id IS NOT NULL)
  ),
  CONSTRAINT waiter_ledger_manual_needs_reason CHECK (
    entry_type <> 'MANUAL_ADJUSTMENT' OR (btrim(coalesce(reason, '')) <> '' AND created_by_staff_id IS NOT NULL)
  )
);
CREATE INDEX waiter_ledger_waiter_idx ON waiter_ledger_entries (waiter_id, created_at);

-- Stock ledger: the single source of truth for whole-bottle stock.
CREATE TABLE stock_movements (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  sku_id               uuid        NOT NULL REFERENCES skus (id),
  business_day_id      uuid        REFERENCES business_days (id),
  movement_type        text        NOT NULL CONSTRAINT stock_movements_type_valid CHECK (movement_type IN (
                         'OPENING', 'PURCHASE_RECEIPT', 'SALE', 'SALE_REVERSAL', 'ADJUSTMENT')),
  qty_delta            integer     NOT NULL CONSTRAINT stock_movements_qty_non_zero CHECK (qty_delta <> 0),
  bill_item_id         uuid        CONSTRAINT stock_movements_bill_item_unique UNIQUE REFERENCES bill_items (id),
  source_ref_type      text,
  source_ref_id        uuid,
  reason               text,
  created_by_staff_id  uuid        REFERENCES staff (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_movements_sign_by_type CHECK (
    (movement_type = 'SALE' AND qty_delta < 0)
    OR (movement_type IN ('OPENING', 'PURCHASE_RECEIPT', 'SALE_REVERSAL') AND qty_delta > 0)
    OR movement_type = 'ADJUSTMENT'
  ),
  CONSTRAINT stock_movements_bill_item_link CHECK (
    (movement_type IN ('SALE', 'SALE_REVERSAL')) = (bill_item_id IS NOT NULL)
  ),
  CONSTRAINT stock_movements_adjustment_needs_reason CHECK (
    movement_type <> 'ADJUSTMENT' OR (btrim(coalesce(reason, '')) <> '' AND created_by_staff_id IS NOT NULL)
  ),
  CONSTRAINT stock_movements_day_required CHECK (movement_type = 'OPENING' OR business_day_id IS NOT NULL)
);
CREATE INDEX stock_movements_sku_idx ON stock_movements (sku_id, created_at);
CREATE INDEX stock_movements_day_idx ON stock_movements (business_day_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Cloud sync: transactional outbox (rows written by trigger in the same transaction)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE sync_outbox (
  seq             bigserial   PRIMARY KEY,
  event_id        uuid        NOT NULL DEFAULT uuidv7() CONSTRAINT sync_outbox_event_id_unique UNIQUE,
  aggregate_type  text        NOT NULL,
  aggregate_id    uuid        NOT NULL,
  event_type      text        NOT NULL,
  payload         jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  synced_at       timestamptz,
  attempts        integer     NOT NULL DEFAULT 0 CONSTRAINT sync_outbox_attempts_non_negative CHECK (attempts >= 0),
  last_error      text
);
CREATE INDEX sync_outbox_pending_idx ON sync_outbox (seq) WHERE synced_at IS NULL;
