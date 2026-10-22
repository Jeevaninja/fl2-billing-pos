/**
 * Captain (waiter) app flows: the waiter's profile, their open bills, and placing an order — a new
 * WAITER_APP bill tagged to the waiter, its lines, and KOTs split by station (Phase 19): liquor and
 * ancillary lines to the BAR printer, kitchen lines to the KITCHEN printer.
 *
 * Orders are idempotent (migration 0004): each carries a client-generated requestId. A retry with
 * the same key and the same order replays the original bill; the same key with a different order
 * (or from another handset) is an IdempotencyConflictError.
 *
 * Phase 27 (migration 0020): the handset's catalog, waiter list and member lookup; rounds added to a
 * bill already open (idempotent the same way, through captain_order_rounds); and settle requests,
 * a flag for the counter that moves no money.
 */
import { createHash } from 'node:crypto';
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { IdempotencyConflictError, InactiveError, isPosError, NotFoundError, PosError, PosErrorCode, withPosErrors } from '../db/errors.js';
import { assertQuantity, type DbInt, type Paise, toPaise, toPaiseOrNull } from '../domain/money.js';
import type { Bill, BillItem } from '../domain/types.js';
import { insertSaleLine } from './billing.service.js';
import {
  type BillDetail,
  CounterQueries,
  type MemberSummary,
  mapSkuLookup,
  SKU_COLUMNS,
  SKU_FROM,
  type SkuLookup,
  type SkuLookupRow,
  type WaiterSummary,
} from './counter-queries.js';
import { KotService, type KotStatus } from './kot.service.js';
import type { KotPrinter } from './printer.service.js';
import { type BillItemRow, type BillRow, getBill, mapBill, mapBillItem, maybeOne, one } from './rows.js';

export interface WaiterProfile extends WaiterSummary {
  isActive: boolean;
  /** Credit still available (limit − outstanding, floored at 0); null when there is no limit. */
  creditHeadroomPaise: Paise | null;
}

export interface OrderLine {
  skuId: string;
  quantity: number;
}

export type { KotStatus } from './kot.service.js';

export interface OrderRequest {
  /** Client-generated UUID, reused on every retry of the same order. */
  requestId: string;
  /** Paired handset placing the order (from its device token). */
  deviceId: string;
  waiterId: string;
  memberId?: string | undefined;
  items: readonly OrderLine[];
}

export interface PlacedOrder {
  bill: Bill;
  /** The order's own lines (a replay returns the original lines, not later counter edits). */
  items: BillItem[];
  waiter: WaiterSummary;
  member: MemberSummary | null;
  /** One print outcome per station that had lines; empty on a replay, which never reprints. */
  kots: KotStatus[];
  /** Kept for older handsets: the BAR ticket, else the KITCHEN one; null on a replay. */
  kot: KotStatus | null;
  /** True when this request repeated an order that already exists. */
  replayed: boolean;
}

export interface RoundRequest {
  /** Client-generated UUID, reused on every retry of the same round. */
  requestId: string;
  deviceId: string;
  waiterId: string;
  /** The open bill the round adds to: tagged to `waiterId`. */
  billId: string;
  items: readonly OrderLine[];
}

export interface PlacedRound {
  bill: Bill;
  /** The round's own lines (a replay returns the original lines). */
  items: BillItem[];
  /** One print outcome per station that had pending lines; empty on a replay. */
  kots: KotStatus[];
  replayed: boolean;
}

export interface SettleRequest {
  deviceId: string;
  waiterId: string;
  billId: string;
}

export interface SettleRequestResult {
  bill: Bill;
  requestedAt: Date;
  /** True when the bill had already been flagged (the first request's time is returned). */
  alreadyRequested: boolean;
}

/** A waiter as the handset's picker shows them: no balances. */
export interface CaptainWaiter {
  id: string;
  code: string;
  displayName: string;
  isTrusted: boolean;
}

/** One orderable item on the handset's grid. */
export type CaptainCatalogItem = Pick<
  SkuLookup,
  'id' | 'skuCode' | 'displayName' | 'sizeCode' | 'pricePaise' | 'saleUnitName' | 'onHandQty' | 'tracksStock' | 'department' | 'departmentName' | 'itemCategory'
>;

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

/** sha256 hex of the canonical order: handset, waiter, member and lines in order. */
export function orderFingerprint(request: Omit<OrderRequest, 'requestId'>): string {
  const canonical = JSON.stringify([
    'fl2-kot-v1',
    request.deviceId,
    request.waiterId.toLowerCase(),
    request.memberId?.toLowerCase() ?? null,
    request.items.map((i) => [i.skuId.toLowerCase(), i.quantity]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** sha256 hex of the canonical round: handset, waiter, bill and lines in order. */
export function roundFingerprint(request: Omit<RoundRequest, 'requestId'>): string {
  const canonical = JSON.stringify([
    'fl2-round-v1',
    request.deviceId,
    request.waiterId.toLowerCase(),
    request.billId.toLowerCase(),
    request.items.map((i) => [i.skuId.toLowerCase(), i.quantity]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

function assertLines(lines: readonly OrderLine[]): void {
  if (lines.length === 0) throw new RangeError('an order needs at least one line');
  if (lines.length > MAX_ORDER_LINES) throw new RangeError(`an order can have at most ${MAX_ORDER_LINES} lines`);
  lines.forEach((l, i) => assertQuantity(l.quantity, `items[${i}].quantity`));
}

/** The waiter must exist and be active. */
async function activeWaiter(tx: SqlClient, waiterId: string): Promise<WaiterRow> {
  const waiter = await maybeOne<WaiterRow>(tx, `SELECT * FROM waiters WHERE id = $1`, [waiterId]);
  if (!waiter) throw new NotFoundError('waiter', waiterId);
  if (!waiter.is_active) throw new InactiveError('waiter', waiterId, waiter.waiter_code);
  return waiter;
}

/** Every line's SKU must exist and be active. */
async function assertActiveSkus(tx: SqlClient, lines: readonly OrderLine[]): Promise<void> {
  for (const { skuId } of lines) {
    const sku = await maybeOne<{ sku_code: string; is_active: boolean }>(tx, `SELECT sku_code, is_active FROM skus WHERE id = $1`, [skuId]);
    if (!sku) throw new NotFoundError('sku', skuId);
    if (!sku.is_active) throw new InactiveError('sku', skuId, sku.sku_code);
  }
}

/** Locks the bill and checks a handset may act on it: an OPEN sale bill tagged to `waiterId`. */
async function lockWaiterBill(tx: SqlClient, billId: string, waiterId: string): Promise<Bill> {
  const bill = await getBill(tx, billId, { forUpdate: true });
  if (bill.kind !== 'SALE') throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `bill ${bill.billNo} is a reversal bill`);
  if (bill.waiterId !== waiterId) throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `bill ${bill.billNo} is not tagged to waiter ${waiterId}`);
  if (bill.status !== 'OPEN') throw new PosError(PosErrorCode.APPEND_ONLY, `bill ${bill.billNo} is ${bill.status} and frozen`);
  return bill;
}

/** A concurrent attempt with the same key committed first: its bill is the unique key, or (for an untrusted waiter) the "open bill". */
function isRetryCollision(err: unknown): boolean {
  if (isPosError(err, PosErrorCode.BILL_ON_BILL)) return true;
  return err instanceof Error && 'code' in err && err.code === '23505' && 'constraint' in err && err.constraint === 'bills_request_id_unique';
}

function waiterSummary(r: WaiterRow): WaiterSummary {
  const { isActive: _active, creditHeadroomPaise: _headroom, ...summary } = mapProfile(r);
  return summary;
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
  private readonly kots: KotService;

  constructor(
    private readonly db: SqlDatabase,
    printer: KotPrinter,
  ) {
    this.queries = new CounterQueries(db);
    this.kots = new KotService(db, printer);
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

  /** Active waiters by code, for the handset's waiter picker. */
  async listWaiters(): Promise<CaptainWaiter[]> {
    return (await this.queries.listWaiters()).map(({ id, code, displayName, isTrusted }) => ({ id, code, displayName, isTrusted }));
  }

  /**
   * Every orderable item: active SKUs of active brands, by department, brand and size. Stock is a
   * snapshot for the grid; the order itself re-checks it.
   */
  async getCatalog(): Promise<CaptainCatalogItem[]> {
    const { rows } = await this.db.query<SkuLookupRow>(
      `SELECT ${SKU_COLUMNS}
         FROM ${SKU_FROM}
        WHERE k.is_active AND p.is_active
        ORDER BY d.sort_order, lower(p.name),
                 array_position(ARRAY['FULL', 'HALF', 'QUARTER', 'BEER_650', 'BEER_330', 'UNIT'], k.size_code),
                 k.sku_code`,
    );
    return rows.map((row) => {
      const s = mapSkuLookup(row);
      return {
        id: s.id,
        skuCode: s.skuCode,
        displayName: s.displayName,
        sizeCode: s.sizeCode,
        pricePaise: s.pricePaise,
        saleUnitName: s.saleUnitName,
        onHandQty: s.onHandQty,
        tracksStock: s.tracksStock,
        department: s.department,
        departmentName: s.departmentName,
        itemCategory: s.itemCategory,
      };
    });
  }

  /** The member whose card number is `code` (case-insensitive, exact). Inactive members are refused. */
  async findMemberByCode(code: string): Promise<MemberSummary> {
    const text = code.trim();
    const row = await maybeOne<{ id: string; membership_no: string; display_name: string; is_active: boolean }>(
      this.db,
      `SELECT id, membership_no, display_name, is_active FROM members WHERE upper(membership_no) = upper($1)`,
      [text],
    );
    if (!row) throw new NotFoundError('member', text);
    if (!row.is_active) throw new InactiveError('member', row.id, row.membership_no);
    return { id: row.id, membershipNo: row.membership_no, displayName: row.display_name };
  }

  /**
   * Adds a round to one of the waiter's open bills, in one transaction: any missing or inactive
   * reference, a bill that isn't this waiter's (PS002) or isn't open (PS001), or a line short of
   * stock (PS003) saves nothing and leaves the key unused. Bill-on-bill doesn't apply: the bill is
   * already open. Afterwards whatever is pending prints at the BAR and KITCHEN, as for a new order.
   */
  async addToBill(request: RoundRequest): Promise<PlacedRound> {
    const { requestId, deviceId, waiterId, billId, items: lines } = request;
    assertLines(lines);
    const fingerprint = roundFingerprint(request);

    const earlier = await this.findRound(requestId, fingerprint);
    if (earlier) return earlier;

    let round: Omit<PlacedRound, 'kots' | 'replayed'>;
    try {
      round = await withPosErrors(() =>
        this.db.transaction(async (tx) => {
          const bill = await lockWaiterBill(tx, billId, waiterId);
          await activeWaiter(tx, waiterId);
          await assertActiveSkus(tx, lines);

          const items: BillItem[] = [];
          for (const line of lines) items.push(await insertSaleLine(tx, bill, line.skuId, line.quantity));
          await tx.query(
            `INSERT INTO captain_order_rounds (request_id, request_fingerprint, bill_id, waiter_id, captain_device_id, first_line_no, line_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [requestId, fingerprint, billId, waiterId, deviceId, items[0]!.lineNo, items.length],
          );
          return { bill: await getBill(tx, billId), items };
        }),
      );
    } catch (err) {
      if (err instanceof Error && 'constraint' in err && err.constraint === 'captain_order_rounds_request_unique') {
        const replay = await this.findRound(requestId, fingerprint);
        if (replay) return replay;
      }
      throw err;
    }

    const kots = await this.kots.sendPending(billId, { deviceId }, { stations: ['BAR', 'KITCHEN'] });
    return { ...round, kots, replayed: false };
  }

  /**
   * Flags one of the waiter's open bills for the counter to settle. Moves no money. A repeat (or a
   * second handset) gets the first request back with `alreadyRequested: true`.
   */
  async requestSettlement({ deviceId, waiterId, billId }: SettleRequest): Promise<SettleRequestResult> {
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        const bill = await lockWaiterBill(tx, billId, waiterId);
        await activeWaiter(tx, waiterId);
        const existing = await maybeOne<{ requested_at: Date }>(tx, `SELECT requested_at FROM bill_settle_requests WHERE bill_id = $1`, [billId]);
        if (existing) return { bill, requestedAt: existing.requested_at, alreadyRequested: true };
        const row = await one<{ requested_at: Date }>(
          tx,
          `INSERT INTO bill_settle_requests (bill_id, waiter_id, captain_device_id) VALUES ($1, $2, $3) RETURNING requested_at`,
          [billId, waiterId, deviceId],
        );
        return { bill, requestedAt: row.requested_at, alreadyRequested: false };
      }),
    );
  }

  /**
   * Opens a WAITER_APP bill for the waiter and adds every line in one transaction: any missing or
   * inactive reference, any line short of stock, or bill-on-bill (PS010, untrusted waiter with an
   * open bill) saves nothing and leaves the key unused. The KOT prints after commit; a printer
   * failure is reported in `kot` and never undoes the order.
   *
   * The key is checked before anything else, and again if the insert collides with a concurrent
   * attempt, so a retry of a committed order replays it rather than failing bill-on-bill.
   */
  async placeOrder(request: OrderRequest): Promise<PlacedOrder> {
    const { requestId, deviceId, waiterId, memberId, items: lines } = request;
    assertLines(lines);
    const fingerprint = orderFingerprint(request);

    const earlier = await this.findOrder(this.db, requestId, fingerprint, lines.length);
    if (earlier) return earlier;

    let order: Omit<PlacedOrder, 'kot' | 'kots' | 'replayed'>;
    try {
      order = await withPosErrors(() =>
        this.db.transaction(async (tx) => {
          const waiter = await activeWaiter(tx, waiterId);

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

          await assertActiveSkus(tx, lines);

          const bill = mapBill(
            await one<BillRow>(
              tx,
              `INSERT INTO bills (billing_mode, status, source, waiter_id, member_id, request_id, request_fingerprint, captain_device_id)
               VALUES ('NORMAL', 'OPEN', 'WAITER_APP', $1, $2, $3, $4, $5) RETURNING *`,
              [waiterId, memberId ?? null, requestId, fingerprint, deviceId],
            ),
          );
          const items: BillItem[] = [];
          for (const line of lines) items.push(await insertSaleLine(tx, bill, line.skuId, line.quantity));

          const saved = mapBill(await one<BillRow>(tx, `SELECT * FROM bills WHERE id = $1`, [bill.id]));
          return { bill: saved, items, waiter: waiterSummary(waiter), member };
        }),
      );
    } catch (err) {
      if (isRetryCollision(err)) {
        const replay = await this.findOrder(this.db, requestId, fingerprint, lines.length);
        if (replay) return replay;
      }
      throw err;
    }

    const kots = await this.kots.sendPending(order.bill.id, { deviceId }, { stations: ['BAR', 'KITCHEN'] });
    return { ...order, kots, kot: kots.find((k) => k.station === 'BAR') ?? kots[0] ?? null, replayed: false };
  }

  /** The order already saved under `requestId`, as a replay; null if the key is unused. */
  private async findOrder(db: SqlClient, requestId: string, fingerprint: string, lineCount: number): Promise<PlacedOrder | null> {
    const row = await maybeOne<BillRow>(db, `SELECT * FROM bills WHERE request_id = $1`, [requestId]);
    if (!row) return null;
    if (row.request_fingerprint !== fingerprint) throw new IdempotencyConflictError(requestId);

    // Order lines are inserted first and in order, so lines 1..N are exactly this order's lines.
    const { rows: itemRows } = await db.query<BillItemRow>(
      `SELECT * FROM bill_items WHERE bill_id = $1 AND line_no <= $2 ORDER BY line_no`,
      [row.id, lineCount],
    );
    const waiter = await one<WaiterRow>(db, `SELECT * FROM waiters WHERE id = $1`, [row.waiter_id]);
    const member = row.member_id
      ? await one<{ id: string; membership_no: string; display_name: string }>(
          db,
          `SELECT id, membership_no, display_name FROM members WHERE id = $1`,
          [row.member_id],
        )
      : null;
    return {
      bill: mapBill(row),
      items: itemRows.map(mapBillItem),
      waiter: waiterSummary(waiter),
      member: member && { id: member.id, membershipNo: member.membership_no, displayName: member.display_name },
      kots: [],
      kot: null,
      replayed: true,
    };
  }

  /** The round already saved under `requestId`, as a replay; null if the key is unused. */
  private async findRound(requestId: string, fingerprint: string): Promise<PlacedRound | null> {
    const row = await maybeOne<{ bill_id: string; request_fingerprint: string; first_line_no: number; line_count: number }>(
      this.db,
      `SELECT bill_id, request_fingerprint, first_line_no, line_count FROM captain_order_rounds WHERE request_id = $1`,
      [requestId],
    );
    if (!row) return null;
    if (row.request_fingerprint !== fingerprint) throw new IdempotencyConflictError(requestId);
    const { rows: itemRows } = await this.db.query<BillItemRow>(
      `SELECT * FROM bill_items WHERE bill_id = $1 AND line_no >= $2 AND line_no < $2 + $3 ORDER BY line_no`,
      [row.bill_id, row.first_line_no, row.line_count],
    );
    return { bill: await getBill(this.db, row.bill_id), items: itemRows.map(mapBillItem), kots: [], replayed: true };
  }
}
