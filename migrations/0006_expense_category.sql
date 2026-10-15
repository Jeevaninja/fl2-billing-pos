-- ─────────────────────────────────────────────────────────────────────────────
-- 0006 Expense categories. Design: docs/ui/phase8-operations-ui-plan.md
--
--   * cash_expenses.category: a fixed list, so reports can group petty cash. Existing rows were
--     free-text only and become OTHER (their description is kept).
--   * The note is optional now, except for OTHER, where it is the only description.
--   * A void (negative row) copies the original's category and must be posted on the original's
--     business day: once a day is closed its cash has been counted, so it can't be corrected later.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE cash_expenses
  ADD COLUMN category text NOT NULL DEFAULT 'OTHER'
    CONSTRAINT cash_expenses_category_valid
    CHECK (category IN ('ICE', 'STAFF_FOOD', 'TRANSPORT', 'CLEANING', 'REPAIRS', 'OTHER')),
  ALTER COLUMN description DROP NOT NULL,
  DROP CONSTRAINT cash_expenses_description_present,
  ADD CONSTRAINT cash_expenses_description_present CHECK (description IS NULL OR btrim(description) <> ''),
  ADD CONSTRAINT cash_expenses_other_needs_note CHECK (category <> 'OTHER' OR description IS NOT NULL);

CREATE OR REPLACE FUNCTION pos_cash_expenses_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_orig cash_expenses%ROWTYPE;
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
      NEW.category := v_orig.category;
      NEW.description := coalesce(NEW.description, v_orig.description);
    END IF;
  END IF;
  RETURN NEW;
END $$;
