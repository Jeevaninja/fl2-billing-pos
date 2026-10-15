import { randomUUID } from 'node:crypto';
import type { PGliteInterface } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../../src/db/client.js';
import { IdempotencyConflictError, PosErrorCode } from '../../src/db/errors.js';
import { CaptainService, formatKot, type KotPrinter, type OrderRequest, orderFingerprint } from '../../src/services/index.js';
import { useSeededDb } from '../support/db.js';
import { one } from '../support/pos.js';
import { expectPosError } from '../support/services.js';

const printer: KotPrinter = { printKOT: async (t) => ({ station: t.station, printedAt: new Date(), text: formatKot(t) }) };

/**
 * Simulates a retry racing an in-flight original: the up-front key lookup sees nothing (the original
 * had not committed yet), so the attempt reaches the INSERT and collides with the committed bill.
 */
function hideFirstKeyLookup(db: PGliteInterface): SqlDatabase {
  let hidden = false;
  return {
    query: <T,>(sql: string, params?: unknown[]) => {
      if (!hidden && sql.includes('WHERE request_id = $1')) {
        hidden = true;
        return Promise.resolve({ rows: [] as T[] });
      }
      return db.query<T>(sql, params);
    },
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
  };
}

describe('CaptainService.placeOrder idempotency', () => {
  const ctx = useSeededDb();
  const request = (over: Partial<OrderRequest> = {}): OrderRequest => {
    const { fx } = ctx();
    return { requestId: randomUUID(), deviceId: 'handset-01', waiterId: fx.waiter.trusted, items: [{ skuId: fx.sku.half, quantity: 1 }], ...over };
  };
  const bills = async () => (await one<{ n: number }>(ctx().db, `SELECT count(*)::int AS n FROM bills`)).n;

  describe('retry racing the original (collision recovery)', () => {
    it('replays when the insert hits the unique key (trusted waiter)', async () => {
      const { db } = ctx();
      const order = request();
      const original = await new CaptainService(db, printer).placeOrder(order);
      const count = await bills();

      const retry = await new CaptainService(hideFirstKeyLookup(db), printer).placeOrder(order);
      expect(retry).toMatchObject({ replayed: true, kot: null, bill: { id: original.bill.id } });
      expect(await bills()).toBe(count);
    });

    it('replays when the insert hits bill-on-bill (untrusted waiter: its own order is the open bill)', async () => {
      const { db, fx } = ctx();
      const order = request({ waiterId: fx.waiter.untrusted });
      const original = await new CaptainService(db, printer).placeOrder(order);

      const retry = await new CaptainService(hideFirstKeyLookup(db), printer).placeOrder(order);
      expect(retry).toMatchObject({ replayed: true, bill: { id: original.bill.id } });
    });

    it('still reports a conflict when the colliding key belongs to a different order', async () => {
      const { db, fx } = ctx();
      const order = request();
      await new CaptainService(db, printer).placeOrder(order);
      await expect(
        new CaptainService(hideFirstKeyLookup(db), printer).placeOrder({ ...order, items: [{ skuId: fx.sku.full, quantity: 1 }] }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('surfaces a genuine bill-on-bill refusal (different key) as PS010', async () => {
      const { db, fx } = ctx();
      const service = new CaptainService(db, printer);
      await service.placeOrder(request({ waiterId: fx.waiter.untrusted }));
      await expectPosError(service.placeOrder(request({ waiterId: fx.waiter.untrusted })), PosErrorCode.BILL_ON_BILL);
    });
  });
});

describe('orderFingerprint', () => {
  const base = {
    deviceId: 'handset-01',
    waiterId: 'AAAAAAAA-0000-4000-8000-000000000001',
    items: [
      { skuId: 'BBBBBBBB-0000-4000-8000-000000000001', quantity: 2 },
      { skuId: 'BBBBBBBB-0000-4000-8000-000000000002', quantity: 1 },
    ],
  };

  it('is 64 hex characters and ignores UUID letter case', () => {
    const fp = orderFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(
      orderFingerprint({
        ...base,
        waiterId: base.waiterId.toLowerCase(),
        items: base.items.map((i) => ({ ...i, skuId: i.skuId.toLowerCase() })),
      }),
    ).toBe(fp);
  });

  it('changes with the handset, waiter, member, quantities or line order', () => {
    const fp = orderFingerprint(base);
    const variants = [
      { ...base, deviceId: 'handset-02' },
      { ...base, waiterId: 'AAAAAAAA-0000-4000-8000-000000000002' },
      { ...base, memberId: 'CCCCCCCC-0000-4000-8000-000000000001' },
      { ...base, items: [{ ...base.items[0]!, quantity: 3 }, base.items[1]!] },
      { ...base, items: [...base.items].reverse() },
    ];
    for (const v of variants) expect(orderFingerprint(v)).not.toBe(fp);
  });
});
