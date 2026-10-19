-- ─────────────────────────────────────────────────────────────────────────────
-- 0016 Revenue centers. Design: docs/ui/phase22-revenue-centers-plan.md
--
--   * D1: departments become the manager's list of revenue centers. Every bill line, brand, item
--     category and expense category already carries one, so each center's P&L is exact from day one.
--     The code stays the key (generated from the name for new centers, never changed); the name,
--     order, KOT station, stock tracking and active flag are editable. Never deleted.
--   * D4: a center prints its KOT at the BAR, the KITCHEN, or NONE (a service such as AC charges).
--   * D3: seeds Cigarettes, Cool Drinks, Water Bottles (stock tracked, Bar) and AC Charges (no stock,
--     no ticket); ANCILLARY is renamed "Other items" (code and history kept).
--   * kitchen_purchases → revenue_center_purchases, tagged with the center they belong to (existing
--     rows: KITCHEN). The functions that name the old tables are re-created; the drawer math is the
--     same as 0015.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── departments: fixed list → managed revenue centers ──────────────────────

DROP TRIGGER departments_no_update ON departments;
ALTER TABLE departments
  DROP CONSTRAINT departments_code_valid,
  DROP CONSTRAINT departments_sort_order_unique,
  DROP CONSTRAINT departments_station_valid,
  ADD CONSTRAINT departments_code_valid CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
  ADD CONSTRAINT departments_station_valid CHECK (kot_station IN ('BAR', 'KITCHEN', 'NONE')),
  ADD CONSTRAINT departments_name_present CHECK (btrim(name) <> '' AND name = btrim(name) AND length(name) <= 30),
  ADD CONSTRAINT departments_sort_order_positive CHECK (sort_order > 0),
  ADD COLUMN id uuid NOT NULL DEFAULT uuidv7() CONSTRAINT departments_id_unique UNIQUE,
  ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX departments_name_unique ON departments (lower(name));

CREATE FUNCTION pos_departments_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code <> OLD.code OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'revenue center % identity columns are immutable', OLD.name USING ERRCODE = 'PS001';
  END IF;
  IF OLD.code = 'LIQUOR' AND (NOT NEW.is_active OR NEW.kot_station <> OLD.kot_station OR NEW.tracks_stock <> OLD.tracks_stock) THEN
    RAISE EXCEPTION 'Liquor is the core business: it stays active, stock-tracked and printed at the bar' USING ERRCODE = 'PS002';
  END IF;
  IF OLD.tracks_stock AND NOT NEW.tracks_stock
     AND EXISTS (SELECT 1 FROM skus s JOIN products p ON p.id = s.product_id JOIN sku_stock k ON k.sku_id = s.id
                  WHERE p.department = OLD.code AND k.on_hand_qty <> 0) THEN
    RAISE EXCEPTION '% still has stock on hand; it can''t stop tracking stock', OLD.name USING ERRCODE = 'PS002';
  END IF;
  IF OLD.is_active AND NOT NEW.is_active
     AND EXISTS (SELECT 1 FROM skus s JOIN products p ON p.id = s.product_id WHERE p.department = OLD.code AND s.is_active AND p.is_active) THEN
    RAISE EXCEPTION '% still has active items; move or deactivate them first', OLD.name USING ERRCODE = 'PS002';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER departments_before_update BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION pos_departments_before_update();
CREATE TRIGGER departments_outbox AFTER INSERT OR UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture('updated_at');

UPDATE departments SET name = 'Other items', sort_order = 7 WHERE code = 'ANCILLARY';
INSERT INTO departments (code, name, kot_station, tracks_stock, sort_order) VALUES
  ('CIGARETTES',  'Cigarettes',    'BAR',  true,  3),
  ('COOL_DRINKS', 'Cool Drinks',   'BAR',  true,  4),
  ('WATER',       'Water Bottles', 'BAR',  true,  5),
  ('AC_CHARGES',  'AC Charges',    'NONE', false, 6);

-- ── kitchen_purchases → revenue_center_purchases ───────────────────────────

ALTER TABLE kitchen_purchases RENAME TO revenue_center_purchases;
ALTER TABLE kitchen_purchase_lines RENAME TO revenue_center_purchase_lines;

-- Constraint, index and trigger names follow the tables.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT c.conname, t.relname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
            WHERE t.relname IN ('revenue_center_purchases', 'revenue_center_purchase_lines') AND c.conname LIKE 'kitchen_purchase%' LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.relname, r.conname, replace(r.conname, 'kitchen_purchase', 'revenue_center_purchase'));
  END LOOP;
  FOR r IN SELECT i.relname FROM pg_class i JOIN pg_index x ON x.indexrelid = i.oid JOIN pg_class t ON t.oid = x.indrelid
            WHERE t.relname IN ('revenue_center_purchases', 'revenue_center_purchase_lines') AND i.relname LIKE 'kitchen_purchase%' LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.relname, replace(r.relname, 'kitchen_purchase', 'revenue_center_purchase'));
  END LOOP;
  FOR r IN SELECT g.tgname, t.relname FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid
            WHERE t.relname IN ('revenue_center_purchases', 'revenue_center_purchase_lines') AND g.tgname LIKE 'kitchen_purchase%' LOOP
    EXECUTE format('ALTER TRIGGER %I ON %I RENAME TO %I', r.tgname, r.relname, replace(r.tgname, 'kitchen_purchase', 'revenue_center_purchase'));
  END LOOP;
END $$;

ALTER FUNCTION pos_kitchen_purchases_before_insert() RENAME TO pos_revenue_center_purchases_before_insert;
ALTER FUNCTION pos_kitchen_purchase_lines_before_insert() RENAME TO pos_revenue_center_purchase_lines_before_insert;
ALTER FUNCTION pos_kitchen_purchase_check_total() RENAME TO pos_revenue_center_purchase_check_total;

-- Every existing purchase was a kitchen purchase.
ALTER TABLE revenue_center_purchases ADD COLUMN department text NOT NULL DEFAULT 'KITCHEN' REFERENCES departments (code);
ALTER TABLE revenue_center_purchases ALTER COLUMN department DROP DEFAULT;
CREATE INDEX revenue_center_purchases_department_idx ON revenue_center_purchases (business_day_id, department);

-- As 0015, plus: an original is tagged to an active, non-liquor center; a void copies the original's.
CREATE OR REPLACE FUNCTION pos_revenue_center_purchases_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_orig revenue_center_purchases%ROWTYPE;
  v_center departments%ROWTYPE;
BEGIN
  NEW.business_day_id := pos_require_open_day(NEW.business_day_id);
  IF NEW.reverses_purchase_id IS NULL THEN
    SELECT * INTO v_center FROM departments WHERE code = NEW.department;
    IF FOUND AND (v_center.code = 'LIQUOR' OR NOT v_center.is_active) THEN
      RAISE EXCEPTION 'purchases here are for active non-liquor revenue centers; % is not one (liquor stock comes in through Purchase)', v_center.name
        USING ERRCODE = 'PS002';
    END IF;
    IF NEW.paid_from = 'DRAWER' AND pos_active_peak_session_id(NEW.business_day_id) IS NOT NULL THEN
      RAISE EXCEPTION 'end the running peak session before paying a revenue-center purchase from the drawer' USING ERRCODE = 'PS007';
    END IF;
  ELSE
    SELECT * INTO v_orig FROM revenue_center_purchases WHERE id = NEW.reverses_purchase_id;
    IF FOUND THEN
      IF v_orig.reverses_purchase_id IS NOT NULL THEN
        RAISE EXCEPTION 'a void cannot itself be voided' USING ERRCODE = 'PS006';
      END IF;
      IF NEW.amount_paise <> -v_orig.amount_paise THEN
        RAISE EXCEPTION 'a purchase void must exactly negate the original' USING ERRCODE = 'PS006';
      END IF;
      IF v_orig.business_day_id <> NEW.business_day_id THEN
        RAISE EXCEPTION 'purchase is from a closed day; its cash was already counted' USING ERRCODE = 'PS007';
      END IF;
      NEW.paid_from := v_orig.paid_from;
      NEW.department := v_orig.department;
      NEW.vendor_name := coalesce(NEW.vendor_name, v_orig.vendor_name);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pos_revenue_center_purchase_lines_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_purchase revenue_center_purchases%ROWTYPE;
BEGIN
  SELECT * INTO v_purchase FROM revenue_center_purchases WHERE id = NEW.purchase_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the FK reports a missing purchase
  END IF;
  IF v_purchase.reverses_purchase_id IS NOT NULL THEN
    RAISE EXCEPTION 'a purchase void carries no lines' USING ERRCODE = 'PS005';
  END IF;
  IF v_purchase.created_at <> now() THEN
    RAISE EXCEPTION 'purchase lines are fixed once the purchase is saved' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pos_revenue_center_purchase_check_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_amount bigint;
  v_lines bigint;
BEGIN
  -- NEW is a header or a line; each has the purchase id under a different name.
  IF TG_TABLE_NAME = 'revenue_center_purchases' THEN
    v_id := (to_jsonb(NEW) ->> 'id')::uuid;
  ELSE
    v_id := (to_jsonb(NEW) ->> 'purchase_id')::uuid;
  END IF;
  SELECT amount_paise INTO v_amount FROM revenue_center_purchases WHERE id = v_id AND reverses_purchase_id IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(amount_paise), 0) INTO v_lines FROM revenue_center_purchase_lines WHERE purchase_id = v_id;
  IF v_lines <> v_amount THEN
    RAISE EXCEPTION 'purchase lines add up to % paise, not the purchase amount % paise', v_lines, v_amount USING ERRCODE = 'PS005';
  END IF;
  RETURN NULL;
END $$;

-- Same math as 0015, reading the renamed table.
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
    - coalesce((SELECT sum(q.amount_paise) FROM revenue_center_purchases q
                 WHERE q.business_day_id = d.id AND q.paid_from = 'DRAWER'), 0)
  )::bigint
  FROM business_days d
  WHERE d.id = p_day_id
$$;
