-- FL2 POS · Phase 2: allow tagging a waiter onto an open bill (WaiterService.tagBillToWaiter).
--
-- 0002 froze bills.waiter_id at insert. A waiter may now be tagged (or re-tagged) while the bill is
-- an OPEN, NORMAL-mode SALE bill with no tenders yet. The trust snapshot is retaken at tagging.
-- Once any tender exists (credit is decided per waiter) or the bill settles, the tag is fixed.
-- Everything else in pos_bills_before_update is unchanged.

CREATE OR REPLACE FUNCTION pos_bills_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tendered bigint;
  v_waiter waiters%ROWTYPE;
BEGIN
  IF OLD.status IN ('SETTLED', 'PEAK_RECONCILED') THEN
    RAISE EXCEPTION 'bill % is % and frozen; post a reversal instead', OLD.bill_no, OLD.status USING ERRCODE = 'PS001';
  END IF;
  IF (NEW.id, NEW.business_day_id, NEW.bill_no, NEW.bill_kind, NEW.billing_mode, NEW.source, NEW.peak_session_id,
      NEW.reverses_bill_id, NEW.replaces_bill_id, NEW.reversal_reason, NEW.created_by_staff_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.business_day_id, OLD.bill_no, OLD.bill_kind, OLD.billing_mode, OLD.source, OLD.peak_session_id,
      OLD.reverses_bill_id, OLD.replaces_bill_id, OLD.reversal_reason, OLD.created_by_staff_id, OLD.created_at) THEN
    RAISE EXCEPTION 'bill % identity columns are immutable', OLD.bill_no USING ERRCODE = 'PS001';
  END IF;
  IF NEW.total_paise <> OLD.total_paise AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'bills.total_paise is derived from bill_items' USING ERRCODE = 'PS009';
  END IF;

  -- Waiter tagging.
  IF NEW.waiter_id IS DISTINCT FROM OLD.waiter_id THEN
    IF OLD.bill_kind <> 'SALE' OR OLD.billing_mode <> 'NORMAL' OR OLD.status <> 'OPEN' THEN
      RAISE EXCEPTION 'bill % cannot be tagged to a waiter: only open NORMAL sale bills can (peak bills are counter-only)',
        OLD.bill_no USING ERRCODE = 'PS002';
    END IF;
    IF NEW.waiter_id IS NULL THEN
      RAISE EXCEPTION 'bill % waiter tag cannot be removed, only changed', OLD.bill_no USING ERRCODE = 'PS002';
    END IF;
    IF EXISTS (SELECT 1 FROM bill_payments WHERE bill_id = NEW.id) THEN
      RAISE EXCEPTION 'bill % already has tenders; its waiter can no longer change', OLD.bill_no USING ERRCODE = 'PS002';
    END IF;
    SELECT * INTO v_waiter FROM waiters WHERE id = NEW.waiter_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'waiter % not found', NEW.waiter_id USING ERRCODE = 'PS002';
    END IF;
    IF NOT v_waiter.is_active THEN
      RAISE EXCEPTION 'waiter % is inactive', v_waiter.waiter_code USING ERRCODE = 'PS002';
    END IF;
    NEW.waiter_trusted_at_billing := v_waiter.is_trusted;
  ELSIF NEW.waiter_trusted_at_billing IS DISTINCT FROM OLD.waiter_trusted_at_billing THEN
    RAISE EXCEPTION 'bill % trust snapshot is immutable', OLD.bill_no USING ERRCODE = 'PS001';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'OPEN' AND NEW.status = 'SETTLED' THEN
      SELECT coalesce(sum(amount_paise), 0) INTO v_tendered FROM bill_payments WHERE bill_id = NEW.id;
      IF v_tendered <> NEW.total_paise THEN
        RAISE EXCEPTION 'bill % cannot settle: tendered % paise, total % paise', NEW.bill_no, v_tendered, NEW.total_paise
          USING ERRCODE = 'PS005';
      END IF;
      NEW.settled_at := now();
    ELSIF OLD.status = 'PEAK_UNSETTLED' AND NEW.status = 'PEAK_RECONCILED' THEN
      IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'peak bills are reconciled by ending their peak session' USING ERRCODE = 'PS002';
      END IF;
      NEW.peak_reconciled_at := now();
    ELSE
      RAISE EXCEPTION 'illegal bill status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'PS002';
    END IF;
  ELSIF (NEW.settled_at, NEW.settled_by_staff_id, NEW.peak_reconciled_at)
        IS DISTINCT FROM (OLD.settled_at, OLD.settled_by_staff_id, OLD.peak_reconciled_at) THEN
    RAISE EXCEPTION 'settlement metadata only changes with the status transition' USING ERRCODE = 'PS002';
  END IF;
  RETURN NEW;
END $$;
