import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { OrderSummaryReport } from '../../api/types'
import { formatBusinessDate } from '../../reports/dateRange'
import { filterOrders, itemsSummary, kotLabel, orderTags, PAGE_SIZE, pageCount, paidByLabel, rungBy } from '../../reports/registerView'
import { money, timeOf } from '../../reports/format'
import { CELL, NUM, ROW, TABLE, THEAD } from './parts'

/** 2 · Order Summary: every bill in order with who rang it, peak session, KOTs and VOID / CANCEL tags. */
export function OrdersView({ report }: { report: OrderSummaryReport }) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const rows = useMemo(() => filterOrders(report.rows, query), [report.rows, query])
  const pages = pageCount(rows.length)
  const at = Math.min(page, pages - 1)
  const showDate = report.range.startDate !== report.range.endDate
  const span = showDate ? 7 : 6
  return (
    <section className="flex flex-col gap-3" aria-label="Order summary">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <label className="flex min-h-11 flex-1 items-center gap-2 rounded-md border-2 border-zinc-700 bg-zinc-950 px-3 focus-within:border-amber-400">
          <Search className="size-4 text-zinc-500" aria-hidden />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
            placeholder="Bill no., item, waiter or cashier"
            className="min-w-0 flex-1 bg-transparent outline-none"
            aria-label="Search the orders"
          />
        </label>
        {pages > 1 && (
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => setPage(Math.max(0, at - 1))} disabled={at === 0} className="min-h-11 rounded-md border-2 border-zinc-700 px-3 font-bold disabled:opacity-40">
              ‹ Prev
            </button>
            <span className="text-sm text-zinc-400">
              Page {at + 1} of {pages}
            </span>
            <button type="button" onClick={() => setPage(Math.min(pages - 1, at + 1))} disabled={at >= pages - 1} className="min-h-11 rounded-md border-2 border-zinc-700 px-3 font-bold disabled:opacity-40">
              Next ›
            </button>
          </span>
        )}
      </div>
      <table className={TABLE}>
        <thead className={THEAD}>
          <tr className="border-b border-zinc-800">
            {showDate && <th className="px-3 py-2 text-left">Date</th>}
            <th className="px-3 py-2 text-right">Bill</th>
            <th className="px-3 py-2 text-left">Time</th>
            <th className="px-3 py-2 text-left">Rung by · Peak · KOT</th>
            <th className="px-3 py-2 text-left">Items</th>
            <th className="px-3 py-2 text-left">Paid by</th>
            <th className="px-3 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={span} className="px-3 py-4 text-zinc-500">
                {report.rows.length === 0 ? 'No bills in this range.' : 'No bill matches.'}
              </td>
            </tr>
          )}
          {/* On screen one page; on paper every bill. */}
          {rows.map((r, i) => {
            const reversal = r.kind === 'REVERSAL'
            const onPage = Math.floor(i / PAGE_SIZE) === at
            const tags = orderTags(r)
            return (
              <tr key={r.billId} className={`${ROW} ${onPage ? '' : 'hidden print:table-row'} ${reversal ? 'text-rose-300 print:text-black' : ''}`}>
                {showDate && <td className={`${CELL} whitespace-nowrap text-zinc-400 print:text-black`}>{formatBusinessDate(r.businessDate)}</td>}
                <td className={`${NUM} font-bold`}>#{r.billNo}</td>
                <td className={`${CELL} font-mono tabular-nums`}>{timeOf(r.createdAt)}</td>
                <td className={`${CELL} text-zinc-300 print:text-black`}>
                  {rungBy(r)}
                  {r.peakSessionNo !== null && <span className="ml-2 rounded bg-violet-500/20 px-1.5 py-0.5 text-xs font-bold">PEAK #{r.peakSessionNo}</span>}
                  {r.kots.length > 0 && <span className="ml-2 font-mono text-xs text-zinc-400 print:text-black">{r.kots.map((k) => kotLabel(r.billNo, k)).join(', ')}</span>}
                </td>
                <td className={CELL}>
                  {tags.map((t) => (
                    <span key={t} className="mr-2 rounded bg-rose-500/20 px-1.5 py-0.5 text-xs font-black uppercase print:border print:border-black print:bg-white">
                      {t}
                    </span>
                  ))}
                  <span className={r.voidedBy ? 'line-through decoration-zinc-500' : ''}>{itemsSummary(r.items)}</span>
                </td>
                <td className={`${CELL} whitespace-nowrap text-zinc-300 print:text-black`}>
                  {paidByLabel(r)}
                  {r.waiterName && r.source !== 'WAITER_APP' ? ` · ${r.waiterName}` : ''}
                </td>
                <td className={`${NUM} font-bold`}>{money(r.totalPaise)}</td>
              </tr>
            )
          })}
        </tbody>
        <tfoot className="font-bold">
          <tr className="border-t-2 border-zinc-700">
            <td colSpan={span - 1} className="px-3 py-2 text-right">
              {report.totals.billCount} bills
            </td>
            <td className={NUM}>{money(report.totals.salesPaise)}</td>
          </tr>
          <tr>
            <td colSpan={span - 1} className="px-3 py-1 text-right text-rose-300 print:text-black">
              {report.totals.reversalCount} void{report.totals.reversalCount === 1 ? '' : 's'} · {report.totals.cancelledQty} item{report.totals.cancelledQty === 1 ? '' : 's'} cancelled
              before settlement
            </td>
            <td className={`${NUM} text-rose-300 print:text-black`}>{money(report.totals.reversalsPaise)}</td>
          </tr>
          <tr className="text-lg font-black">
            <td colSpan={span - 1} className="px-3 py-2 text-right">
              Net sales
            </td>
            <td className={NUM}>{money(report.totals.netPaise)}</td>
          </tr>
        </tfoot>
      </table>
      {report.openBillCount > 0 && (
        <p className="text-sm text-amber-300 print:text-black">
          {report.openBillCount} open tab{report.openBillCount === 1 ? '' : 's'} not listed: not a sale until settled.
        </p>
      )}
    </section>
  )
}
