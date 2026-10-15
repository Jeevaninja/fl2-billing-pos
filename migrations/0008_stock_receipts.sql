-- ─────────────────────────────────────────────────────────────────────────────
-- 0008 Stock receipts (GRN). Design: docs/ui/phase9-purchase-grn-plan.md
--
--   * stock_receipts: one row per supplier invoice received on the open day. Append-only.
--   * stock_receipt_lines: whole sealed bottles of one SKU at one unit cost (₹0 allowed for
--     scheme / free bottles). Append-only. No stored totals: qty × unit_cost_paise is summed in queries.
--   * Each line posts exactly one PURCHASE_RECEIPT stock movement (by trigger), linked through
--     stock_movements.receipt_line_id. A receipt is now the only way to inward stock.
--   * The same invoice number from the same vendor (case- and space-insensitive) is refused (PS011).
--   * A receipt touches no drawer cash and carries no tax fields.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE stock_receipts (
  id                    uuid        PRIMARY KEY DEFAULT uuidv7(),
  business_day_id       uuid        NOT NULL REFERENCES business_days (id),
  invoice_no            text        NOT NULL CONSTRAINT stock_receipts_invoice_present CHECK (btrim(invoice_no) <> ''),
  vendor_name           text                 CONSTRAINT stock_receipts_vendor_present CHECK (vendor_name IS NULL OR btrim(vendor_name) <> ''),
  received_by_staff_id  uuid        NOT NULL REFERENCES staff (id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stock_receipts_invoice_unique
  ON stock_receipts (upper(btrim(invoice_no)), lower(btrim(coalesce(vendor_name, ''))));
CREATE INDEX stock_receipts_day_idx ON stock_receipts (business_day_id, created_at);

CREATE TABLE stock_receipt_lines (
  id               uuid    PRIMARY KEY DEFAULT uuidv7(),
  receipt_id       uuid    NOT NULL REFERENCES stock_receipts (id),
  line_no          integer NOT NULL CONSTRAINT stock_receipt_lines_line_no_positive CHECK (line_no >= 1),
  sku_id           uuid    NOT NULL REFERENCES skus (id),
  qty              integer NOT NULL CONSTRAINT stock_receipt_lines_qty_positive CHECK (qty > 0),
  unit_cost_paise  bigint  NOT NULL CONSTRAINT stock_receipt_lines_cost_non_negative CHECK (unit_cost_paise >= 0),
  CONSTRAINT stock_receipt_lines_sku_once UNIQUE (receipt_id, sku_id),
  CONSTRAINT stock_receipt_lines_no_unique UNIQUE (receipt_id, line_no)
);
CREATE INDEX stock_receipt_lines_sku_idx ON stock_receipt_lines (sku_id);

-- Trace from the ledger back to the invoice line. Before 0008 nothing posted PURCHASE_RECEIPT
-- movements, so the pairing is enforced for new rows only (as 0005 did for the cash count).
ALTER TABLE stock_movements
  ADD COLUMN receipt_line_id uuid CONSTRAINT stock_movements_receipt_line_unique UNIQUE REFERENCES stock_receipt_lines (id);
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_receipt_line_link CHECK (
    (movement_type = 'PURCHASE_RECEIPT') = (receipt_line_id IS NOT NULL)
  ) NOT VALID;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rules
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION pos_stock_receipts_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.business_day_id := pos_require_open_day(NEW.business_day_id);
  RETURN NEW;
END $$;

CREATE FUNCTION pos_stock_receipt_lines_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_sku skus%ROWTYPE;
BEGIN
  SELECT * INTO v_sku FROM skus WHERE id = NEW.sku_id;
  IF FOUND AND NOT v_sku.is_active THEN
    RAISE EXCEPTION 'SKU % is inactive', v_sku.sku_code USING ERRCODE = 'PS002';
  END IF;
  RETURN NEW; -- a missing SKU is reported by the FK
END $$;

CREATE FUNCTION pos_stock_receipt_lines_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stock_movements (sku_id, business_day_id, movement_type, qty_delta, receipt_line_id, created_by_staff_id)
  SELECT NEW.sku_id, r.business_day_id, 'PURCHASE_RECEIPT', NEW.qty, NEW.id, r.received_by_staff_id
    FROM stock_receipts r
   WHERE r.id = NEW.receipt_id;
  RETURN NULL;
END $$;

-- As 0002, plus: PURCHASE_RECEIPT movements are posted only from stock_receipt_lines.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Trigger wiring
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TRIGGER stock_receipts_before_insert BEFORE INSERT ON stock_receipts
  FOR EACH ROW EXECUTE FUNCTION pos_stock_receipts_before_insert();
CREATE TRIGGER stock_receipt_lines_before_insert BEFORE INSERT ON stock_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION pos_stock_receipt_lines_before_insert();
CREATE TRIGGER stock_receipt_lines_after_insert AFTER INSERT ON stock_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION pos_stock_receipt_lines_after_insert();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_receipts', 'stock_receipt_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pos_forbid_change()', t || '_no_update', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pos_forbid_change()', t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION pos_forbid_change()',
                   t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture()', t || '_outbox', t);
  END LOOP;
END $$;
