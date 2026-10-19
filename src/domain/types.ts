import type { Paise } from './money.js';

export type BillingMode = 'NORMAL' | 'PEAK';
export type BillKind = 'SALE' | 'REVERSAL';
export type BillStatus = 'OPEN' | 'SETTLED' | 'PEAK_UNSETTLED' | 'PEAK_RECONCILED';
export type BillSource = 'COUNTER' | 'WAITER_APP';
export type SizeCode = 'FULL' | 'HALF' | 'QUARTER' | 'BEER_650' | 'BEER_330' | 'UNIT';
/**
 * P&L department / revenue center code (0013; manager-defined since 0016): LIQUOR, KITCHEN,
 * CIGARETTES, COOL_DRINKS, … Every line of a bill carries one; the drawer stays unified.
 */
export type DepartmentCode = string;
/** A KOT printer station. */
export type KotStation = 'BAR' | 'KITCHEN';
/** Where a department's KOT lines print; NONE = no ticket (a service such as AC charges). */
export type DepartmentStation = KotStation | 'NONE';
export type CounterTender = 'CASH' | 'UPI';
export type Tender = CounterTender | 'WAITER_CREDIT';

export interface Bill {
  id: string;
  businessDayId: string;
  billNo: number;
  kind: BillKind;
  mode: BillingMode;
  status: BillStatus;
  source: BillSource;
  peakSessionId: string | null;
  waiterId: string | null;
  waiterTrustedAtBilling: boolean | null;
  memberId: string | null;
  totalPaise: Paise;
  reversesBillId: string | null;
  replacesBillId: string | null;
  reversalReason: string | null;
  createdByStaffId: string | null;
  createdAt: Date;
  settledAt: Date | null;
  settledByStaffId: string | null;
  peakReconciledAt: Date | null;
  /** Captain-app idempotency key; null on counter bills. */
  requestId: string | null;
  /** Paired handset that placed a Captain-app order. */
  captainDeviceId: string | null;
}

export interface BillItem {
  id: string;
  billId: string;
  lineNo: number;
  skuId: string;
  skuCode: string;
  displayName: string;
  sizeCode: SizeCode;
  /** Whole bottles; negative on cancellation / reversal lines. */
  quantity: number;
  unitPricePaise: Paise;
  lineTotalPaise: Paise;
  reversesItemId: string | null;
  restock: boolean;
  /** Snapshotted at insert (a cancellation / reversal copies the original's). */
  department: DepartmentCode;
}

export interface BillPayment {
  id: string;
  billId: string;
  businessDayId: string;
  peakSessionId: string | null;
  tender: Tender;
  /** Negative on refunds. */
  amountPaise: Paise;
  reversesPaymentId: string | null;
  createdAt: Date;
}

export interface PeakSession {
  id: string;
  businessDayId: string;
  sessionNo: number;
  startedAt: Date;
  startedByStaffId: string;
  startCashPaise: Paise;
  startUpiPaise: Paise;
  endedAt: Date | null;
  endedByStaffId: string | null;
  endCashPaise: Paise | null;
  endUpiPaise: Paise | null;
  expectedPaise: Paise | null;
  variancePaise: Paise | null;
}

export interface WaiterPayment {
  id: string;
  waiterId: string;
  businessDayId: string;
  peakSessionId: string | null;
  tender: CounterTender;
  amountPaise: Paise;
  reversesWaiterPaymentId: string | null;
  createdAt: Date;
}
