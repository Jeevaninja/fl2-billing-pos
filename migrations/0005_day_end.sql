-- ─────────────────────────────────────────────────────────────────────────────
-- 0005 Day End: opening float, cash count, frozen expected cash and variance, cash expenses.
-- Design: docs/ui/phase7-day-end-plan.md
--
--   * business_days gains opening_float_paise (set at Day Open, immutable) and the close-time
--     counted / expected / variance columns. Expected and variance are computed here on close;
--     client-supplied values are overwritten.
--   * Closing is refused (PS007) while any waiter owes money, on top of the existing
--     running-peak and open-bill blockers.
--   * cash_expenses: append-only petty-cash ledger (negative rows correct an earlier expense).
--
--   expected cash = opening float
--                 + CASH bill tenders outside peak windows (refunds are negative)
--                 + Σ ended peak sessions (end cash − start cash)   ← counted drawer delta
--                 + CASH waiter repayments outside peak windows
--                 − cash expenses outside peak windows
--
-- Inside a peak window the counted drawer delta already holds every cash movement, so those
-- movements are not added again; a peak shortage is reported once, as the session's variance.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE business_days
  ADD COLUMN opening_float_paise bigint NOT NULL DEFAULT 0
    CONSTRAINT business_days_opening_float_non_negative CHECK (opening_float_paise >= 0),
  ADD COLUMN counted_cash_paise  bigint
    CONSTRAINT business_days_counted_cash_non_negative CHECK (counted_cash_paise >= 0),
  ADD COLUMN expected_cash_paise bigint,
  ADD COLUMN cash_variance_paise bigint;

-- Days closed before 0005 have no cash count, so the pairing applies to new and updated rows only.
ALTER TABLE business_days
  ADD CONSTRAINT business_days_cash_count_on_close CHECK (
    (status = 'CLOSED') = (counted_cash_paise IS NOT NULL)
    AND (status = 'CLOSED') = (expected_cash_paise IS NOT NULL)
    AND (status = 'CLOSED') = (cash_variance_paise IS NOT NULL)
  ) NOT VALID;

CREATE TABLE cash_expenses (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  business_day_id      uuid        NOT NULL REFERENCES business_days (id),
  peak_session_id      uuid        REFERENCES peak_sessions (id),
  amount_paise         bigint      NOT NULL CONSTRAINT cash_expenses_amount_non_zero CHECK (amount_paise <> 0),
  reverses_expense_id  uuid        CONSTRAINT cash_expenses_reverses_unique UNIQUE REFERENCES cash_expenses (id),
  description          text        NOT NULL CONSTRAINT cash_expenses_description_present CHECK (btrim(description) <> ''),
  created_by_staff_id  uuid        NOT NULL REFERENCES staff (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_expenses_reversal_shape CHECK (
    (amount_paise > 0 AND reverses_expense_id IS NULL)
    OR (amount_paise < 0 AND reverses_expense_id IS NOT NULL)
  )
);

CREATE FUNCTION pos_cash_expenses_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_orig cash_expenses%ROWTYPE;
BEGIN
  NEW.business_day_id := pos_require_open_day(NEW.business_day_id);
  NEW.peak_session_id := pos_active_peak_session_id(NEW.business_day_id);
  IF NEW.amount_paise < 0 THEN
    SELECT * INTO v_orig FROM cash_expenses WHERE id = NEW.reverses_expense_id;
    IF FOUND AND NEW.amount_paise <> -v_orig.amount_paise THEN
      RAISE EXCEPTION 'an expense correction must exactly negate the original expense' USING ERRCODE = 'PS006';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cash_expenses_before_insert BEFORE INSERT ON cash_expenses
  FOR EACH ROW EXECUTE FUNCTION pos_cash_expenses_before_insert();
CREATE TRIGGER cash_expenses_no_update BEFORE UPDATE ON cash_expenses
  FOR EACH ROW EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER cash_expenses_no_delete BEFORE DELETE ON cash_expenses
  FOR EACH ROW EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER cash_expenses_no_truncate BEFORE TRUNCATE ON cash_expenses
  FOR EACH STATEMENT EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER cash_expenses_outbox AFTER INSERT OR UPDATE ON cash_expenses
  FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture();

-- A cash expense paid during a peak window leaves the drawer, so it lowers that session's expected
-- collection (otherwise the peak would show a false shortage).
CREATE OR REPLACE FUNCTION pos_peak_expected_paise(p_session_id uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (
      coalesce((SELECT sum(b.total_paise) FROM bills b WHERE b.peak_session_id = p_session_id), 0)
    + coalesce((SELECT sum(p.amount_paise) FROM bill_payments p
                 WHERE p.peak_session_id = p_session_id AND p.tender_type IN ('CASH', 'UPI')), 0)
    + coalesce((SELECT sum(w.amount_paise) FROM waiter_payments w WHERE w.peak_session_id = p_session_id), 0)
    - coalesce((SELECT sum(e.amount_paise) FROM cash_expenses e WHERE e.peak_session_id = p_session_id), 0)
  )::bigint
$$;

CREATE FUNCTION pos_day_expected_cash(p_day_id uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (
      d.opening_float_paise
    + coalesce((SELECT sum(p.amount_paise) FROM bill_payments p
                 WHERE p.business_day_id = d.id AND p.tender_type = 'CASH' AND p.peak_session_id IS NULL), 0)
    + coalesce((SELECT sum(s.peak_end_cash - s.peak_start_cash) FROM peak_sessions s
                 WHERE s.business_day_id = d.id AND s.ended_at IS NOT NULL), 0)
    + coalesce((SELECT sum(w.amount_paise) FROM waiter_payments w
                 WHERE w.business_day_id = d.id AND w.tender_type = 'CASH' AND w.peak_session_id IS NULL), 0)
    - coalesce((SELECT sum(e.amount_paise) FROM cash_expenses e
                 WHERE e.business_day_id = d.id AND e.peak_session_id IS NULL), 0)
  )::bigint
  FROM business_days d
  WHERE d.id = p_day_id
$$;

-- Replaces the 0002 version: adds the float to the identity columns, the waiter-balance blocker,
-- and the cash count.
CREATE OR REPLACE FUNCTION pos_business_days_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_open_bills integer;
  v_owing integer;
  v_owed bigint;
BEGIN
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'business day % is closed and frozen', OLD.business_date USING ERRCODE = 'PS001';
  END IF;
  IF (NEW.id, NEW.business_date, NEW.opened_at, NEW.opened_by_staff_id, NEW.opening_float_paise)
     IS DISTINCT FROM (OLD.id, OLD.business_date, OLD.opened_at, OLD.opened_by_staff_id, OLD.opening_float_paise) THEN
    RAISE EXCEPTION 'business day identity columns and the opening float are immutable' USING ERRCODE = 'PS001';
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
    SELECT count(*), coalesce(sum(outstanding_balance), 0) INTO v_owing, v_owed
      FROM waiters WHERE outstanding_balance > 0;
    IF v_owing > 0 THEN
      RAISE EXCEPTION 'cannot close business day %: % waiter(s) still owe % paise', OLD.business_date, v_owing, v_owed
        USING ERRCODE = 'PS007';
    END IF;
    IF NEW.counted_cash_paise IS NULL THEN
      RAISE EXCEPTION 'closing a business day needs the counted cash' USING ERRCODE = 'PS002';
    END IF;
    NEW.closed_at := now();
    NEW.expected_cash_paise := pos_day_expected_cash(NEW.id);
    NEW.cash_variance_paise := NEW.counted_cash_paise - NEW.expected_cash_paise;
  ELSE
    IF (NEW.closed_at, NEW.closed_by_staff_id) IS DISTINCT FROM (OLD.closed_at, OLD.closed_by_staff_id) THEN
      RAISE EXCEPTION 'closing metadata only changes when the day is closed' USING ERRCODE = 'PS002';
    END IF;
    IF (NEW.counted_cash_paise, NEW.expected_cash_paise, NEW.cash_variance_paise)
       IS DISTINCT FROM (OLD.counted_cash_paise, OLD.expected_cash_paise, OLD.cash_variance_paise) THEN
      RAISE EXCEPTION 'the cash count is recorded only when the day is closed' USING ERRCODE = 'PS002';
    END IF;
  END IF;
  RETURN NEW;
END $$;
