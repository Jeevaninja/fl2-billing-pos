import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatKot, PrinterService, type KotTicket } from '../../src/services/index.js';

const ticket: KotTicket = {
  kotNo: 17,
  billId: 'bill-17',
  station: 'COUNTER',
  waiter: { code: 'W01', displayName: 'Suresh' },
  member: { membershipNo: 'M-0001', displayName: 'Anil Kumar' },
  lines: [
    { skuCode: 'HRUM-F', displayName: 'House Rum - Full', sizeCode: 'FULL', quantity: 2 },
    { skuCode: 'HLAG-650', displayName: 'A Very Long Imported Single Malt Name Edition', sizeCode: 'BEER_650', quantity: 12 },
  ],
  createdAt: new Date('2026-10-14T15:00:00Z'), // 20:30 IST
};

describe('formatKot', () => {
  it('renders an 80 mm (48-column) ticket: header, waiter, member, quantities and sizes, no prices', () => {
    expect(formatKot(ticket)).toBe(
      [
        '================================================',
        '               KOT #17 - COUNTER',
        '================================================',
        'Bill #17                       14/10/2026, 20:30',
        'Waiter: W01 Suresh',
        'Member: M-0001 Anil Kumar',
        '------------------------------------------------',
        'QTY  ITEM                                  SIZE',
        '  2  House Rum - Full                      FULL',
        ' 12  A Very Long Imported Single Malt Na. 650ML',
        '------------------------------------------------',
        'Lines: 2   Bottles: 14',
        '================================================',
      ].join('\n'),
    );
  });

  it('fits 58 mm paper (32 columns), omits the member line for walk-ins and never prints money', () => {
    const text = formatKot({ ...ticket, member: null }, { width: 32 });
    const lines = text.split('\n');
    expect(Math.max(...lines.map((l) => l.length))).toBe(32);
    expect(text).not.toContain('Member:');
    expect(text).not.toMatch(/₹|\d+\.\d{2}/);
    expect(lines).toContain(' 12  A Very Long Importe. 650ML');
  });

  it('formats the time in the configured zone', () => {
    expect(formatKot(ticket, { timeZone: 'UTC' })).toContain('14/10/2026, 15:00');
  });
});

describe('PrinterService (stub)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the formatted ticket to console.log by default and reports the station', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await new PrinterService().printKOT(ticket);
    expect(log).toHaveBeenCalledWith(formatKot(ticket));
    expect(result).toEqual({ station: 'COUNTER', printedAt: expect.any(Date), text: formatKot(ticket) });
  });

  it('accepts a custom sink and paper width', async () => {
    const sink = vi.fn();
    await new PrinterService({ sink, width: 32 }).printKOT(ticket);
    expect(sink).toHaveBeenCalledWith(formatKot(ticket, { width: 32 }));
  });
});
