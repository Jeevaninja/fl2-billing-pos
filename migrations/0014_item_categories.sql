-- ─────────────────────────────────────────────────────────────────────────────
-- 0014 Custom item categories: a flat, stock-report catalog. Design: docs/ui/phase20-item-categories-plan.md
--
--   * item_categories: the manager's groupings (FULL, HALF, QUARTER, BEER, WINE, …) in report order.
--     Master data like expense categories: editable, never deleted (disable instead), outbox on change.
--     Each suggests a default bottle size and a default department for new items.
--   * skus.item_category_id: every item (one SKU) sits in exactly one category. The size code stays on
--     the SKU (D2): it still drives KOT labels, case sizes and excise reporting.
--   * Brands (products) stay as an internal link found or created by name (D1); department stays on
--     the brand (D3). Bills, stock, KOTs and Day End are untouched.
--   * system_key ties the seven seeded categories to the back-fill rule, so a SKU inserted without a
--     category (older callers, seeds) still lands in the right one even after the manager renames it.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE item_categories (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  name               text        NOT NULL
                                 CONSTRAINT item_categories_name_present CHECK (btrim(name) <> '' AND name = btrim(name) AND length(name) <= 30),
  sort_order         integer     NOT NULL CONSTRAINT item_categories_sort_order_positive CHECK (sort_order > 0),
  is_active          boolean     NOT NULL DEFAULT true,
  default_size_code  text        CONSTRAINT item_categories_default_size_valid
                                 CHECK (default_size_code IN ('FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330', 'UNIT')),
  default_department text        NOT NULL DEFAULT 'LIQUOR' REFERENCES departments (code),
  system_key         text        CONSTRAINT item_categories_system_key_unique UNIQUE
                                 CONSTRAINT item_categories_system_key_valid
                                 CHECK (system_key IN ('FULL', 'HALF', 'QUARTER', 'BEER', 'WINE', 'FOOD', 'OTHERS')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX item_categories_name_unique ON item_categories (lower(name));

CREATE FUNCTION pos_item_categories_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.system_key IS DISTINCT FROM OLD.system_key OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'item category % identity columns are immutable', OLD.name USING ERRCODE = 'PS001';
  END IF;
  -- A disabled category would hide items that are still on sale.
  IF OLD.is_active AND NOT NEW.is_active
     AND EXISTS (SELECT 1 FROM skus WHERE item_category_id = OLD.id AND is_active) THEN
    RAISE EXCEPTION 'item category % still has active items; move or deactivate them first', OLD.name USING ERRCODE = 'PS002';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER item_categories_before_update BEFORE UPDATE ON item_categories
  FOR EACH ROW EXECUTE FUNCTION pos_item_categories_before_update();
CREATE TRIGGER item_categories_no_delete BEFORE DELETE ON item_categories
  FOR EACH ROW EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER item_categories_no_truncate BEFORE TRUNCATE ON item_categories
  FOR EACH STATEMENT EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER item_categories_outbox AFTER INSERT OR UPDATE ON item_categories
  FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture('updated_at');

INSERT INTO item_categories (name, sort_order, default_size_code, default_department, system_key) VALUES
  ('FULL',    1, 'FULL',     'LIQUOR',    'FULL'),
  ('HALF',    2, 'HALF',     'LIQUOR',    'HALF'),
  ('QUARTER', 3, 'QUARTER',  'LIQUOR',    'QUARTER'),
  ('BEER',    4, 'BEER_650', 'LIQUOR',    'BEER'),
  ('WINE',    5, 'FULL',     'LIQUOR',    'WINE'),
  ('FOOD',    6, 'UNIT',     'KITCHEN',   'FOOD'),
  ('OTHERS',  7, 'UNIT',     'ANCILLARY', 'OTHERS');

-- The seeded category an item of this brand and size belongs to: any Kitchen item → FOOD (plates
-- included), any Ancillary item → OTHERS, wine → WINE, either beer size → BEER, Full / Half / Quarter
-- → the same, anything else → OTHERS.
CREATE FUNCTION pos_default_item_category(p_product_id uuid, p_size_code text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT c.id
    FROM products p
    JOIN item_categories c ON c.system_key = CASE
           WHEN p.department = 'KITCHEN' THEN 'FOOD'
           WHEN p.department = 'ANCILLARY' THEN 'OTHERS'
           WHEN p.category = 'WINE' THEN 'WINE'
           WHEN p_size_code IN ('BEER_650', 'BEER_330') THEN 'BEER'
           WHEN p_size_code IN ('FULL', 'HALF', 'QUARTER') THEN p_size_code
           ELSE 'OTHERS' END
   WHERE p.id = p_product_id
$$;

-- ── skus ─────────────────────────────────────────────────────────────────────

ALTER TABLE skus ADD COLUMN item_category_id uuid REFERENCES item_categories (id);
UPDATE skus SET item_category_id = pos_default_item_category(product_id, size_code);
ALTER TABLE skus ALTER COLUMN item_category_id SET NOT NULL;
CREATE INDEX skus_item_category_idx ON skus (item_category_id);

-- A SKU inserted without a category (seeds, the brand-and-sizes API) takes its seeded default.
CREATE FUNCTION pos_skus_default_item_category() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.item_category_id IS NULL THEN
    NEW.item_category_id := pos_default_item_category(NEW.product_id, NEW.size_code);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER skus_default_item_category BEFORE INSERT ON skus
  FOR EACH ROW EXECUTE FUNCTION pos_skus_default_item_category();
