/**
 * Payment routing for the F9 dialog. Pure: picks which API calls settle the bill.
 *
 *   no waiter         → settleNormalBill with tenders that exactly match the amount due
 *   untrusted waiter  → one settleWaiterBill for the full amount (bill-on-bill)
 *   trusted waiter    → also partial (part now, rest on credit) or collect later (all on credit)
 *
 * Cash tendered above the amount due is never recorded; the excess is change, shown on screen only.
 */
import type { BillDetail, CounterPayment, CounterTender, Paise, Tender } from '../api/types'
import { formatPaise } from '../lib/money'

export type PayOption = 'cash' | 'upi' | 'split' | 'partial' | 'credit'

export interface PayInput {
  option: PayOption
  /** cash: cash tendered (null = exact) · split: the cash part · partial: the part paid now. */
  amount: Paise | null
  /** Tender for the part paid now on a partial payment. */
  partialTender: CounterTender
}

export type PayPlan =
  | { kind: 'counter'; payments: CounterPayment[]; changePaise: Paise }
  | { kind: 'waiter'; waiterId: string; steps: Array<{ tender: Tender; amount?: Paise }>; changePaise: Paise }

export type PlanResult = { ok: true; plan: PayPlan } | { ok: false; error: string }

export function payOptions(detail: BillDetail): PayOption[] {
  if (!detail.bill.waiterId) return ['cash', 'upi', 'split']
  return detail.bill.waiterTrustedAtBilling ? ['cash', 'upi', 'partial', 'credit'] : ['cash', 'upi']
}

const fail = (error: string): PlanResult => ({ ok: false, error })

export function planPayment(detail: BillDetail, input: PayInput): PlanResult {
  const due = detail.duePaise
  if (due <= 0n) return fail('Nothing is due on this bill')
  if (!payOptions(detail).includes(input.option)) return fail('That payment option is not available for this bill')
  const waiterId = detail.bill.waiterId

  const creditCheck = (credit: Paise): PlanResult | null => {
    const limit = detail.waiter?.creditLimitPaise
    if (limit === null || limit === undefined) return null
    const headroom = limit - (detail.waiter?.outstandingPaise ?? 0n)
    return credit > headroom ? fail(`Over credit limit: ${formatPaise(headroom < 0n ? 0n : headroom)} headroom, ${formatPaise(credit)} asked`) : null
  }

  switch (input.option) {
    case 'cash': {
      const tendered = input.amount ?? due
      if (tendered < due) return fail(`Cash tendered is less than ${formatPaise(due)}`)
      const changePaise = tendered - due
      return waiterId
        ? { ok: true, plan: { kind: 'waiter', waiterId, steps: [{ tender: 'CASH' }], changePaise } }
        : { ok: true, plan: { kind: 'counter', payments: [{ mode: 'CASH', amount: due }], changePaise } }
    }
    case 'upi':
      return waiterId
        ? { ok: true, plan: { kind: 'waiter', waiterId, steps: [{ tender: 'UPI' }], changePaise: 0n } }
        : { ok: true, plan: { kind: 'counter', payments: [{ mode: 'UPI', amount: due }], changePaise: 0n } }
    case 'split': {
      const cash = input.amount
      if (cash === null || cash <= 0n || cash >= due) return fail(`Enter a cash part between ₹0 and ${formatPaise(due)}`)
      return {
        ok: true,
        plan: { kind: 'counter', payments: [{ mode: 'CASH', amount: cash }, { mode: 'UPI', amount: due - cash }], changePaise: 0n },
      }
    }
    case 'partial': {
      const part = input.amount
      if (!waiterId) return fail('Partial payment needs a trusted waiter')
      if (part === null || part <= 0n || part >= due) return fail(`Enter an amount paid now between ₹0 and ${formatPaise(due)}`)
      const over = creditCheck(due - part)
      if (over) return over
      return {
        ok: true,
        plan: { kind: 'waiter', waiterId, steps: [{ tender: input.partialTender, amount: part }, { tender: 'WAITER_CREDIT' }], changePaise: 0n },
      }
    }
    case 'credit': {
      if (!waiterId) return fail('Collect later needs a trusted waiter')
      const over = creditCheck(due)
      if (over) return over
      return { ok: true, plan: { kind: 'waiter', waiterId, steps: [{ tender: 'WAITER_CREDIT' }], changePaise: 0n } }
    }
  }
}

/** One-line description of how a bill was paid, for the receipt banner. */
export function describePlan(plan: PayPlan, detail: BillDetail): string {
  if (plan.kind === 'counter') {
    if (plan.payments.length === 1) return plan.payments[0]?.mode === 'CASH' ? 'Cash' : 'UPI'
    return plan.payments.map((p) => `${p.mode === 'CASH' ? 'Cash' : 'UPI'} ${formatPaise(p.amount)}`).join(' + ')
  }
  const who = detail.waiter?.displayName ?? 'waiter'
  return plan.steps
    .map((s) =>
      s.tender === 'WAITER_CREDIT' ? `credit to ${who}` : `${s.tender === 'CASH' ? 'Cash' : 'UPI'}${s.amount ? ` ${formatPaise(s.amount)}` : ''} via ${who}`,
    )
    .join(' + ')
}

const GRID_COLUMNS = 2
const ARROW_STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -GRID_COLUMNS, ArrowDown: GRID_COLUMNS }

/**
 * Arrow-key movement across the dialog's 2-column option grid: ←/→ step sideways within a row,
 * ↑/↓ move a row. No wrap: a move off the grid (or onto an empty cell) stays put.
 */
export function moveOption(options: readonly PayOption[], current: PayOption, key: string): PayOption {
  const step = ARROW_STEP[key]
  const at = options.indexOf(current)
  if (step === undefined || at === -1) return current
  const next = at + step
  if (next < 0 || next >= options.length) return current
  if (Math.abs(step) === 1 && Math.floor(next / GRID_COLUMNS) !== Math.floor(at / GRID_COLUMNS)) return current
  return options[next] ?? current
}

const AMOUNT_MAX_LENGTH = 12

/**
 * Typing a tendered amount without focusing the field (Cash: the field is optional, blank = exact).
 * Returns the new text, or null when the key is not amount input.
 */
export function amountKey(text: string, key: string): string | null {
  if (key === 'Backspace') return text.slice(0, -1)
  if (!/^[\d.,]$/.test(key)) return null
  return text.length >= AMOUNT_MAX_LENGTH ? text : text + key
}
