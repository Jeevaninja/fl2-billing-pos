-- ─────────────────────────────────────────────────────────────────────────────
-- 0012 Custom expense categories. Design: docs/ui/phase18-expense-categories-plan.md
--
--   * expense_categories: a managed list (Settings → Expense Categories) replacing the fixed CHECK
--     list from 0006. Master data like the catalog: editable (name, note rule, order, active), never
--     deleted — "delete" is disable. Every change goes to the sync outbox.
--   * cash_expenses stays append-only and its existing rows are NOT touched (no back-fill, which
--     would need its UPDATE guard lifted and would skip the outbox). Old rows keep their text
--     `category`; the six seeded categories claim those codes through `legacy_code`, so old and new
--     rows resolve to the same category (and follow a rename). New rows carry `category_id`.
--   * The "OTHER needs a note" CHECK becomes a per-category `note_required` flag, enforced on insert.
--   * Day End and peak math only sum amounts, so pos_day_expected_cash and the peak functions are
--     unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE expense_categories (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  name          text        NOT NULL
                            CONSTRAINT expense_categories_name_present CHECK (btrim(name) <> '' AND name = btrim(name) AND length(name) <= 40),
  is_active     boolean     NOT NULL DEFAULT true,
  note_required boolean     NOT NULL DEFAULT false,
  sort_order    integer     NOT NULL CONSTRAINT expense_categories_sort_order_positive CHECK (sort_order > 0),
  legacy_code   text        CONSTRAINT expense_categories_legacy_code_unique UNIQUE
                            CONSTRAINT expense_categories_legacy_code_valid
                            CHECK (legacy_code IN ('ICE', 'STAFF_FOOD', 'TRANSPORT', 'CLEANING', 'REPAIRS', 'OTHER')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX expense_categories_name_unique ON expense_categories (lower(name));

-- legacy_code is identity: it ties pre-0012 expenses to their category.
CREATE FUNCTION pos_expense_categories_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.legacy_code IS DISTINCT FROM OLD.legacy_code OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'expense category % identity columns are immutable', OLD.name USING ERRCODE = 'PS001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER expense_categories_before_update BEFORE UPDATE ON expense_categories
  FOR EACH ROW EXECUTE FUNCTION pos_expense_categories_before_update();
CREATE TRIGGER expense_categories_no_delete BEFORE DELETE ON expense_categories
  FOR EACH ROW EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER expense_categories_no_truncate BEFORE TRUNCATE ON expense_categories
  FOR EACH STATEMENT EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER expense_categories_outbox AFTER INSERT OR UPDATE ON expense_categories
  FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture('updated_at');

-- The six 0006 categories keep their codes ("Repairs" now reads "Repairs & Maintenance"), plus Bata.
INSERT INTO expense_categories (name, sort_order, legacy_code, note_required) VALUES
  ('Ice',                   1, 'ICE',        false),
  ('Staff food',            2, 'STAFF_FOOD', false),
  ('Transport',             3, 'TRANSPORT',  false),
  ('Cleaning',              4, 'CLEANING',   false),
  ('Repairs & Maintenance', 5, 'REPAIRS',    false),
  ('Bata / Daily Wages',    6, NULL,         false),
  ('Other',                 7, 'OTHER',      true);

-- ── cash_expenses ────────────────────────────────────────────────────────────

ALTER TABLE cash_expenses
  ADD COLUMN category_id uuid REFERENCES expense_categories (id),
  ALTER COLUMN category DROP DEFAULT,
  ALTER COLUMN category DROP NOT NULL,
  DROP CONSTRAINT cash_expenses_other_needs_note,
  ADD CONSTRAINT cash_expenses_one_category CHECK ((category IS NULL) <> (category_id IS NULL));
CREATE INDEX cash_expenses_category_idx ON cash_expenses (category_id) WHERE category_id IS NOT NULL;

CREATE OR REPLACE FUNCTION pos_cash_expenses_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_orig cash_expenses%ROWTYPE;
  v_cat expense_categories%ROWTYPE;
BEGIN
  NEW.business_day_id := pos_require_open_day(NEW.business_day_id);
  NEW.peak_session_id := pos_active_peak_session_id(NEW.business_day_id);
  IF NEW.amount_paise < 0 THEN
    SELECT * INTO v_orig FROM cash_expenses WHERE id = NEW.reverses_expense_id;
    IF FOUND THEN
      IF NEW.amount_paise <> -v_orig.amount_paise THEN
        RAISE EXCEPTION 'an expense correction must exactly negate the original expense' USING ERRCODE = 'PS006';
      END IF;
      IF v_orig.business_day_id <> NEW.business_day_id THEN
        RAISE EXCEPTION 'expense is from a closed day; its cash was already counted' USING ERRCODE = 'PS007';
      END IF;
      -- A void carries the original's category, legacy code or id, whatever was sent.
      NEW.category := v_orig.category;
      NEW.category_id := v_orig.category_id;
      NEW.description := coalesce(NEW.description, v_orig.description);
    END IF;
    RETURN NEW;
  END IF;

  -- New expenses pick a managed category; legacy codes belong to pre-0012 rows only.
  IF NEW.category IS NOT NULL OR NEW.category_id IS NULL THEN
    RAISE EXCEPTION 'a new expense needs a category from Settings → Expense Categories' USING ERRCODE = 'PS002';
  END IF;
  SELECT * INTO v_cat FROM expense_categories WHERE id = NEW.category_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the unknown category
  END IF;
  IF NOT v_cat.is_active THEN
    RAISE EXCEPTION 'expense category % is disabled', v_cat.name USING ERRCODE = 'PS002';
  END IF;
  IF v_cat.note_required AND NEW.description IS NULL THEN
    RAISE EXCEPTION 'a % expense needs a note', v_cat.name USING ERRCODE = 'PS002';
  END IF;
  RETURN NEW;
END $$;
