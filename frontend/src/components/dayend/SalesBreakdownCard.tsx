import type { SalesBreakdown } from '../../api/types'
import { salesCard } from '../../dayend/salesRows'
import { formatPaise } from '../../lib/money'

/** How the day's revenue was collected: normal bills by tender, peak sales split by the UPI readings. */
export function SalesBreakdownCard({ sales }: { sales: SalesBreakdown }) {
  const card = salesCard(sales)
  return (
    <section className="rounded-lg border-2 border-zinc-700 bg-zinc-950 p-4">
      <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">Sales breakdown</h2>
      <table className="mt-2 w-full font-mono text-sm tabular-nums">
        <thead>
          <tr className="text-xs text-zinc-500 uppercase">
            <th className="py-1 text-left font-sans font-bold tracking-wider">&nbsp;</th>
            <th className="py-1 text-right font-sans font-bold tracking-wider">Cash</th>
            <th className="py-1 text-right font-sans font-bold tracking-wider">UPI</th>
            <th className="py-1 text-right font-sans font-bold tracking-wider">Credit</th>
            <th className="py-1 text-right font-sans font-bold tracking-wider">Total</th>
          </tr>
        </thead>
        <tbody>
          {card.rows.map((row) => {
            const strong = row.key === 'total'
            return (
              <tr key={row.key} className={strong ? 'border-t-2 border-zinc-700 text-base font-black' : ''}>
                <th scope="row" className={`py-1 pr-2 text-left font-sans ${strong ? 'font-bold' : 'font-normal text-zinc-300'}`}>
                  {row.label}
                </th>
                <td className={`py-1 pl-2 text-right ${row.cash < 0n ? 'text-amber-300' : ''}`}>{formatPaise(row.cash)}</td>
                <td className="py-1 pl-2 text-right">{formatPaise(row.upi)}</td>
                <td className="py-1 pl-2 text-right">{row.credit === null ? <span className="text-zinc-600">—</span> : formatPaise(row.credit)}</td>
                <td className="py-1 pl-2 text-right">{formatPaise(row.total)}</td>
              </tr>
            )
          })}
          <tr className="text-zinc-400">
            <th scope="row" className="py-1 pr-2 text-left font-sans font-normal">Waiter repayments</th>
            <td className="py-1 pl-2 text-right">{formatPaise(card.repayments.cash)}</td>
            <td className="py-1 pl-2 text-right">{formatPaise(card.repayments.upi)}</td>
            <td colSpan={2} className="py-1 pl-2 text-right font-sans text-xs text-zinc-500">
              credit collected, not sales
            </td>
          </tr>
        </tbody>
      </table>
      {card.warnings.map((w) => (
        <p key={w} className="mt-2 text-sm font-semibold text-amber-300">
          {w}
        </p>
      ))}
      <p className="mt-2 text-xs text-zinc-500">
        Peak UPI is the UPI reading&rsquo;s movement less UPI taken on bills and repayments during the peak; peak cash = peak sales − peak UPI.
        Any peak variance stays in the cash count, and normal-bill cash taken during a peak is counted there inside the peak&rsquo;s cash.
      </p>
    </section>
  )
}
