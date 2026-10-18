-- ─────────────────────────────────────────────────────────────────────────────
-- 0010 Tender adjustments (the Day End tally tool) and running peak analytics.
-- Design: docs/ui/phase13-peak-close-tally-plan.md
--
--   * tender_adjustments: a day-level Cash ⇄ UPI reclassification of normal-bill revenue, for a
--     bill keyed as UPI that was paid in cash (or the reverse). Append-only; a mistake is voided by
--     a row that exactly negates it. Every row moves money between the two tenders, so total
--     revenue cannot change (cash_delta + upi_delta = 0). The trigger records the system figures
--     the adjustment was made against, and refuses to take adjusted cash or UPI below ₹0.
--   * pos_day_expected_cash adds Σ cash deltas, so the frozen expected cash and the close variance
--     use the adjusted figures. Days already closed keep their stored figures.
--   * v_peak_sessions gains the running session's peak sales and the UPI recorded inside its
--     window, so the end dialog can derive the cash / UPI split as the readings are typed.
--
--   "Normal-bill tenders" are bill_payments outside a still-running peak window (the same set the
--   Day End sales breakdown shows); waiter repayments and peak readings are never adjusted.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE tender_adjustments (
  id                      uuid        PRIMARY KEY DEFAULT uuidv7(),
  business_day_id         uuid        NOT NULL REFERENCES business_days (id),
  cash_delta_paise        bigint      NOT NULL CONSTRAINT tender_adjustments_non_zero CHECK (cash_delta_paise <> 0),
  upi_delta_paise         bigint      NOT NULL,
  -- Normal-bill tenders as recorded on bills when the row was written (trigger-set, never client-supplied).
  system_cash_paise       bigint      NOT NULL,
  system_upi_paise        bigint      NOT NULL,
  reason                  text        NOT NULL CONSTRAINT tender_adjustments_reason_present CHECK (btrim(reason) <> ''),
  reverses_adjustment_id  uuid        CONSTRAINT tender_adjustments_reverses_unique UNIQUE REFERENCES tender_adjustments (id),
  created_by_staff_id     uuid        NOT NULL REFERENCES staff (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tender_adjustments_revenue_locked CHECK (cash_delta_paise + upi_delta_paise = 0)
);
CREATE INDEX tender_adjustments_day_idx ON tender_adjustments (business_day_id, created_at);

-- Normal-bill CASH or UPI tenders of a day, leaving out a still-running peak window.
CREATE FUNCTION pos_day_bill_tenders(p_day_id uuid, p_tender text) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(p.amount_paise), 0)::bigint
    FROM bill_payments p
    LEFT JOIN peak_sessions s ON s.id = p.peak_session_id
   WHERE p.business_day_id = p_day_id AND p.tender_type = p_tender
     AND (p.peak_session_id IS NULL OR s.ended_at IS NOT NULL)
$$;

CREATE FUNCTION pos_tender_adjustments_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_orig tender_adjustments%ROWTYPE;
  v_cash_adj bigint;
  v_upi_adj bigint;
BEGIN
  NEW.business_day_id := pos_require_open_day(NEW.business_day_id);

  IF NEW.reverses_adjustment_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM tender_adjustments WHERE id = NEW.reverses_adjustment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tender adjustment % does not exist', NEW.reverses_adjustment_id USING ERRCODE = 'PS006';
    END IF;
    IF v_orig.reverses_adjustment_id IS NOT NULL THEN
      RAISE EXCEPTION 'a void cannot itself be voided' USING ERRCODE = 'PS006';
    END IF;
    IF EXISTS (SELECT 1 FROM tender_adjustments WHERE reverses_adjustment_id = v_orig.id) THEN
      RAISE EXCEPTION 'tender adjustment % is already voided', v_orig.id USING ERRCODE = 'PS006';
    END IF;
    IF v_orig.business_day_id <> NEW.business_day_id OR NEW.cash_delta_paise <> -v_orig.cash_delta_paise THEN
      RAISE EXCEPTION 'a void must exactly negate an adjustment of the same day' USING ERRCODE = 'PS006';
    END IF;
  END IF;

  NEW.system_cash_paise := pos_day_bill_tenders(NEW.business_day_id, 'CASH');
  NEW.system_upi_paise := pos_day_bill_tenders(NEW.business_day_id, 'UPI');

  -- Serialise adjustments of one day (the day row, so it also holds for the first one) so two
  -- concurrent rows can't both pass the floor check.
  PERFORM 1 FROM business_days WHERE id = NEW.business_day_id FOR UPDATE;
  SELECT coalesce(sum(cash_delta_paise), 0), coalesce(sum(upi_delta_paise), 0) INTO v_cash_adj, v_upi_adj
    FROM tender_adjustments WHERE business_day_id = NEW.business_day_id;
  IF NEW.system_cash_paise + v_cash_adj + NEW.cash_delta_paise < 0 THEN
    RAISE EXCEPTION 'cannot move % paise out of cash: only % paise of normal cash after adjustments',
      -NEW.cash_delta_paise, NEW.system_cash_paise + v_cash_adj USING ERRCODE = 'PS002';
  END IF;
  IF NEW.system_upi_paise + v_upi_adj + NEW.upi_delta_paise < 0 THEN
    RAISE EXCEPTION 'cannot move % paise out of UPI: only % paise of normal UPI after adjustments',
      -NEW.upi_delta_paise, NEW.system_upi_paise + v_upi_adj USING ERRCODE = 'PS002';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tender_adjustments_before_insert BEFORE INSERT ON tender_adjustments
  FOR EACH ROW EXECUTE FUNCTION pos_tender_adjustments_before_insert();
CREATE TRIGGER tender_adjustments_no_update BEFORE UPDATE ON tender_adjustments
  FOR EACH ROW EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER tender_adjustments_no_delete BEFORE DELETE ON tender_adjustments
  FOR EACH ROW EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER tender_adjustments_no_truncate BEFORE TRUNCATE ON tender_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER tender_adjustments_outbox AFTER INSERT ON tender_adjustments
  FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture();

-- Expected drawer cash now includes the tally adjustments.
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
  )::bigint
  FROM business_days d
  WHERE d.id = p_day_id
$$;

-- Running peak analytics, appended to the view (NULL once the session has ended).
CREATE OR REPLACE VIEW v_peak_sessions AS
SELECT ps.*,
       CASE WHEN ps.ended_at IS NULL THEN pos_peak_expected_paise(ps.id) ELSE ps.peak_expected_paise END
         AS running_expected_paise,
       CASE WHEN ps.ended_at IS NULL THEN pos_peak_expected_drawer_cash(ps.id) END
         AS expected_drawer_cash_paise,
       CASE WHEN ps.ended_at IS NULL THEN
         coalesce((SELECT sum(b.total_paise) FROM bills b WHERE b.peak_session_id = ps.id), 0)::bigint END
         AS running_sales_paise,
       CASE WHEN ps.ended_at IS NULL THEN (
           coalesce((SELECT sum(p.amount_paise) FROM bill_payments p WHERE p.peak_session_id = ps.id AND p.tender_type = 'UPI'), 0)
         + coalesce((SELECT sum(w.amount_paise) FROM waiter_payments w WHERE w.peak_session_id = ps.id AND w.tender_type = 'UPI'), 0)
       )::bigint END
         AS running_in_window_upi_paise
  FROM peak_sessions ps;
