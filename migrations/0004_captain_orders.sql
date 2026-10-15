-- ─────────────────────────────────────────────────────────────────────────────
-- 0004 Captain orders: idempotency keys, paired-handset id, bill-on-bill.
-- Design: docs/db/phase5-captain-idempotency-plan.md
--
--   * request_id / request_fingerprint: a Captain-app order carries a client-generated key. A retry
--     with the same key finds the original bill instead of creating a second one (unique index);
--     the fingerprint (sha256 of device + waiter + member + lines) detects a key reused for a
--     different order.
--   * captain_device_id: the paired handset that placed the order.
--   * Bill-on-bill: an untrusted waiter cannot open a new app order while any bill tagged to them
--     is still OPEN (PS010).
--
-- Existing WAITER_APP rows (dev/test data only) keep NULL keys; the requirement applies to new
-- inserts through a trigger, so no backfill is needed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE bills
  ADD COLUMN request_id          uuid,
  ADD COLUMN request_fingerprint text,
  ADD COLUMN captain_device_id   text,
  ADD CONSTRAINT bills_request_pairing     CHECK ((request_id IS NULL) = (request_fingerprint IS NULL)),
  ADD CONSTRAINT bills_request_waiter_app  CHECK (request_id IS NULL OR source = 'WAITER_APP'),
  ADD CONSTRAINT bills_request_fingerprint CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT bills_device_waiter_app   CHECK (captain_device_id IS NULL OR source = 'WAITER_APP'),
  ADD CONSTRAINT bills_device_id_format    CHECK (captain_device_id IS NULL OR captain_device_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$');

-- The idempotency guarantee. Partial: counter bills carry no key.
CREATE UNIQUE INDEX bills_request_id_unique ON bills (request_id) WHERE request_id IS NOT NULL;

-- Runs after bills_before_insert (triggers fire in name order), so waiter_trusted_at_billing is set.
CREATE FUNCTION pos_waiter_app_bill_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_waiter waiters%ROWTYPE;
  v_open_bill_no integer;
BEGIN
  IF NEW.request_id IS NULL OR NEW.captain_device_id IS NULL THEN
    RAISE EXCEPTION 'waiter app bills need a request_id and a captain_device_id' USING ERRCODE = 'PS002';
  END IF;

  -- Serialise orders per waiter: two handsets cannot both pass the bill-on-bill check.
  SELECT * INTO v_waiter FROM waiters WHERE id = NEW.waiter_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- the FK reports the missing waiter
  END IF;

  IF NEW.waiter_trusted_at_billing IS FALSE THEN
    SELECT bill_no INTO v_open_bill_no
      FROM bills
     WHERE waiter_id = NEW.waiter_id AND status = 'OPEN' AND bill_kind = 'SALE'
     ORDER BY bill_no
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'bill-on-bill: waiter % has unpaid bill #%; settle it before a new order',
        v_waiter.waiter_code, v_open_bill_no USING ERRCODE = 'PS010';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bills_waiter_app_before_insert BEFORE INSERT ON bills
  FOR EACH ROW WHEN (NEW.source = 'WAITER_APP') EXECUTE FUNCTION pos_waiter_app_bill_guard();

-- The key and handset are identity: never edited (PS001 via the shared append-only helper).
CREATE TRIGGER bills_request_immutable BEFORE UPDATE ON bills
  FOR EACH ROW
  WHEN ((NEW.request_id, NEW.request_fingerprint, NEW.captain_device_id)
        IS DISTINCT FROM (OLD.request_id, OLD.request_fingerprint, OLD.captain_device_id))
  EXECUTE FUNCTION pos_forbid_change();
