/**
 * Captain (waiter) app flows: the waiter's profile, their open bills, and placing an order — a new
 * WAITER_APP bill tagged to the waiter, its lines, and a KOT routed to the counter printer.
 */
import type { SqlDatabase } from '../db/client.js';
import { InactiveError, NotFoundError, withPosErrors } from '../db/errors.js';
import { assertQuantity, type DbInt, type Paise, toPaise, toPaiseOrNull } from '../domain/money.js';
import type { Bill, BillItem } from '../domain/types.js';
import { insertSaleLine } from './billing.service.js';
import { type BillDetail, CounterQueries, type MemberSummary, type WaiterSummary } from './counter-queries.js';
import type { KotPrinter, KotStation, KotTicket } from './printer.service.js';
import { type BillRow, mapBill, maybeOne, one } from './rows.js';

export interface WaiterProfile extends WaiterSummary {
  isActive: boolean;
  /** Credit still available (limit − outstanding, floored at 0); null when there is no limit. */
  creditHeadroomPaise: Paise | null;
}

export interface OrderLine {
  skuId: string;
  quantity: number;
}

export interface KotStatus {
  station: KotStation;
  printed: boolean;
  printedAt: Date | null;
  /** Why printing failed; the order itself is already saved. */
  error: string | null;
}

export interface PlacedOrder {
  bill: Bill;
  items: BillItem[];
  waiter: WaiterSummary;
  member: MemberSummary | null;
  kot: KotStatus;
}

/** Longest order one KOT may carry; a guard against runaway clients, not a business rule. */
export const MAX_ORDER_LINES = 50;

interface WaiterRow {
  id: string;
  waiter_code: string;
  display_name: string;
  is_trusted: boolean;
  is_active: boolean;
  outstanding_balance: DbInt;
  credit_limit_paise: DbInt | null;
}

function mapProfile(r: WaiterRow): WaiterProfile {
  const outstandingPaise = toPaise(r.outstanding_balance);
  const creditLimitPaise = toPaiseOrNull(r.credit_limit_paise);
  const headroom = creditLimitPaise === null ? null : creditLimitPaise - outstandingPaise;
  return {
    id: r.id,
    code: r.waiter_code,
    displayName: r.display_name,
    isTrusted: r.is_trusted,
    isActive: r.is_active,
    outstandingPaise,
    creditLimitPaise,
    creditHeadroomPaise: headroom === null ? null : headroom < 0n ? 0n : headroom,
  };
}

export class CaptainService {
  private readonly queries: CounterQueries;

  constructor(
    private readonly db: SqlDatabase,
    private readonly printer: KotPrinter,
  ) {
    this.queries = new CounterQueries(db);
  }

  async getWaiterProfile(waiterId: string): Promise<WaiterProfile> {
    const row = await maybeOne<WaiterRow>(this.db, `SELECT * FROM waiters WHERE id = $1`, [waiterId]);
    if (!row) throw new NotFoundError('waiter', waiterId);
    return mapProfile(row);
  }

  /** The waiter's OPEN sale bills (app orders and counter bills tagged to them), oldest first. */
  async listOpenBills(waiterId: string): Promise<BillDetail[]> {
    await this.getWaiterProfile(waiterId);
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM bills
        WHERE waiter_id = $1 AND status = 'OPEN' AND bill_kind = 'SALE'
        ORDER BY bill_no`,
      [waiterId],
    );
    const bills: BillDetail[] = [];
    for (const { id } of rows) bills.push(await this.queries.getBillDetail(id));
    return bills;
  }

  /**
   * Opens a WAITER_APP bill for the waiter and adds every line in one transaction: any missing or
   * inactive reference, or any line short of stock, saves nothing. The KOT prints after commit; a
   * printer failure is reported in `kot` and never undoes the order.
   */
  async placeOrder(waiterId: string, lines: readonly OrderLine[], memberId?: string): Promise<PlacedOrder> {
    if (lines.length === 0) throw new RangeError('an order needs at least one line');
    if (lines.length > MAX_ORDER_LINES) throw new RangeError(`an order can have at most ${MAX_ORDER_LINES} lines`);
    lines.forEach((l, i) => assertQuantity(l.quantity, `items[${i}].quantity`));

    const order = await withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const waiter = await maybeOne<WaiterRow>(tx, `SELECT * FROM waiters WHERE id = $1`, [waiterId]);
        if (!waiter) throw new NotFoundError('waiter', waiterId);
        if (!waiter.is_active) throw new InactiveError('waiter', waiterId, waiter.waiter_code);

        let member: MemberSummary | null = null;
        if (memberId !== undefined) {
          const row = await maybeOne<{ membership_no: string; display_name: string; is_active: boolean }>(
            tx,
            `SELECT membership_no, display_name, is_active FROM members WHERE id = $1`,
            [memberId],
          );
          if (!row) throw new NotFoundError('member', memberId);
          if (!row.is_active) throw new InactiveError('member', memberId, row.membership_no);
          member = { id: memberId, membershipNo: row.membership_no, displayName: row.display_name };
        }

        for (const { skuId } of lines) {
          const sku = await maybeOne<{ sku_code: string; is_active: boolean }>(
            tx,
            `SELECT sku_code, is_active FROM skus WHERE id = $1`,
            [skuId],
          );
          if (!sku) throw new NotFoundError('sku', skuId);
          if (!sku.is_active) throw new InactiveError('sku', skuId, sku.sku_code);
        }

        const bill = mapBill(
          await one<BillRow>(
            tx,
            `INSERT INTO bills (billing_mode, status, source, waiter_id, member_id)
             VALUES ('NORMAL', 'OPEN', 'WAITER_APP', $1, $2) RETURNING *`,
            [waiterId, memberId ?? null],
          ),
        );
        const items: BillItem[] = [];
        for (const line of lines) items.push(await insertSaleLine(tx, bill, line.skuId, line.quantity));

        const saved = mapBill(await one<BillRow>(tx, `SELECT * FROM bills WHERE id = $1`, [bill.id]));
        const { isActive: _active, creditHeadroomPaise: _headroom, ...summary } = mapProfile(waiter);
        return { bill: saved, items, waiter: summary, member };
      }),
    );

    const { waiter } = order;
    const ticket: KotTicket = {
      kotNo: order.bill.billNo,
      billId: order.bill.id,
      station: 'COUNTER',
      waiter: { code: waiter.code, displayName: waiter.displayName },
      member: order.member && { membershipNo: order.member.membershipNo, displayName: order.member.displayName },
      lines: order.items.map((i) => ({ skuCode: i.skuCode, displayName: i.displayName, sizeCode: i.sizeCode, quantity: i.quantity })),
      createdAt: order.bill.createdAt,
    };
    let kot: KotStatus;
    try {
      const printed = await this.printer.printKOT(ticket);
      kot = { station: printed.station, printed: true, printedAt: printed.printedAt, error: null };
    } catch (err) {
      kot = { station: ticket.station, printed: false, printedAt: null, error: err instanceof Error ? err.message : String(err) };
    }
    return { bill: order.bill, items: order.items, waiter, member: order.member, kot };
  }
}
