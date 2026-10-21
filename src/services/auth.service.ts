/**
 * Phase 25: Super Admin sign-in, staff PINs and the staff list (plan docs/ui/phase25-auth-polish-qa-plan.md).
 *
 * - Credentials live in `staff_credentials` (0018), which is never synced (D2).
 * - A password is for ADMIN staff only. A 4–6 digit PIN authorises Day Open for CASHIER, MANAGER or ADMIN
 *   (D5).
 * - Five failures lock the password, or that person's PIN, for five minutes (D4). The counters are
 *   committed even though the attempt fails, and the lock is judged by the database clock.
 * - Staff are never deleted: deactivate instead.
 */
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { AuthError, NotFoundError, PosError, PosErrorCode, withPosErrors } from '../db/errors.js';
import type { StaffRole, StaffSummary } from './counter-queries.js';
import { maybeOne, one } from './rows.js';
import { DEFAULT_COST, decoyHash, hashSecret, type ScryptCost, verifySecret } from './secrets.js';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 5;
export const PIN_PATTERN = /^\d{4,6}$/;
export const USERNAME_PATTERN = /^[a-z][a-z0-9._-]{2,31}$/;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_STAFF_NAME = 40;
/** Roles the Staff & PINs screen can create or switch between; ADMIN is made only by the CLI (D6). */
export const COUNTER_ROLES = ['CASHIER', 'MANAGER'] as const satisfies readonly StaffRole[];
export type CounterRole = (typeof COUNTER_ROLES)[number];

export interface StaffMember extends StaffSummary {
  isActive: boolean;
  hasPin: boolean;
  /** Sign-in name (ADMIN staff with a password only). */
  username: string | null;
  hasPassword: boolean;
  /** Seconds until a locked PIN can be tried again; null when it is not locked. */
  pinLockedForSeconds: number | null;
}

export type PinCheck = { ok: true; staff: StaffSummary } | { ok: false; error: AuthError };

export interface StaffPatch {
  displayName?: string;
  role?: CounterRole;
  isActive?: boolean;
}

interface StaffRow {
  id: string;
  display_name: string;
  role: StaffRole;
  is_active: boolean;
  username: string | null;
  has_password: boolean;
  has_pin: boolean;
  pin_locked_for: number | null;
}

const SELECT_STAFF = `
  SELECT s.id, s.display_name, s.role, s.is_active, c.username,
         c.password_hash IS NOT NULL AS has_password, c.pin_hash IS NOT NULL AS has_pin,
         CASE WHEN c.pin_locked_until > now() THEN ceil(extract(epoch FROM c.pin_locked_until - now()))::int END AS pin_locked_for
    FROM staff s
    LEFT JOIN staff_credentials c ON c.staff_id = s.id`;

function mapStaff(r: StaffRow): StaffMember {
  return {
    id: r.id,
    displayName: r.display_name,
    role: r.role,
    isActive: r.is_active,
    hasPin: r.has_pin,
    username: r.username,
    hasPassword: r.has_password,
    pinLockedForSeconds: r.pin_locked_for,
  };
}

/** Trimmed, inner runs of spaces collapsed; RangeError when blank or too long. */
export function cleanStaffName(name: string): string {
  const text = name.trim().replace(/\s+/g, ' ');
  if (text === '') throw new RangeError('a staff member needs a name');
  if (text.length > MAX_STAFF_NAME) throw new RangeError(`a staff name is at most ${MAX_STAFF_NAME} characters`);
  return text;
}

export function checkPinFormat(pin: string): void {
  if (!PIN_PATTERN.test(pin)) throw new RangeError('a PIN is 4 to 6 digits');
}

export function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new RangeError(`a password is at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > MAX_PASSWORD_LENGTH) throw new RangeError(`a password is at most ${MAX_PASSWORD_LENGTH} characters`);
}

/** Lower-cased; RangeError unless 3–32 of a–z, 0–9, `.`, `_`, `-`, starting with a letter. */
export function cleanUsername(username: string): string {
  const text = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(text)) throw new RangeError('a username is 3–32 letters, digits, ".", "_" or "-", starting with a letter');
  return text;
}

const lockedError = (seconds: number, what: string) =>
  new AuthError('LOCKED', `${what} is locked after ${MAX_FAILED_ATTEMPTS} wrong attempts — try again in ${Math.ceil(seconds / 60)} min`, {
    retryAfterSeconds: seconds,
  });

/** Records one failure; locks once the count reaches the limit. Returns attempts left (0 = now locked). */
async function recordFailure(tx: SqlClient, staffId: string, kind: 'pin' | 'password'): Promise<number> {
  const attempts = `failed_${kind}_attempts`;
  const lockedUntil = `${kind}_locked_until`;
  const row = await one<{ failed: number }>(
    tx,
    `UPDATE staff_credentials
        SET ${attempts} = CASE WHEN ${attempts} + 1 >= $2 THEN 0 ELSE ${attempts} + 1 END,
            ${lockedUntil} = CASE WHEN ${attempts} + 1 >= $2 THEN now() + make_interval(mins => $3) END
      WHERE staff_id = $1
  RETURNING CASE WHEN ${lockedUntil} IS NOT NULL THEN $2 ELSE ${attempts} END AS failed`,
    [staffId, MAX_FAILED_ATTEMPTS, LOCK_MINUTES],
  );
  return MAX_FAILED_ATTEMPTS - row.failed;
}

async function clearFailures(tx: SqlClient, staffId: string, kind: 'pin' | 'password'): Promise<void> {
  await tx.query(
    `UPDATE staff_credentials SET failed_${kind}_attempts = 0, ${kind}_locked_until = NULL
      WHERE staff_id = $1 AND (failed_${kind}_attempts <> 0 OR ${kind}_locked_until IS NOT NULL)`,
    [staffId],
  );
}

/**
 * Checks `pin` for `staffId` inside the caller's transaction (it locks the credential row). It never
 * throws for a wrong PIN; the caller commits the failure count, then throws `error` (D5: Day Open
 * verifies the PIN and opens the day in one transaction).
 */
export async function checkPin(tx: SqlClient, staffId: string, pin: string): Promise<PinCheck> {
  checkPinFormat(pin);
  const staff = await maybeOne<{ id: string; display_name: string; role: StaffRole; is_active: boolean }>(
    tx,
    `SELECT id, display_name, role, is_active FROM staff WHERE id = $1`,
    [staffId],
  );
  if (!staff) throw new NotFoundError('staff', staffId);
  const credential = await maybeOne<{ pin_hash: string | null; locked_for: number | null }>(
    tx,
    `SELECT pin_hash, CASE WHEN pin_locked_until > now() THEN ceil(extract(epoch FROM pin_locked_until - now()))::int END AS locked_for
       FROM staff_credentials WHERE staff_id = $1 FOR UPDATE`,
    [staffId],
  );
  const row = { ...staff, pin_hash: credential?.pin_hash ?? null, locked_for: credential?.locked_for ?? null };
  if (!row.is_active || row.pin_hash === null) {
    return { ok: false, error: new AuthError('INVALID_PIN', `${row.display_name} has no active PIN — set one in Settings → Staff & PINs`) };
  }
  if (row.locked_for !== null) return { ok: false, error: lockedError(row.locked_for, `${row.display_name}'s PIN`) };

  if (await verifySecret(pin, row.pin_hash)) {
    await clearFailures(tx, staffId, 'pin');
    return { ok: true, staff: { id: row.id, displayName: row.display_name, role: row.role } };
  }
  const left = await recordFailure(tx, staffId, 'pin');
  if (left === 0) return { ok: false, error: lockedError(LOCK_MINUTES * 60, `${row.display_name}'s PIN`) };
  return { ok: false, error: new AuthError('INVALID_PIN', `Wrong PIN — ${left} attempt${left === 1 ? '' : 's'} left`, { attemptsLeft: left }) };
}

export class AuthService {
  constructor(
    private readonly db: SqlDatabase,
    /** Cost for newly written hashes (tests pass a cheap one). */
    private readonly cost: ScryptCost = DEFAULT_COST,
  ) {}

  /** True once an active ADMIN has a sign-in password (else the API logs a setup hint). */
  async adminConfigured(): Promise<boolean> {
    const row = await maybeOne(
      this.db,
      `SELECT 1 FROM staff_credentials c JOIN staff s ON s.id = c.staff_id
        WHERE c.password_hash IS NOT NULL AND s.is_active AND s.role = 'ADMIN' LIMIT 1`,
    );
    return row !== undefined;
  }

  /** Super Admin sign-in. Unknown user, wrong password, inactive staff → the same INVALID_CREDENTIALS. */
  async login(username: string, password: string): Promise<StaffSummary> {
    const invalid = () => new AuthError('INVALID_CREDENTIALS', 'Wrong username or password');
    const name = username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(name) || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      await verifySecret(password.slice(0, MAX_PASSWORD_LENGTH), await decoyHash());
      throw invalid();
    }
    const result = await this.db.transaction(async (tx): Promise<StaffSummary | AuthError> => {
      const row = await maybeOne<{ id: string; display_name: string; role: StaffRole; is_active: boolean; password_hash: string | null; locked_for: number | null }>(
        tx,
        `SELECT s.id, s.display_name, s.role, s.is_active, c.password_hash,
                CASE WHEN c.password_locked_until > now() THEN ceil(extract(epoch FROM c.password_locked_until - now()))::int END AS locked_for
           FROM staff_credentials c
           JOIN staff s ON s.id = c.staff_id
          WHERE c.username = $1
            FOR UPDATE OF c`,
        [name],
      );
      if (!row || row.password_hash === null) {
        await verifySecret(password, await decoyHash());
        return invalid();
      }
      if (row.locked_for !== null) return lockedError(row.locked_for, 'This account');
      const match = await verifySecret(password, row.password_hash);
      if (match && row.is_active && row.role === 'ADMIN') {
        await clearFailures(tx, row.id, 'password');
        return { id: row.id, displayName: row.display_name, role: row.role };
      }
      const left = await recordFailure(tx, row.id, 'password');
      return left === 0 ? lockedError(LOCK_MINUTES * 60, 'This account') : invalid();
    });
    if (result instanceof AuthError) throw result;
    return result;
  }

  /**
   * CLI (D6): sets the password of the ADMIN signing in as `username`, creating that admin (named
   * `displayName`, default "Super Admin") when no one has the username yet. Clears any lockout.
   */
  async setAdminPassword(username: string, password: string, displayName = 'Super Admin'): Promise<StaffSummary> {
    const name = cleanUsername(username);
    checkPassword(password);
    const hash = await hashSecret(password, this.cost);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const existing = await maybeOne<{ staff_id: string }>(tx, `SELECT staff_id FROM staff_credentials WHERE username = $1 FOR UPDATE`, [name]);
        const staffId =
          existing?.staff_id ??
          (await one<{ id: string }>(tx, `INSERT INTO staff (display_name, role) VALUES ($1, 'ADMIN') RETURNING id`, [cleanStaffName(displayName)])).id;
        const staff = await one<{ id: string; display_name: string; role: StaffRole; is_active: boolean }>(
          tx,
          `SELECT id, display_name, role, is_active FROM staff WHERE id = $1`,
          [staffId],
        );
        if (staff.role !== 'ADMIN') throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `${staff.display_name} is not an ADMIN`);
        if (!staff.is_active) await tx.query(`UPDATE staff SET is_active = true WHERE id = $1`, [staffId]);
        await tx.query(
          `INSERT INTO staff_credentials (staff_id, username, password_hash) VALUES ($1, $2, $3)
           ON CONFLICT (staff_id) DO UPDATE
             SET username = EXCLUDED.username, password_hash = EXCLUDED.password_hash,
                 failed_password_attempts = 0, password_locked_until = NULL`,
          [staffId, name, hash],
        );
        return { id: staff.id, displayName: staff.display_name, role: staff.role };
      }),
    );
  }

  /** Sets (or, with null, clears) a staff member's PIN, and clears any PIN lockout. */
  async setPin(staffId: string, pin: string | null): Promise<StaffMember> {
    if (pin !== null) checkPinFormat(pin);
    const hash = pin === null ? null : await hashSecret(pin, this.cost);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const staff = await maybeOne<{ is_active: boolean; display_name: string }>(tx, `SELECT is_active, display_name FROM staff WHERE id = $1 FOR UPDATE`, [staffId]);
        if (!staff) throw new NotFoundError('staff', staffId);
        if (hash !== null && !staff.is_active) throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `${staff.display_name} is inactive`);
        await tx.query(
          `INSERT INTO staff_credentials (staff_id, pin_hash) VALUES ($1, $2)
           ON CONFLICT (staff_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, failed_pin_attempts = 0, pin_locked_until = NULL`,
          [staffId, hash],
        );
        return this.getStaff(staffId, tx);
      }),
    );
  }

  /** Everyone, active first, in the order they were added. */
  async listStaff(): Promise<StaffMember[]> {
    const { rows } = await this.db.query<StaffRow>(`${SELECT_STAFF} ORDER BY s.is_active DESC, s.created_at, s.id`);
    return rows.map(mapStaff);
  }

  /** Who can authorise Day Open: active staff with a PIN (D5). Names and roles only. */
  async pinHolders(): Promise<StaffSummary[]> {
    const { rows } = await this.db.query<{ id: string; display_name: string; role: StaffRole }>(
      `SELECT s.id, s.display_name, s.role
         FROM staff s JOIN staff_credentials c ON c.staff_id = s.id
        WHERE s.is_active AND c.pin_hash IS NOT NULL
        ORDER BY CASE s.role WHEN 'CASHIER' THEN 0 WHEN 'MANAGER' THEN 1 ELSE 2 END, s.display_name`,
    );
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, role: r.role }));
  }

  async getStaff(staffId: string, db: SqlClient = this.db): Promise<StaffMember> {
    const row = await maybeOne<StaffRow>(db, `${SELECT_STAFF} WHERE s.id = $1`, [staffId]);
    if (!row) throw new NotFoundError('staff', staffId);
    return mapStaff(row);
  }

  /** A cashier or manager (admins come from the CLI). Names are unique, ignoring case. */
  async createStaff(input: { displayName: string; role: CounterRole; pin?: string | null }): Promise<StaffMember> {
    const name = cleanStaffName(input.displayName);
    if (!(COUNTER_ROLES as readonly string[]).includes(input.role)) throw new RangeError('role must be CASHIER or MANAGER');
    if (input.pin != null) checkPinFormat(input.pin);
    const hash = input.pin == null ? null : await hashSecret(input.pin, this.cost);
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await this.assertNameFree(tx, name);
        const { id } = await one<{ id: string }>(tx, `INSERT INTO staff (display_name, role) VALUES ($1, $2) RETURNING id`, [name, input.role]);
        if (hash !== null) await tx.query(`INSERT INTO staff_credentials (staff_id, pin_hash) VALUES ($1, $2)`, [id, hash]);
        return this.getStaff(id, tx);
      }),
    );
  }

  /**
   * Rename, switch CASHIER ⇄ MANAGER, or (de)activate. `actingStaffId` (the signed-in admin) can't
   * deactivate themselves, and the last active admin with a password can't be deactivated.
   */
  async updateStaff(staffId: string, patch: StaffPatch, actingStaffId: string): Promise<StaffMember> {
    const name = patch.displayName === undefined ? undefined : cleanStaffName(patch.displayName);
    if (patch.role !== undefined && !(COUNTER_ROLES as readonly string[]).includes(patch.role)) throw new RangeError('role must be CASHIER or MANAGER');
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const current = await maybeOne<{ role: StaffRole; is_active: boolean; display_name: string }>(
          tx,
          `SELECT role, is_active, display_name FROM staff WHERE id = $1 FOR UPDATE`,
          [staffId],
        );
        if (!current) throw new NotFoundError('staff', staffId);
        if (patch.role !== undefined && patch.role !== current.role && current.role === 'ADMIN') {
          throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, 'an admin’s role is managed with the staff CLI');
        }
        if (patch.isActive === false && current.is_active) {
          if (staffId === actingStaffId) throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, 'you can’t deactivate the account you are signed in with');
          if (current.role === 'ADMIN') {
            const others = await one<{ n: number }>(
              tx,
              `SELECT count(*)::int AS n FROM staff s JOIN staff_credentials c ON c.staff_id = s.id
                WHERE s.role = 'ADMIN' AND s.is_active AND c.password_hash IS NOT NULL AND s.id <> $1`,
              [staffId],
            );
            if (others.n === 0) throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, 'the last admin who can sign in can’t be deactivated');
          }
        }
        if (name !== undefined && name.toLowerCase() !== current.display_name.toLowerCase()) await this.assertNameFree(tx, name, staffId);
        await tx.query(
          `UPDATE staff SET display_name = coalesce($2, display_name), role = coalesce($3, role), is_active = coalesce($4, is_active)
            WHERE id = $1`,
          [staffId, name ?? null, patch.role ?? null, patch.isActive ?? null],
        );
        return this.getStaff(staffId, tx);
      }),
    );
  }

  /** Staff matching `name` (case-insensitive), for the CLI. */
  async findStaffByName(name: string): Promise<StaffMember[]> {
    const { rows } = await this.db.query<StaffRow>(`${SELECT_STAFF} WHERE lower(s.display_name) = lower($1) ORDER BY s.created_at`, [name.trim()]);
    return rows.map(mapStaff);
  }

  private async assertNameFree(tx: SqlClient, name: string, exceptId?: string): Promise<void> {
    const clash = await maybeOne(tx, `SELECT 1 FROM staff WHERE lower(display_name) = lower($1) AND id IS DISTINCT FROM $2`, [name, exceptId ?? null]);
    if (clash) throw new PosError(PosErrorCode.DUPLICATE_CATALOG_ENTRY, `a staff member named ${name} already exists`);
  }
}
