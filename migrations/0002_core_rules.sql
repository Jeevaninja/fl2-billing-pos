-- FL2 POS · Phase 1 core rules: append-only guards, state transitions, derived balances,
-- peak reconciliation and the sync outbox. Design reference: docs/db/phase1-core-schema.md
--
-- Error codes (mirrored in src/db/errors.ts):
--   PS001 append-only / frozen row        PS006 reversal rule
--   PS002 illegal state transition        PS007 business day / peak session rule
--   PS003 insufficient stock              PS008 waiter balance would go negative
--   PS004 credit not allowed              PS009 derived column written directly
--   PS005 tender mismatch
--
-- Derived columns (bills.total_paise, waiters.outstanding_balance, sku_stock.on_hand_qty,
-- business_days.next_bill_no) may only change from inside another trigger, detected with
-- pg_trigger_depth() > 1. A direct UPDATE from the application runs at depth 1.

-- ─────────────────────────────────────────────────────────────────────────────
-- Generic helpers
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION pos_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'PS001';
END $$;

CREATE FUNCTION pos_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION pos_open_business_day_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM business_days WHERE status = 'OPEN'
$$;

-- Resolves (or validates) the business day a row is posted to. Takes a share lock so the
-- day cannot be closed underneath the posting transaction.
CREATE FUNCTION pos_require_open_day(p_day_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_day_id uuid := coalesce(p_day_id, pos_open_business_day_id());
BEGIN
  IF v_day_id IS NULL THEN
    RAISE EXCEPTION 'no business day is open' USING ERRCODE = 'PS007';
  END IF;
  PERFORM 1 FROM business_days WHERE id = v_day_id AND status = 'OPEN' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'business day % is not open', v_day_id USING ERRCODE = 'PS007';
  END IF;
  RETURN v_day_id;
END $$;

-- The running peak session of a day, share-locked so it cannot end mid-transaction.
CREATE FUNCTION pos_active_peak_session_id(p_day_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_session_id uuid;
BEGIN
  SELECT id INTO v_session_id
    FROM peak_sessions
   WHERE business_day_id = p_day_id AND ended_at IS NULL
     FOR SHARE;
  RETURN v_session_id;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sync outbox capture
-- TG_ARGV lists derived columns: an UPDATE that only touches those is not emitted
-- (the cloud rebuilds them from the ledgers that are emitted).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION pos_outbox_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_new jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - TG_ARGV) = (v_new - TG_ARGV) THEN
    RETURN NULL;
  END IF;
  INSERT INTO sync_outbox (aggregate_type, aggregate_id, event_type, payload)
  VALUES (TG_TABLE_NAME, (v_new ->> 'id')::uuid, TG_TABLE_NAME || '.' || lower(TG_OP), v_new - 'pin_hash');
  RETURN NULL;
END $$;

CREATE FUNCTION pos_sync_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.seq, NEW.event_id, NEW.aggregate_type, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.created_at)
     IS DISTINCT FROM
     (OLD.seq, OLD.event_id, OLD.aggregate_type, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.created_at) THEN
    RAISE EXCEPTION 'sync_outbox events are immutable; only delivery status may change' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Inventory
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION pos_skus_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sku_stock (sku_id) VALUES (NEW.id);
  RETURN NULL;
END $$;

CREATE FUNCTION pos_sku_stock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'sku_stock is derived from stock_movements and cannot be written directly' USING ERRCODE = 'PS009';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.on_hand_qty <> 0 THEN
    RAISE EXCEPTION 'sku_stock rows start at zero; post an OPENING movement instead' USING ERRCODE = 'PS009';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION pos_stock_movements_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_on_hand integer;
BEGIN
  IF NEW.movement_type IN ('SALE', 'SALE_REVERSAL') AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'SALE / SALE_REVERSAL movements are posted automatically from bill_items' USING ERRCODE = 'PS009';
  END IF;
  IF NEW.movement_type <> 'OPENING' THEN
    NEW.business_day_id := pos_require_open_day(NEW.business_day_id);
  END IF;

  SELECT on_hand_qty INTO v_on_hand FROM sku_stock WHERE sku_id = NEW.sku_id FOR UPDATE;
  IF FOUND AND v_on_hand + NEW.qty_delta < 0 THEN
    RAISE EXCEPTION 'insufficient stock for %: % bottle(s) on hand, % requested',
      (SELECT sku_code FROM skus WHERE id = NEW.sku_id), v_on_hand, -NEW.qty_delta
      USING ERRCODE = 'PS003';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION pos_stock_movements_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE sku_stock
     SET on_hand_qty = on_hand_qty + NEW.qty_delta,
         updated_at = now()
   WHERE sku_id = NEW.sku_id;
  RETURN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Business days & peak sessions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION pos_business_days_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'OPEN' OR NEW.next_bill_no <> 1 THEN
    RAISE EXCEPTION 'business days start OPEN with bill numbering at 1' USING ERRCODE = 'PS002';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION pos_business_days_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_open_bills integer;
BEGIN
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'business day % is closed and frozen', OLD.business_date USING ERRCODE = 'PS001';
  END IF;
  IF (NEW.id, NEW.business_date, NEW.opened_at, NEW.opened_by_staff_id)
     IS DISTINCT FROM (OLD.id, OLD.business_date, OLD.opened_at, OLD.opened_by_staff_id) THEN
    RAISE EXCEPTION 'business day identity columns are immutable' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.next_bill_no <> OLD.next_bill_no
     AND (pg_trigger_depth() < 2 OR NEW.next_bill_no <> OLD.next_bill_no + 1) THEN
    RAISE EXCEPTION 'next_bill_no is allocated automatically' USING ERRCODE = 'PS009';
  END IF;

  IF NEW.status = 'CLOSED' THEN
    IF EXISTS (SELECT 1 FROM peak_sessions WHERE business_day_id = NEW.id AND ended_at IS NULL) THEN
      RAISE EXCEPTION 'end the running peak session before closing the business day' USING ERRCODE = 'PS007';
    END IF;
    SELECT count(*) INTO v_open_bills
      FROM bills WHERE business_day_id = NEW.id AND status IN ('OPEN', 'PEAK_UNSETTLED');
    IF v_open_bills > 0 THEN
      RAISE EXCEPTION 'cannot close business day %: % bill(s) still open', OLD.business_date, v_open_bills
        USING ERRCODE = 'PS007';
    END IF;
    NEW.closed_at := now();
  ELSIF (NEW.closed_at, NEW.closed_by_staff_id) IS DISTINCT FROM (OLD.closed_at, OLD.closed_by_staff_id) THEN
    RAISE EXCEPTION 'closing metadata only changes when the day is closed' USING ERRCODE = 'PS002';
  END IF;
  RETURN NEW;
END $$;

-- Expected cash + UPI collected during a peak session:
--   Σ peak bill totals (incl. negative peak reversals)
-- + Σ CASH/UPI bill tenders taken during the session (incl. refunds, which are negative)
-- + Σ waiter repayments taken during the session
CREATE FUNCTION pos_peak_expected_paise(p_session_id uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (
      coalesce((SELECT sum(b.total_paise) FROM bills b WHERE b.peak_session_id = p_session_id), 0)
    + coalesce((SELECT sum(p.amount_paise) FROM bill_payments p
                 WHERE p.peak_session_id = p_session_id AND p.tender_type IN ('CASH', 'UPI')), 0)
    + coalesce((SELECT sum(w.amount_paise) FROM waiter_payments w WHERE w.peak_session_id = p_session_id), 0)
  )::bigint
$$;

CREATE FUNCTION pos_peak_sessions_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.business_day_id := coalesce(NEW.business_day_id, pos_open_business_day_id());
  -- Row-lock the day: serialises session numbering against concurrent starts and day close.
  PERFORM 1 FROM business_days WHERE id = NEW.business_day_id AND status = 'OPEN' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'peak sessions can only start on the open business day' USING ERRCODE = 'PS007';
  END IF;
  IF NEW.ended_at IS NOT NULL OR NEW.ended_by_staff_id IS NOT NULL OR NEW.peak_end_cash IS NOT NULL
     OR NEW.peak_end_upi IS NOT NULL OR NEW.peak_expected_paise IS NOT NULL OR NEW.peak_variance_paise IS NOT NULL THEN
    RAISE EXCEPTION 'a peak session must be started before it can be ended' USING ERRCODE = 'PS002';
  END IF;
  IF EXISTS (SELECT 1 FROM peak_sessions WHERE business_day_id = NEW.business_day_id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'a peak session is already running' USING ERRCODE = 'PS007';
  END IF;
  SELECT coalesce(max(session_no), 0) + 1 INTO NEW.session_no
    FROM peak_sessions WHERE business_day_id = NEW.business_day_id;
  NEW.started_at := now();
  RETURN NEW;
END $$;

-- The only permitted update is ending the session. Expected and variance are always
-- computed here (any client-supplied values are overwritten) and then frozen.
CREATE FUNCTION pos_peak_sessions_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'peak session % has ended and is frozen', OLD.session_no USING ERRCODE = 'PS001';
  END IF;
  IF (NEW.id, NEW.business_day_id, NEW.session_no, NEW.started_at, NEW.started_by_staff_id,
      NEW.peak_start_cash, NEW.peak_start_upi)
     IS DISTINCT FROM
     (OLD.id, OLD.business_day_id, OLD.session_no, OLD.started_at, OLD.started_by_staff_id,
      OLD.peak_start_cash, OLD.peak_start_upi) THEN
    RAISE EXCEPTION 'peak session start figures are immutable' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.peak_end_cash IS NULL OR NEW.peak_end_upi IS NULL OR NEW.ended_by_staff_id IS NULL THEN
    RAISE EXCEPTION 'ending a peak session requires peak_end_cash, peak_end_upi and ended_by_staff_id'
      USING ERRCODE = 'PS002';
  END IF;

  NEW.ended_at := now();
  NEW.peak_expected_paise := pos_peak_expected_paise(NEW.id);
  NEW.peak_variance_paise := (NEW.peak_end_cash - NEW.peak_start_cash)
                           + (NEW.peak_end_upi - NEW.peak_start_upi)
                           - NEW.peak_expected_paise;
  RETURN NEW;
END $$;

CREATE FUNCTION pos_peak_sessions_after_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE bills
     SET status = 'PEAK_RECONCILED'
   WHERE peak_session_id = NEW.id AND status = 'PEAK_UNSETTLED';
  RETURN NULL;
END $$;

CREATE FUNCTION pos_start_peak(p_start_cash bigint, p_start_upi bigint, p_staff_id uuid)
RETURNS peak_sessions LANGUAGE sql AS $$
  INSERT INTO peak_sessions (started_by_staff_id, peak_start_cash, peak_start_upi)
  VALUES (p_staff_id, p_start_cash, p_start_upi)
  RETURNING *
$$;

CREATE FUNCTION pos_end_peak(p_session_id uuid, p_end_cash bigint, p_end_upi bigint, p_staff_id uuid)
RETURNS peak_sessions LANGUAGE plpgsql AS $$
DECLARE
  v_session peak_sessions;
BEGIN
  UPDATE peak_sessions
     SET peak_end_cash = p_end_cash, peak_end_upi = p_end_upi, ended_by_staff_id = p_staff_id
   WHERE id = p_session_id
  RETURNING * INTO v_session;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'peak session % not found', p_session_id USING ERRCODE = 'PS007';
  END IF;
  RETURN v_session;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Waiters
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION pos_waiters_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.outstanding_balance <> 0 THEN
      RAISE EXCEPTION 'waiters start with a zero balance; use a MANUAL_ADJUSTMENT ledger entry' USING ERRCODE = 'PS009';
    END IF;
  ELSE
    IF NEW.outstanding_balance <> OLD.outstanding_balance AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'outstanding_balance is derived from waiter_ledger_entries' USING ERRCODE = 'PS009';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION pos_waiter_ledger_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_balance bigint;
BEGIN
  IF NEW.entry_type <> 'MANUAL_ADJUSTMENT' AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION '% ledger entries are posted automatically', NEW.entry_type USING ERRCODE = 'PS009';
  END IF;
  NEW.business_day_id := pos_require_open_day(NEW.business_day_id);

  SELECT outstanding_balance INTO v_balance FROM waiters WHERE id = NEW.waiter_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- FK violation reports the missing waiter
  END IF;
  IF v_balance + NEW.amount_paise < 0 THEN
    RAISE EXCEPTION 'waiter balance cannot go negative: owes % paise, entry is % paise', v_balance, NEW.amount_paise
      USING ERRCODE = 'PS008';
  END IF;
  NEW.balance_after_paise := v_balance + NEW.amount_paise;
  RETURN NEW;
END $$;

CREATE FUNCTION pos_waiter_ledger_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE waiters SET outstanding_balance = NEW.balance_after_paise WHERE id = NEW.waiter_id;
  RETURN NULL;
END $$;

CREATE FUNCTION pos_waiter_payments_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_orig waiter_payments%ROWTYPE;
BEGIN
  NEW.business_day_id := pos_require_open_day(NEW.business_day_id);
  NEW.peak_session_id := pos_active_peak_session_id(NEW.business_day_id);

  IF NEW.amount_paise < 0 THEN
    SELECT * INTO v_orig FROM waiter_payments WHERE id = NEW.reverses_waiter_payment_id;
    IF FOUND AND (v_orig.waiter_id <> NEW.waiter_id OR NEW.amount_paise <> -v_orig.amount_paise) THEN
      RAISE EXCEPTION 'a waiter payment reversal must exactly negate the original payment of the same waiter'
        USING ERRCODE = 'PS006';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION pos_waiter_payments_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO waiter_ledger_entries
    (waiter_id, business_day_id, entry_type, amount_paise, waiter_payment_id, created_by_staff_id)
  VALUES
    (NEW.waiter_id, NEW.business_day_id,
     CASE WHEN NEW.amount_paise > 0 THEN 'PAYMENT' ELSE 'PAYMENT_REVERSAL' END,
     -NEW.amount_paise, NEW.id, NEW.received_by_staff_id);
  RETURN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Bills
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION pos_bills_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_open_day_id uuid;
  v_session_id uuid;
  v_target bills%ROWTYPE;
  v_waiter waiters%ROWTYPE;
BEGIN
  IF NEW.total_paise <> 0 OR NEW.settled_at IS NOT NULL OR NEW.settled_by_staff_id IS NOT NULL
     OR NEW.peak_reconciled_at IS NOT NULL OR NEW.bill_no IS NOT NULL THEN
    RAISE EXCEPTION 'bills are inserted empty and unsettled; bill_no, totals and settlement are maintained by the database'
      USING ERRCODE = 'PS009';
  END IF;

  -- Business day and bill number. The UPDATE row-locks the day, serialising numbering.
  v_open_day_id := pos_open_business_day_id();
  IF v_open_day_id IS NULL OR (NEW.business_day_id IS NOT NULL AND NEW.business_day_id <> v_open_day_id) THEN
    RAISE EXCEPTION 'bills can only be posted to the open business day' USING ERRCODE = 'PS007';
  END IF;
  NEW.business_day_id := v_open_day_id;
  UPDATE business_days SET next_bill_no = next_bill_no + 1
   WHERE id = v_open_day_id AND status = 'OPEN'
  RETURNING next_bill_no - 1 INTO NEW.bill_no;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bills can only be posted to the open business day' USING ERRCODE = 'PS007';
  END IF;

  -- Mode and initial status.
  IF NEW.billing_mode = 'PEAK' THEN
    IF NEW.status IS DISTINCT FROM 'PEAK_UNSETTLED' THEN
      RAISE EXCEPTION 'peak bills start as PEAK_UNSETTLED' USING ERRCODE = 'PS002';
    END IF;
    v_session_id := pos_active_peak_session_id(v_open_day_id);
    IF v_session_id IS NULL THEN
      RAISE EXCEPTION 'peak bills require a running peak session' USING ERRCODE = 'PS007';
    END IF;
    IF NEW.peak_session_id IS NOT NULL AND NEW.peak_session_id <> v_session_id THEN
      RAISE EXCEPTION 'peak bills belong to the running peak session' USING ERRCODE = 'PS007';
    END IF;
    NEW.peak_session_id := v_session_id;
  ELSIF NEW.status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'normal bills start as OPEN' USING ERRCODE = 'PS002';
  END IF;

  -- Reversal: never edits the original; validates and inherits its waiter / member.
  IF NEW.bill_kind = 'REVERSAL' AND NEW.reverses_bill_id IS NOT NULL THEN
    SELECT * INTO v_target FROM bills WHERE id = NEW.reverses_bill_id FOR UPDATE;
    IF FOUND THEN
      IF v_target.bill_kind <> 'SALE' THEN
        RAISE EXCEPTION 'a reversal bill cannot itself be reversed' USING ERRCODE = 'PS006';
      END IF;
      IF v_target.status = 'OPEN' THEN
        RAISE EXCEPTION 'open bills are corrected with line cancellations, not reversals' USING ERRCODE = 'PS006';
      END IF;
      IF v_target.status = 'PEAK_UNSETTLED' AND NEW.billing_mode <> 'PEAK' THEN
        RAISE EXCEPTION 'an unsettled peak bill is reversed inside its running peak session (PEAK mode)'
          USING ERRCODE = 'PS006';
      END IF;
      IF v_target.status IN ('SETTLED', 'PEAK_RECONCILED') AND NEW.billing_mode <> 'NORMAL' THEN
        RAISE EXCEPTION 'settled or reconciled bills are reversed in NORMAL mode with refund tenders'
          USING ERRCODE = 'PS006';
      END IF;
      NEW.waiter_id := v_target.waiter_id;
      NEW.waiter_trusted_at_billing := v_target.waiter_trusted_at_billing;
      NEW.member_id := v_target.member_id;
    END IF;
  ELSIF NEW.waiter_id IS NOT NULL THEN
    SELECT * INTO v_waiter FROM waiters WHERE id = NEW.waiter_id;
    IF FOUND THEN
      IF NOT v_waiter.is_active THEN
        RAISE EXCEPTION 'waiter % is inactive', v_waiter.waiter_code USING ERRCODE = 'PS002';
      END IF;
      NEW.waiter_trusted_at_billing := v_waiter.is_trusted;
    END IF;
  ELSE
    NEW.waiter_trusted_at_billing := NULL;
  END IF;

  -- Correction: a replacement may only follow a completed reversal of a SALE bill.
  IF NEW.replaces_bill_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM bills WHERE id = NEW.replaces_bill_id AND bill_kind = 'SALE') THEN
      RAISE EXCEPTION 'only SALE bills can be replaced' USING ERRCODE = 'PS006';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM bills WHERE reverses_bill_id = NEW.replaces_bill_id) THEN
      RAISE EXCEPTION 'a bill can only be replaced after it has been reversed' USING ERRCODE = 'PS006';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE FUNCTION pos_bills_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tendered bigint;
BEGIN
  IF OLD.status IN ('SETTLED', 'PEAK_RECONCILED') THEN
    RAISE EXCEPTION 'bill % is % and frozen; post a reversal instead', OLD.bill_no, OLD.status USING ERRCODE = 'PS001';
  END IF;
  IF (NEW.id, NEW.business_day_id, NEW.bill_no, NEW.bill_kind, NEW.billing_mode, NEW.source, NEW.peak_session_id,
      NEW.waiter_id, NEW.waiter_trusted_at_billing, NEW.reverses_bill_id, NEW.replaces_bill_id, NEW.reversal_reason,
      NEW.created_by_staff_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.business_day_id, OLD.bill_no, OLD.bill_kind, OLD.billing_mode, OLD.source, OLD.peak_session_id,
      OLD.waiter_id, OLD.waiter_trusted_at_billing, OLD.reverses_bill_id, OLD.replaces_bill_id, OLD.reversal_reason,
      OLD.created_by_staff_id, OLD.created_at) THEN
    RAISE EXCEPTION 'bill % identity columns are immutable', OLD.bill_no USING ERRCODE = 'PS001';
  END IF;
  IF NEW.total_paise <> OLD.total_paise AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'bills.total_paise is derived from bill_items' USING ERRCODE = 'PS009';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'OPEN' AND NEW.status = 'SETTLED' THEN
      SELECT coalesce(sum(amount_paise), 0) INTO v_tendered FROM bill_payments WHERE bill_id = NEW.id;
      IF v_tendered <> NEW.total_paise THEN
        RAISE EXCEPTION 'bill % cannot settle: tendered % paise, total % paise', NEW.bill_no, v_tendered, NEW.total_paise
          USING ERRCODE = 'PS005';
      END IF;
      NEW.settled_at := now();
    ELSIF OLD.status = 'PEAK_UNSETTLED' AND NEW.status = 'PEAK_RECONCILED' THEN
      IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'peak bills are reconciled by ending their peak session' USING ERRCODE = 'PS002';
      END IF;
      NEW.peak_reconciled_at := now();
    ELSE
      RAISE EXCEPTION 'illegal bill status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'PS002';
    END IF;
  ELSIF (NEW.settled_at, NEW.settled_by_staff_id, NEW.peak_reconciled_at)
        IS DISTINCT FROM (OLD.settled_at, OLD.settled_by_staff_id, OLD.peak_reconciled_at) THEN
    RAISE EXCEPTION 'settlement metadata only changes with the status transition' USING ERRCODE = 'PS002';
  END IF;
  RETURN NEW;
END $$;

-- Deferred to COMMIT: a reversal bill must fully reverse every line of the original
-- (partial corrections are done as full reversal + replacement bill).
CREATE FUNCTION pos_bills_check_reversal_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_open_lines integer;
BEGIN
  SELECT count(*) INTO v_open_lines
    FROM bill_items o
   WHERE o.bill_id = NEW.reverses_bill_id
     AND o.qty > 0
     AND o.qty + coalesce((SELECT sum(c.qty) FROM bill_items c WHERE c.reverses_item_id = o.id), 0) <> 0;
  IF v_open_lines > 0 THEN
    RAISE EXCEPTION 'reversal bill % leaves % line(s) of the original unreversed', NEW.bill_no, v_open_lines
      USING ERRCODE = 'PS006';
  END IF;
  RETURN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Bill items
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION pos_bill_items_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_bill bills%ROWTYPE;
  v_sku skus%ROWTYPE;
  v_orig bill_items%ROWTYPE;
  v_remaining integer;
BEGIN
  SELECT * INTO v_bill FROM bills WHERE id = NEW.bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- FK violation reports the missing bill
  END IF;
  IF v_bill.status NOT IN ('OPEN', 'PEAK_UNSETTLED') THEN
    RAISE EXCEPTION 'bill % is %; items can no longer be added', v_bill.bill_no, v_bill.status USING ERRCODE = 'PS001';
  END IF;
  IF NEW.line_no IS NULL THEN
    SELECT coalesce(max(line_no), 0) + 1 INTO NEW.line_no FROM bill_items WHERE bill_id = NEW.bill_id;
  END IF;

  IF NEW.qty > 0 THEN
    IF v_bill.bill_kind <> 'SALE' THEN
      RAISE EXCEPTION 'reversal bills only contain negative lines' USING ERRCODE = 'PS006';
    END IF;
    SELECT * INTO v_sku FROM skus WHERE id = NEW.sku_id;
    IF NOT FOUND THEN
      RETURN NEW; -- FK violation reports the missing SKU
    END IF;
    IF NOT v_sku.is_active THEN
      RAISE EXCEPTION 'SKU % is inactive', v_sku.sku_code USING ERRCODE = 'PS002';
    END IF;
    IF NEW.unit_price_paise IS NOT NULL AND NEW.unit_price_paise <> v_sku.price_paise THEN
      RAISE EXCEPTION 'unit price for % must be the current SKU price (% paise)', v_sku.sku_code, v_sku.price_paise
        USING ERRCODE = 'PS002';
    END IF;
    NEW.unit_price_paise := v_sku.price_paise;
    NEW.sku_code_snapshot := v_sku.sku_code;
    NEW.display_name_snapshot := v_sku.display_name;
    NEW.size_code_snapshot := v_sku.size_code;

  ELSIF NEW.qty < 0 AND NEW.reverses_item_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM bill_items WHERE id = NEW.reverses_item_id;
    IF NOT FOUND THEN
      RETURN NEW; -- FK violation reports the missing line
    END IF;
    IF v_orig.qty < 0 THEN
      RAISE EXCEPTION 'only positive lines can be cancelled or reversed' USING ERRCODE = 'PS006';
    END IF;
    IF v_bill.bill_kind = 'SALE' AND v_orig.bill_id <> NEW.bill_id THEN
      RAISE EXCEPTION 'a cancellation line must reference a line on the same bill' USING ERRCODE = 'PS006';
    END IF;
    IF v_bill.bill_kind = 'REVERSAL' AND v_orig.bill_id <> v_bill.reverses_bill_id THEN
      RAISE EXCEPTION 'a reversal line must reference a line on the reversed bill' USING ERRCODE = 'PS006';
    END IF;
    IF (NEW.sku_id IS NOT NULL AND NEW.sku_id <> v_orig.sku_id)
       OR (NEW.unit_price_paise IS NOT NULL AND NEW.unit_price_paise <> v_orig.unit_price_paise) THEN
      RAISE EXCEPTION 'a negative line must match the SKU and price of the line it reverses' USING ERRCODE = 'PS006';
    END IF;
    -- Serialise against other cancellations of the same original line.
    PERFORM 1 FROM bills WHERE id = v_orig.bill_id FOR UPDATE;
    SELECT v_orig.qty + coalesce(sum(qty), 0) INTO v_remaining FROM bill_items WHERE reverses_item_id = v_orig.id;
    IF v_remaining + NEW.qty < 0 THEN
      RAISE EXCEPTION 'cannot reverse % bottle(s): only % remain on line %', -NEW.qty, v_remaining, v_orig.line_no
        USING ERRCODE = 'PS006';
    END IF;
    NEW.sku_id := v_orig.sku_id;
    NEW.unit_price_paise := v_orig.unit_price_paise;
    NEW.sku_code_snapshot := v_orig.sku_code_snapshot;
    NEW.display_name_snapshot := v_orig.display_name_snapshot;
    NEW.size_code_snapshot := v_orig.size_code_snapshot;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION pos_bill_items_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_day_id uuid;
BEGIN
  UPDATE bills SET total_paise = total_paise + NEW.line_total_paise
   WHERE id = NEW.bill_id
  RETURNING business_day_id INTO v_day_id;

  IF NEW.qty > 0 THEN
    INSERT INTO stock_movements (sku_id, business_day_id, movement_type, qty_delta, bill_item_id, created_by_staff_id)
    VALUES (NEW.sku_id, v_day_id, 'SALE', -NEW.qty, NEW.id, NEW.created_by_staff_id);
  ELSIF NEW.restock THEN
    INSERT INTO stock_movements (sku_id, business_day_id, movement_type, qty_delta, bill_item_id, created_by_staff_id)
    VALUES (NEW.sku_id, v_day_id, 'SALE_REVERSAL', -NEW.qty, NEW.id, NEW.created_by_staff_id);
  END IF;
  RETURN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Bill payments (tenders)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION pos_bill_payments_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_bill bills%ROWTYPE;
  v_waiter waiters%ROWTYPE;
  v_orig bill_payments%ROWTYPE;
  v_target_mode text;
  v_tendered bigint;
BEGIN
  SELECT * INTO v_bill FROM bills WHERE id = NEW.bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- FK violation reports the missing bill
  END IF;
  IF v_bill.billing_mode <> 'NORMAL' THEN
    RAISE EXCEPTION 'peak bills take no tenders; they are reconciled with their peak session' USING ERRCODE = 'PS005';
  END IF;
  IF v_bill.status <> 'OPEN' THEN
    RAISE EXCEPTION 'bill % is %; tenders can no longer be added', v_bill.bill_no, v_bill.status USING ERRCODE = 'PS001';
  END IF;

  NEW.business_day_id := pos_require_open_day(NEW.business_day_id);
  NEW.peak_session_id := pos_active_peak_session_id(NEW.business_day_id);
  SELECT coalesce(sum(amount_paise), 0) INTO v_tendered FROM bill_payments WHERE bill_id = NEW.bill_id;

  IF NEW.amount_paise > 0 THEN
    IF v_bill.bill_kind <> 'SALE' THEN
      RAISE EXCEPTION 'reversal bills only take refund (negative) tenders' USING ERRCODE = 'PS006';
    END IF;
    IF v_tendered + NEW.amount_paise > v_bill.total_paise THEN
      RAISE EXCEPTION 'tender of % paise exceeds % paise due on bill %',
        NEW.amount_paise, v_bill.total_paise - v_tendered, v_bill.bill_no USING ERRCODE = 'PS005';
    END IF;
    IF NEW.tender_type = 'WAITER_CREDIT' THEN
      IF v_bill.waiter_id IS NULL THEN
        RAISE EXCEPTION 'collect-later credit requires a waiter on the bill' USING ERRCODE = 'PS004';
      END IF;
      SELECT * INTO v_waiter FROM waiters WHERE id = v_bill.waiter_id FOR UPDATE;
      IF NOT v_waiter.is_trusted THEN
        RAISE EXCEPTION 'waiter % is not trusted: bill-on-bill settlement only, no collect-later credit',
          v_waiter.waiter_code USING ERRCODE = 'PS004';
      END IF;
      IF v_waiter.credit_limit_paise IS NOT NULL
         AND v_waiter.outstanding_balance + NEW.amount_paise > v_waiter.credit_limit_paise THEN
        RAISE EXCEPTION 'waiter % credit limit of % paise would be exceeded (owes % paise)',
          v_waiter.waiter_code, v_waiter.credit_limit_paise, v_waiter.outstanding_balance USING ERRCODE = 'PS004';
      END IF;
    END IF;

  ELSE
    IF v_bill.bill_kind <> 'REVERSAL' THEN
      RAISE EXCEPTION 'refund tenders belong on reversal bills' USING ERRCODE = 'PS006';
    END IF;
    SELECT billing_mode INTO v_target_mode FROM bills WHERE id = v_bill.reverses_bill_id;
    IF v_target_mode = 'PEAK' THEN
      -- A reconciled peak bill had no individual tenders: the refund is a plain cash/UPI outflow.
      IF NEW.reverses_payment_id IS NOT NULL OR NEW.tender_type = 'WAITER_CREDIT' THEN
        RAISE EXCEPTION 'refunds of peak bills are plain CASH/UPI outflows' USING ERRCODE = 'PS006';
      END IF;
      IF v_tendered + NEW.amount_paise < v_bill.total_paise THEN
        RAISE EXCEPTION 'refund exceeds the reversal total of bill %', v_bill.bill_no USING ERRCODE = 'PS005';
      END IF;
    ELSE
      IF NEW.reverses_payment_id IS NULL THEN
        RAISE EXCEPTION 'a refund must reference the tender it reverses' USING ERRCODE = 'PS006';
      END IF;
      SELECT * INTO v_orig FROM bill_payments WHERE id = NEW.reverses_payment_id;
      IF FOUND THEN
        IF v_orig.bill_id <> v_bill.reverses_bill_id THEN
          RAISE EXCEPTION 'the referenced tender belongs to a different bill' USING ERRCODE = 'PS006';
        END IF;
        IF NEW.amount_paise <> -v_orig.amount_paise THEN
          RAISE EXCEPTION 'a refund must exactly negate the original tender (% paise)', v_orig.amount_paise
            USING ERRCODE = 'PS006';
        END IF;
        IF NEW.tender_type = 'WAITER_CREDIT' AND v_orig.tender_type <> 'WAITER_CREDIT' THEN
          RAISE EXCEPTION 'only a collect-later tender can be reversed back onto the waiter account'
            USING ERRCODE = 'PS006';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION pos_bill_payments_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tender_type = 'WAITER_CREDIT' THEN
    INSERT INTO waiter_ledger_entries
      (waiter_id, business_day_id, entry_type, amount_paise, bill_payment_id, created_by_staff_id)
    SELECT b.waiter_id, NEW.business_day_id,
           CASE WHEN NEW.amount_paise > 0 THEN 'BILL_CREDIT' ELSE 'BILL_CREDIT_REVERSAL' END,
           NEW.amount_paise, NEW.id, NEW.received_by_staff_id
      FROM bills b
     WHERE b.id = NEW.bill_id;
  END IF;
  RETURN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Trigger wiring
-- ─────────────────────────────────────────────────────────────────────────────

-- No DELETE / TRUNCATE anywhere in the domain.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'staff', 'members', 'products', 'skus', 'sku_stock', 'business_days', 'peak_sessions', 'waiters',
    'waiter_payments', 'waiter_ledger_entries', 'bills', 'bill_items', 'bill_payments', 'stock_movements', 'sync_outbox'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pos_forbid_change()',
                   t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION pos_forbid_change()',
                   t || '_no_truncate', t);
  END LOOP;

  -- Strict ledgers: no UPDATE either.
  FOREACH t IN ARRAY ARRAY['stock_movements', 'bill_items', 'bill_payments', 'waiter_ledger_entries', 'waiter_payments'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pos_forbid_change()',
                   t || '_no_update', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['staff', 'members', 'products', 'skus'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pos_touch_updated_at()',
                   t || '_touch_updated_at', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'staff', 'members', 'products', 'skus', 'peak_sessions', 'waiter_payments', 'waiter_ledger_entries',
    'bill_items', 'bill_payments', 'stock_movements'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture()',
                   t || '_outbox', t);
  END LOOP;
END $$;

-- Outbox for tables with derived columns: skip updates that only touch those columns.
CREATE TRIGGER business_days_outbox AFTER INSERT OR UPDATE ON business_days
  FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture('next_bill_no');
CREATE TRIGGER bills_outbox AFTER INSERT OR UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture('total_paise');
CREATE TRIGGER waiters_outbox AFTER INSERT OR UPDATE ON waiters
  FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture('outstanding_balance', 'updated_at');

CREATE TRIGGER sync_outbox_guard BEFORE UPDATE ON sync_outbox
  FOR EACH ROW EXECUTE FUNCTION pos_sync_outbox_guard();

-- Inventory
CREATE TRIGGER skus_create_stock_row AFTER INSERT ON skus
  FOR EACH ROW EXECUTE FUNCTION pos_skus_after_insert();
CREATE TRIGGER sku_stock_guard BEFORE INSERT OR UPDATE ON sku_stock
  FOR EACH ROW EXECUTE FUNCTION pos_sku_stock_guard();
CREATE TRIGGER stock_movements_before_insert BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION pos_stock_movements_before_insert();
CREATE TRIGGER stock_movements_after_insert AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION pos_stock_movements_after_insert();

-- Business days & peak sessions
CREATE TRIGGER business_days_before_insert BEFORE INSERT ON business_days
  FOR EACH ROW EXECUTE FUNCTION pos_business_days_before_insert();
CREATE TRIGGER business_days_before_update BEFORE UPDATE ON business_days
  FOR EACH ROW EXECUTE FUNCTION pos_business_days_before_update();
CREATE TRIGGER peak_sessions_before_insert BEFORE INSERT ON peak_sessions
  FOR EACH ROW EXECUTE FUNCTION pos_peak_sessions_before_insert();
CREATE TRIGGER peak_sessions_before_update BEFORE UPDATE ON peak_sessions
  FOR EACH ROW EXECUTE FUNCTION pos_peak_sessions_before_update();
CREATE TRIGGER peak_sessions_after_update AFTER UPDATE ON peak_sessions
  FOR EACH ROW EXECUTE FUNCTION pos_peak_sessions_after_update();

-- Waiters
CREATE TRIGGER waiters_guard BEFORE INSERT OR UPDATE ON waiters
  FOR EACH ROW EXECUTE FUNCTION pos_waiters_guard();
CREATE TRIGGER waiter_ledger_before_insert BEFORE INSERT ON waiter_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION pos_waiter_ledger_before_insert();
CREATE TRIGGER waiter_ledger_after_insert AFTER INSERT ON waiter_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION pos_waiter_ledger_after_insert();
CREATE TRIGGER waiter_payments_before_insert BEFORE INSERT ON waiter_payments
  FOR EACH ROW EXECUTE FUNCTION pos_waiter_payments_before_insert();
CREATE TRIGGER waiter_payments_after_insert AFTER INSERT ON waiter_payments
  FOR EACH ROW EXECUTE FUNCTION pos_waiter_payments_after_insert();

-- Bills
CREATE TRIGGER bills_before_insert BEFORE INSERT ON bills
  FOR EACH ROW EXECUTE FUNCTION pos_bills_before_insert();
CREATE TRIGGER bills_before_update BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION pos_bills_before_update();
CREATE CONSTRAINT TRIGGER bills_reversal_complete AFTER INSERT ON bills
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.bill_kind = 'REVERSAL') EXECUTE FUNCTION pos_bills_check_reversal_complete();
CREATE TRIGGER bill_items_before_insert BEFORE INSERT ON bill_items
  FOR EACH ROW EXECUTE FUNCTION pos_bill_items_before_insert();
CREATE TRIGGER bill_items_after_insert AFTER INSERT ON bill_items
  FOR EACH ROW EXECUTE FUNCTION pos_bill_items_after_insert();
CREATE TRIGGER bill_payments_before_insert BEFORE INSERT ON bill_payments
  FOR EACH ROW EXECUTE FUNCTION pos_bill_payments_before_insert();
CREATE TRIGGER bill_payments_after_insert AFTER INSERT ON bill_payments
  FOR EACH ROW EXECUTE FUNCTION pos_bill_payments_after_insert();

-- ─────────────────────────────────────────────────────────────────────────────
-- Views
-- ─────────────────────────────────────────────────────────────────────────────

-- SALE bills that have not been reversed. Reports read from here.
CREATE VIEW v_bills_effective AS
SELECT b.*
  FROM bills b
 WHERE b.bill_kind = 'SALE'
   AND NOT EXISTS (SELECT 1 FROM bills r WHERE r.reverses_bill_id = b.id);

-- Peak sessions with a live expected figure for the running session.
CREATE VIEW v_peak_sessions AS
SELECT ps.*,
       CASE WHEN ps.ended_at IS NULL THEN pos_peak_expected_paise(ps.id) ELSE ps.peak_expected_paise END
         AS running_expected_paise
  FROM peak_sessions ps;

-- Nightly self-check: every row here is a broken invariant. Expected to be empty.
CREATE VIEW v_invariant_violations AS
SELECT 'sku_stock_matches_ledger' AS check_name, s.sku_id AS entity_id,
       format('cached %s, ledger %s', s.on_hand_qty, coalesce(m.total, 0)) AS detail
  FROM sku_stock s
  LEFT JOIN (SELECT sku_id, sum(qty_delta) AS total FROM stock_movements GROUP BY sku_id) m USING (sku_id)
 WHERE s.on_hand_qty <> coalesce(m.total, 0)
UNION ALL
SELECT 'waiter_balance_matches_ledger', w.id,
       format('cached %s, ledger %s', w.outstanding_balance, coalesce(l.total, 0))
  FROM waiters w
  LEFT JOIN (SELECT waiter_id, sum(amount_paise) AS total FROM waiter_ledger_entries GROUP BY waiter_id) l
         ON l.waiter_id = w.id
 WHERE w.outstanding_balance <> coalesce(l.total, 0)
UNION ALL
SELECT 'bill_total_matches_items', b.id,
       format('bill %s: total %s, items %s', b.bill_no, b.total_paise, coalesce(i.total, 0))
  FROM bills b
  LEFT JOIN (SELECT bill_id, sum(line_total_paise) AS total FROM bill_items GROUP BY bill_id) i ON i.bill_id = b.id
 WHERE b.total_paise <> coalesce(i.total, 0)
UNION ALL
SELECT 'settled_bill_tenders_match_total', b.id,
       format('bill %s: total %s, tendered %s', b.bill_no, b.total_paise, coalesce(p.total, 0))
  FROM bills b
  LEFT JOIN (SELECT bill_id, sum(amount_paise) AS total FROM bill_payments GROUP BY bill_id) p ON p.bill_id = b.id
 WHERE b.status = 'SETTLED' AND b.total_paise <> coalesce(p.total, 0)
UNION ALL
SELECT 'peak_bill_has_no_tenders', b.id, format('bill %s has tenders', b.bill_no)
  FROM bills b
 WHERE b.billing_mode = 'PEAK' AND EXISTS (SELECT 1 FROM bill_payments p WHERE p.bill_id = b.id);
