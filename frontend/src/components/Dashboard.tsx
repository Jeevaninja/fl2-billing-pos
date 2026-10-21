import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarDays, ChevronRight, Keyboard, LogOut, Settings, Sunrise } from 'lucide-react'
import { api } from '../api/client'
import type { CounterContext, PeakSessionView } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { initials } from '../auth/pinPad'
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts'
import { formatPaise } from '../lib/money'
import { describeVariance } from '../peak/peakMath'
import { PeakBanner, PeakEndDialog, PeakStartDialog, StartPeakButton } from './peak/PeakControls'
import { ACTIONS, BILLING_ACTIONS, HERO_TILE, MODULE_TILES, runStub, SETTINGS_ACTIONS, type PosActionId } from './dashboard/actions'
import { FOCUS_RING, formatTime } from '../lib/ui'
import { BrandMark, Kbd, LiveClock } from './ui'

const TILE_ACCENT: Record<PosActionId, string> = {
  'new-bill': 'bg-amber-400 text-zinc-950',
  member: 'bg-sky-500 text-zinc-950',
  pay: 'bg-emerald-500 text-zinc-950',
  billing: 'bg-zinc-950 text-amber-400',
  'captain-orders': 'bg-sky-500 text-zinc-950',
  expense: 'bg-rose-500 text-zinc-950',
  'bank-deposit': 'bg-indigo-400 text-zinc-950',
  purchase: 'bg-violet-400 text-zinc-950',
  'revenue-centers': 'bg-green-500 text-zinc-950',
  'center-settings': 'bg-green-400 text-zinc-950',
  catalog: 'bg-teal-400 text-zinc-950',
  orders: 'bg-cyan-400 text-zinc-950',
  'expense-categories': 'bg-rose-400 text-zinc-950',
  'item-categories': 'bg-lime-400 text-zinc-950',
  'day-end': 'bg-orange-500 text-zinc-950',
  reports: 'bg-emerald-400 text-zinc-950',
  staff: 'bg-fuchsia-400 text-zinc-950',
}

/** The soft wash a tile picks up on hover, in its accent colour. */
const TILE_GLOW: Partial<Record<PosActionId, string>> = {
  'captain-orders': 'from-sky-500/12',
  expense: 'from-rose-500/12',
  'bank-deposit': 'from-indigo-400/12',
  purchase: 'from-violet-400/12',
  'revenue-centers': 'from-green-500/12',
  orders: 'from-cyan-400/12',
  'day-end': 'from-orange-500/12',
  reports: 'from-emerald-400/12',
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
  onOpenExpenses: () => void
  onOpenBankDeposits: () => void
  onOpenPurchase: () => void
  onOpenCatalog: () => void
  onOpenOrders: () => void
  onOpenRevenueCenters: () => void
  onOpenCenterSettings: () => void
  onOpenExpenseCategories: () => void
  onOpenItemCategories: () => void
  onOpenReports: () => void
  onOpenStaff: () => void
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

/** The counter context (open day, running peak), polled; null while unknown or when the API is unreachable. */
function useCounterContext(): { context: CounterContext | null; reload: () => void } {
  const [context, setContext] = useState<CounterContext | null>(null)
  const live = useRef(true)
  const reload = useCallback(() => {
    api
      .context()
      .then((c) => live.current && setContext(c))
      .catch(() => live.current && setContext(null))
  }, [])
  useEffect(() => {
    live.current = true
    reload()
    const timer = setInterval(reload, CAPTAIN_COUNT_POLL_MS)
    return () => {
      live.current = false
      clearInterval(timer)
    }
  }, [reload])
  return { context, reload }
}

/** Start dialog, or the end dialog with its own session snapshot (it outlives the session to show the result). */
type PeakDialog = { kind: 'start'; businessDayId: string } | { kind: 'end'; session: PeakSessionView } | null

export default function Dashboard({
  recent,
  onUse,
  onOpenBilling,
  onOpenCaptainOrders,
  onOpenDayEnd,
  onOpenExpenses,
  onOpenBankDeposits,
  onOpenPurchase,
  onOpenCatalog,
  onOpenOrders,
  onOpenRevenueCenters,
  onOpenCenterSettings,
  onOpenExpenseCategories,
  onOpenItemCategories,
  onOpenReports,
  onOpenStaff,
}: DashboardProps) {
  const { staff: me, signOut } = useAuth()
  const [lastAction, setLastAction] = useState<LastAction | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [peakDialog, setPeakDialog] = useState<PeakDialog>(null)
  const captainCount = useCaptainOrderCount()
  const { context, reload } = useCounterContext()
  const businessDay = context?.businessDay ?? null
  const peak = context?.peakSession ?? null
  const dayClosed = context !== null && businessDay === null

  const togglePeak = useCallback(() => {
    if (peak) setPeakDialog({ kind: 'end', session: peak })
    else if (businessDay) setPeakDialog({ kind: 'start', businessDayId: businessDay.id })
    else setStatus('Open a business day before starting a peak session')
  }, [peak, businessDay])

  const trigger = useCallback(
    (id: PosActionId) => {
      onUse(id)
      if (BILLING_ACTIONS.has(id)) {
        onOpenBilling()
        return
      }
      const open: Partial<Record<PosActionId, () => void>> = {
        'captain-orders': onOpenCaptainOrders,
        'day-end': onOpenDayEnd,
        expense: onOpenExpenses,
        'bank-deposit': onOpenBankDeposits,
        purchase: onOpenPurchase,
        catalog: onOpenCatalog,
        orders: onOpenOrders,
        'revenue-centers': onOpenRevenueCenters,
        'center-settings': onOpenCenterSettings,
        'expense-categories': onOpenExpenseCategories,
        'item-categories': onOpenItemCategories,
        reports: onOpenReports,
        staff: onOpenStaff,
      }
      const go = open[id]
      if (go) {
        go()
        return
      }
      runStub(id)
      setLastAction({ id, at: new Date() })
    },
    [onUse, onOpenBilling, onOpenCaptainOrders, onOpenDayEnd, onOpenExpenses, onOpenBankDeposits, onOpenPurchase, onOpenCatalog, onOpenOrders, onOpenRevenueCenters, onOpenCenterSettings, onOpenExpenseCategories, onOpenItemCategories, onOpenReports, onOpenStaff],
  )

  useGlobalShortcuts(
    {
      F1: () => trigger('new-bill'),
      F2: () => trigger('member'),
      F8: togglePeak,
      F9: () => trigger('pay'),
    },
    peakDialog === null,
  )

  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-zinc-800 bg-zinc-900/95 px-5 shadow-[inset_0_-2px_0_0_var(--color-amber-400)]">
        <BrandMark />
        <h1 className="text-lg font-bold tracking-wide uppercase">Operations</h1>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {businessDay && (
            <span className="hidden items-center gap-2 rounded-full border border-zinc-700 bg-zinc-950/60 py-1 pr-3 pl-2 font-medium whitespace-nowrap text-zinc-300 sm:flex">
              <CalendarDays className="size-4 text-emerald-400" aria-hidden />
              Day {businessDay.businessDate}
              <span className="hidden text-zinc-500 xl:inline">· open since {formatTime(new Date(businessDay.openedAt)).slice(0, 5)}</span>
            </span>
          )}
          {businessDay && !peak && <StartPeakButton onClick={togglePeak} className="whitespace-nowrap" />}
          <LiveClock />
          <span className="mx-1 h-8 w-px bg-zinc-800" aria-hidden />
          <span className="flex items-center gap-2" title={`Signed in as ${me.displayName}`}>
            <span className="flex size-8 items-center justify-center rounded-full bg-amber-400/15 text-xs font-black text-amber-300 ring-1 ring-amber-400/40">{initials(me.displayName)}</span>
            <span className="hidden flex-col leading-tight xl:flex">
              <span className="font-bold text-zinc-100">{me.displayName}</span>
              <span className="text-xs text-zinc-400">Super Admin</span>
            </span>
          </span>
          <button
            type="button"
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out"
            className={`flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 font-semibold text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 hover:text-zinc-50 ${FOCUS_RING}`}
          >
            <LogOut className="size-4" aria-hidden />
            <span className="hidden lg:inline">Sign out</span>
          </button>
          <SettingsMenu onSelect={trigger} />
        </div>
      </header>

      {peak && <PeakBanner session={peak} onEnd={togglePeak} />}

      {dayClosed && (
        <button
          type="button"
          onClick={() => trigger('day-end')}
          className={`group flex items-center gap-3 border-b border-amber-400/40 bg-gradient-to-r from-amber-400/20 via-amber-400/10 to-transparent px-5 py-3 text-left font-semibold text-amber-100 hover:from-amber-400/30 ${FOCUS_RING}`}
        >
          <Sunrise className="size-5 shrink-0 text-amber-400" aria-hidden />
          No business day is open — billing is paused. Open a new day with an opening float and a PIN.
          <span className="ml-auto flex items-center gap-1 font-bold text-amber-300">
            Open Day <ChevronRight className="size-5 transition-transform group-hover:translate-x-1" aria-hidden />
          </span>
        </button>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="grid flex-1 auto-rows-[minmax(10rem,auto)] grid-cols-2 gap-4 overflow-y-auto p-5 lg:auto-rows-fr lg:grid-cols-5 lg:grid-rows-2 lg:overflow-visible" aria-label="Modules">
          {MODULE_TILES.map((id) =>
            id === HERO_TILE ? (
              <HeroTile key={id} id={id} paused={dayClosed} onSelect={trigger} />
            ) : (
              <ModuleTile
                key={id}
                id={id}
                primary={dayClosed && id === 'day-end'}
                badge={id === 'captain-orders' ? captainCount : null}
                override={id === 'day-end' && dayClosed ? { label: 'Open Day', hint: 'Opening float + a cashier or manager PIN' } : undefined}
                onSelect={trigger}
              />
            ),
          )}
        </main>

        <aside className="hidden w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/60 xl:flex" aria-label="Recently used">
          <h2 className="px-4 pt-4 pb-2 text-xs font-bold tracking-widest text-zinc-400 uppercase">Recently Used</h2>
          <ul className="flex flex-col gap-2 px-3 pb-3">
            {recent.map((id) => (
              <li key={id}>
                <RailButton id={id} onSelect={trigger} />
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <footer className="flex h-10 shrink-0 items-center gap-5 border-t border-zinc-800 bg-zinc-900 px-5 text-sm">
        <Keyboard className="size-4 text-zinc-500" aria-hidden />
        {(['new-bill', 'member', 'pay'] as const).map((id) => (
          <span key={id} className="flex items-center gap-2 text-zinc-300">
            <Kbd>{ACTIONS[id].shortcut}</Kbd>
            {ACTIONS[id].label}
          </span>
        ))}
        <span className="flex items-center gap-2 text-zinc-300">
          <Kbd>F8</Kbd>
          {peak ? 'End peak' : 'Start peak'}
        </span>
        <span className="ml-auto font-mono text-zinc-400" aria-live="polite">
          {status ?? (lastAction ? `${ACTIONS[lastAction.id].label}: stub fired at ${formatTime(lastAction.at)}` : 'Ready')}
        </span>
      </footer>

      {peakDialog?.kind === 'start' && (
        <PeakStartDialog
          businessDayId={peakDialog.businessDayId}
          onStarted={(session) => {
            setPeakDialog(null)
            setStatus(`Peak #${session.sessionNo} started at ${formatTime(new Date(session.startedAt))}`)
            reload()
          }}
          onClose={() => setPeakDialog(null)}
        />
      )}
      {peakDialog?.kind === 'end' && (
        <PeakEndDialog
          session={peakDialog.session}
          onEnded={(r) => {
            setStatus(`Peak #${r.session.sessionNo} ended · ${describeVariance(r.breakdown.variancePaise).label} (expected ${formatPaise(r.breakdown.expectedPaise)})`)
            reload()
          }}
          onClose={() => setPeakDialog(null)}
        />
      )}
    </div>
  )
}

/**
 * Phase 25 (D7): the Billing hero, spanning both grid rows of the first column. Amber while a day is
 * open; a quiet dark tile while billing is paused (Day End is then the call to action).
 */
function HeroTile({ id, paused, onSelect }: { id: PosActionId; paused: boolean; onSelect: (id: PosActionId) => void }) {
  const { icon: Icon, label, hint } = ACTIONS[id]
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={`group relative row-span-2 flex flex-col justify-between overflow-hidden rounded-2xl p-6 text-left hover:-translate-y-0.5 active:translate-y-0 ${
        paused
          ? 'border border-zinc-700 bg-zinc-900 text-zinc-50 shadow-tile hover:border-zinc-500 hover:shadow-tile-hover'
          : 'bg-gradient-to-br from-amber-300 via-amber-400 to-amber-500 text-zinc-950 shadow-glow-amber hover:from-amber-200 hover:via-amber-300 hover:to-amber-400'
      } ${FOCUS_RING}`}
    >
      {!paused && (
        <span
          aria-hidden
          className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-white/25 blur-3xl transition-transform duration-300 group-hover:scale-110"
        />
      )}
      <span className="relative flex items-start justify-between">
        <span className={`flex size-20 items-center justify-center rounded-2xl ${paused ? 'bg-zinc-800 text-amber-400' : 'bg-zinc-950 text-amber-400 shadow-lg'}`}>
          <Icon className="size-11" strokeWidth={2.25} aria-hidden />
        </span>
        <span className={`rounded-full px-3 py-1 text-xs font-black tracking-widest uppercase ${paused ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-950/90 text-amber-300'}`}>
          {paused ? 'Paused' : 'Ready'}
        </span>
      </span>
      <span className="relative">
        <span className="block text-4xl leading-none font-black tracking-tight xl:text-5xl">{label}</span>
        <span className={`mt-3 block text-base font-semibold ${paused ? 'text-zinc-400' : 'text-zinc-900/80'}`}>{paused ? 'Open a business day to start billing' : hint}</span>
        <span className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-bold">
          {(['new-bill', 'member', 'pay'] as const).map((a) => (
            <span key={a} className="flex items-center gap-1.5">
              <kbd className={`rounded-md border-b-[3px] px-1.5 py-0.5 font-mono text-xs ${paused ? 'border-zinc-600 bg-zinc-800 text-zinc-200' : 'border-zinc-950/60 bg-zinc-950/85 text-amber-200'}`}>{ACTIONS[a].shortcut}</kbd>
              {ACTIONS[a].label}
            </span>
          ))}
          <ChevronRight className="ml-auto size-8 transition-transform group-hover:translate-x-1.5" aria-hidden />
        </span>
      </span>
    </button>
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
    ? 'bg-gradient-to-br from-amber-300 to-amber-500 text-zinc-950 shadow-glow-amber'
    : 'border border-zinc-800 bg-zinc-900 text-zinc-50 shadow-tile hover:border-zinc-600 hover:bg-zinc-850 hover:shadow-tile-hover'

  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={`group relative flex min-h-36 flex-col justify-between overflow-hidden rounded-2xl p-5 text-left hover:-translate-y-0.5 active:translate-y-0 ${surface} ${FOCUS_RING}`}
    >
      {!primary && (
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${TILE_GLOW[id] ?? 'from-zinc-400/10'} to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100`}
        />
      )}
      <span className="relative flex items-start justify-between gap-3">
        <span className={`flex size-14 items-center justify-center rounded-xl shadow-[0_1px_0_0_rgb(255_255_255/0.3)_inset] ${primary ? 'bg-zinc-950 text-amber-400' : TILE_ACCENT[id]}`}>
          <Icon className="size-8" strokeWidth={2.25} aria-hidden />
        </span>
        {badge !== null && (
          <span
            className={`rounded-full px-3 py-1 font-mono text-base font-black tabular-nums ${badge > 0 ? 'bg-sky-500 text-zinc-950 shadow-[0_0_16px_rgb(14_165_233/0.5)]' : 'bg-zinc-800 text-zinc-400'}`}
            aria-label={`${badge} open`}
          >
            {badge} open
          </span>
        )}
      </span>
      <span className="relative flex items-end justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-2xl leading-tight font-extrabold tracking-tight">{label}</span>
          <span className={`mt-1 line-clamp-2 text-sm font-medium text-pretty ${primary ? 'text-zinc-900/80' : 'text-zinc-400 group-hover:text-zinc-300'}`}>{hint}</span>
        </span>
        <ChevronRight className={`size-7 shrink-0 transition-transform group-hover:translate-x-1 ${primary ? 'text-zinc-950' : 'text-zinc-600 group-hover:text-zinc-300'}`} aria-hidden />
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
      className={`group flex w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-left hover:border-zinc-600 hover:bg-zinc-850 ${FOCUS_RING}`}
    >
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${TILE_ACCENT[id]}`}>
        <Icon className="size-5" strokeWidth={2.25} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-bold">{label}</span>
        <span className="block truncate text-xs text-zinc-400 group-hover:text-zinc-300">{hint}</span>
      </span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </button>
  )
}

/** Header gear: screens that don't need a grid tile (Inventory Catalog, the category and center setup, staff). */
function SettingsMenu({ onSelect }: { onSelect: (id: PosActionId) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings"
        title="Settings"
        className={`flex items-center rounded-lg border p-1.5 ${open ? 'border-amber-400 bg-amber-400 text-zinc-950' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 hover:text-zinc-50'} ${FOCUS_RING}`}
      >
        <Settings className={`size-5 transition-transform duration-300 ${open ? 'rotate-90' : ''}`} aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label="Settings" className="absolute top-full right-0 z-40 mt-2 w-80 rounded-xl border border-zinc-700 bg-zinc-900 p-2 shadow-dialog motion-safe:animate-pop-in">
          <p className="px-2 pt-1 pb-2 text-[11px] font-bold tracking-widest text-zinc-400 uppercase">Settings</p>
          {SETTINGS_ACTIONS.map((id, i) => {
            const { label, hint, icon: Icon } = ACTIONS[id]
            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                autoFocus={i === 0}
                onClick={() => {
                  setOpen(false)
                  onSelect(id)
                }}
                className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-zinc-800 ${FOCUS_RING}`}
              >
                <span className={`rounded-lg p-2 ${TILE_ACCENT[id]}`}>
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="flex flex-col">
                  <span className="font-bold">{label}</span>
                  <span className="text-sm text-zinc-400">{hint}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
