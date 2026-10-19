/**
 * Bank Deposits (Phase 24 §1.7): the contra log — cash taken from the till to the bank — in order.
 * Voids are listed beside the deposit they cancel and net to ₹0. "Depositor" is the staff member who
 * recorded the deposit at the till; the system does not record who carried the cash to the bank.
 */
import type { SqlClient } from '../../db/client.js';
import { type DbInt, type Paise, toPaise } from '../../domain/money.js';
import { type ReportHeader, sum } from './shared.js';

export interface BankDepositRow {
  id: string;
  businessDate: string;
  at: Date;
  /** Negative on a void. */
  amountPaise: Paise;
  reference: string | null;
  depositorName: string;
  isVoid: boolean;
  voided: boolean;
}

export interface BankDepositLog extends ReportHeader {
  rows: BankDepositRow[];
  /** Net of voids = the ledger's contra. */
  totalPaise: Paise;
}

export async function bankDepositLog(db: SqlClient, head: ReportHeader): Promise<BankDepositLog> {
  const { rows } = await db.query<{
    id: string;
    business_date: string;
    created_at: Date;
    amount: DbInt;
    reference: string | null;
    depositor: string;
    is_void: boolean;
    voided: boolean;
  }>(
    `SELECT k.id, d.business_date::text AS business_date, k.created_at, k.amount_paise::text AS amount, k.reference,
            s.display_name AS depositor, (k.reverses_deposit_id IS NOT NULL) AS is_void,
            EXISTS (SELECT 1 FROM bank_deposits v WHERE v.reverses_deposit_id = k.id) AS voided
       FROM bank_deposits k
       JOIN business_days d ON d.id = k.business_day_id
       JOIN staff s ON s.id = k.created_by_staff_id
      WHERE d.business_date BETWEEN $1::date AND $2::date
      ORDER BY d.business_date, k.created_at, k.id`,
    [head.range.startDate, head.range.endDate],
  );
  const out = rows.map((r) => ({
    id: r.id,
    businessDate: r.business_date,
    at: r.created_at,
    amountPaise: toPaise(r.amount),
    reference: r.reference,
    depositorName: r.depositor,
    isVoid: r.is_void,
    voided: r.voided,
  }));
  return { ...head, rows: out, totalPaise: sum(out, (r) => r.amountPaise) };
}
