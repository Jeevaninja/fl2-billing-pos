import type { SalesBreakdown, TenderAdjustmentEntry } from '../../api/types'
import { salesCard } from '../../dayend/salesRows'
import { describeShift } from '../../dayend/tallyForm'
import { formatPaise } from '../../lib/money'
import { FOCUS_RING, keepFocus } from '../../lib/ui'
import { Kbd } from '../ui'

interface SalesBreakdownCardProps {
  sales: SalesBreakdown
  adjustments: TenderAdjustmentEntry[]
  /** Open day only: opens the tally dialog (F7). */
  onAdjust?: (() => void) | undefined
  /** Open day only: asks to void an adjustment. */
  onVoid?: ((adjustment: TenderAdjustmentEntry) => void) | undefined
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** How the day's revenue was collected: normal bills by tender, peak sales split by the UPI readings. */
export function SalesBreakdownCard({ sales, adjustments, onAdjust, onVoid }: SalesBreakdownCardProps) {
  const card = salesCard(sales)
  const { normal } = sales
  const adjusted = normal.cashPaise !== normal.systemCashPaise
  return (
    <section className="rounded-lg border-2 border-zinc-700 bg-zinc-950 p-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">Sales breakdown</h2>
        {onAdjust && (
          <button
            type="button"
            {...keepFocus}
            onClick={onAdjust}
            className={`ml-auto flex items-center gap-2 rounded-md border-2 border-zinc-600 px-3 py-1 text-sm font-bold text-zinc-200 hover:border-amber-400 ${FOCUS_RING}`}
          >
            Adjust Cash ⇄ UPI <Kbd>F7</Kbd>
          </button>
        )}
      </div>
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
                <td className={`py-1 pl-2 text-right ${row.cash < 0n ? 'text-amber-300' : ''}`}>
                  {formatPaise(row.cash)}
                  {row.key === 'normal' && adjusted && <SystemNote value={normal.systemCashPaise} />}
                </td>
                <td className="py-1 pl-2 text-right">
                  {formatPaise(row.upi)}
                  {row.key === 'normal' && adjusted && <SystemNote value={normal.systemUpiPaise} />}
                </td>
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
      <div className="mt-3 border-t border-zinc-800 pt-2">
        <h3 className="text-xs font-bold tracking-widest text-zinc-500 uppercase">By revenue center</h3>
        <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 font-mono text-sm tabular-nums">
          {card.departments.map((d) => (
            <div key={d.key} className={`contents ${d.key === 'total' ? 'text-base font-black' : d.key === 'open' ? 'text-amber-300' : ''}`}>
              <dt className={`py-0.5 font-sans ${d.key === 'total' ? 'border-t border-zinc-700 font-bold' : 'text-zinc-300'}`}>{d.label}</dt>
              <dd className={`py-0.5 text-right ${d.key === 'total' ? 'border-t border-zinc-700' : ''}`}>{formatPaise(d.amount)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-1 text-xs text-zinc-500">For the P&amp;L only — every center&rsquo;s cash goes to the one drawer and one Expected cash. Centers with no sales are left out.</p>
      </div>
      {adjustments.length > 0 && (
        <div className="mt-3 border-t border-zinc-800 pt-2">
          <h3 className="text-xs font-bold tracking-widest text-zinc-500 uppercase">Tally adjustments</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {adjustments.map((a) => (
              <li key={a.id} className={`flex items-center gap-3 ${a.voidedAt ? 'text-zinc-600 line-through' : 'text-zinc-300'}`}>
                <span className="font-mono text-zinc-500">{clock(a.createdAt)}</span>
                <span className="font-mono font-bold whitespace-nowrap">{describeShift(a.cashDeltaPaise)}</span>
                <span className="min-w-0 flex-1 truncate" title={a.reason}>
                  {a.reason}
                </span>
                {a.voidedAt ? (
                  <span className="text-xs no-underline">voided {clock(a.voidedAt)}</span>
                ) : (
                  onVoid && (
                    <button type="button" {...keepFocus} onClick={() => onVoid(a)} className="rounded border border-zinc-600 px-2 py-0.5 text-xs font-bold hover:border-rose-400">
                      Void
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
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

function SystemNote({ value }: { value: bigint }) {
  return <span className="block text-xs font-normal text-zinc-500">system {formatPaise(value)}</span>
}
