import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, Clock, Keyboard, WifiOff } from 'lucide-react'
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts'
import { ACTIONS, DEFAULT_RECENT, MODULE_TILES, runStub, type PosActionId } from './dashboard/actions'

const RECENT_LIMIT = 6

const TILE_ACCENT: Record<PosActionId, string> = {
  'new-bill': 'bg-amber-400 text-zinc-950',
  member: 'bg-sky-500 text-zinc-950',
  pay: 'bg-emerald-500 text-zinc-950',
  billing: 'bg-zinc-950 text-amber-400',
  kots: 'bg-sky-500 text-zinc-950',
  expense: 'bg-rose-500 text-zinc-950',
  purchase: 'bg-violet-400 text-zinc-950',
  'day-end': 'bg-orange-500 text-zinc-950',
  reports: 'bg-emerald-500 text-zinc-950',
}

const FOCUS_RING = 'outline-none focus-visible:ring-4 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950'

interface LastAction {
  id: PosActionId
  at: Date
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export default function Dashboard() {
  const [recent, setRecent] = useState<PosActionId[]>([...DEFAULT_RECENT])
  const [lastAction, setLastAction] = useState<LastAction | null>(null)

  const trigger = useCallback((id: PosActionId) => {
    runStub(id)
    setRecent((prev) => [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_LIMIT))
    setLastAction({ id, at: new Date() })
  }, [])

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
            <WifiOff className="size-4" aria-hidden />
            Preview: backend not connected
          </span>
          <LiveClock />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="grid flex-1 grid-cols-2 grid-rows-3 gap-4 p-5 lg:grid-cols-3 lg:grid-rows-2" aria-label="Modules">
          {MODULE_TILES.map((id) => (
            <ModuleTile key={id} id={id} primary={id === 'billing'} onSelect={trigger} />
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

function ModuleTile({ id, primary, onSelect }: { id: PosActionId; primary: boolean; onSelect: (id: PosActionId) => void }) {
  const { label, hint, icon: Icon } = ACTIONS[id]
  const surface = primary
    ? 'border-amber-300 bg-amber-400 text-zinc-950 hover:bg-amber-300'
    : 'border-zinc-700 bg-zinc-900 text-zinc-50 hover:border-zinc-400 hover:bg-zinc-800'

  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={`group flex flex-col justify-between rounded-lg border-2 p-5 text-left transition-colors ${surface} ${FOCUS_RING}`}
    >
      <span className={`flex size-14 items-center justify-center rounded-md ${TILE_ACCENT[id]}`}>
        <Icon className="size-8" strokeWidth={2.25} aria-hidden />
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

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-zinc-500 border-b-2 bg-zinc-800 px-1.5 py-0.5 font-mono text-xs font-bold text-zinc-100">
      {children}
    </kbd>
  )
}

/** Isolated so the per-second tick only re-renders the clock. */
function LiveClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="flex items-center gap-1.5 font-mono text-base font-semibold tabular-nums">
      <Clock className="size-4 text-zinc-400" aria-hidden />
      {formatTime(now)}
    </span>
  )
}
