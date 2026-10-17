-- ─────────────────────────────────────────────────────────────────────────────
-- 0009 Master catalog & case-based inwarding. Design: docs/ui/phase10-catalog-case-grn-plan.md
--
--   * skus.case_size: sealed bottles per supplier case (whole integer, 1–1000). Required.
--   * skus.purchase_price_paise: default per-bottle cost pre-filled on a GRN line. Optional.
--     The default sale price remains skus.price_paise.
--   * stock_receipt_lines.cases + case_size: how a GRN line was counted (Decision B). qty stays the
--     only number the stock ledger sees; loose bottles = qty − cases × case_size. A supplied
--     case_size must equal the SKU's current one, so a catalog edit mid-entry cannot skew stock.
--   * Catalog duplicates (name, code, barcode, size) map to PS012 in src/db/errors.ts.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE skus
  ADD COLUMN case_size integer CONSTRAINT skus_case_size_range CHECK (case_size BETWEEN 1 AND 1000),
  ADD COLUMN purchase_price_paise bigint
    CONSTRAINT skus_purchase_price_non_negative CHECK (purchase_price_paise IS NULL OR purchase_price_paise >= 0);

-- Decision C: backfill by size (Indian distribution cases), then require it.
UPDATE skus SET case_size = CASE size_code
  WHEN 'FULL' THEN 12
  WHEN 'HALF' THEN 32
  WHEN 'QUARTER' THEN 64
  WHEN 'BEER_650' THEN 12
  WHEN 'BEER_330' THEN 24
END;
ALTER TABLE skus ALTER COLUMN case_size SET NOT NULL;

ALTER TABLE stock_receipt_lines
  ADD COLUMN cases integer NOT NULL DEFAULT 0 CONSTRAINT stock_receipt_lines_cases_non_negative CHECK (cases >= 0),
  -- Snapshot of skus.case_size when the line was counted in cases; NULL on loose-only / pre-0009 lines.
  ADD COLUMN case_size integer,
  ADD CONSTRAINT stock_receipt_lines_case_shape CHECK (
    (case_size IS NULL AND cases = 0)
    OR (case_size IS NOT NULL AND case_size >= 1 AND cases::bigint * case_size <= qty)
  );

-- As 0008, plus: a supplied case_size must match the catalog (as bill_items does for the price).
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
  IF NEW.case_size IS NOT NULL AND NEW.case_size <> v_sku.case_size THEN
    RAISE EXCEPTION 'case size for % is now % — re-check the line', v_sku.sku_code, v_sku.case_size
      USING ERRCODE = 'PS002';
  END IF;
  RETURN NEW;
END $$;
