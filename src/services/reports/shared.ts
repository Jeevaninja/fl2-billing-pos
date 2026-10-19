/**
 * Shared by every report (Phase 23/24): the business-date range, its trading days, and small helpers.
 * A date is a business (trading) date: a bill rung at 1:30 am belongs to the evening it was sold.
 */
import type { SqlClient, SqlDatabase } from '../../db/client.js';
import type { DbInt, Paise } from '../../domain/money.js';

/** At most a year (inclusive), so one request stays a few hundred Day End calls at worst. */
export const MAX_REPORT_DAYS = 366;

export interface ReportRange {
  startDate: string;
  endDate: string;
}

export interface ReportDay {
  id: string;
  businessDate: string;
  status: 'OPEN' | 'CLOSED';
}

/** Every report starts with the range and the trading days found in it. */
export interface ReportHeader {
  range: ReportRange;
  days: ReportDay[];
  /** True when a day in the range is still open: its figures change until Day End. */
  provisional: boolean;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function dateMs(value: unknown, name: string): number {
  const m = typeof value === 'string' ? ISO_DATE.exec(value) : null;
  if (!m) throw new RangeError(`${name} must be a date as YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new RangeError(`${name} ${value as string} is not a real date`);
  return ms;
}

/** RangeError for a malformed date, start after end, or more than MAX_REPORT_DAYS days. */
export function checkRange(range: ReportRange): ReportRange {
  const start = dateMs(range.startDate, 'startDate');
  const end = dateMs(range.endDate, 'endDate');
  if (start > end) throw new RangeError('startDate must be on or before endDate');
  if ((end - start) / DAY_MS + 1 > MAX_REPORT_DAYS) throw new RangeError(`a report covers at most ${MAX_REPORT_DAYS} days`);
  return { startDate: range.startDate, endDate: range.endDate };
}

/** The calendar date before `date` (YYYY-MM-DD). */
export function dayBefore(date: string): string {
  return new Date(dateMs(date, 'date') - DAY_MS).toISOString().slice(0, 10);
}

export const sum = <T>(rows: readonly T[], pick: (r: T) => Paise) => rows.reduce((total, r) => total + pick(r), 0n);
export const int = (value: DbInt): number => Number(value);

/** `$1` / `$2` = the range: rows of a business day inside it. */
export const IN_RANGE = `business_day_id IN (SELECT id FROM business_days WHERE business_date BETWEEN $1::date AND $2::date)`;

export async function header(db: SqlClient, range: ReportRange): Promise<ReportHeader> {
  const checked = checkRange(range);
  const { rows } = await db.query<{ id: string; business_date: string; status: 'OPEN' | 'CLOSED' }>(
    `SELECT id, business_date::text AS business_date, status FROM business_days
      WHERE business_date BETWEEN $1::date AND $2::date ORDER BY business_date`,
    [checked.startDate, checked.endDate],
  );
  const days = rows.map((r) => ({ id: r.id, businessDate: r.business_date, status: r.status }));
  return { range: checked, days, provisional: days.some((d) => d.status === 'OPEN') };
}

/**
 * Runs a report inside one READ ONLY, REPEATABLE READ transaction (Phase 24 D6): every query of the
 * report sees the same snapshot, so a bill settled mid-report can't land in a total but not in its
 * rows. Read-only snapshots take no locks that block billing.
 */
export function snapshot<T>(db: SqlDatabase, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return fn(tx);
  });
}
