/** SQLSTATE codes raised by the rules in migrations/0002_core_rules.sql. */
export const PosErrorCode = {
  APPEND_ONLY: 'PS001',
  ILLEGAL_TRANSITION: 'PS002',
  INSUFFICIENT_STOCK: 'PS003',
  CREDIT_NOT_ALLOWED: 'PS004',
  TENDER_MISMATCH: 'PS005',
  REVERSAL_RULE: 'PS006',
  DAY_OR_PEAK_RULE: 'PS007',
  WAITER_BALANCE: 'PS008',
  DERIVED_COLUMN: 'PS009',
  BILL_ON_BILL: 'PS010',
} as const;

export type PosErrorCode = (typeof PosErrorCode)[keyof typeof PosErrorCode];

const POS_CODES: ReadonlySet<string> = new Set(Object.values(PosErrorCode));

/** Standard PostgreSQL codes the schema relies on. */
export const PgErrorCode = {
  CHECK_VIOLATION: '23514',
  UNIQUE_VIOLATION: '23505',
  NOT_NULL_VIOLATION: '23502',
  FOREIGN_KEY_VIOLATION: '23503',
} as const;

/**
 * Constraints that encode business rules. A violation is reported as the matching PS code,
 * so callers see one error vocabulary whether a rule fired in a trigger or in a constraint
 * (e.g. two terminals racing to start a peak session hit the unique index, not the trigger).
 */
const CONSTRAINT_CODES: Readonly<Record<string, PosErrorCode>> = {
  bills_reverses_unique: PosErrorCode.REVERSAL_RULE,
  bills_replaces_unique: PosErrorCode.REVERSAL_RULE,
  bills_reversal_reason: PosErrorCode.REVERSAL_RULE,
  bills_reversal_shape: PosErrorCode.REVERSAL_RULE,
  bill_items_reversal_shape: PosErrorCode.REVERSAL_RULE,
  bill_payments_reverses_unique: PosErrorCode.REVERSAL_RULE,
  waiter_payments_reverses_unique: PosErrorCode.REVERSAL_RULE,
  waiter_payments_reversal_shape: PosErrorCode.REVERSAL_RULE,
  cash_expenses_reverses_unique: PosErrorCode.REVERSAL_RULE,
  cash_expenses_reversal_shape: PosErrorCode.REVERSAL_RULE,
  business_days_cash_count_on_close: PosErrorCode.ILLEGAL_TRANSITION,
  bills_peak_counter_only: PosErrorCode.ILLEGAL_TRANSITION,
  bills_waiter_app_needs_waiter: PosErrorCode.ILLEGAL_TRANSITION,
  bills_mode_status_pairing: PosErrorCode.ILLEGAL_TRANSITION,
  sku_stock_non_negative: PosErrorCode.INSUFFICIENT_STOCK,
  waiters_outstanding_non_negative: PosErrorCode.WAITER_BALANCE,
  waiter_ledger_balance_non_negative: PosErrorCode.WAITER_BALANCE,
  peak_sessions_one_active_per_day: PosErrorCode.DAY_OR_PEAK_RULE,
  business_days_one_open: PosErrorCode.DAY_OR_PEAK_RULE,
  business_days_date_unique: PosErrorCode.DAY_OR_PEAK_RULE,
};

/** A POS business-rule violation, carrying one of the PS001–PS010 codes. */
export class PosError extends Error {
  override readonly name = 'PosError';
  readonly code: PosErrorCode;
  /** The constraint that fired, when the rule was enforced by a constraint rather than a trigger. */
  readonly constraint: string | undefined;

  constructor(code: PosErrorCode, message: string, options: { cause?: unknown; constraint?: string | undefined } = {}) {
    super(message, { cause: options.cause });
    this.code = code;
    this.constraint = options.constraint;
  }
}

/** A referenced row (bill, SKU, waiter, …) does not exist. */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';

  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} ${id} not found`);
  }
}

/** A referenced row exists but is deactivated (inactive waiter, member or SKU). */
export class InactiveError extends Error {
  override readonly name = 'InactiveError';

  constructor(
    readonly entity: string,
    readonly id: string,
    label: string,
  ) {
    super(`${entity} ${label} is inactive`);
  }
}

/** A Captain idempotency key was reused for a different order (or from a different handset). */
export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';

  constructor(readonly requestId: string) {
    super(`request ${requestId} was already used for a different order`);
  }
}

interface DbErrorLike {
  code: string;
  message: string;
  constraint?: string | undefined;
}

function isDbError(err: unknown): err is DbErrorLike {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof err.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(err.code)
  );
}

/** Maps a raw driver error onto a PosError when it represents a business rule; otherwise returns it unchanged. */
export function toPosError(err: unknown): unknown {
  if (err instanceof PosError || !isDbError(err)) return err;
  if (POS_CODES.has(err.code)) return new PosError(err.code as PosErrorCode, err.message, { cause: err });
  const mapped = err.constraint === undefined ? undefined : CONSTRAINT_CODES[err.constraint];
  if (mapped) return new PosError(mapped, err.message, { cause: err, constraint: err.constraint });
  return err;
}

/** Runs `fn`, re-throwing database rule violations as PosError. */
export async function withPosErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toPosError(err);
  }
}

export function isPosError(err: unknown, code?: PosErrorCode): err is PosError {
  return err instanceof PosError && (code === undefined || err.code === code);
}
