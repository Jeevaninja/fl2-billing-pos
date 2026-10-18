/**
 * KOT (kitchen/bar order ticket) printing. Phase 5 stub: tickets are formatted as plain text and
 * written to a sink (console.log by default). The real ESC/POS network printer replaces the sink
 * with a TCP socket to the printer (port 9100) and adds the ESC/POS framing (init, cut).
 *
 * KOTs carry quantities, not prices: they tell the counter what to hand over.
 */
import type { SizeCode } from '../domain/types.js';

/** Where a ticket prints. Every category is liquor, and liquor routes to the counter printer. */
export type KotStation = 'COUNTER';

export interface KotTicket {
  /** The bill number doubles as the KOT number. */
  kotNo: number;
  billId: string;
  station: KotStation;
  waiter: { code: string; displayName: string };
  member: { membershipNo: string; displayName: string } | null;
  lines: Array<{ skuCode: string; displayName: string; sizeCode: SizeCode; quantity: number }>;
  createdAt: Date;
}

export interface KotPrintResult {
  station: KotStation;
  printedAt: Date;
  /** The exact text sent to the printer. */
  text: string;
}

/** What the Captain order flow needs from a printer; swap in an ESC/POS implementation later. */
export interface KotPrinter {
  printKOT(ticket: KotTicket): Promise<KotPrintResult>;
}

export interface KotFormat {
  /** Characters per line: 48 for 80 mm paper (Font A), 32 for 58 mm. */
  width?: number;
  timeZone?: string;
}

const SIZE_LABEL: Record<SizeCode, string> = { FULL: 'FULL', HALF: 'HALF', QUARTER: 'QTR', BEER_650: '650ML', BEER_330: '330ML' };

function fit(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}.`; // ASCII: printer code pages
}

function center(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return (' '.repeat(pad) + text).padEnd(width);
}

/** Renders a ticket as fixed-width text. Pure, so it is unit-tested directly. */
export function formatKot(ticket: KotTicket, { width = 48, timeZone = 'Asia/Kolkata' }: KotFormat = {}): string {
  const rule = (ch: string) => ch.repeat(width);
  const when = new Intl.DateTimeFormat('en-IN', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ticket.createdAt);
  const qtyWidth = 4;
  const sizeWidth = 6;
  const nameWidth = width - qtyWidth - sizeWidth - 2;
  const bottles = ticket.lines.reduce((n, l) => n + l.quantity, 0);

  const header = `KOT #${ticket.kotNo} - ${ticket.station}`;
  const meta = `Bill #${ticket.kotNo}`;
  return [
    rule('='),
    center(header, width),
    rule('='),
    `${meta}${when.padStart(width - meta.length)}`,
    fit(asciiText(`Waiter: ${ticket.waiter.code} ${ticket.waiter.displayName}`), width),
    ...(ticket.member ? [fit(asciiText(`Member: ${ticket.member.membershipNo} ${ticket.member.displayName}`), width)] : []),
    rule('-'),
    `${'QTY'.padStart(qtyWidth - 1)}  ${fit('ITEM', nameWidth)}${'SIZE'.padStart(sizeWidth)}`,
    ...ticket.lines.map(
      (l) => `${String(l.quantity).padStart(qtyWidth - 1)}  ${fit(asciiText(l.displayName), nameWidth)}${SIZE_LABEL[l.sizeCode].padStart(sizeWidth)}`,
    ),
    rule('-'),
    `Lines: ${ticket.lines.length}   Bottles: ${bottles}`,
    rule('='),
  ]
    .map((line) => line.trimEnd())
    .join('\n');
}

// ── Customer receipt (Phase 17 reprint) ─────────────────────────────────────

export interface ReceiptLine {
  displayName: string;
  sizeCode: SizeCode;
  quantity: number;
  unitPricePaise: bigint;
  amountPaise: bigint;
}

export interface ReceiptTicket {
  billNo: number;
  createdAt: Date;
  /** Shown under the bill number: "Counter 1", "W01 Suresh", "Peak #2". */
  servedBy: string;
  member: { membershipNo: string; displayName: string } | null;
  /** Lines with bottles left (cancelled bottles are not on the customer's receipt). */
  lines: ReceiptLine[];
  totalPaise: bigint;
  /** Positive tenders, in order. WAITER_CREDIT prints as "Waiter credit". */
  payments: Array<{ tender: 'CASH' | 'UPI' | 'WAITER_CREDIT'; amountPaise: bigint }>;
  duePaise: bigint;
  /** A status line under the totals, e.g. "VOIDED 21:05 - wrong bottle" or "PEAK SALE - settled at session end". */
  note: string | null;
  /** Set on a reprint: the receipt says DUPLICATE and when it was printed. */
  reprintedAt: Date | null;
}

export interface ReceiptPrintResult {
  printedAt: Date;
  text: string;
}

/** What the Orders reprint needs from a printer. */
export interface ReceiptPrinter {
  printReceipt(ticket: ReceiptTicket): Promise<ReceiptPrintResult>;
}

const TENDER_LABEL: Record<ReceiptTicket['payments'][number]['tender'], string> = { CASH: 'Cash', UPI: 'UPI', WAITER_CREDIT: 'Waiter credit' };

/** Thermal printer code pages are ASCII: dashes fold to "-", accents to their letters, anything else drops. */
export function asciiText(text: string): string {
  return text
    .replace(/[\u2012-\u2015\u2212]/g, '-')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** "Rs 1,23,456.78": Indian digit grouping in ASCII (printer code pages), from whole paise. */
export function receiptMoney(paise: bigint): string {
  const sign = paise < 0n ? '-' : '';
  const abs = paise < 0n ? -paise : paise;
  const rupees = (abs / 100n).toString();
  const head = rupees.length > 3 ? rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '';
  return `${sign}Rs ${head}${rupees.slice(-3)}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** Renders a customer receipt as fixed-width text. Pure. No tax lines (no GST engine in Phase 1). */
export function formatReceipt(ticket: ReceiptTicket, { width = 48, timeZone = 'Asia/Kolkata' }: KotFormat = {}): string {
  const rule = (ch: string) => ch.repeat(width);
  const stamp = (d: Date) =>
    new Intl.DateTimeFormat('en-IN', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const pair = (left: string, right: string) => `${fit(left, Math.max(1, width - right.length - 1))} ${right}`;
  const amountWidth = 13;
  const qtyWidth = 4;
  const nameWidth = width - (qtyWidth - 1) - 2 - amountWidth;
  const bottles = ticket.lines.reduce((n, l) => n + l.quantity, 0);
  const meta = `Bill #${ticket.billNo}`;
  const when = stamp(ticket.createdAt);

  return [
    rule('='),
    center('FL2', width),
    ...(ticket.reprintedAt ? [center('*** DUPLICATE ***', width)] : []),
    rule('='),
    `${meta}${when.padStart(width - meta.length)}`,
    fit(asciiText(ticket.servedBy), width),
    ...(ticket.member ? [fit(asciiText(`Member: ${ticket.member.membershipNo} ${ticket.member.displayName}`), width)] : []),
    rule('-'),
    `${'QTY'.padStart(qtyWidth - 1)}  ${fit('ITEM', nameWidth)}${'AMOUNT'.padStart(amountWidth)}`,
    ...ticket.lines.flatMap((l) => [
      // Catalog names already carry the size ("House Rum - Quarter").
      `${String(l.quantity).padStart(qtyWidth - 1)}  ${fit(asciiText(l.displayName), nameWidth)}${receiptMoney(l.amountPaise).padStart(amountWidth)}`,
      ...(l.quantity > 1 ? [`${' '.repeat(qtyWidth + 1)}@ ${receiptMoney(l.unitPricePaise)}`] : []),
    ]),
    rule('-'),
    pair(`TOTAL  (${bottles} btl)`, receiptMoney(ticket.totalPaise)),
    ...ticket.payments.map((p) => pair(`  ${TENDER_LABEL[p.tender]}`, receiptMoney(p.amountPaise))),
    ...(ticket.duePaise > 0n ? [pair('  DUE', receiptMoney(ticket.duePaise))] : []),
    ...(ticket.note ? [rule('-'), fit(asciiText(ticket.note), width)] : []),
    rule('='),
    ...(ticket.reprintedAt ? [center(`Reprinted ${stamp(ticket.reprintedAt)}`, width)] : []),
    center('Thank you', width),
  ]
    .map((line) => line.trimEnd())
    .join('\n');
}

/** Stub ESC/POS printer: formats the ticket and writes it to `sink`. */
export class PrinterService implements KotPrinter, ReceiptPrinter {
  private readonly sink: (text: string) => void;
  private readonly format: KotFormat;

  constructor(options: { sink?: (text: string) => void } & KotFormat = {}) {
    const { sink = (text: string) => console.log(text), ...format } = options;
    this.sink = sink;
    this.format = format;
  }

  async printKOT(ticket: KotTicket): Promise<KotPrintResult> {
    const text = formatKot(ticket, this.format);
    this.sink(text);
    return { station: ticket.station, printedAt: new Date(), text };
  }

  async printReceipt(ticket: ReceiptTicket): Promise<ReceiptPrintResult> {
    const text = formatReceipt(ticket, this.format);
    this.sink(text);
    return { printedAt: new Date(), text };
  }
}
