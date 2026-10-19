-- ─────────────────────────────────────────────────────────────────────────────
-- 0017 SKU volume and excise group. Design: docs/ui/phase24-reporting-suite-plan.md (Revision 1, R2)
--
--   * skus.volume_ml: the nominal volume printed on one sealed bottle / tin (750, 375, 180, 650, …).
--     A static label for the excise ML summary (bottles × volume). Stock stays whole bottles: there is
--     no peg, cutting or open-bottle ml tracking (CLAUDE.md). NULL for items that are not bottles.
--   * skus.excise_group: the statutory summary group (LIQUOR, BEER, TIN_BEER, WINE). NULL outside the
--     liquor center (cigarettes, cool drinks, food).
--   * Both default from the structured size code (never from display names) on back-fill and on insert,
--     and stay editable on the catalog item (a 500 ml tin, a 1000 ml bottle).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE skus
  ADD COLUMN volume_ml integer CONSTRAINT skus_volume_ml_positive CHECK (volume_ml IS NULL OR volume_ml > 0),
  ADD COLUMN excise_group text CONSTRAINT skus_excise_group_valid CHECK (excise_group IN ('LIQUOR', 'BEER', 'TIN_BEER', 'WINE'));

CREATE FUNCTION pos_default_volume_ml(p_size_code text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_size_code
           WHEN 'FULL' THEN 750
           WHEN 'HALF' THEN 375
           WHEN 'QUARTER' THEN 180
           WHEN 'BEER_650' THEN 650
           WHEN 'BEER_330' THEN 330
         END
$$;

CREATE FUNCTION pos_default_excise_group(p_product_id uuid, p_size_code text, p_item_category_id uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN p.department <> 'LIQUOR' OR p_size_code = 'UNIT' THEN NULL
           WHEN p_size_code = 'BEER_650' THEN 'BEER'
           WHEN p_size_code = 'BEER_330' THEN 'TIN_BEER'
           WHEN p.category = 'WINE' OR ic.system_key = 'WINE' THEN 'WINE'
           WHEN p.category = 'BEER' OR ic.system_key = 'BEER' THEN 'BEER'
           ELSE 'LIQUOR'
         END
    FROM products p
    LEFT JOIN item_categories ic ON ic.id = p_item_category_id
   WHERE p.id = p_product_id
$$;

UPDATE skus
   SET volume_ml = pos_default_volume_ml(size_code),
       excise_group = pos_default_excise_group(product_id, size_code, item_category_id);

-- Fires after skus_default_item_category (triggers run in name order), so the category is known.
CREATE FUNCTION pos_skus_excise_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.volume_ml IS NULL THEN
    NEW.volume_ml := pos_default_volume_ml(NEW.size_code);
  END IF;
  IF NEW.excise_group IS NULL THEN
    NEW.excise_group := pos_default_excise_group(NEW.product_id, NEW.size_code, NEW.item_category_id);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER skus_excise_defaults BEFORE INSERT ON skus
  FOR EACH ROW EXECUTE FUNCTION pos_skus_excise_defaults();
