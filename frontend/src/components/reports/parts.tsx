import type { ReactNode } from 'react'
import type { MlSummary, Paise } from '../../api/types'
import { money } from '../../reports/format'
import { formatLitres, formatMl } from '../../reports/registerView'

/** Shared building blocks for the Reports tabs (Phase 24): cards, lines, tables, the ML summary. */

export function Card({ title, children, total, totalLabel = 'Total' }: { title: string; children: ReactNode; total?: Paise; totalLabel?: string }) {
  return (
    <section className="flex flex-col rounded-lg border-2 border-zinc-800 bg-zinc-900 print:break-inside-avoid print:border-zinc-400 print:bg-white" aria-label={title}>
      <h2 className="border-b border-zinc-800 px-4 py-2 text-xs font-bold tracking-widest text-zinc-400 uppercase print:text-black">{title}</h2>
      <div className="flex flex-1 flex-col">{children}</div>
      {total !== undefined && (
        <div className="flex items-baseline justify-between border-t-2 border-zinc-700 px-4 py-3 text-lg font-black">
          <span>{totalLabel}</span>
          <span className="font-mono tabular-nums">{money(total)}</span>
        </div>
      )}
    </section>
  )
}

export function Line({ label, value, hint, strong = false, tone }: { label: ReactNode; value: Paise; hint?: ReactNode; strong?: boolean; tone?: 'in' | 'out' }) {
  const sign = tone === 'out' ? '− ' : tone === 'in' ? '+ ' : ''
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-800/60 px-4 py-2 last:border-b-0">
      <span className="flex min-w-0 flex-col">
        <span className={strong ? 'font-bold' : ''}>{label}</span>
        {hint && <span className="text-xs text-zinc-500 print:text-black">{hint}</span>}
      </span>
      <span className={`shrink-0 font-mono tabular-nums ${strong ? 'font-black' : 'font-semibold'}`}>
        {sign}
        {money(value)}
      </span>
    </div>
  )
}

export const Empty = ({ text }: { text: string }) => <p className="px-4 py-3 text-sm text-zinc-500">{text}</p>

export const TABLE = 'w-full rounded-lg border-2 border-zinc-800 bg-zinc-900 text-sm print:border-zinc-400 print:bg-white print:text-[11px]'
export const THEAD = 'text-xs tracking-widest text-zinc-500 uppercase print:text-black'
export const ROW = 'border-b border-zinc-800/60 align-top print:break-inside-avoid'
export const NUM = 'px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap'
export const CELL = 'px-3 py-1.5'
export const GROUP_ROW = 'bg-zinc-800/60 font-bold print:bg-zinc-100'

/** A signed amount: short (negative) in red, over (positive) in green. */
export function Variance({ value }: { value: Paise | null }) {
  if (value === null) return <span className="text-zinc-500">—</span>
  const tone = value < 0n ? 'text-rose-300' : value > 0n ? 'text-emerald-300' : ''
  const word = value < 0n ? ' short' : value > 0n ? ' over' : ''
  return (
    <span className={`${tone} print:text-black`}>
      {money(value)}
      <span className="text-xs">{word}</span>
    </span>
  )
}

/** Center filter chips for Expenses / Purchases. */
export function CenterFilter({
  centers,
  value,
  onChange,
  shared = false,
}: {
  centers: ReadonlyArray<{ code: string; name: string }>
  value: string | null
  onChange: (code: string | null) => void
  shared?: boolean
}) {
  const options = [{ code: null as string | null, name: 'All centers' }, ...centers, ...(shared ? [{ code: 'SHARED', name: 'Shared' }] : [])]
  return (
    <div className="flex flex-wrap gap-2 print:hidden" role="group" aria-label="Revenue center">
      {options.map((o) => (
        <button
          key={o.code ?? 'all'}
          type="button"
          aria-pressed={value === o.code}
          onClick={() => onChange(o.code)}
          className={`min-h-11 rounded-md border-2 px-3 font-bold ${value === o.code ? 'border-amber-400 bg-amber-400 text-zinc-950' : 'border-zinc-700 text-zinc-300 hover:border-zinc-400'}`}
        >
          {o.name}
        </button>
      ))}
    </div>
  )
}

/** R2: ML / Unit Details — bottles × nominal volume by excise group, for Sale and Closing. */
export function MlTable({ ml }: { ml: MlSummary }) {
  return (
    <section className="flex flex-col gap-2 print:break-inside-avoid" aria-label="ML / Unit details">
      <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase print:text-black">ML / Unit details</h2>
      <table className={TABLE}>
        <thead className={THEAD}>
          <tr className="border-b border-zinc-800">
            <th className="px-3 py-2 text-left">Group</th>
            <th className="px-3 py-2 text-right">Size</th>
            <th className="px-3 py-2 text-right">Sale units</th>
            <th className="px-3 py-2 text-right">Sale ml</th>
            <th className="px-3 py-2 text-right">Closing units</th>
            <th className="px-3 py-2 text-right">Closing ml</th>
          </tr>
        </thead>
        <tbody>
          {ml.groups.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-3 text-zinc-500">
                No liquor sold or in stock in this range.
              </td>
            </tr>
          )}
          {ml.groups.map((g) => [
            ...g.bySize.map((s, i) => (
              <tr key={`${g.group}-${s.volumeMl}`} className={ROW}>
                <td className={`${CELL} font-semibold`}>{i === 0 ? g.label : ''}</td>
                <td className={NUM}>{formatMl(s.volumeMl)} ml</td>
                <td className={NUM}>{s.saleUnits}</td>
                <td className={NUM}>{formatMl(s.saleMl)}</td>
                <td className={NUM}>{s.closingUnits}</td>
                <td className={NUM}>{formatMl(s.closingMl)}</td>
              </tr>
            )),
            <tr key={`${g.group}-total`} className={GROUP_ROW}>
              <td className={CELL} colSpan={2}>
                {g.label} total
              </td>
              <td className={NUM}>{g.saleUnits}</td>
              <td className={NUM}>
                {formatMl(g.saleMl)} <span className="text-xs font-normal text-zinc-400 print:text-black">({formatLitres(g.saleMl)})</span>
              </td>
              <td className={NUM}>{g.closingUnits}</td>
              <td className={NUM}>
                {formatMl(g.closingMl)} <span className="text-xs font-normal text-zinc-400 print:text-black">({formatLitres(g.closingMl)})</span>
              </td>
            </tr>,
          ])}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-zinc-700 text-base font-black">
            <td className={CELL} colSpan={2}>
              Grand total
            </td>
            <td className={NUM}>{ml.total.saleUnits}</td>
            <td className={NUM}>{formatLitres(ml.total.saleMl)}</td>
            <td className={NUM}>{ml.total.closingUnits}</td>
            <td className={NUM}>{formatLitres(ml.total.closingMl)}</td>
          </tr>
        </tfoot>
      </table>
      {ml.missing.length > 0 && (
        <p className="text-sm text-amber-300 print:text-black">
          Left out — no bottle volume or excise group set in the catalog: {ml.missing.join(', ')}.
        </p>
      )}
      <p className="text-sm text-zinc-500 print:hidden">Sale and Closing are whole sealed bottles from the stock ledger × each item&rsquo;s labelled volume.</p>
    </section>
  )
}
