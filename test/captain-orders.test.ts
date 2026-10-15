import { describe, expect, it } from 'vitest';
import type { SqlClient } from '../src/db/client.js';
import { PgErrorCode, PosErrorCode } from '../src/db/errors.js';
import { expectSqlError, useSeededDb } from './support/db.js';
import { addItem, one, openBill, pay, settle, type BillRow } from './support/pos.js';

const FP = 'a'.repeat(64);
let keySeq = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++keySeq).padStart(12, '0')}`;

interface AppBillRow extends BillRow {
  request_id: string | null;
  request_fingerprint: string | null;
  captain_device_id: string | null;
}

function appBill(
  db: SqlClient,
  waiterId: string,
  over: { requestId?: string | null; fingerprint?: string | null; deviceId?: string | null } = {},
): Promise<AppBillRow> {
  return one<AppBillRow>(
    db,
    `INSERT INTO bills (billing_mode, status, source, waiter_id, request_id, request_fingerprint, captain_device_id)
     VALUES ('NORMAL', 'OPEN', 'WAITER_APP', $1, $2, $3, $4) RETURNING *`,
    [
      waiterId,
      over.requestId === undefined ? newKey() : over.requestId,
      over.fingerprint === undefined ? FP : over.fingerprint,
      over.deviceId === undefined ? 'handset-01' : over.deviceId,
    ],
  );
}

/** Rejects with SQLSTATE `code` raised by the named constraint. */
async function expectConstraint(promise: Promise<unknown>, code: string, constraint: string): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toMatchObject({ code, constraint });
}

describe('Captain orders schema (0004)', () => {
  const ctx = useSeededDb();

  describe('idempotency key and handset columns', () => {
    it('stores key, fingerprint and handset on app bills; counter bills carry none', async () => {
      const { db, fx } = ctx();
      const key = newKey();
      expect(await appBill(db, fx.waiter.trusted, { requestId: key })).toMatchObject({
        source: 'WAITER_APP',
        request_id: key,
        request_fingerprint: FP,
        captain_device_id: 'handset-01',
      });
      expect(await openBill(db, { waiterId: fx.waiter.trusted })).toMatchObject({
        request_id: null,
        request_fingerprint: null,
        captain_device_id: null,
      });
    });

    it('requires a key and a handset on every new app bill (PS002)', async () => {
      const { db, fx } = ctx();
      await expectSqlError(appBill(db, fx.waiter.trusted, { requestId: null, fingerprint: null }), PosErrorCode.ILLEGAL_TRANSITION, /request_id/);
      await expectSqlError(appBill(db, fx.waiter.trusted, { deviceId: null }), PosErrorCode.ILLEGAL_TRANSITION, /captain_device_id/);
    });

    it('rejects one key used for two bills (unique index)', async () => {
      const { db, fx } = ctx();
      const key = newKey();
      await appBill(db, fx.waiter.trusted, { requestId: key });
      await expectConstraint(appBill(db, fx.waiter.trusted, { requestId: key }), PgErrorCode.UNIQUE_VIOLATION, 'bills_request_id_unique');
    });

    it('enforces pairing, format and app-only CHECKs', async () => {
      const { db, fx } = ctx();
      const check = PgErrorCode.CHECK_VIOLATION;
      await expectConstraint(appBill(db, fx.waiter.trusted, { fingerprint: null }), check, 'bills_request_pairing');
      await expectConstraint(appBill(db, fx.waiter.trusted, { fingerprint: 'XYZ' }), check, 'bills_request_fingerprint');
      await expectConstraint(appBill(db, fx.waiter.trusted, { fingerprint: 'A'.repeat(64) }), check, 'bills_request_fingerprint');
      await expectConstraint(appBill(db, fx.waiter.trusted, { deviceId: 'Handset 1' }), check, 'bills_device_id_format');
      await expectConstraint(
        one(db, `INSERT INTO bills (billing_mode, status, source, request_id, request_fingerprint) VALUES ('NORMAL', 'OPEN', 'COUNTER', $1, $2) RETURNING *`, [newKey(), FP]),
        check,
        'bills_request_waiter_app',
      );
      await expectConstraint(
        one(db, `INSERT INTO bills (billing_mode, status, source, captain_device_id) VALUES ('NORMAL', 'OPEN', 'COUNTER', 'handset-01') RETURNING *`),
        check,
        'bills_device_waiter_app',
      );
    });

    it('never lets the key or handset change, while the bill can still be settled', async () => {
      const { db, fx } = ctx();
      const bill = await appBill(db, fx.waiter.trusted);
      await expectSqlError(db.query(`UPDATE bills SET request_id = $2 WHERE id = $1`, [bill.id, newKey()]), PosErrorCode.APPEND_ONLY);
      await expectSqlError(db.query(`UPDATE bills SET request_fingerprint = $2 WHERE id = $1`, [bill.id, 'b'.repeat(64)]), PosErrorCode.APPEND_ONLY);
      await expectSqlError(db.query(`UPDATE bills SET captain_device_id = 'handset-02' WHERE id = $1`, [bill.id]), PosErrorCode.APPEND_ONLY);

      await addItem(db, bill.id, fx.sku.quarter, 1);
      await pay(db, bill.id, 'CASH', 60_000);
      expect(await settle(db, bill.id)).toMatchObject({ status: 'SETTLED' });
    });
  });

  describe('bill-on-bill for untrusted waiters (PS010)', () => {
    it('blocks a second app order while the first is unpaid, naming the open bill', async () => {
      const { db, fx } = ctx();
      const first = await appBill(db, fx.waiter.untrusted);
      await expectSqlError(appBill(db, fx.waiter.untrusted), PosErrorCode.BILL_ON_BILL, new RegExp(`W02 has unpaid bill #${first.bill_no}`));
    });

    it('also counts an open counter bill tagged to the waiter', async () => {
      const { db, fx } = ctx();
      await openBill(db, { waiterId: fx.waiter.untrusted });
      await expectSqlError(appBill(db, fx.waiter.untrusted), PosErrorCode.BILL_ON_BILL);
    });

    it('allows the next order once the open bill is settled', async () => {
      const { db, fx } = ctx();
      const first = await appBill(db, fx.waiter.untrusted);
      await addItem(db, first.id, fx.sku.beer330, 1);
      await pay(db, first.id, 'UPI', 15_000);
      await settle(db, first.id);
      expect(await appBill(db, fx.waiter.untrusted)).toMatchObject({ status: 'OPEN', waiter_trusted_at_billing: false });
    });

    it('never blocks trusted waiters, and other waiters’ bills never count', async () => {
      const { db, fx } = ctx();
      await appBill(db, fx.waiter.trusted);
      await appBill(db, fx.waiter.trusted);
      await appBill(db, fx.waiter.limited);
      await openBill(db, { waiterId: fx.waiter.trusted });
      expect(await appBill(db, fx.waiter.untrusted)).toMatchObject({ status: 'OPEN' });
    });

    it('does not apply to counter tagging (Captain API only)', async () => {
      const { db, fx } = ctx();
      await appBill(db, fx.waiter.untrusted);
      expect(await openBill(db, { waiterId: fx.waiter.untrusted })).toMatchObject({ status: 'OPEN' });
    });

    it('leaves no gap in bill numbers when an order is refused', async () => {
      const { db, fx } = ctx();
      const first = await appBill(db, fx.waiter.untrusted);
      await expectSqlError(appBill(db, fx.waiter.untrusted), PosErrorCode.BILL_ON_BILL);
      await expectSqlError(appBill(db, fx.waiter.trusted, { requestId: first.request_id }), PgErrorCode.UNIQUE_VIOLATION);
      expect((await openBill(db)).bill_no).toBe(first.bill_no + 1);
    });
  });
});
