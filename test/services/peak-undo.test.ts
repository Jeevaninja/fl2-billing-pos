import { describe, expect, it } from 'vitest';
import { NotFoundError, PosErrorCode } from '../../src/db/errors.js';
import { useSeededDb } from '../support/db.js';
import { one } from '../support/pos.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

/** Phase 12: Ctrl+Z in peak — the server finds this till's newest scan. */
describe('BillingService.undoLastPeakSale', () => {
  const ctx = useSeededDb();
  const setup = () => {
    const { db, fx } = ctx();
    return { db, fx, ...makeServices(db) };
  };
  const onHand = async (db: ReturnType<typeof ctx>['db'], skuId: string) =>
    (await one<{ on_hand_qty: number }>(db, `SELECT on_hand_qty FROM sku_stock WHERE sku_id = $1`, [skuId])).on_hand_qty;
  const runningExpected = async (db: ReturnType<typeof ctx>['db'], sessionId: string) =>
    BigInt((await one<{ e: string }>(db, `SELECT running_expected_paise::text AS e FROM v_peak_sessions WHERE id = $1`, [sessionId])).e);

  it("voids this cashier's newest scan, restocks it and lowers the expected figure; repeats walk back", async () => {
    const { db, fx, billing, peak } = setup();
    const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    const first = await billing.recordPeakSale(session.id, fx.sku.quarter, 1, fx.cashier);
    const second = await billing.recordPeakSale(session.id, fx.sku.beer650, 2, fx.cashier);
    await billing.recordPeakSale(session.id, fx.sku.full, 1, fx.manager); // another till's scan, newer
    const beerBefore = await onHand(db, fx.sku.beer650);
    expect(await runningExpected(db, session.id)).toBe(PAISE.quarter + 2n * PAISE.beer650 + PAISE.full);

    const undo = await billing.undoLastPeakSale(fx.cashier);
    expect(undo.undone).toEqual({
      billId: second.bill.id,
      billNo: second.bill.billNo,
      sessionNo: 1,
      displayName: second.item.displayName,
      sizeCode: 'BEER_650',
      quantity: 2,
      totalPaise: 2n * PAISE.beer650,
    });
    expect(undo.reversal).toMatchObject({ kind: 'REVERSAL', mode: 'PEAK', status: 'PEAK_UNSETTLED', reversesBillId: second.bill.id, totalPaise: -2n * PAISE.beer650 });
    expect(await onHand(db, fx.sku.beer650)).toBe(beerBefore + 2);
    expect(await runningExpected(db, session.id)).toBe(PAISE.quarter + PAISE.full);

    // The next undo skips the voided scan and the other till's scan.
    expect((await billing.undoLastPeakSale(fx.cashier)).undone.billId).toBe(first.bill.id);
    await expect(billing.undoLastPeakSale(fx.cashier)).rejects.toBeInstanceOf(NotFoundError);
    expect(await runningExpected(db, session.id)).toBe(PAISE.full);

    // The other till still undoes its own scan.
    expect((await billing.undoLastPeakSale(fx.manager)).undone).toMatchObject({ sizeCode: 'FULL', quantity: 1 });
  });

  it('is refused with no running session, and never reaches into an ended one', async () => {
    const { fx, billing, peak } = setup();
    await expectPosError(billing.undoLastPeakSale(fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /no peak session is running/);

    const s1 = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    await billing.recordPeakSale(s1.id, fx.sku.quarter, 1, fx.cashier);
    await peak.endPeakSession(s1.id, PAISE.quarter, 0n, fx.cashier);
    await expectPosError(billing.undoLastPeakSale(fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE);

    await peak.startPeakSession(fx.dayId, PAISE.quarter, 0n, fx.cashier);
    await expect(billing.undoLastPeakSale(fx.cashier)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('two undos at once void two different scans, never the same one twice', async () => {
    const { fx, billing, peak } = setup();
    const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    const a = await billing.recordPeakSale(session.id, fx.sku.quarter, 1, fx.cashier);
    const b = await billing.recordPeakSale(session.id, fx.sku.half, 1, fx.cashier);

    const [u1, u2] = await Promise.all([billing.undoLastPeakSale(fx.cashier), billing.undoLastPeakSale(fx.cashier)]);
    expect([u1.undone.billId, u2.undone.billId].sort()).toEqual([a.bill.id, b.bill.id].sort());
  });
});
