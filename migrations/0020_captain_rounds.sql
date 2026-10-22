-- ─────────────────────────────────────────────────────────────────────────────
-- 0020 Captain rounds and settle requests. Design: docs/ui/phase27-waiter-order-flow-plan.md
--
--   * captain_order_rounds (D4): a Captain handset adding items to a bill that is already open. Each
--     round carries its own client-generated key, so a retry replays the round instead of adding the
--     items twice. The first order of a bill keeps its key on bills.request_id (0004).
--     first_line_no / line_count are the bill lines the round inserted, for the replay.
--   * bill_settle_requests (D5): "please settle this bill", raised from a handset. A flag only; it
--     moves no money, and the counter settles through the existing flows. One per bill: a repeat
--     returns the first.
--
-- Both are append-only (PS001) and go to the sync outbox. A row must name an OPEN sale bill tagged
-- to the same waiter (PS002 / PS001), so the service checks are also enforced here.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE captain_order_rounds (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  request_id          uuid        NOT NULL CONSTRAINT captain_order_rounds_request_unique UNIQUE,
  request_fingerprint text        NOT NULL CONSTRAINT captain_order_rounds_fingerprint CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  bill_id             uuid        NOT NULL REFERENCES bills (id),
  waiter_id           uuid        NOT NULL REFERENCES waiters (id),
  captain_device_id   text        NOT NULL CONSTRAINT captain_order_rounds_device_id_format CHECK (captain_device_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  first_line_no       integer     NOT NULL CONSTRAINT captain_order_rounds_first_line_positive CHECK (first_line_no >= 1),
  line_count          integer     NOT NULL CONSTRAINT captain_order_rounds_line_count_range CHECK (line_count BETWEEN 1 AND 50),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX captain_order_rounds_bill ON captain_order_rounds (bill_id);

CREATE TABLE bill_settle_requests (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  bill_id           uuid        NOT NULL REFERENCES bills (id) CONSTRAINT bill_settle_requests_bill_unique UNIQUE,
  waiter_id         uuid        NOT NULL REFERENCES waiters (id),
  captain_device_id text        NOT NULL CONSTRAINT bill_settle_requests_device_id_format CHECK (captain_device_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  requested_at      timestamptz NOT NULL DEFAULT now()
);

-- The bill must be an OPEN sale bill tagged to the row's waiter.
CREATE FUNCTION pos_captain_bill_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_bill bills%ROWTYPE;
BEGIN
  SELECT * INTO v_bill FROM bills WHERE id = NEW.bill_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the FK reports the missing bill
  END IF;
  IF v_bill.bill_kind <> 'SALE' THEN
    RAISE EXCEPTION 'bill % is a reversal bill', v_bill.bill_no USING ERRCODE = 'PS002';
  END IF;
  IF v_bill.waiter_id IS DISTINCT FROM NEW.waiter_id THEN
    RAISE EXCEPTION 'bill % is not tagged to this waiter', v_bill.bill_no USING ERRCODE = 'PS002';
  END IF;
  IF v_bill.status <> 'OPEN' THEN
    RAISE EXCEPTION 'bill % is % and frozen', v_bill.bill_no, v_bill.status USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['captain_order_rounds', 'bill_settle_requests'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION pos_captain_bill_guard()', t || '_before_insert', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pos_forbid_change()', t || '_no_update', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pos_forbid_change()', t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION pos_forbid_change()',
                   t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pos_outbox_capture()', t || '_outbox', t);
  END LOOP;
END $$;
