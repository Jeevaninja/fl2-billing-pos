import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Keyboard, PlugZap, Sunrise } from 'lucide-react'
import { api } from '../api/client'
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts'
import { ACTIONS, BILLING_ACTIONS, MODULE_TILES, runStub, type PosActionId } from './dashboard/actions'
import { FOCUS_RING, formatTime } from '../lib/ui'
import { Kbd, LiveClock } from './ui'

const TILE_ACCENT: Record<PosActionId, string> = {
  'new-bill': 'bg-amber-400 text-zinc-950',
  member: 'bg-sky-500 text-zinc-950',
  pay: 'bg-emerald-500 text-zinc-950',
  billing: 'bg-zinc-950 text-amber-400',
  'captain-orders': 'bg-sky-500 text-zinc-950',
  expense: 'bg-rose-500 text-zinc-950',
  purchase: 'bg-violet-400 text-zinc-950',
  'day-end': 'bg-orange-500 text-zinc-950',
  reports: 'bg-emerald-500 text-zinc-950',
}

interface LastAction {
  id: PosActionId
  at: Date
}

interface DashboardProps {
  /** Recently used actions; held by App so the rail survives a visit to the billing screen. */
  recent: readonly PosActionId[]
  onUse: (id: PosActionId) => void
  onOpenBilling: () => void
  onOpenCaptainOrders: () => void
  onOpenDayEnd: () => void
}

const CAPTAIN_COUNT_POLL_MS = 15_000

/** Open Captain orders for the tile badge; null while unknown or when the API is unreachable. */
function useCaptainOrderCount(): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    const load = () =>
      api
        .captainOrders()
        .then((orders) => live && setCount(orders.length))
        .catch(() => live && setCount(null))
    void load()
    const timer = setInterval(() => void load(), CAPTAIN_COUNT_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  return count
}

/** Whether a business day is open; null while unknown or when the API is unreachable. */
function useDayOpen(): { open: boolean; date: string | null } | null {
  const [day, setDay] = useState<{ open: boolean; date: string | null } | null>(null)
  useEffect(() => {
    let live = true
    const load = () =>
      api
        .context()
        .then((c) => live && setDay({ open: c.businessDay !== null, date: c.businessDay?.businessDate ?? null }))
        .catch(() => live && setDay(null))
    void load()
    const timer = setInterval(() => void load(), CAPTAIN_COUNT_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  return day
}

export default function Dashboard({ recent, onUse, onOpenBilling, onOpenCaptainOrders, onOpenDayEnd }: DashboardProps) {
  const [lastAction, setLastAction] = useState<LastAction | null>(null)
  const captainCount = useCaptainOrderCount()
  const day = useDayOpen()
  const dayClosed = day !== null && !day.open

  const trigger = useCallback(
    (id: PosActionId) => {
      onUse(id)
      if (BILLING_ACTIONS.has(id)) {
        onOpenBilling()
        return
      }
      if (id === 'captain-orders') {
        onOpenCaptainOrders()
        return
      }
      if (id === 'day-end') {
        onOpenDayEnd()
        return
      }
      runStub(id)
      setLastAction({ id, at: new Date() })
    },
    [onUse, onOpenBilling, onOpenCaptainOrders, onOpenDayEnd],
  )

  useGlobalShortcuts({
    F1: () => trigger('new-bill'),
    F2: () => trigger('member'),
    F9: () => trigger('pay'),
  })

  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b-2 border-amber-400 bg-zinc-900 px-5">
        <span className="rounded bg-amber-400 px-2 py-0.5 text-lg font-black tracking-tight text-zinc-950">FL2</span>
        <h1 className="text-lg font-bold tracking-wide uppercase">Operations</h1>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="flex items-center gap-1.5 rounded border border-zinc-600 px-2 py-1 font-medium text-zinc-300">
            <PlugZap className="size-4" aria-hidden />
            Billing, Captain Orders &amp; Day End live · other modules preview
          </span>
          {day?.date && <span className="text-zinc-400">Day {day.date}</span>}
          <LiveClock />
        </div>
      </header>

      {dayClosed && (
        <button
          type="button"
          onClick={() => trigger('day-end')}
          className={`flex items-center gap-3 border-b-2 border-amber-400 bg-amber-400/15 px-5 py-3 text-left font-semibold text-amber-200 hover:bg-amber-400/25 ${FOCUS_RING}`}
        >
          <Sunrise className="size-5 shrink-0 text-amber-400" aria-hidden />
          No business day is open — billing is paused. Open a new day with an opening float.
          <span className="ml-auto flex items-center gap-1 font-bold text-amber-300">
            Open Day <ChevronRight className="size-5" aria-hidden />
          </span>
        </button>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="grid flex-1 grid-cols-2 grid-rows-3 gap-4 p-5 lg:grid-cols-3 lg:grid-rows-2" aria-label="Modules">
          {MODULE_TILES.map((id) => (
            <ModuleTile
              key={id}
              id={id}
              primary={dayClosed ? id === 'day-end' : id === 'billing'}
              badge={id === 'captain-orders' ? captainCount : null}
              override={id === 'day-end' && dayClosed ? { label: 'Open Day', hint: 'Start the next day with an opening float' } : undefined}
              onSelect={trigger}
            />
          ))}
        </main>

        <aside className="hidden w-80 shrink-0 flex-col border-l-2 border-zinc-800 bg-zinc-900 md:flex" aria-label="Recently used">
          <h2 className="border-b border-zinc-800 px-4 py-3 text-xs font-bold tracking-widest text-zinc-400 uppercase">
            Recently Used
          </h2>
          <ul className="flex flex-col gap-2 p-3">
            {recent.map((id) => (
              <li key={id}>
                <RailButton id={id} onSelect={trigger} />
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <footer className="flex h-10 shrink-0 items-center gap-5 border-t-2 border-zinc-800 bg-zinc-900 px-5 text-sm">
        <Keyboard className="size-4 text-zinc-400" aria-hidden />
        {(['new-bill', 'member', 'pay'] as const).map((id) => (
          <span key={id} className="flex items-center gap-2 text-zinc-300">
            <Kbd>{ACTIONS[id].shortcut}</Kbd>
            {ACTIONS[id].label}
          </span>
        ))}
        <span className="ml-auto font-mono text-zinc-400" aria-live="polite">
          {lastAction
            ? `${ACTIONS[lastAction.id].label}: stub fired at ${formatTime(lastAction.at)}`
            : 'Ready'}
        </span>
      </footer>
    </div>
  )
}

interface ModuleTileProps {
  id: PosActionId
  primary: boolean
  /** Live count shown on the tile (e.g. open Captain orders); null hides it. */
  badge: number | null
  /** Replaces the tile's label and hint (Day End reads "Open Day" when no day is open). */
  override?: { label: string; hint: string } | undefined
  onSelect: (id: PosActionId) => void
}

function ModuleTile({ id, primary, badge, override, onSelect }: ModuleTileProps) {
  const { icon: Icon } = ACTIONS[id]
  const { label, hint } = override ?? ACTIONS[id]
  const surface = primary
    ? 'border-amber-300 bg-amber-400 text-zinc-950 hover:bg-amber-300'
    : 'border-zinc-700 bg-zinc-900 text-zinc-50 hover:border-zinc-400 hover:bg-zinc-800'

  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={`group flex flex-col justify-between rounded-lg border-2 p-5 text-left transition-colors ${surface} ${FOCUS_RING}`}
    >
      <span className="flex items-start justify-between gap-3">
        <span className={`flex size-14 items-center justify-center rounded-md ${TILE_ACCENT[id]}`}>
          <Icon className="size-8" strokeWidth={2.25} aria-hidden />
        </span>
        {badge !== null && (
          <span
            className={`rounded-full px-3 py-1 font-mono text-lg font-black tabular-nums ${badge > 0 ? 'bg-sky-500 text-zinc-950' : 'bg-zinc-800 text-zinc-400'}`}
            aria-label={`${badge} open`}
          >
            {badge} open
          </span>
        )}
      </span>
      <span className="flex items-end justify-between gap-3">
        <span>
          <span className="block text-2xl font-extrabold tracking-tight">{label}</span>
          <span className={`mt-1 block text-sm font-medium ${primary ? 'text-zinc-800' : 'text-zinc-400'}`}>{hint}</span>
        </span>
        <ChevronRight
          className={`size-7 shrink-0 transition-transform group-hover:translate-x-1 ${primary ? 'text-zinc-950' : 'text-zinc-500'}`}
          aria-hidden
        />
      </span>
    </button>
  )
}

function RailButton({ id, onSelect }: { id: PosActionId; onSelect: (id: PosActionId) => void }) {
  const { label, hint, icon: Icon, shortcut } = ACTIONS[id]
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={`flex w-full items-center gap-3 rounded-md border border-zinc-700 bg-zinc-950 p-3 text-left hover:border-zinc-400 hover:bg-zinc-800 ${FOCUS_RING}`}
    >
      <span className={`flex size-10 shrink-0 items-center justify-center rounded ${TILE_ACCENT[id]}`}>
        <Icon className="size-5" strokeWidth={2.25} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-bold">{label}</span>
        <span className="block truncate text-xs text-zinc-400">{hint}</span>
      </span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </button>
  )
}
