-- ─────────────────────────────────────────────────────────────────────────────
-- 0015 Kitchen purchases. Design: docs/ui/phase21-kitchen-kiosk-plan.md
--
--   * kitchen_purchases: raw materials bought for the kitchen (meat, oil, vegetables), kept apart
--     from the strict liquor GRN (stock_receipts). No stock is kept: quantities are free-text labels
--     ("5 kg") on the lines, never arithmetic, so there are no floats and no kitchen inventory yet.
--   * paid_from (D2): DRAWER purchases are cash out of the till, so pos_day_expected_cash subtracts
--     them, and like bank deposits they are refused while a peak session runs (the peak's counted
--     drawer delta stays untouched). OUTSIDE purchases (owner, bank, credit) only count in the P&L.
--   * Append-only: a mistake is voided by a header row that exactly negates it (no lines), on the
--     same day, once. An original's lines must add up to its amount, checked at commit; lines can't
--     be added to a purchase after the transaction that created it.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE kitchen_purchases (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  business_day_id      uuid        NOT NULL REFERENCES business_days (id),
  vendor_name          text        CONSTRAINT kitchen_purchases_vendor_present
                                   CHECK (vendor_name IS NULL OR (btrim(vendor_name) <> '' AND length(vendor_name) <= 80)),
  paid_from            text        NOT NULL CONSTRAINT kitchen_purchases_paid_from_valid CHECK (paid_from IN ('DRAWER', 'OUTSIDE')),
  amount_paise         bigint      NOT NULL CONSTRAINT kitchen_purchases_amount_non_zero CHECK (amount_paise <> 0),
  note                 text        CONSTRAINT kitchen_purchases_note_present CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 200)),
  reverses_purchase_id uuid        CONSTRAINT kitchen_purchases_reverses_unique UNIQUE REFERENCES kitchen_purchases (id),
  created_by_staff_id  uuid        NOT NULL REFERENCES staff (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kitchen_purchases_reversal_shape CHECK (
    (amount_paise > 0 AND reverses_purchase_id IS NULL)
    OR (amount_paise < 0 AND reverses_purchase_id IS NOT NULL)
  )
);
CREATE INDEX kitchen_purchases_day_idx ON kitchen_purchases (business_day_id, created_at);

CREATE TABLE kitchen_purchase_lines (
  id           uuid    PRIMARY KEY DEFAULT uuidv7(),
  purchase_id  uuid    NOT NULL REFERENCES kitchen_purchases (id),
  line_no      integer NOT NULL CONSTRAINT kitchen_purchase_lines_line_no_positive CHECK (line_no >= 1),
  description  text    NOT NULL CONSTRAINT kitchen_purchase_lines_description_present
                       CHECK (btrim(description) <> '' AND length(description) <= 60),
  quantity     text    CONSTRAINT kitchen_purchase_lines_quantity_present
                       CHECK (quantity IS NULL OR (btrim(quantity) <> '' AND length(quantity) <= 20)),
  amount_paise bigint  NOT NULL CONSTRAINT kitchen_purchase_lines_amount_positive CHECK (amount_paise > 0),
  CONSTRAINT kitchen_purchase_lines_line_unique UNIQUE (purchase_id, line_no)
);

CREATE FUNCTION pos_kitchen_purchases_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_orig kitchen_purchases%ROWTYPE;
BEGIN
  NEW.business_day_id := pos_require_open_day(NEW.business_day_id);
  IF NEW.reverses_purchase_id IS NULL THEN
    IF NEW.paid_from = 'DRAWER' AND pos_active_peak_session_id(NEW.business_day_id) IS NOT NULL THEN
      RAISE EXCEPTION 'end the running peak session before paying a kitchen purchase from the drawer' USING ERRCODE = 'PS007';
    END IF;
  ELSE
    SELECT * INTO v_orig FROM kitchen_purchases WHERE id = NEW.reverses_purchase_id;
    IF FOUND THEN
      IF v_orig.reverses_purchase_id IS NOT NULL THEN
        RAISE EXCEPTION 'a void cannot itself be voided' USING ERRCODE = 'PS006';
      END IF;
      IF NEW.amount_paise <> -v_orig.amount_paise THEN
        RAISE EXCEPTION 'a kitchen purchase void must exactly negate the original' USING ERRCODE = 'PS006';
      END IF;
      IF v_orig.business_day_id <> NEW.business_day_id THEN
        RAISE EXCEPTION 'kitchen purchase is from a closed day; its cash was already counted' USING ERRCODE = 'PS007';
      END IF;
      NEW.paid_from := v_orig.paid_from;
      NEW.vendor_name := coalesce(NEW.vendor_name, v_orig.vendor_name);
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Lines belong to an original purchase, and only to the transaction that created it.
CREATE FUNCTION pos_kitchen_purchase_lines_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_purchase kitchen_purchases%ROWTYPE;
BEGIN
  SELECT * INTO v_purchase FROM kitchen_purchases WHERE id = NEW.purchase_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the FK reports a missing purchase
  END IF;
  IF v_purchase.reverses_purchase_id IS NOT NULL THEN
    RAISE EXCEPTION 'a kitchen purchase void carries no lines' USING ERRCODE = 'PS005';
  END IF;
  IF v_purchase.created_at <> now() THEN
    RAISE EXCEPTION 'kitchen purchase lines are fixed once the purchase is saved' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END $$;

-- At commit: an original's lines add up to its amount.
CREATE FUNCTION pos_kitchen_purchase_check_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_amount bigint;
  v_lines bigint;
BEGIN
  -- NEW is a header or a line; each has the purchase id under a different name.
  IF TG_TABLE_NAME = 'kitchen_purchases' THEN
    v_id := (to_jsonb(NEW) ->> 'id')::uuid;
  ELSE
    v_id := (to_jsonb(NEW) ->> 'purchase_id')::uuid;
  END IF;
  SELECT amount_paise INTO v_amount FROM kitchen_purchases WHERE id = v_id AND reverses_purchase_id IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(amount_paise), 0) INTO v_lines FROM kitchen_purchase_lines WHERE purchase_id = v_id;
  IF v_lines <> v_amount THEN
    RAISE EXCEPTION 'kitchen purchase lines add up to % paise, not the purchase amount % paise', v_lines, v_amount USING ERRCODE = 'PS005';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER kitchen_purchases_before_insert BEFORE INSERT ON kitchen_purchases
  FOR EACH ROW EXECUTE FUNCTION pos_kitchen_purchases_before_insert();
CREATE TRIGGER kitchen_purchase_lines_before_insert BEFORE INSERT ON kitchen_purchase_lines
  FOR EACH ROW EXECUTE FUNCTION pos_kitchen_purchase_lines_before_insert();
CREATE CONSTRAINT TRIGGER kitchen_purchases_total AFTER INSERT ON kitchen_purchases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pos_kitchen_purchase_check_total();
CREATE CONSTRAINT TRIGGER kitchen_purchase_lines_total AFTER INSERT ON kitchen_purchase_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pos_kitchen_purchase_check_total();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kitchen_purchases', 'kitchen_purchase_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pos_forbid_change()', t || '_no_update', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pos_forbid_change()', t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION pos_forbid_change()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture()', t || '_outbox', t);
  END LOOP;
END $$;

-- Expected drawer cash now also subtracts the day's kitchen purchases paid from the drawer.
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
    - coalesce((SELECT sum(q.amount_paise) FROM kitchen_purchases q
                 WHERE q.business_day_id = d.id AND q.paid_from = 'DRAWER'), 0)
  )::bigint
  FROM business_days d
  WHERE d.id = p_day_id
$$;
