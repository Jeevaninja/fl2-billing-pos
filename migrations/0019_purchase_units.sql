-- ─────────────────────────────────────────────────────────────────────────────
-- 0019 Purchase units and center stock purchases. Design: docs/ui/phase26-bulk-unit-purchase-plan.md
--
--   * D1: skus.case_size (0009) stays the one conversion factor ("units per purchase unit"). Nothing
--     here adds a second one; stock is still whole units only.
--   * D2: skus.purchase_unit_name ("Case", "Packet", "Carton") and skus.sale_unit_name ("Bottle",
--     "Stick") are labels. GRN lines snapshot the purchase unit they were counted in (set by trigger).
--   * D3: stock_receipts.department tags a receipt posted from a revenue center's purchase modal. Such a
--     receipt is for an active, stock-tracked, non-liquor center, and every line must be one of its items.
--   * D5: stock_receipts.paid_from. DRAWER receipts are cash out of the till: pos_day_expected_cash
--     subtracts their cost, and like supply purchases they are refused while a peak runs. Existing
--     receipts (and the Purchase screen) are OUTSIDE.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE skus
  ADD COLUMN purchase_unit_name text CONSTRAINT skus_purchase_unit_name_shape CHECK (purchase_unit_name ~ '^\S(.{0,18}\S)?$'),
  ADD COLUMN sale_unit_name text CONSTRAINT skus_sale_unit_name_shape CHECK (sale_unit_name ~ '^\S(.{0,18}\S)?$');

-- Bottles where the center sells bottles; the manager edits the rest (Cigarettes: Stick or Packet).
CREATE FUNCTION pos_default_sale_unit_name(p_product_id uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p.department IN ('LIQUOR', 'COOL_DRINKS', 'WATER') THEN 'Bottle' ELSE 'Unit' END
    FROM products p
   WHERE p.id = p_product_id
$$;

UPDATE skus SET purchase_unit_name = 'Case', sale_unit_name = pos_default_sale_unit_name(product_id);
ALTER TABLE skus
  ALTER COLUMN purchase_unit_name SET NOT NULL,
  ALTER COLUMN sale_unit_name SET NOT NULL;

-- An insert without names takes the brand's (its first size's), else Case and the center's selling unit.
CREATE FUNCTION pos_skus_unit_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_sibling skus%ROWTYPE;
BEGIN
  IF NEW.purchase_unit_name IS NULL OR NEW.sale_unit_name IS NULL THEN
    SELECT * INTO v_sibling FROM skus WHERE product_id = NEW.product_id ORDER BY created_at, id LIMIT 1;
    NEW.purchase_unit_name := coalesce(NEW.purchase_unit_name, v_sibling.purchase_unit_name, 'Case');
    NEW.sale_unit_name := coalesce(NEW.sale_unit_name, v_sibling.sale_unit_name, pos_default_sale_unit_name(NEW.product_id), 'Unit');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER skus_unit_defaults BEFORE INSERT ON skus
  FOR EACH ROW EXECUTE FUNCTION pos_skus_unit_defaults();

-- How a GRN line was counted, as named then. NULL on loose-only and pre-0019 lines.
ALTER TABLE stock_receipt_lines
  ADD COLUMN purchase_unit_name text,
  ADD CONSTRAINT stock_receipt_lines_unit_name_shape CHECK (purchase_unit_name IS NULL OR case_size IS NOT NULL);

ALTER TABLE stock_receipts
  ADD COLUMN paid_from text NOT NULL DEFAULT 'OUTSIDE'
    CONSTRAINT stock_receipts_paid_from_valid CHECK (paid_from IN ('DRAWER', 'OUTSIDE')),
  ADD COLUMN department text REFERENCES departments (code);
CREATE INDEX stock_receipts_department_idx ON stock_receipts (business_day_id, department) WHERE department IS NOT NULL;

-- As 0008, plus the center and drawer rules.
CREATE OR REPLACE FUNCTION pos_stock_receipts_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_center departments%ROWTYPE;
BEGIN
  NEW.business_day_id := pos_require_open_day(NEW.business_day_id);
  IF NEW.department IS NOT NULL THEN
    SELECT * INTO v_center FROM departments WHERE code = NEW.department;
    IF FOUND AND (v_center.code = 'LIQUOR' OR NOT v_center.is_active OR NOT v_center.tracks_stock) THEN
      RAISE EXCEPTION 'stock purchases here are for active, stock-tracked non-liquor centers; % is not one', v_center.name
        USING ERRCODE = 'PS002';
    END IF;
  END IF;
  IF NEW.paid_from = 'DRAWER' AND pos_active_peak_session_id(NEW.business_day_id) IS NOT NULL THEN
    RAISE EXCEPTION 'end the running peak session before paying for stock from the drawer' USING ERRCODE = 'PS007';
  END IF;
  RETURN NEW;
END $$;

-- As 0013, plus: a center receipt takes only that center's items, and the purchase unit is snapshotted.
CREATE OR REPLACE FUNCTION pos_stock_receipt_lines_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_sku skus%ROWTYPE;
  v_center text;
  v_item_center text;
BEGIN
  SELECT * INTO v_sku FROM skus WHERE id = NEW.sku_id;
  IF NOT FOUND THEN
    RETURN NEW; -- a missing SKU is reported by the FK
  END IF;
  IF NOT v_sku.is_active THEN
    RAISE EXCEPTION 'SKU % is inactive', v_sku.sku_code USING ERRCODE = 'PS002';
  END IF;
  IF NOT pos_sku_tracks_stock(v_sku.id) THEN
    RAISE EXCEPTION '% is not stock-tracked (Kitchen items) and cannot be received', v_sku.sku_code USING ERRCODE = 'PS002';
  END IF;
  IF NEW.case_size IS NOT NULL AND NEW.case_size <> v_sku.case_size THEN
    RAISE EXCEPTION 'case size for % is now % — re-check the line', v_sku.sku_code, v_sku.case_size
      USING ERRCODE = 'PS002';
  END IF;
  SELECT department INTO v_center FROM stock_receipts WHERE id = NEW.receipt_id;
  IF v_center IS NOT NULL THEN
    SELECT department INTO v_item_center FROM products WHERE id = v_sku.product_id;
    IF v_item_center <> v_center THEN
      RAISE EXCEPTION '% is not a % item', v_sku.display_name, (SELECT name FROM departments WHERE code = v_center)
        USING ERRCODE = 'PS002';
    END IF;
  END IF;
  NEW.purchase_unit_name := CASE WHEN NEW.case_size IS NOT NULL THEN v_sku.purchase_unit_name END;
  RETURN NEW;
END $$;

-- As 0016, plus stock bought with drawer cash.
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
    - coalesce((SELECT sum(l.qty::bigint * l.unit_cost_paise) FROM stock_receipt_lines l
                  JOIN stock_receipts r ON r.id = l.receipt_id
                 WHERE r.business_day_id = d.id AND r.paid_from = 'DRAWER'), 0)
  )::bigint
  FROM business_days d
  WHERE d.id = p_day_id
$$;
