import { describe, expect, it } from 'vitest';
import { NotFoundError, PosErrorCode } from '../../src/db/errors.js';
import { DayEndService } from '../../src/services/index.js';
import { expectSqlError, useSeededDb } from '../support/db.js';
import { one } from '../support/pos.js';
import { expectPosError, makeServices, PAISE } from '../support/services.js';

const TEN_THOUSAND = 10_000_00n;

/** Phase 14: bank deposits (cash drops) lower the expected drawer without touching sales or expenses. */
describe('bank deposits', () => {
  const ctx = useSeededDb();
  const setup = async () => {
    const { db, fx } = ctx();
    const services = { db, fx, dayEnd: new DayEndService(db), ...makeServices(db) };
    // Enough drawer cash for a ₹10,000 drop: 5 Full bottles in cash, 1 Half on UPI.
    const cash = await services.billing.createBill('NORMAL', fx.cashier);
    await services.billing.addItemToBill(cash.id, fx.sku.full, 5);
    await services.billing.settleNormalBill(cash.id, [{ mode: 'CASH', amount: 5n * PAISE.full }]);
    const upi = await services.billing.createBill('NORMAL', fx.cashier);
    await services.billing.addItemToBill(upi.id, fx.sku.half, 1);
    await services.billing.settleNormalBill(upi.id, [{ mode: 'UPI', amount: PAISE.half }]);
    await services.dayEnd.recordCashExpense(150_00n, 'Ice', fx.cashier, 'ICE');
    return services;
  };

  it('a ₹10,000 deposit lowers expected cash by exactly ₹10,000 and leaves sales and expenses alone', async () => {
    const { fx, dayEnd } = await setup();
    const before = await dayEnd.getDayEndSummary(fx.dayId);

    const deposit = await dayEnd.recordBankDeposit(TEN_THOUSAND, '  RTGS to Sri Balaji  ', fx.cashier);
    expect(deposit).toMatchObject({
      businessDayId: fx.dayId,
      amountPaise: TEN_THOUSAND,
      reference: 'RTGS to Sri Balaji',
      reversesDepositId: null,
      createdByStaffId: fx.cashier,
    });

    const after = await dayEnd.getDayEndSummary(fx.dayId);
    expect(after.breakdown.bankDepositsPaise).toBe(TEN_THOUSAND);
    expect(after.breakdown.expectedCashPaise).toBe(before.breakdown.expectedCashPaise - TEN_THOUSAND);
    expect(after.breakdown.cashExpensesPaise).toBe(before.breakdown.cashExpensesPaise);
    expect(after.breakdown.upiTotalPaise).toBe(before.breakdown.upiTotalPaise);
    expect(after.sales).toEqual(before.sales);
    expect(await dayEnd.listCashExpenses(fx.dayId)).toHaveLength(1);
    expect(await dayEnd.listBankDeposits(fx.dayId)).toEqual([expect.objectContaining({ id: deposit.id, voidedAt: null })]);
  });

  it('freezes the deposit into expected cash and the variance at close', async () => {
    const { fx, dayEnd } = await setup();
    await dayEnd.recordBankDeposit(TEN_THOUSAND, null, fx.cashier);
    const expected = 5n * PAISE.full - 150_00n - TEN_THOUSAND;
    const closed = await dayEnd.closeBusinessDay(fx.dayId, expected - 20_00n, fx.cashier);
    expect(closed.day).toMatchObject({ expectedCashPaise: expected, cashVariancePaise: -20_00n });
    expect(closed.breakdown.bankDepositsPaise).toBe(TEN_THOUSAND);
    await expectPosError(dayEnd.recordBankDeposit(100n, null, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE);
  });

  it('voids by a negating row, once, and never a void', async () => {
    const { fx, dayEnd } = await setup();
    const before = await dayEnd.getDayEndSummary(fx.dayId);
    const deposit = await dayEnd.recordBankDeposit(TEN_THOUSAND, 'RTGS', fx.cashier);
    const v = await dayEnd.voidBankDeposit(deposit.id, fx.cashier);
    expect(v).toMatchObject({ amountPaise: -TEN_THOUSAND, reversesDepositId: deposit.id, reference: 'RTGS' });

    const s = await dayEnd.getDayEndSummary(fx.dayId);
    expect(s.breakdown.bankDepositsPaise).toBe(0n);
    expect(s.breakdown.expectedCashPaise).toBe(before.breakdown.expectedCashPaise);
    expect(await dayEnd.listBankDeposits(fx.dayId)).toEqual([expect.objectContaining({ id: deposit.id, voidedAt: expect.any(Date) })]);

    await expectPosError(dayEnd.voidBankDeposit(deposit.id, fx.cashier), PosErrorCode.REVERSAL_RULE);
    await expectPosError(dayEnd.voidBankDeposit(v.id, fx.cashier), PosErrorCode.REVERSAL_RULE, /cannot itself be voided/);
    await expect(dayEnd.voidBankDeposit('00000000-0000-0000-0000-000000000000', fx.cashier)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a deposit while a peak session runs, but still allows a void', async () => {
    const { fx, dayEnd, peak } = await setup();
    const deposit = await dayEnd.recordBankDeposit(5_000_00n, null, fx.cashier);
    const session = await peak.startPeakSession(fx.dayId, 0n, 0n, fx.cashier);
    await expectPosError(dayEnd.recordBankDeposit(100_00n, null, fx.cashier), PosErrorCode.DAY_OR_PEAK_RULE, /peak session/);
    await dayEnd.voidBankDeposit(deposit.id, fx.cashier);
    await peak.endPeakSession(session.id, 0n, 0n, fx.cashier);
    await dayEnd.recordBankDeposit(100_00n, null, fx.cashier);
  });

  it('shows the deposit in the peak start baseline, whose terms still add up', async () => {
    const { fx, dayEnd, peak } = await setup();
    await dayEnd.recordBankDeposit(TEN_THOUSAND, null, fx.cashier);
    const b = await peak.getStartBaseline(fx.dayId);
    expect(b.bankDepositsPaise).toBe(TEN_THOUSAND);
    expect(
      b.openingFloatPaise + b.normalCashPaise + b.waiterCashPaise + b.peakCashPaise - b.cashExpensesPaise + b.tenderAdjustmentPaise - b.bankDepositsPaise,
    ).toBe(b.expectedCashPaise);
  });

  it('validates the input before touching the database', async () => {
    const { fx, dayEnd } = await setup();
    await expect(dayEnd.recordBankDeposit(0n, null, fx.cashier)).rejects.toBeInstanceOf(RangeError);
    await expect(dayEnd.recordBankDeposit(-100n, null, fx.cashier)).rejects.toBeInstanceOf(RangeError);
    await expect(dayEnd.recordBankDeposit(100n, 'x'.repeat(201), fx.cashier)).rejects.toBeInstanceOf(RangeError);
    expect((await dayEnd.recordBankDeposit(100n, '   ', fx.cashier)).reference).toBeNull();
  });

  it('is append-only and enforces the void shape in the database', async () => {
    const { db, fx, dayEnd } = await setup();
    const deposit = await dayEnd.recordBankDeposit(100_00n, 'x', fx.cashier);
    await expectSqlError(db.query(`UPDATE bank_deposits SET reference = 'y' WHERE id = $1`, [deposit.id]), PosErrorCode.APPEND_ONLY);
    await expectSqlError(db.query(`DELETE FROM bank_deposits WHERE id = $1`, [deposit.id]), PosErrorCode.APPEND_ONLY);
    await expectSqlError(
      db.query(`INSERT INTO bank_deposits (amount_paise, reverses_deposit_id, created_by_staff_id) VALUES (-50, $1, $2)`, [deposit.id, fx.cashier]),
      PosErrorCode.REVERSAL_RULE,
      /exactly negate/,
    );
  });

  it('writes every row to the sync outbox', async () => {
    const { db, fx, dayEnd } = await setup();
    const deposit = await dayEnd.recordBankDeposit(100_00n, null, fx.cashier);
    await dayEnd.voidBankDeposit(deposit.id, fx.cashier);
    const row = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM sync_outbox WHERE event_type = 'bank_deposits.insert'`);
    expect(row.n).toBe(2);
  });
});
