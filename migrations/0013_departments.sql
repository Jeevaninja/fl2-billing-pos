-- ─────────────────────────────────────────────────────────────────────────────
-- 0013 Departments: unified billing, split ledger. Design: docs/ui/phase19-departments-plan.md
--
--   * departments: a fixed, read-only list (LIQUOR, KITCHEN, ANCILLARY). Each says which KOT station
--     its lines print at and whether its items are stock-tracked. Seeded here on every database, so
--     it has no outbox.
--   * products.department (D1): every size of a product shares it. Existing products are liquor
--     (and LIQUOR stays the default for a product inserted without one).
--   * bill_items.department: snapshotted at insert like the name and price (a cancellation or
--     reversal copies the original's), so a later catalog change never moves billed revenue.
--     Existing lines are liquor; the column is added by DDL, so the append-only guard is untouched.
--   * Kitchen items are not stock-tracked (D2): no SALE movement, no out-of-stock refusal, and no
--     GRN / opening / adjustment. Ancillary items are tracked in whole units like liquor.
--   * New categories FOOD, BEVERAGE, TOBACCO and the single-size UNIT size code (D3).
--   * expense_categories.department (D4): NULL = Shared overheads. Expenses follow their category.
--   * kot_tickets / kot_ticket_lines (D5): append-only record of what each station was sent.
--   * Bills, tenders, pos_day_expected_cash and the peak functions are unchanged: one drawer.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE departments (
  code         text    PRIMARY KEY CONSTRAINT departments_code_valid CHECK (code IN ('LIQUOR', 'KITCHEN', 'ANCILLARY')),
  name         text    NOT NULL,
  kot_station  text    NOT NULL CONSTRAINT departments_station_valid CHECK (kot_station IN ('BAR', 'KITCHEN')),
  tracks_stock boolean NOT NULL,
  sort_order   integer NOT NULL CONSTRAINT departments_sort_order_unique UNIQUE
);

INSERT INTO departments (code, name, kot_station, tracks_stock, sort_order) VALUES
  ('LIQUOR',    'Liquor',    'BAR',     true,  1),
  ('KITCHEN',   'Kitchen',   'KITCHEN', false, 2),
  ('ANCILLARY', 'Ancillary', 'BAR',     true,  3);

CREATE TRIGGER departments_no_update BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER departments_no_delete BEFORE DELETE ON departments
  FOR EACH ROW EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER departments_no_truncate BEFORE TRUNCATE ON departments
  FOR EACH STATEMENT EXECUTE FUNCTION pos_forbid_change();

-- ── Catalog ──────────────────────────────────────────────────────────────────

ALTER TABLE products
  ADD COLUMN department text NOT NULL DEFAULT 'LIQUOR' REFERENCES departments (code),
  DROP CONSTRAINT products_category_valid,
  ADD CONSTRAINT products_category_valid
    CHECK (category IN ('WHISKY', 'RUM', 'VODKA', 'BRANDY', 'GIN', 'WINE', 'BEER', 'OTHER', 'FOOD', 'BEVERAGE', 'TOBACCO'));

ALTER TABLE skus
  DROP CONSTRAINT skus_size_code_valid,
  ADD CONSTRAINT skus_size_code_valid CHECK (size_code IN ('FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330', 'UNIT'));

-- Whether a SKU's stock is counted (its product's department).
CREATE FUNCTION pos_sku_tracks_stock(p_sku_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT d.tracks_stock
    FROM skus s JOIN products p ON p.id = s.product_id JOIN departments d ON d.code = p.department
   WHERE s.id = p_sku_id
$$;

-- Moving a product with bottles on hand into an untracked department would strand that stock.
CREATE FUNCTION pos_products_department_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.department IS DISTINCT FROM OLD.department
     AND NOT (SELECT tracks_stock FROM departments WHERE code = NEW.department)
     AND EXISTS (SELECT 1 FROM skus s JOIN sku_stock k ON k.sku_id = s.id WHERE s.product_id = NEW.id AND k.on_hand_qty <> 0) THEN
    RAISE EXCEPTION '% still has stock on hand; % items are not stock-tracked',
      OLD.name, (SELECT name FROM departments WHERE code = NEW.department)
      USING ERRCODE = 'PS002';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER products_department_guard BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION pos_products_department_guard();

-- ── Stock: untracked departments never move stock ───────────────────────────

-- As 0008, plus: no movement at all for a SKU whose department is not stock-tracked.
CREATE OR REPLACE FUNCTION pos_stock_movements_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_on_hand integer;
BEGIN
  IF NEW.movement_type IN ('SALE', 'SALE_REVERSAL') AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'SALE / SALE_REVERSAL movements are posted automatically from bill_items' USING ERRCODE = 'PS009';
  END IF;
  IF NEW.movement_type = 'PURCHASE_RECEIPT' AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'PURCHASE_RECEIPT movements are posted automatically from stock receipt lines' USING ERRCODE = 'PS009';
  END IF;
  IF NOT coalesce(pos_sku_tracks_stock(NEW.sku_id), true) THEN
    RAISE EXCEPTION '% is not stock-tracked (Kitchen items)', (SELECT sku_code FROM skus WHERE id = NEW.sku_id)
      USING ERRCODE = 'PS002';
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

-- As 0009, plus: Kitchen items are never inwarded through a GRN.
CREATE OR REPLACE FUNCTION pos_stock_receipt_lines_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_sku skus%ROWTYPE;
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
  RETURN NEW;
END $$;

-- ── Bill lines: department snapshot ─────────────────────────────────────────

-- The default only fills the existing (liquor) lines and lets a missing SKU / line surface as its FK
-- error: the insert trigger always sets the real department on every new line.
ALTER TABLE bill_items ADD COLUMN department text NOT NULL DEFAULT 'LIQUOR' REFERENCES departments (code);
CREATE INDEX bill_items_bill_department_idx ON bill_items (bill_id, department);

-- As 0002, plus the department snapshot (from the product on a positive line, else the original's).
CREATE OR REPLACE FUNCTION pos_bill_items_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
    NEW.department := (SELECT department FROM products WHERE id = v_sku.product_id);

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
    NEW.department := v_orig.department;
  END IF;
  RETURN NEW;
END $$;

-- As 0002, but a line of an untracked department posts no stock movement.
CREATE OR REPLACE FUNCTION pos_bill_items_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_day_id uuid;
BEGIN
  UPDATE bills SET total_paise = total_paise + NEW.line_total_paise
   WHERE id = NEW.bill_id
  RETURNING business_day_id INTO v_day_id;

  IF NOT (SELECT tracks_stock FROM departments WHERE code = NEW.department) THEN
    RETURN NULL;
  END IF;
  IF NEW.qty > 0 THEN
    INSERT INTO stock_movements (sku_id, business_day_id, movement_type, qty_delta, bill_item_id, created_by_staff_id)
    VALUES (NEW.sku_id, v_day_id, 'SALE', -NEW.qty, NEW.id, NEW.created_by_staff_id);
  ELSIF NEW.restock THEN
    INSERT INTO stock_movements (sku_id, business_day_id, movement_type, qty_delta, bill_item_id, created_by_staff_id)
    VALUES (NEW.sku_id, v_day_id, 'SALE_REVERSAL', -NEW.qty, NEW.id, NEW.created_by_staff_id);
  END IF;
  RETURN NULL;
END $$;

-- ── Expense categories ──────────────────────────────────────────────────────

-- NULL = Shared (overheads that belong to no single P&L).
ALTER TABLE expense_categories ADD COLUMN department text REFERENCES departments (code);
UPDATE expense_categories SET department = 'LIQUOR' WHERE legacy_code = 'ICE';

-- ── KOT ledger ───────────────────────────────────────────────────────────────

CREATE TABLE kot_tickets (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  bill_id             uuid        NOT NULL REFERENCES bills (id),
  station             text        NOT NULL CONSTRAINT kot_tickets_station_valid CHECK (station IN ('BAR', 'KITCHEN')),
  -- Per bill and station: KOT #12, #12/2, …
  ticket_no           integer     NOT NULL CONSTRAINT kot_tickets_ticket_no_positive CHECK (ticket_no >= 1),
  printed_at          timestamptz NOT NULL DEFAULT now(),
  created_by_staff_id uuid        REFERENCES staff (id),
  captain_device_id   text,
  CONSTRAINT kot_tickets_no_unique UNIQUE (bill_id, station, ticket_no),
  CONSTRAINT kot_tickets_one_sender CHECK (created_by_staff_id IS NULL OR captain_device_id IS NULL)
);

CREATE TABLE kot_ticket_lines (
  id           uuid    PRIMARY KEY DEFAULT uuidv7(),
  ticket_id    uuid    NOT NULL REFERENCES kot_tickets (id),
  -- Always the original (positive) line; a negative qty is a CANCEL.
  bill_item_id uuid    NOT NULL REFERENCES bill_items (id),
  qty          integer NOT NULL CONSTRAINT kot_ticket_lines_qty_non_zero CHECK (qty <> 0),
  CONSTRAINT kot_ticket_lines_item_unique UNIQUE (ticket_id, bill_item_id)
);
CREATE INDEX kot_ticket_lines_item_idx ON kot_ticket_lines (bill_item_id);

CREATE FUNCTION pos_kot_ticket_lines_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ticket kot_tickets%ROWTYPE;
  v_item bill_items%ROWTYPE;
BEGIN
  SELECT * INTO v_ticket FROM kot_tickets WHERE id = NEW.ticket_id;
  SELECT * INTO v_item FROM bill_items WHERE id = NEW.bill_item_id;
  IF v_ticket.id IS NULL OR v_item.id IS NULL THEN
    RETURN NEW; -- the FKs report a missing row
  END IF;
  IF v_item.bill_id <> v_ticket.bill_id OR v_item.qty < 0 THEN
    RAISE EXCEPTION 'a KOT line must reference an original line of the ticket''s bill' USING ERRCODE = 'PS002';
  END IF;
  IF (SELECT kot_station FROM departments WHERE code = v_item.department) <> v_ticket.station THEN
    RAISE EXCEPTION '% does not print at the % station', v_item.display_name_snapshot, v_ticket.station
      USING ERRCODE = 'PS002';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER kot_ticket_lines_before_insert BEFORE INSERT ON kot_ticket_lines
  FOR EACH ROW EXECUTE FUNCTION pos_kot_ticket_lines_before_insert();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kot_tickets', 'kot_ticket_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pos_forbid_change()', t || '_no_update', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pos_forbid_change()', t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION pos_forbid_change()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture()', t || '_outbox', t);
  END LOOP;
END $$;
