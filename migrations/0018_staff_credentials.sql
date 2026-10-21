-- ─────────────────────────────────────────────────────────────────────────────
-- 0018 Staff credentials. Design: docs/ui/phase25-auth-polish-qa-plan.md (D2, D4)
--
--   * staff_credentials: one row per staff member who can sign in or authorise with a PIN.
--     - username + password_hash: Super Admin sign-in (ADMIN staff only).
--     - pin_hash: 4–6 digit PIN for Day Open (CASHIER, MANAGER or ADMIN).
--     Hashes are `scrypt$N$r$p$<salt b64>$<hash b64>`, written by the API (src/services/secrets.ts).
--   * Local only: deliberately NO outbox trigger, so password and PIN hashes never leave the till.
--   * Master data like staff: DELETE / TRUNCATE are refused; a credential is revoked by nulling its hash.
--   * Lockout counters (D4): 5 failures lock the password or the PIN for 5 minutes. They live here, so a
--     lock survives an API restart.
--   * staff.pin_hash (0001) was never used and is superseded by this table; it is left in place.
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON COLUMN staff.pin_hash IS 'Unused; superseded by staff_credentials.pin_hash (0018), which is not synced.';

CREATE TABLE staff_credentials (
  staff_id                  uuid        PRIMARY KEY REFERENCES staff (id),
  username                  text        CONSTRAINT staff_credentials_username_format
                                          CHECK (username ~ '^[a-z][a-z0-9._-]{2,31}$'),
  password_hash             text        CONSTRAINT staff_credentials_password_hash_format
                                          CHECK (password_hash ~ '^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$'),
  pin_hash                  text        CONSTRAINT staff_credentials_pin_hash_format
                                          CHECK (pin_hash ~ '^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$'),
  failed_password_attempts  integer     NOT NULL DEFAULT 0 CHECK (failed_password_attempts >= 0),
  password_locked_until     timestamptz,
  failed_pin_attempts       integer     NOT NULL DEFAULT 0 CHECK (failed_pin_attempts >= 0),
  pin_locked_until          timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_credentials_password_needs_username CHECK (password_hash IS NULL OR username IS NOT NULL)
);

CREATE UNIQUE INDEX staff_credentials_username_unique ON staff_credentials (username) WHERE username IS NOT NULL;

-- A password sign-in belongs to ADMIN staff only; the staff id never changes.
CREATE FUNCTION pos_staff_credentials_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_role text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.staff_id IS DISTINCT FROM OLD.staff_id THEN
    RAISE EXCEPTION 'staff_credentials.staff_id is immutable' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.password_hash IS NOT NULL THEN
    SELECT role INTO v_role FROM staff WHERE id = NEW.staff_id;
    IF v_role IS DISTINCT FROM 'ADMIN' THEN
      RAISE EXCEPTION 'only ADMIN staff can have a sign-in password' USING ERRCODE = 'PS002';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER staff_credentials_guard BEFORE INSERT OR UPDATE ON staff_credentials
  FOR EACH ROW EXECUTE FUNCTION pos_staff_credentials_guard();
CREATE TRIGGER staff_credentials_touch_updated_at BEFORE UPDATE ON staff_credentials
  FOR EACH ROW EXECUTE FUNCTION pos_touch_updated_at();
CREATE TRIGGER staff_credentials_no_delete BEFORE DELETE ON staff_credentials
  FOR EACH ROW EXECUTE FUNCTION pos_forbid_change();
CREATE TRIGGER staff_credentials_no_truncate BEFORE TRUNCATE ON staff_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION pos_forbid_change();

-- An admin who holds a password can't be demoted out from under it: clear the password first.
CREATE FUNCTION pos_staff_role_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role <> 'ADMIN' AND OLD.role = 'ADMIN'
     AND EXISTS (SELECT 1 FROM staff_credentials WHERE staff_id = NEW.id AND password_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'staff % has a sign-in password: clear it before changing the role', NEW.display_name
      USING ERRCODE = 'PS002';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER staff_role_guard BEFORE UPDATE OF role ON staff
  FOR EACH ROW EXECUTE FUNCTION pos_staff_role_guard();
