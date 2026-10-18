-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 Bank deposits (cash drops). Design: docs/ui/phase14-bank-deposits-plan.md
--
--   * bank_deposits: cash taken out of the drawer to be banked (e.g. for an RTGS vendor payment).
--     Kept apart from cash_expenses so it never inflates operating expenses, and it is not revenue.
--     Append-only; a mistake is voided by a row that exactly negates it.
--   * Refused while a peak session runs: the peak's counted drawer delta would otherwise have to
--     account for it. A void (a bookkeeping correction, no cash moves) is allowed at any time.
--   * pos_day_expected_cash subtracts Σ deposits, so the frozen expected cash and the close variance
--     include them. Days already closed keep their stored figures.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE bank_deposits (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  business_day_id      uuid        NOT NULL REFERENCES business_days (id),
  amount_paise         bigint      NOT NULL CONSTRAINT bank_deposits_amount_non_zero CHECK (amount_paise <> 0),
  reference            text        CONSTRAINT bank_deposits_reference_present CHECK (reference IS NULL OR btrim(reference) <> ''),
  reverses_deposit_id  uuid        CONSTRAINT bank_deposits_reverses_unique UNIQUE REFERENCES bank_deposits (id),
  created_by_staff_id  uuid        NOT NULL REFERENCES staff (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_deposits_reversal_shape CHECK (
    (amount_paise > 0 AND reverses_deposit_id IS NULL)
    OR (amount_paise < 0 AND reverses_deposit_id IS NOT NULL)
  )
);
CREATE INDEX bank_deposits_day_idx ON bank_deposits (business_day_id, created_at);

CREATE FUNCTION pos_bank_deposits_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_orig bank_deposits%ROWTYPE;
BEGIN
  NEW.business_day_id := pos_require_open_day(NEW.business_day_id);
  IF NEW.reverses_deposit_id IS NULL THEN
    IF pos_active_peak_session_id(NEW.business_day_id) IS NOT NULL THEN
      RAISE EXCEPTION 'end the running peak session before a bank deposit' USING ERRCODE = 'PS007';
    END IF;
  ELSE
    SELECT * INTO v_orig FROM bank_deposits WHERE id = NEW.reverses_deposit_id;
    IF FOUND THEN
      IF v_orig.reverses_deposit_id IS NOT NULL THEN
        RAISE EXCEPTION 'a void cannot itself be voided' USING ERRCODE = 'PS006';
      END IF;
      IF NEW.amount_paise <> -v_orig.amount_paise THEN
        RAISE EXCEPTION 'a deposit void must exactly negate the original deposit' USING ERRCODE = 'PS006';
      END IF;
      IF v_orig.business_day_id <> NEW.business_day_id THEN
        RAISE EXCEPTION 'deposit is from a closed day; its cash was already counted' USING ERRCODE = 'PS007';
      END IF;
      NEW.reference := coalesce(NEW.reference, v_orig.reference);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bank_deposits_before_insert BEFORE INSERT ON bank_deposits
  FOR EACH ROW EXECUTE FUNCTION pos_bank_deposits_before_insert();
CREATE TRIGGER bank_deposits_no_update BEFORE UPDATE ON bank_deposits
  FOR EACH ROW EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER bank_deposits_no_delete BEFORE DELETE ON bank_deposits
  FOR EACH ROW EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER bank_deposits_no_truncate BEFORE TRUNCATE ON bank_deposits
  FOR EACH STATEMENT EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER bank_deposits_outbox AFTER INSERT ON bank_deposits
  FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture();

-- Expected drawer cash now subtracts the day's bank deposits.
CREATE OR REPLACE FUNCTION pos_day_expected_cash(p_day_id uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
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
    + coalesce((SELECT sum(t.cash_delta_paise) FROM tender_adjustments t WHERE t.business_day_id = d.id), 0)
    - coalesce((SELECT sum(k.amount_paise) FROM bank_deposits k WHERE k.business_day_id = d.id), 0)
  )::bigint
  FROM business_days d
  WHERE d.id = p_day_id
$$;
