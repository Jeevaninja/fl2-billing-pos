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
    fit(`Waiter: ${ticket.waiter.code} ${ticket.waiter.displayName}`, width),
    ...(ticket.member ? [fit(`Member: ${ticket.member.membershipNo} ${ticket.member.displayName}`, width)] : []),
    rule('-'),
    `${'QTY'.padStart(qtyWidth - 1)}  ${fit('ITEM', nameWidth)}${'SIZE'.padStart(sizeWidth)}`,
    ...ticket.lines.map(
      (l) => `${String(l.quantity).padStart(qtyWidth - 1)}  ${fit(l.displayName, nameWidth)}${SIZE_LABEL[l.sizeCode].padStart(sizeWidth)}`,
    ),
    rule('-'),
    `Lines: ${ticket.lines.length}   Bottles: ${bottles}`,
    rule('='),
  ]
    .map((line) => line.trimEnd())
    .join('\n');
}

/** Stub ESC/POS printer: formats the ticket and writes it to `sink`. */
export class PrinterService implements KotPrinter {
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
}
