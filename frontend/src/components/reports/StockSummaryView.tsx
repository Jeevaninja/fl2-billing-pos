import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { StockSummary, StockSummaryRow, StockSummaryTotals } from '../../api/types'
import { filterStockGroups, stockTotals } from '../../reports/registerView'
import { money } from '../../reports/format'
import { CELL, GROUP_ROW, MlTable, NUM, ROW, TABLE, THEAD } from './parts'

/**
 * 3 · Stock Summary (Revision 1 R1) — the TN FL2 register:
 * Item | Op.Stk | Purch | Total | Sale | Closing | P.Rate | SRate | Clo.Purch Val | Clo.Sales Val | Sales Total
 * (Adj. appears only when a stock adjustment exists in the range), then the ML / unit details.
 */
export function StockSummaryView({ report }: { report: StockSummary }) {
  const [hideIdle, setHideIdle] = useState(true)
  const [query, setQuery] = useState('')
  const groups = useMemo(() => filterStockGroups(report.groups, { hideIdle, query }), [report.groups, hideIdle, query])
  const totals = useMemo(() => stockTotals(groups.flatMap((g) => g.rows)), [groups])
  const adj = report.hasAdjustments
  const columns = adj ? 13 : 12
  return (
    <section className="flex flex-col gap-3" aria-label="Stock summary">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <label className="flex min-h-11 flex-1 items-center gap-2 rounded-md border-2 border-zinc-700 bg-zinc-950 px-3 focus-within:border-amber-400">
          <Search className="size-4 text-zinc-500" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Item or code" className="min-w-0 flex-1 bg-transparent outline-none" aria-label="Search the stock summary" />
        </label>
        <label className="flex min-h-11 items-center gap-2 font-semibold text-zinc-300">
          <input type="checkbox" checked={hideIdle} onChange={(e) => setHideIdle(e.target.checked)} className="size-5 accent-emerald-500" />
          Hide items with no stock and no movement
        </label>
      </div>
      <div className="overflow-x-auto print:overflow-visible">
        <table className={TABLE}>
          <thead className={THEAD}>
            <tr className="border-b border-zinc-800">
              <th className="px-3 py-2 text-left">Item name</th>
              <th className="px-2 py-2 text-right">Op.Stk</th>
              <th className="px-2 py-2 text-right">Purch</th>
              <th className="px-2 py-2 text-right">Total</th>
              <th className="px-2 py-2 text-right">Sale</th>
              {adj && <th className="px-2 py-2 text-right">Adj.</th>}
              <th className="px-2 py-2 text-right">Closing</th>
              <th className="px-2 py-2 text-right">P.Rate</th>
              <th className="px-2 py-2 text-right">SRate</th>
              <th className="px-2 py-2 text-right">Clo.Purch Val</th>
              <th className="px-2 py-2 text-right">Clo.Sales Val</th>
              <th className="px-2 py-2 text-right">Sales Total</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr>
                <td colSpan={columns} className="px-3 py-4 text-zinc-500">
                  Nothing to show for this range.
                </td>
              </tr>
            )}
            {groups.map((g) => [
              <tr key={`h-${g.categoryName}`} className="bg-zinc-800 print:bg-zinc-200">
                <td colSpan={columns} className="px-3 py-1.5 text-xs font-black tracking-widest uppercase">
                  {g.categoryName}
                </td>
              </tr>,
              ...g.rows.map((r) => <ItemRow key={r.skuId} row={r} adj={adj} />),
              <TotalsRow key={`t-${g.categoryName}`} label={`${g.categoryName} total`} totals={g.totals} adj={adj} className={GROUP_ROW} />,
            ])}
          </tbody>
          <tfoot>
            <TotalsRow label="Grand total" totals={totals} adj={adj} className="border-t-2 border-zinc-700 text-base font-black" />
          </tfoot>
        </table>
      </div>
      {totals.unratedCount > 0 && (
        <p className="text-sm text-amber-300 print:text-black">
          {totals.unratedCount} item{totals.unratedCount === 1 ? '' : 's'} ({totals.unratedClosingQty} bottles) have no purchase rate — no GRN cost and no catalog purchase price —
          so they are left out of Clo.Purch Val.
        </p>
      )}
      <p className="text-sm text-zinc-500 print:text-black">
        Total = Op.Stk + Purch · Closing = Total − Sale{adj ? ' + Adj.' : ''}. P.Rate is the last purchase cost on or before the end date (GRN; else the catalog purchase price;
        ₹0 scheme bottles skipped). SRate is the current selling price. Op.Stk includes the opening count of items added inside the range.
      </p>
      <MlTable ml={report.ml} />
    </section>
  )
}

const dim = (n: number) => (n === 0 ? 'text-zinc-600 print:text-black' : '')

function ItemRow({ row: r, adj }: { row: StockSummaryRow; adj: boolean }) {
  return (
    <tr className={ROW}>
      <td className={CELL}>
        {r.name}
        <span className="ml-2 font-mono text-xs text-zinc-500 print:hidden">{r.skuCode}</span>
        {!r.isActive && <span className="ml-2 text-xs text-zinc-500">(inactive)</span>}
      </td>
      <td className={`${NUM} ${dim(r.opStk)}`}>{r.opStk}</td>
      <td className={`${NUM} ${dim(r.purch)}`}>{r.purch}</td>
      <td className={`${NUM} ${dim(r.total)}`}>{r.total}</td>
      <td className={`${NUM} ${dim(r.sale)}`}>{r.sale}</td>
      {adj && <td className={`${NUM} ${dim(r.adj)}`}>{r.adj}</td>}
      <td className={`${NUM} font-bold`}>{r.closing}</td>
      <td className={NUM} title={r.pRateSource === 'CATALOG' ? 'Catalog purchase price (no GRN cost yet)' : undefined}>
        {r.pRatePaise === null ? '—' : money(r.pRatePaise)}
        {r.pRateSource === 'CATALOG' && <sup className="text-zinc-500">c</sup>}
      </td>
      <td className={NUM}>{money(r.sRatePaise)}</td>
      <td className={NUM}>{r.cloPurchValPaise === null ? '—' : money(r.cloPurchValPaise)}</td>
      <td className={NUM}>{money(r.cloSalesValPaise)}</td>
      <td className={NUM}>{money(r.salesTotalPaise)}</td>
    </tr>
  )
}

function TotalsRow({ label, totals: t, adj, className }: { label: string; totals: StockSummaryTotals; adj: boolean; className: string }) {
  return (
    <tr className={className}>
      <td className={CELL}>{label}</td>
      <td className={NUM}>{t.opStk}</td>
      <td className={NUM}>{t.purch}</td>
      <td className={NUM}>{t.total}</td>
      <td className={NUM}>{t.sale}</td>
      {adj && <td className={NUM}>{t.adj}</td>}
      <td className={NUM}>{t.closing}</td>
      <td />
      <td />
      <td className={NUM}>{money(t.cloPurchValPaise)}</td>
      <td className={NUM}>{money(t.cloSalesValPaise)}</td>
      <td className={NUM}>{money(t.salesTotalPaise)}</td>
    </tr>
  )
}
