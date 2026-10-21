import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../api/client'
import type { WaiterStats, WaiterStatsReport } from '../api/types'
import { Kbd } from '../components/ui'
import { formatPaise } from '../lib/money'
import { counterErrorMessage } from './errors'
import { Modal } from './Modal'
import { TrustBadge } from './PickerDialogs'
import { filterWaiters, sumStats, waiterNote } from './waiterStats'

const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_7rem] items-center gap-3'

/**
 * Petpooja-style waiter panel (F4): slides in from the right with today's open / closed bills per
 * waiter. Picking a row tags that waiter on the current billing tab. Figures are read on open.
 */
export function WaiterSidebar({
  currentWaiterId,
  onPick,
  onClose,
}: {
  currentWaiterId: string | null
  onPick: (waiter: WaiterStats) => void
  onClose: () => void
}) {
  const [report, setReport] = useState<WaiterStatsReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    let live = true
    api
      .waiterStats()
      .then((r) => live && setReport(r))
      .catch((err: unknown) => live && setError(counterErrorMessage(err)))
    return () => {
      live = false
    }
  }, [reload])

  const items = report ? filterWaiters(report.waiters, query) : []
  const active = Math.min(index, Math.max(0, items.length - 1))
  const filtered = query.trim() !== ''
  const shown = filtered ? sumStats(items) : report?.totals

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const retry = () => {
    setError(null)
    setReload((n) => n + 1)
  }

  return (
    <Modal
      title="Waiters · today"
      placement="right"
      width="max-w-2xl"
      onClose={onClose}
      onKey={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          setIndex(Math.min(items.length - 1, Math.max(0, active + (e.key === 'ArrowDown' ? 1 : -1))))
          return true
        }
        if (e.key === 'Enter') {
          const waiter = items[active]
          if (waiter) onPick(waiter)
          return true
        }
        return false
      }}
      footer={
        <div className="flex flex-col gap-2">
          {shown && (
            <div className={`${COLUMNS} px-3.5 font-mono text-sm`} aria-label="Totals">
              <span className="font-sans font-bold text-zinc-300">{filtered ? `Shown (${items.length})` : `All waiters (${report?.waiters.length ?? 0})`}</span>
              <Figure count={shown.openBills} amount={shown.openDuePaise} tone={shown.openBills > 0 ? 'amber' : 'plain'} />
              <Figure count={shown.closedBills} amount={shown.settledPaise} tone="plain" />
              <span />
            </div>
          )}
          <span className="text-sm text-zinc-400">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> select · <Kbd>Enter</Kbd> tag on this bill · <Kbd>Esc</Kbd> close
          </span>
        </div>
      }
    >
      <input
        data-autofocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setIndex(0)
        }}
        placeholder="Filter by code or name"
        autoComplete="off"
        className="w-full rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 py-2 text-lg outline-none focus:border-amber-400"
      />

      <div className={`${COLUMNS} mt-4 px-3 text-xs font-bold tracking-widest text-zinc-400 uppercase`}>
        <span>Waiter</span>
        <span className="text-right">Open · to settle</span>
        <span className="text-right">Closed · settled</span>
        <span className="text-right">Credit owed</span>
      </div>

      {error && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-rose-500/20 px-3 py-2 text-sm text-rose-300" role="alert">
          <span>{error}</span>
          <button type="button" onClick={retry} className="inline-flex items-center gap-1 rounded border border-rose-300/50 px-2 py-1 font-bold hover:bg-rose-400/15">
            <RefreshCw className="size-4" aria-hidden /> Retry
          </button>
        </div>
      )}
      {!report && !error && <p className="mt-3 text-sm text-zinc-400">Loading today&apos;s waiter figures…</p>}
      {report && report.businessDayId === null && <p className="mt-3 text-sm text-amber-300">No business day is open: figures show zero.</p>}
      {report && items.length === 0 && <p className="mt-3 text-sm text-zinc-400">{filtered ? 'No waiter matches' : 'No active waiters'}</p>}

      <ul ref={listRef} className="mt-2 flex flex-col gap-1" role="listbox" aria-label="Waiters">
        {items.map((w, i) => (
          <li key={w.id} role="option" aria-selected={i === active} data-index={i}>
            <WaiterRow waiter={w} highlighted={i === active} current={w.id === currentWaiterId} onPick={() => onPick(w)} onHover={() => setIndex(i)} />
          </li>
        ))}
      </ul>
    </Modal>
  )
}

function WaiterRow({
  waiter: w,
  highlighted,
  current,
  onPick,
  onHover,
}: {
  waiter: WaiterStats
  highlighted: boolean
  current: boolean
  onPick: () => void
  onHover: () => void
}) {
  const note = waiterNote(w)
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={onHover}
      className={`hover:border-zinc-600 ${COLUMNS} w-full rounded-md border-2 px-3 py-2.5 text-left ${highlighted ? 'border-amber-400 bg-zinc-800' : 'border-transparent bg-zinc-950'}`}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-zinc-400">{w.code}</span>
          <span className="truncate font-bold">{w.displayName}</span>
          <TrustBadge trusted={w.isTrusted} />
          {current && <span className="rounded bg-amber-400 px-1.5 py-0.5 text-[11px] font-black text-zinc-950 uppercase">On this bill</span>}
        </span>
        {note && <span className="text-xs font-semibold text-amber-300">{note}</span>}
      </span>
      <Figure count={w.openBills} amount={w.openDuePaise} tone={w.openBills > 0 ? 'amber' : 'muted'} />
      <Figure count={w.closedBills} amount={w.settledPaise} tone={w.closedBills > 0 ? 'plain' : 'muted'} />
      <span className="text-right font-mono text-sm">
        {w.isTrusted ? (
          <>
            <span className={w.outstandingPaise > 0n ? 'text-zinc-100' : 'text-zinc-500'}>{formatPaise(w.outstandingPaise)}</span>
            {w.creditLimitPaise !== null && <span className="block text-xs text-zinc-500">of {formatPaise(w.creditLimitPaise)}</span>}
          </>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </span>
    </button>
  )
}

function Figure({ count, amount, tone }: { count: number; amount: bigint; tone: 'amber' | 'plain' | 'muted' }) {
  const color = tone === 'amber' ? 'text-amber-300' : tone === 'plain' ? 'text-zinc-100' : 'text-zinc-500'
  return (
    <span className={`flex flex-col items-end font-mono tabular-nums ${color}`}>
      <span className="text-base font-bold">{formatPaise(amount)}</span>
      <span className="text-xs text-zinc-400">
        {count} bill{count === 1 ? '' : 's'}
      </span>
    </span>
  )
}
