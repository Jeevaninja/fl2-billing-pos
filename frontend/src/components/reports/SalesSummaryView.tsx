import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { MemberSales, SalesSummary } from '../../api/types'
import { departmentChip } from '../../lib/departments'
import { formatBusinessDate } from '../../reports/dateRange'
import { groupSalesSummary } from '../../reports/registerView'
import { money, timeOf } from '../../reports/format'
import { CELL, GROUP_ROW, MlTable, NUM, ROW, TABLE, THEAD } from './parts'

export type SalesMode = 'items' | 'members'

/**
 * 1 · Sales Summary (R3): one row per item — never one per bill line — grouped by revenue center and
 * category, then the ML / unit details. Member-wise: tagged bills per member visit; untagged sales on
 * their own line (never assigned to a member).
 */
export function SalesSummaryView({ summary, members, mode, onMode }: { summary: SalesSummary; members: MemberSales; mode: SalesMode; onMode: (m: SalesMode) => void }) {
  return (
    <section className="flex flex-col gap-4" aria-label="Sales summary">
      <div className="flex gap-2 print:hidden" role="group" aria-label="View">
        {(['items', 'members'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => onMode(m)}
            className={`min-h-11 rounded-md border-2 px-4 font-bold ${mode === m ? 'border-amber-400 bg-amber-400 text-zinc-950' : 'border-zinc-700 text-zinc-300 hover:border-zinc-400'}`}
          >
            {m === 'items' ? 'By item' : 'Member-wise'}
          </button>
        ))}
      </div>
      {mode === 'items' ? <ByItem summary={summary} /> : <ByMember report={members} />}
    </section>
  )
}

function ByItem({ summary }: { summary: SalesSummary }) {
  const [query, setQuery] = useState('')
  const centers = useMemo(() => groupSalesSummary(summary.rows, query), [summary.rows, query])
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {summary.byCenter.map((c) => (
          <span key={c.code} className={`rounded-md border-2 px-3 py-1.5 font-bold ${departmentChip(c.code)} print:border-zinc-400 print:bg-white print:text-black`}>
            {c.name} <span className="font-mono tabular-nums">{money(c.amountPaise)}</span>
          </span>
        ))}
        <span className="rounded-md border-2 border-zinc-200 px-3 py-1.5 font-black print:border-black">
          Total <span className="font-mono tabular-nums">{money(summary.totalPaise)}</span>
        </span>
      </div>
      <label className="flex min-h-11 items-center gap-2 rounded-md border-2 border-zinc-700 bg-zinc-950 px-3 focus-within:border-amber-400 print:hidden">
        <Search className="size-4 text-zinc-500" aria-hidden />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Item or code" className="min-w-0 flex-1 bg-transparent outline-none" aria-label="Search items" />
      </label>
      <table className={TABLE}>
        <thead className={THEAD}>
          <tr className="border-b border-zinc-800">
            <th className="px-3 py-2 text-left">Item</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2 text-right">SRate</th>
            <th className="px-3 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {centers.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-4 text-zinc-500">
                {summary.rows.length === 0 ? 'No sales in this range.' : 'No item matches.'}
              </td>
            </tr>
          )}
          {centers.map((c) => [
            <tr key={`c-${c.code}`} className="bg-zinc-800 print:bg-zinc-200">
              <td className="px-3 py-2 text-xs font-black tracking-widest uppercase">{c.name}</td>
              <td className={`${NUM} font-bold`}>{c.qty}</td>
              <td />
              <td className={`${NUM} font-black`}>{money(c.amountPaise)}</td>
            </tr>,
            ...c.categories.flatMap((g) => [
              <tr key={`g-${c.code}-${g.categoryName}`} className={GROUP_ROW}>
                <td className={`${CELL} pl-6 text-xs tracking-widest uppercase`}>{g.categoryName}</td>
                <td className={NUM}>{g.qty}</td>
                <td />
                <td className={NUM}>{money(g.amountPaise)}</td>
              </tr>,
              ...g.rows.map((r) => (
                <tr key={`${r.skuId}-${r.centerCode}`} className={ROW}>
                  <td className={`${CELL} pl-9`}>
                    {r.name}
                    <span className="ml-2 font-mono text-xs text-zinc-500">{r.skuCode}</span>
                  </td>
                  <td className={`${NUM} font-bold`}>{r.qty}</td>
                  <td className={NUM}>{r.sRatePaise === null ? <span title="The price changed inside this range">Mixed*</span> : money(r.sRatePaise)}</td>
                  <td className={`${NUM} font-bold`}>{money(r.amountPaise)}</td>
                </tr>
              )),
            ]),
          ])}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-zinc-700 text-lg font-black">
            <td className={CELL}>All items</td>
            <td className={NUM}>{summary.totalQty}</td>
            <td />
            <td className={NUM}>{money(summary.totalPaise)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="text-sm text-zinc-500 print:text-black">
        One line per item, net of voids and cancellations. SRate is the billed price; *Mixed = the price changed inside the range, and the amount is exactly what was
        billed.
      </p>
      <MlTable ml={summary.ml} />
    </>
  )
}

function ByMember({ report }: { report: MemberSales }) {
  const multiDay = report.range.startDate !== report.range.endDate
  return (
    <>
      <table className={TABLE}>
        <thead className={THEAD}>
          <tr className="border-b border-zinc-800">
            <th className="px-3 py-2 text-left">Member</th>
            {multiDay && <th className="px-3 py-2 text-left">Date</th>}
            <th className="px-3 py-2 text-left">First / last bill</th>
            <th className="px-3 py-2 text-left">Bills</th>
            <th className="px-3 py-2 text-left">Items purchased</th>
            <th className="px-3 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {report.members.length === 0 && (
            <tr>
              <td colSpan={multiDay ? 6 : 5} className="px-3 py-4 text-zinc-500">
                No bill in this range was tagged to a member (F2 at billing).
              </td>
            </tr>
          )}
          {report.members.map((m) =>
            m.visits.map((v, i) => (
              <tr key={`${m.memberId}-${v.businessDate}`} className={ROW}>
                <td className={CELL}>
                  {i === 0 && (
                    <>
                      <span className="font-mono font-bold">{m.membershipNo}</span> {m.name}
                    </>
                  )}
                </td>
                {multiDay && <td className={`${CELL} whitespace-nowrap`}>{formatBusinessDate(v.businessDate)}</td>}
                <td className={`${CELL} font-mono whitespace-nowrap tabular-nums`}>
                  {timeOf(v.firstBillAt)} – {timeOf(v.lastBillAt)}
                </td>
                <td className={`${CELL} font-mono`}>{v.billNos.map((n) => `#${n}`).join(' ')}</td>
                <td className={CELL}>{v.items.length === 0 ? <span className="text-zinc-500">voided / nothing net</span> : v.items.map((it) => `${it.qty}× ${it.name}`).join(', ')}</td>
                <td className={`${NUM} font-bold`}>{money(v.totalPaise)}</td>
              </tr>
            )),
          )}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-zinc-700">
            <td className={CELL} colSpan={multiDay ? 4 : 3}>
              Not tagged to a member · {report.untagged.billCount} bill{report.untagged.billCount === 1 ? '' : 's'}
            </td>
            <td className={CELL}>{report.untagged.qty} items</td>
            <td className={`${NUM} font-bold`}>{money(report.untagged.totalPaise)}</td>
          </tr>
          <tr className="text-lg font-black">
            <td className={CELL} colSpan={multiDay ? 5 : 4}>
              Total sales
            </td>
            <td className={NUM}>{money(report.totalPaise)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="text-sm text-zinc-500 print:text-black">
        Only bills tagged to a member at the counter are listed under a member. Times are the first and last bill of the visit; gate entry and exit are not recorded by the
        POS.
      </p>
    </>
  )
}
