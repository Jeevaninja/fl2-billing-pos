/**
 * KOT routing (Phase 19, migration 0013). Every bill line belongs to a department, and each
 * department prints at one station: liquor and ancillary at the BAR, kitchen at the KITCHEN.
 *
 * kot_tickets / kot_ticket_lines record what each station has been sent, so a send prints only
 * what is still pending for each line:
 *
 *   pending = net quantity (the line less its cancellations) − Σ quantity already sent
 *
 * A positive pending prints; a negative one (a dish cancelled after it was sent) prints as CANCEL.
 * Each station is one transaction: lock the bill, record the ticket, print it, commit. A printer
 * error rolls that station back, so its lines stay pending and the next send retries them. A print
 * never undoes the sale, which is always committed before a send.
 */
import type { SqlDatabase } from '../db/client.js';
import { NotFoundError } from '../db/errors.js';
import type { KotStation, SizeCode } from '../domain/types.js';
import type { KotPrinter, KotTicket } from './printer.service.js';
import { maybeOne, one } from './rows.js';

export interface KotStatus {
  station: KotStation;
  /** Per bill and station (KOT #12/2 → 2); null when printing failed. */
  ticketNo: number | null;
  printed: boolean;
  printedAt: Date | null;
  /** Quantity sent on this ticket. */
  sentQuantity: number;
  /** Quantity cancelled on this ticket (lines sent earlier, since cancelled). */
  cancelledQuantity: number;
  /** Why printing failed; the sale itself is already saved and its lines stay pending. */
  error: string | null;
}

/** Who sends: the counter (a staff id) or a Captain handset. */
export type KotSender = { staffId: string } | { deviceId: string };

export interface KotSendOptions {
  /** Stations to send to. Default: the KITCHEN only (the counter is the bar). */
  stations?: readonly KotStation[] | undefined;
  /**
   * Count lines reversed on a reversal bill as cancelled too. Only the peak "undo last scan" uses
   * this: a refund reversal of a served bill must not cancel food at the kitchen.
   */
  includeReversals?: boolean | undefined;
}

interface PendingRow {
  id: string;
  sku_code_snapshot: string;
  display_name_snapshot: string;
  size_code_snapshot: SizeCode;
  pending: number;
}

interface TicketBillRow {
  bill_no: number;
  created_at: Date;
  waiter_code: string | null;
  waiter_name: string | null;
  membership_no: string | null;
  member_name: string | null;
}

export class KotService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly printer: KotPrinter,
  ) {}

  /**
   * Prints whatever is pending on the bill, one ticket per station that has anything. Returns a
   * status per ticket attempted (empty when nothing was pending). Throws only for a missing bill.
   */
  async sendPending(billId: string, by: KotSender, options: KotSendOptions = {}): Promise<KotStatus[]> {
    const exists = await maybeOne(this.db, `SELECT 1 FROM bills WHERE id = $1`, [billId]);
    if (!exists) throw new NotFoundError('bill', billId);

    const statuses: KotStatus[] = [];
    for (const station of options.stations ?? ['KITCHEN']) {
      // Set inside the transaction callback, so held in an object (closures defeat narrowing).
      const state: { attempt: KotStatus | null } = { attempt: null };
      try {
        await this.db.transaction(async (tx) => {
          const bill = await one<TicketBillRow>(
            tx,
            `SELECT b.bill_no, b.created_at, w.waiter_code, w.display_name AS waiter_name,
                    m.membership_no, m.display_name AS member_name
               FROM bills b
               LEFT JOIN waiters w ON w.id = b.waiter_id
               LEFT JOIN members m ON m.id = b.member_id
              WHERE b.id = $1
                FOR UPDATE OF b`,
            [billId],
          );
          const { rows } = await tx.query<PendingRow>(
            `SELECT i.id, i.sku_code_snapshot, i.display_name_snapshot, i.size_code_snapshot,
                    (i.qty
                     + coalesce((SELECT sum(c.qty) FROM bill_items c
                                  WHERE c.reverses_item_id = i.id AND ($3 OR c.bill_id = i.bill_id)), 0)
                     - coalesce((SELECT sum(k.qty) FROM kot_ticket_lines k WHERE k.bill_item_id = i.id), 0))::int AS pending
               FROM bill_items i
               JOIN departments d ON d.code = i.department
              WHERE i.bill_id = $1 AND i.qty > 0 AND d.kot_station = $2
              ORDER BY i.line_no`,
            [billId, station, options.includeReversals === true],
          );
          const lines = rows.filter((r) => r.pending !== 0);
          if (lines.length === 0) return;

          const sentQuantity = lines.reduce((n, l) => n + Math.max(l.pending, 0), 0);
          const cancelledQuantity = lines.reduce((n, l) => n + Math.max(-l.pending, 0), 0);
          const attempt: KotStatus = { station, ticketNo: null, printed: false, printedAt: null, sentQuantity, cancelledQuantity, error: null };
          state.attempt = attempt;

          const ticket = await one<{ id: string; ticket_no: number; printed_at: Date }>(
            tx,
            `INSERT INTO kot_tickets (bill_id, station, ticket_no, created_by_staff_id, captain_device_id)
             VALUES ($1, $2, (SELECT coalesce(max(ticket_no), 0) + 1 FROM kot_tickets WHERE bill_id = $1 AND station = $2), $3, $4)
             RETURNING id, ticket_no, printed_at`,
            [billId, station, 'staffId' in by ? by.staffId : null, 'deviceId' in by ? by.deviceId : null],
          );
          for (const line of lines) {
            await tx.query(`INSERT INTO kot_ticket_lines (ticket_id, bill_item_id, qty) VALUES ($1, $2, $3)`, [ticket.id, line.id, line.pending]);
          }

          const kot: KotTicket = {
            kotNo: bill.bill_no,
            ticketNo: ticket.ticket_no,
            billId,
            station,
            waiter: bill.waiter_code === null ? null : { code: bill.waiter_code, displayName: bill.waiter_name ?? '' },
            member: bill.membership_no === null ? null : { membershipNo: bill.membership_no, displayName: bill.member_name ?? '' },
            lines: ticketLines(lines),
            createdAt: ticket.printed_at,
          };
          const printed = await this.printer.printKOT(kot);
          state.attempt = { ...attempt, ticketNo: ticket.ticket_no, printed: true, printedAt: printed.printedAt };
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        state.attempt = state.attempt ? { ...state.attempt, ticketNo: null, printed: false, printedAt: null, error } : failed(station, error);
      }
      if (state.attempt) statuses.push(state.attempt);
    }
    return statuses;
  }
}

/** One printed line per SKU (two scans of a dish print as "2 ×"), sends and cancels kept apart. */
function ticketLines(lines: readonly PendingRow[]): KotTicket['lines'] {
  const merged = new Map<string, KotTicket['lines'][number]>();
  for (const l of lines) {
    const key = `${l.sku_code_snapshot}:${l.pending > 0 ? '+' : '-'}`;
    const line = merged.get(key);
    if (line) line.quantity += l.pending;
    else merged.set(key, { skuCode: l.sku_code_snapshot, displayName: l.display_name_snapshot, sizeCode: l.size_code_snapshot, quantity: l.pending });
  }
  return [...merged.values()];
}

function failed(station: KotStation, error: string): KotStatus {
  return { station, ticketNo: null, printed: false, printedAt: null, sentQuantity: 0, cancelledQuantity: 0, error };
}
