import { describe, expect, it } from 'vitest';
import { AuthError, PosErrorCode } from '../../src/db/errors.js';
import { AuthService, DayEndService, hashSecret, LOCK_MINUTES, MAX_FAILED_ATTEMPTS, verifySecret } from '../../src/services/index.js';
import { expectSqlError, useSeededDb } from '../support/db.js';
import { one } from '../support/pos.js';
import { expectPosError } from '../support/services.js';

/** Cheap scrypt cost so the suite stays fast; verification reads the cost back from the hash. */
const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';

async function rejection(promise: Promise<unknown>): Promise<AuthError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AuthError);
  return err as AuthError;
}

describe('secrets (scrypt)', () => {
  it('hashes with a fresh salt each time and verifies only the right secret', async () => {
    const a = await hashSecret('1234', CHEAP);
    const b = await hashSecret('1234', CHEAP);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(await verifySecret('1234', a)).toBe(true);
    expect(await verifySecret('1235', a)).toBe(false);
  });

  it('never matches a malformed or out-of-bounds stored hash', async () => {
    const good = await hashSecret('1234', CHEAP);
    expect(await verifySecret('1234', 'plain-text')).toBe(false);
    expect(await verifySecret('1234', good.replace('$1024$', '$1000$'))).toBe(false); // N not a power of two
    expect(await verifySecret('1234', good.replace('$1024$', `$${2 ** 22}$`))).toBe(false); // N too large
  });
});

describe('AuthService (Phase 25)', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, auth: new AuthService(db, CHEAP), dayEnd: new DayEndService(db) };
  };
  const expireLocks = (db: ReturnType<typeof ctx>['db']) =>
    db.query(`UPDATE staff_credentials SET pin_locked_until = now() - interval '1 second', password_locked_until = now() - interval '1 second'
               WHERE pin_locked_until IS NOT NULL OR password_locked_until IS NOT NULL`);

  describe('Super Admin sign-in', () => {
    it('creates the admin from the CLI path and signs in, case-insensitively on the username', async () => {
      const { auth } = setup();
      expect(await auth.adminConfigured()).toBe(false);
      const admin = await auth.setAdminPassword('Owner', PASSWORD);
      expect(admin).toMatchObject({ displayName: 'Super Admin', role: 'ADMIN' });
      expect(await auth.adminConfigured()).toBe(true);
      expect(await auth.login(' OWNER ', PASSWORD)).toEqual(admin);
    });

    it('gives the same answer for an unknown user and a wrong password', async () => {
      const { auth } = setup();
      await auth.setAdminPassword('owner', PASSWORD);
      const unknown = await rejection(auth.login('nobody', PASSWORD));
      const wrong = await rejection(auth.login('owner', 'wrong password!'));
      expect([unknown.code, unknown.message]).toEqual(['INVALID_CREDENTIALS', 'Wrong username or password']);
      expect([wrong.code, wrong.message]).toEqual([unknown.code, unknown.message]);
    });

    it(`locks the account after ${MAX_FAILED_ATTEMPTS} wrong passwords, even for the right one, until the lock expires`, async () => {
      const { db, auth } = setup();
      await auth.setAdminPassword('owner', PASSWORD);
      for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) expect((await rejection(auth.login('owner', `wrong ${i} attempt`))).code).toBe('INVALID_CREDENTIALS');
      const locked = await rejection(auth.login('owner', 'wrong final attempt'));
      expect(locked.code).toBe('LOCKED');
      expect(locked.details.retryAfterSeconds).toBe(LOCK_MINUTES * 60);
      expect((await rejection(auth.login('owner', PASSWORD))).code).toBe('LOCKED');

      await expireLocks(db);
      expect(await auth.login('owner', PASSWORD)).toMatchObject({ role: 'ADMIN' });
      expect(await one(db, `SELECT failed_password_attempts AS n FROM staff_credentials WHERE username = 'owner'`)).toEqual({ n: 0 });
    });

    it('re-running set-admin resets the password and clears the lock', async () => {
      const { auth } = setup();
      await auth.setAdminPassword('owner', PASSWORD);
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await rejection(auth.login('owner', `wrong ${i} attempt`));
      await auth.setAdminPassword('owner', 'a brand new password');
      expect(await auth.login('owner', 'a brand new password')).toMatchObject({ role: 'ADMIN' });
      await rejection(auth.login('owner', PASSWORD));
    });

    it('refuses a deactivated admin, and checks password and username rules', async () => {
      const { db, auth } = setup();
      const admin = await auth.setAdminPassword('owner', PASSWORD);
      await db.query(`UPDATE staff SET is_active = false WHERE id = $1`, [admin.id]);
      expect((await rejection(auth.login('owner', PASSWORD))).code).toBe('INVALID_CREDENTIALS');
      await expect(auth.setAdminPassword('owner', 'short')).rejects.toBeInstanceOf(RangeError);
      await expect(auth.setAdminPassword('1owner', PASSWORD)).rejects.toBeInstanceOf(RangeError);
    });

    it('allows a password on ADMIN staff only, and never syncs credentials', async () => {
      const { db, fx, auth } = setup();
      const hash = await hashSecret(PASSWORD, CHEAP);
      await expectSqlError(
        db.query(`INSERT INTO staff_credentials (staff_id, username, password_hash) VALUES ($1, 'cashier', $2)`, [fx.cashier, hash]),
        PosErrorCode.ILLEGAL_TRANSITION,
      );
      const admin = await auth.setAdminPassword('owner', PASSWORD);
      await auth.setPin(admin.id, '9876');
      expect(await one(db, `SELECT count(*)::int AS n FROM sync_outbox WHERE aggregate_type = 'staff_credentials' OR payload::text LIKE '%scrypt$%'`)).toEqual({ n: 0 });
      await expectSqlError(db.query(`DELETE FROM staff_credentials`), PosErrorCode.APPEND_ONLY);
      await expectSqlError(db.query(`UPDATE staff SET role = 'MANAGER' WHERE id = $1`, [admin.id]), PosErrorCode.ILLEGAL_TRANSITION);
    });
  });

  describe('Day Open PIN', () => {
    async function closeDay() {
      const { db, fx, dayEnd } = setup();
      await dayEnd.closeBusinessDay(fx.dayId, 0n, fx.manager);
      return { db, fx, dayEnd };
    }

    it('opens the day as the PIN holder, in one step', async () => {
      const { auth } = setup();
      const { db, fx, dayEnd } = await closeDay();
      await auth.setPin(fx.manager, '2468');
      const day = await dayEnd.openBusinessDayWithPin(50_000n, fx.manager, '2468', '2026-10-15');
      expect(day).toMatchObject({ businessDate: '2026-10-15', status: 'OPEN', openingFloatPaise: 50_000n });
      expect(await one(db, `SELECT opened_by_staff_id AS who FROM business_days WHERE id = $1`, [day.id])).toEqual({ who: fx.manager });
    });

    it('a wrong PIN opens nothing, counts down, then locks for five minutes', async () => {
      const { auth } = setup();
      const { db, fx, dayEnd } = await closeDay();
      await auth.setPin(fx.cashier, '1357');
      const first = await rejection(dayEnd.openBusinessDayWithPin(0n, fx.cashier, '0000', '2026-10-15'));
      expect(first).toMatchObject({ code: 'INVALID_PIN', message: 'Wrong PIN — 4 attempts left', details: { attemptsLeft: 4 } });
      for (let i = 0; i < MAX_FAILED_ATTEMPTS - 2; i++) await rejection(dayEnd.openBusinessDayWithPin(0n, fx.cashier, '0000', '2026-10-15'));
      const locked = await rejection(dayEnd.openBusinessDayWithPin(0n, fx.cashier, '0000', '2026-10-15'));
      expect(locked).toMatchObject({ code: 'LOCKED', details: { retryAfterSeconds: LOCK_MINUTES * 60 } });
      expect((await rejection(dayEnd.openBusinessDayWithPin(0n, fx.cashier, '1357', '2026-10-15'))).code).toBe('LOCKED');
      expect((await auth.getStaff(fx.cashier)).pinLockedForSeconds).toBeGreaterThan(0);
      expect(await one(db, `SELECT count(*)::int AS n FROM business_days WHERE status = 'OPEN'`)).toEqual({ n: 0 });

      await expireLocks(db);
      expect((await dayEnd.openBusinessDayWithPin(0n, fx.cashier, '1357', '2026-10-15')).status).toBe('OPEN');
    });

    it('a manager resetting the PIN clears the lock', async () => {
      const { auth } = setup();
      const { fx, dayEnd } = await closeDay();
      await auth.setPin(fx.cashier, '1357');
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await rejection(dayEnd.openBusinessDayWithPin(0n, fx.cashier, '0000'));
      await auth.setPin(fx.cashier, '8642');
      expect((await auth.getStaff(fx.cashier)).pinLockedForSeconds).toBeNull();
      expect((await dayEnd.openBusinessDayWithPin(0n, fx.cashier, '8642', '2026-10-15')).status).toBe('OPEN');
    });

    it('spends no attempt while a day is still open, and refuses staff without a PIN', async () => {
      const { db, fx, auth, dayEnd } = setup();
      await auth.setPin(fx.cashier, '1357');
      await expectPosError(dayEnd.openBusinessDayWithPin(0n, fx.cashier, '0000'), PosErrorCode.DAY_OR_PEAK_RULE, /already open/);
      expect(await one(db, `SELECT failed_pin_attempts AS n FROM staff_credentials WHERE staff_id = $1`, [fx.cashier])).toEqual({ n: 0 });

      await dayEnd.closeBusinessDay(fx.dayId, 0n, fx.manager);
      expect((await rejection(dayEnd.openBusinessDayWithPin(0n, fx.manager, '1357'))).message).toMatch(/has no active PIN/);
      await expect(dayEnd.openBusinessDayWithPin(0n, fx.cashier, '12ab')).rejects.toBeInstanceOf(RangeError);
    });

    it('a deactivated staff member’s PIN no longer works', async () => {
      const { auth } = setup();
      const { fx, dayEnd } = await closeDay();
      const admin = await auth.setAdminPassword('owner', PASSWORD);
      await auth.setPin(fx.cashier, '1357');
      await auth.updateStaff(fx.cashier, { isActive: false }, admin.id);
      expect((await rejection(dayEnd.openBusinessDayWithPin(0n, fx.cashier, '1357'))).code).toBe('INVALID_PIN');
      expect((await auth.pinHolders()).map((s) => s.id)).not.toContain(fx.cashier);
    });
  });

  describe('Staff & PINs', () => {
    it('lists staff with PIN and sign-in status, and PIN holders cashier-first', async () => {
      const { fx, auth } = setup();
      const admin = await auth.setAdminPassword('owner', PASSWORD);
      await auth.setPin(fx.manager, '2468');
      await auth.setPin(fx.cashier, '1357');
      const list = await auth.listStaff();
      expect(list.map((s) => [s.displayName, s.role, s.hasPin, s.hasPassword, s.username])).toEqual([
        ['Counter 1', 'CASHIER', true, false, null],
        ['Manager', 'MANAGER', true, false, null],
        ['Super Admin', 'ADMIN', false, true, 'owner'],
      ]);
      expect((await auth.pinHolders()).map((s) => s.displayName)).toEqual(['Counter 1', 'Manager']);
      await auth.setPin(fx.manager, null);
      expect((await auth.pinHolders()).map((s) => s.displayName)).toEqual(['Counter 1']);
      expect(admin.id).toBeTruthy();
    });

    it('creates and edits cashiers and managers, with unique names', async () => {
      const { auth } = setup();
      const admin = await auth.setAdminPassword('owner', PASSWORD);
      const ravi = await auth.createStaff({ displayName: '  Ravi   K ', role: 'CASHIER', pin: '4321' });
      expect(ravi).toMatchObject({ displayName: 'Ravi K', role: 'CASHIER', hasPin: true, isActive: true });
      await expectPosError(auth.createStaff({ displayName: 'ravi k', role: 'MANAGER' }), PosErrorCode.DUPLICATE_CATALOG_ENTRY);
      await expect(auth.createStaff({ displayName: 'Boss', role: 'ADMIN' as 'MANAGER' })).rejects.toBeInstanceOf(RangeError);
      expect(await auth.updateStaff(ravi.id, { role: 'MANAGER', displayName: 'Ravi Kumar' }, admin.id)).toMatchObject({ role: 'MANAGER', displayName: 'Ravi Kumar' });
      expect(await auth.updateStaff(ravi.id, { isActive: false }, admin.id)).toMatchObject({ isActive: false });
      await expectPosError(auth.setPin(ravi.id, '1111'), PosErrorCode.ILLEGAL_TRANSITION, /inactive/);
    });

    it('protects the signed-in admin and the last admin', async () => {
      const { auth } = setup();
      const admin = await auth.setAdminPassword('owner', PASSWORD);
      const other = await auth.createStaff({ displayName: 'Ravi', role: 'CASHIER' });
      await expectPosError(auth.updateStaff(admin.id, { isActive: false }, admin.id), PosErrorCode.ILLEGAL_TRANSITION, /signed in with/);
      await expectPosError(auth.updateStaff(admin.id, { isActive: false }, other.id), PosErrorCode.ILLEGAL_TRANSITION, /last admin/);
      await expectPosError(auth.updateStaff(admin.id, { role: 'CASHIER' }, other.id), PosErrorCode.ILLEGAL_TRANSITION, /CLI/);
      const second = await auth.setAdminPassword('deputy', PASSWORD, 'Deputy');
      expect(await auth.updateStaff(admin.id, { isActive: false }, second.id)).toMatchObject({ isActive: false });
    });
  });
});
