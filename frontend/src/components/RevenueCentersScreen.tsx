import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react'
import { ArrowLeft, Plus, RefreshCw, Store, Trash2, WifiOff, X } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { CenterPurchaseEntry, Department, RevenueCenterOverview, RevenueCenterSummary } from '../api/types'
import { FlashLine } from '../billing/BillingPanels'
import type { Flash } from '../billing/billingReducer'
import { counterErrorMessage } from '../billing/errors'
import { Modal } from '../billing/Modal'
import { centerFormError, NEW_CENTER, type CenterForm } from '../centers/centerForm'
import {
  addLine,
  ALL_CENTERS,
  centerTabs,
  MAX_LINES,
  newPurchaseForm,
  pnlCards,
  purchaseFormError,
  purchasePayload,
  purchaseTotal,
  removeLine,
  setLine,
  stepTab,
  type PurchaseForm,
} from '../centers/purchaseForm'
import { beep } from '../lib/beep'
import { departmentChip } from '../lib/departments'
import { formatPaise } from '../lib/money'
import { FOCUS_RING, keepFocus } from '../lib/ui'
import { CenterModal } from './centers/CenterModal'
import { Kbd, LiveClock } from './ui'

const POLL_MS = 15_000
const TAB_KEY = 'fl2.revenueCenters.tab'

function rememberedTab(): string {
  try {
    return localStorage.getItem(TAB_KEY) ?? ALL_CENTERS
  } catch {
    return ALL_CENTERS
  }
}

function rememberTab(code: string): void {
  try {
    localStorage.setItem(TAB_KEY, code)
  } catch {
    // private window / storage blocked: the tab just isn't remembered
  }
}

interface State {
  load: 'loading' | 'ready' | 'offline' | 'noDay'
  overview: RevenueCenterOverview | null
  /** Every revenue center (for the center modal's duplicate check and the purchase form). */
  departments: Department[]
  tab: string
  /** The selected center's P&L (null on "All centers" or while it loads). */
  summary: RevenueCenterSummary | null
  peakRunning: boolean
  selectedId: string | null
  form: PurchaseForm | null
  centerForm: CenterForm | null
  confirmVoid: CenterPurchaseEntry | null
  saving: boolean
  saveError: string | null
  flash: Flash | null
}

type Action =
  | { type: 'loaded'; overview: RevenueCenterOverview; departments: Department[]; summary: RevenueCenterSummary | null; peakRunning: boolean; tab: string }
  | { type: 'failed'; message: string; noDay: boolean }
  | { type: 'tab'; code: string }
  | { type: 'select'; id: string }
  | { type: 'form'; form: PurchaseForm | null }
  | { type: 'centerForm'; form: CenterForm | null }
  | { type: 'editCenter'; patch: Partial<CenterForm> }
  | { type: 'confirmVoid'; purchase: CenterPurchaseEntry | null }
  | { type: 'saving'; on: boolean }
  | { type: 'saveError'; message: string }
  | { type: 'flash'; kind: Flash['kind']; text: string }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded': {
      // A reply for a tab the cashier already left is dropped (its summary would be the wrong center).
      if (action.tab !== state.tab) return { ...state, overview: action.overview, departments: action.departments, peakRunning: action.peakRunning }
      const ids = action.summary?.purchases.map((p) => p.id) ?? []
      return {
        ...state,
        load: 'ready',
        overview: action.overview,
        departments: action.departments,
        summary: action.summary,
        peakRunning: action.peakRunning,
        selectedId: ids.includes(state.selectedId ?? '') ? state.selectedId : (ids[0] ?? null),
      }
    }
    case 'failed':
      if (action.noDay) return { ...state, load: 'noDay' }
      return { ...state, load: state.overview ? 'ready' : 'offline', flash: { kind: 'error', text: action.message, seq: (state.flash?.seq ?? 0) + 1 } }
    case 'tab':
      return action.code === state.tab ? state : { ...state, tab: action.code, summary: null, selectedId: null }
    case 'select':
      return { ...state, selectedId: action.id }
    case 'form':
      return { ...state, form: action.form, saving: false, saveError: null }
    case 'centerForm':
      return { ...state, centerForm: action.form, saving: false, saveError: null }
    case 'editCenter':
      return state.centerForm ? { ...state, centerForm: { ...state.centerForm, ...action.patch }, saveError: null } : state
    case 'confirmVoid':
      return { ...state, confirmVoid: action.purchase }
    case 'saving':
      return { ...state, saving: action.on }
    case 'saveError':
      return { ...state, saving: false, saveError: action.message }
    case 'flash':
      return { ...state, flash: { kind: action.kind, text: action.text, seq: (state.flash?.seq ?? 0) + 1 } }
  }
}

function initialState(): State {
  return {
    load: 'loading',
    overview: null,
    departments: [],
    tab: rememberedTab(),
    summary: null,
    peakRunning: false,
    selectedId: null,
    form: null,
    centerForm: null,
    confirmVoid: null,
    saving: false,
    saveError: null,
    flash: null,
  }
}

/**
 * Revenue Centers (Phase 22; the Kitchen Kiosk until Phase 21): a P&L per non-liquor micro-business —
 * Kitchen, Cigarettes, Cool Drinks, Water Bottles, AC Charges, … — switched with tabs, plus an "All
 * centers" overview. Each center: sales (its bill lines), expenses (its petty-cash categories),
 * purchases (GRN stock of its items + its own supply purchases) and gross. Shows the open day, else
 * the last closed one (read-only).
 */
export default function RevenueCentersScreen({ onExit }: { onExit: () => void }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  const flash = useCallback((kind: Flash['kind'], text: string) => {
    beep(kind)
    dispatch({ type: 'flash', kind, text })
  }, [])

  const refresh = useCallback(async () => {
    const tab = stateRef.current.tab
    try {
      const [overview, departments, context] = await Promise.all([api.centersOverview(), api.listDepartments(true), api.context()])
      const known = tab === ALL_CENTERS || overview.centers.some((c) => c.code === tab)
      const summary = known && tab !== ALL_CENTERS ? await api.centerSummary(tab) : null
      if (!known) {
        // The remembered center was disabled meanwhile: fall back to the overview.
        rememberTab(ALL_CENTERS)
        dispatch({ type: 'tab', code: ALL_CENTERS })
      }
      dispatch({ type: 'loaded', overview, departments, summary, peakRunning: context.peakSession !== null, tab: known ? tab : ALL_CENTERS })
    } catch (err) {
      const noDay = err instanceof ApiError && err.status === 404
      dispatch({ type: 'failed', message: counterErrorMessage(err), noDay })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      const s = stateRef.current
      if (!s.form && !s.confirmVoid && !s.centerForm) void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const switchTab = useCallback(
    (code: string) => {
      rememberTab(code)
      dispatch({ type: 'tab', code })
      stateRef.current = { ...stateRef.current, tab: code }
      void refresh()
    },
    [refresh],
  )

  const tabs = centerTabs(state.overview)
  const centers = (state.overview?.centers ?? []).map((c) => ({
    code: c.code,
    name: c.name,
    tracksStock: state.departments.find((d) => d.code === c.code)?.tracksStock ?? false,
  }))
  const day = state.overview?.day
  const open = day?.status === 'OPEN'

  const openPurchase = useCallback(() => {
    const s = stateRef.current
    if (s.overview?.day.status !== 'OPEN') return
    const first = s.overview.centers[0]?.code ?? ''
    dispatch({ type: 'form', form: newPurchaseForm(s.peakRunning, s.tab === ALL_CENTERS ? first : s.tab) })
  }, [])

  const savePurchase = useCallback(() => {
    const { form, peakRunning, saving } = stateRef.current
    if (!form || saving) return
    const problem = purchaseFormError(form, peakRunning)
    if (problem) {
      dispatch({ type: 'saveError', message: problem })
      return
    }
    dispatch({ type: 'saving', on: true })
    api
      .recordCenterPurchase(purchasePayload(form))
      .then((saved) => {
        dispatch({ type: 'form', form: null })
        dispatch({ type: 'select', id: saved.id })
        const name = stateRef.current.overview?.centers.find((c) => c.code === saved.department)?.name ?? saved.department
        flash('ok', `${name} purchase of ${formatPaise(saved.amountPaise)} recorded${saved.paidFrom === 'DRAWER' ? ' · paid from the drawer' : ''}`)
        void refresh()
      })
      .catch((err: unknown) => dispatch({ type: 'saveError', message: counterErrorMessage(err) }))
  }, [flash, refresh])

  const saveCenter = useCallback(() => {
    const { centerForm, departments, saving } = stateRef.current
    if (!centerForm || saving) return
    const problem = centerFormError(centerForm, departments)
    if (problem) {
      dispatch({ type: 'saveError', message: problem })
      return
    }
    dispatch({ type: 'saving', on: true })
    api
      .createDepartment({ name: centerForm.name, kotStation: centerForm.kotStation, tracksStock: centerForm.tracksStock })
      .then((saved) => {
        dispatch({ type: 'centerForm', form: null })
        flash('ok', `${saved.name} added — point its brands at it in the Inventory Catalog`)
        switchTab(saved.code)
      })
      .catch((err: unknown) => dispatch({ type: 'saveError', message: err instanceof ApiError ? err.message : counterErrorMessage(err) }))
  }, [flash, switchTab])

  const voidPurchase = useCallback(() => {
    const target = stateRef.current.confirmVoid
    if (!target) return
    dispatch({ type: 'confirmVoid', purchase: null })
    api
      .voidCenterPurchase(target.id)
      .then(() => {
        flash('ok', `Voided the ${formatPaise(target.amountPaise)} purchase${target.vendorName ? ` from ${target.vendorName}` : ''}`)
        void refresh()
      })
      .catch((err: unknown) => flash('error', counterErrorMessage(err)))
  }, [flash, refresh])

  // Page keys (a modal owns the keyboard while open).
  const modalOpen = state.form !== null || state.confirmVoid !== null || state.centerForm !== null
  useEffect(() => {
    if (modalOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const s = stateRef.current
      const list = s.summary?.purchases ?? []
      const at = list.findIndex((p) => p.id === s.selectedId)
      const allTabs = centerTabs(s.overview)
      if (/^[1-9]$/.test(event.key)) {
        const tab = allTabs[Number(event.key) - 1]
        if (tab) {
          event.preventDefault()
          switchTab(tab.code)
        }
        return
      }
      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          onExit()
          return
        case 'ArrowLeft':
        case 'ArrowRight':
          event.preventDefault()
          switchTab(stepTab(allTabs, s.tab, event.key === 'ArrowLeft' ? -1 : 1))
          return
        case 'Insert':
          event.preventDefault()
          openPurchase()
          return
        case 'ArrowUp':
        case 'ArrowDown': {
          event.preventDefault()
          const next = list[Math.min(list.length - 1, Math.max(0, at + (event.key === 'ArrowUp' ? -1 : 1)))]
          if (next) dispatch({ type: 'select', id: next.id })
          return
        }
        case 'Delete': {
          const current = list[at]
          if (current && !current.voidedAt && s.overview?.day.status === 'OPEN') {
            event.preventDefault()
            dispatch({ type: 'confirmVoid', purchase: current })
          }
          return
        }
        case 'r':
        case 'R':
          event.preventDefault()
          void refresh()
          return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [modalOpen, onExit, refresh, switchTab, openPurchase])

  const summary = state.summary
  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b-2 border-green-500 bg-zinc-900 px-5">
        <button type="button" {...keepFocus} onClick={onExit} className="flex items-center gap-2 rounded px-1 text-zinc-300 hover:text-zinc-50" aria-label="Back to dashboard (Esc)">
          <ArrowLeft className="size-5" aria-hidden />
          <span className="rounded bg-amber-400 px-2 py-0.5 text-lg font-black tracking-tight text-zinc-950">FL2</span>
        </button>
        <h1 className="flex items-center gap-2 text-lg font-bold tracking-wide uppercase">
          <Store className="size-5 text-green-400" aria-hidden /> Revenue Centers
        </h1>
        {day && (
          <span className={`rounded px-2.5 py-1 text-sm font-black tracking-widest uppercase ${open ? 'bg-green-500 text-zinc-950' : 'bg-zinc-700 text-zinc-200'}`}>
            {day.businessDate} · {open ? 'open' : 'closed'}
          </span>
        )}
        <FlashLine flash={state.flash} />
        <div className="ml-auto flex items-center gap-4 text-sm">
          <LiveClock />
          <span className="flex items-center gap-1 text-zinc-400">
            <Kbd>Esc</Kbd> Dashboard
          </span>
        </div>
      </header>

      {state.overview && (
        <nav className="flex shrink-0 flex-wrap items-center gap-2 border-b-2 border-zinc-800 bg-zinc-900 px-5 py-2" role="tablist" aria-label="Revenue centers">
          {tabs.map((t, i) => {
            const on = t.code === state.tab
            return (
              <button
                key={t.code}
                type="button"
                role="tab"
                aria-selected={on}
                {...keepFocus}
                onClick={() => switchTab(t.code)}
                className={`flex min-h-11 items-center gap-2 rounded-md border-2 px-3 font-bold ${
                  on ? (t.code === ALL_CENTERS ? 'border-zinc-200 bg-zinc-200 text-zinc-950' : departmentChip(t.code)) : 'border-zinc-700 text-zinc-300 hover:border-zinc-400'
                } ${FOCUS_RING}`}
              >
                {i < 9 && <span className="font-mono text-xs opacity-60">{i + 1}</span>}
                {t.label}
              </button>
            )
          })}
          <button
            type="button"
            {...keepFocus}
            onClick={() => dispatch({ type: 'centerForm', form: NEW_CENTER })}
            className={`flex min-h-11 items-center gap-1 rounded-md border-2 border-dashed border-zinc-600 px-3 font-bold text-zinc-300 hover:border-zinc-300 ${FOCUS_RING}`}
          >
            <Plus className="size-4" aria-hidden /> Center
          </button>
        </nav>
      )}

      {state.load === 'loading' && <CenterNote title="Loading revenue centers…" />}
      {state.load === 'noDay' && <CenterNote title="No business day yet — open one in Day End" />}
      {state.load === 'offline' && (
        <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />}>
          <button type="button" onClick={() => void refresh()} className="mt-2 inline-flex items-center gap-2 rounded-md border-2 border-zinc-600 px-4 py-2 font-bold hover:border-zinc-300">
            <RefreshCw className="size-4" aria-hidden /> Retry now
          </button>
        </CenterNote>
      )}

      {state.load === 'ready' && state.tab === ALL_CENTERS && state.overview && (
        <main className="flex min-h-0 flex-1 flex-col gap-4 p-5" aria-label="All centers">
          <table className="w-full overflow-hidden rounded-lg border-2 border-zinc-800 bg-zinc-900 font-mono tabular-nums">
            <thead className="text-xs tracking-widest text-zinc-500 uppercase">
              <tr className="border-b border-zinc-800">
                <th className="px-4 py-2 text-left font-sans">Center</th>
                <th className="px-4 py-2 text-right font-sans">Sales</th>
                <th className="px-4 py-2 text-right font-sans">Expenses</th>
                <th className="px-4 py-2 text-right font-sans">Purchases</th>
                <th className="px-4 py-2 text-right font-sans">Gross</th>
              </tr>
            </thead>
            <tbody>
              {state.overview.centers.map((c) => (
                <tr key={c.code} onClick={() => switchTab(c.code)} className="cursor-pointer border-b border-zinc-800 hover:bg-zinc-800/60">
                  <td className="px-4 py-3 font-sans">
                    <span className={`rounded border px-2 py-0.5 font-bold ${departmentChip(c.code)}`}>{c.name}</span>
                  </td>
                  <td className="px-4 py-3 text-right font-bold">{formatPaise(c.salesPaise)}</td>
                  <td className="px-4 py-3 text-right text-zinc-300">{c.expensesPaise === 0n ? '—' : `− ${formatPaise(c.expensesPaise)}`}</td>
                  <td className="px-4 py-3 text-right text-zinc-300">{c.purchasesPaise === 0n ? '—' : `− ${formatPaise(c.purchasesPaise)}`}</td>
                  <td className={`px-4 py-3 text-right font-black ${c.grossPaise < 0n ? 'text-rose-300' : 'text-emerald-300'}`}>{formatPaise(c.grossPaise)}</td>
                </tr>
              ))}
              <tr className="text-lg font-black">
                <td className="px-4 py-3 font-sans">All centers</td>
                <td className="px-4 py-3 text-right">{formatPaise(state.overview.total.salesPaise)}</td>
                <td className="px-4 py-3 text-right">− {formatPaise(state.overview.total.expensesPaise)}</td>
                <td className="px-4 py-3 text-right">− {formatPaise(state.overview.total.purchasesPaise)}</td>
                <td className={`px-4 py-3 text-right ${state.overview.total.grossPaise < 0n ? 'text-rose-300' : 'text-emerald-300'}`}>{formatPaise(state.overview.total.grossPaise)}</td>
              </tr>
            </tbody>
          </table>
          <p className="text-sm text-zinc-500">
            Liquor stays on Day End. Purchases = stock received through Purchase (GRN) for the center&rsquo;s items + its own supply purchases. Shared overheads (transport,
            repairs, wages) are not in any center. <Kbd>←</Kbd>/<Kbd>→</Kbd> or <Kbd>1</Kbd>–<Kbd>9</Kbd> switch centers · <Kbd>Ins</Kbd> new purchase · <Kbd>Esc</Kbd> dashboard.
          </p>
        </main>
      )}

      {state.load === 'ready' && state.tab !== ALL_CENTERS && summary && (
        <main className="flex min-h-0 flex-1 flex-col gap-4 p-5" aria-label={`${summary.center.name} P&L`}>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Center P&L">
            {pnlCards(summary, formatPaise).map((card) => (
              <div
                key={card.key}
                className={`rounded-lg border-2 p-4 ${card.key === 'gross' ? (card.value < 0n ? 'border-rose-500 bg-rose-500/10' : 'border-emerald-500 bg-emerald-500/10') : 'border-zinc-700 bg-zinc-900'}`}
              >
                <h2 className="truncate text-xs font-bold tracking-widest text-zinc-400 uppercase">{card.label}</h2>
                <p className={`mt-1 font-mono text-3xl font-black tabular-nums ${card.value < 0n && card.key !== 'gross' ? 'text-zinc-200' : ''}`}>
                  {card.value < 0n ? '− ' : ''}
                  {formatPaise(card.value < 0n ? -card.value : card.value)}
                </p>
                <p className="mt-1 text-sm text-zinc-400">{card.hint}</p>
              </div>
            ))}
          </section>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="flex min-h-0 flex-col rounded-lg border-2 border-zinc-800 bg-zinc-900" aria-label="Items sold">
              <h2 className="border-b border-zinc-800 px-4 py-2 text-xs font-bold tracking-widest text-zinc-400 uppercase">{summary.center.name} items sold</h2>
              <ul className="min-h-0 flex-1 overflow-y-auto">
                {summary.itemsSold.map((item) => (
                  <li key={item.skuId} className="flex min-h-11 items-center gap-3 border-b border-zinc-800 px-4">
                    <span className="min-w-0 flex-1 truncate font-semibold">{item.displayName}</span>
                    <span className="w-12 text-right font-mono tabular-nums">{item.quantity}</span>
                    <span className="w-28 text-right font-mono font-bold tabular-nums">{formatPaise(item.amountPaise)}</span>
                  </li>
                ))}
                {summary.itemsSold.length === 0 && <li className="p-6 text-center text-zinc-500">No {summary.center.name} sales counted yet today.</li>}
              </ul>
              <h2 className="border-y border-zinc-800 px-4 py-2 text-xs font-bold tracking-widest text-zinc-400 uppercase">{summary.center.name} expenses (from the Expense screen)</h2>
              <ul className="max-h-48 overflow-y-auto">
                {summary.expenses.map((e) => (
                  <li key={e.id} className={`flex min-h-10 items-center gap-3 border-b border-zinc-800 px-4 text-sm ${e.voidedAt ? 'text-zinc-600 line-through' : ''}`}>
                    <span className="font-mono text-zinc-500">{clock(e.createdAt)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {e.category.name}
                      {e.description && <span className="text-zinc-400"> · {e.description}</span>}
                    </span>
                    <span className="font-mono tabular-nums">{formatPaise(e.amountPaise)}</span>
                  </li>
                ))}
                {summary.expenses.length === 0 && <li className="px-4 py-3 text-sm text-zinc-500">None — petty cash in a {summary.center.name} expense category shows here.</li>}
              </ul>
            </section>

            <section className="flex min-h-0 flex-col rounded-lg border-2 border-zinc-800 bg-zinc-900" aria-label="Purchases">
              <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
                <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">{summary.center.name} supply purchases</h2>
                {open && (
                  <button
                    type="button"
                    onClick={openPurchase}
                    className={`ml-auto flex min-h-11 items-center gap-2 rounded-lg bg-emerald-500 px-4 font-black text-zinc-950 hover:bg-emerald-400 ${FOCUS_RING}`}
                  >
                    <Plus className="size-5" aria-hidden /> New purchase <Kbd>Ins</Kbd>
                  </button>
                )}
              </div>
              {summary.stockPurchasesPaise !== 0n && (
                <p className="border-b border-zinc-800 px-4 py-2 text-sm text-sky-200">
                  + {formatPaise(summary.stockPurchasesPaise)} of stock received through Purchase (GRN) today — see the Purchase screen.
                </p>
              )}
              <ul className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Purchases today">
                {summary.purchases.map((p) => {
                  const selected = p.id === state.selectedId
                  return (
                    <li
                      key={p.id}
                      role="option"
                      aria-selected={selected}
                      onClick={() => dispatch({ type: 'select', id: p.id })}
                      className={`cursor-pointer border-b border-zinc-800 px-4 py-2 ${selected ? 'bg-emerald-400/10 outline-2 -outline-offset-2 outline-emerald-400/60' : ''} ${p.voidedAt ? 'text-zinc-600' : ''}`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-sm text-zinc-500">{clock(p.createdAt)}</span>
                        <span className={`min-w-0 flex-1 truncate font-bold ${p.voidedAt ? 'line-through' : ''}`}>{p.vendorName ?? 'Purchase'}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[11px] font-black uppercase ${p.paidFrom === 'DRAWER' ? 'bg-amber-400 text-zinc-950' : 'bg-zinc-700 text-zinc-200'}`}>
                          {p.paidFrom === 'DRAWER' ? 'drawer' : 'outside'}
                        </span>
                        <span className={`w-28 text-right font-mono font-bold tabular-nums ${p.voidedAt ? 'line-through' : ''}`}>{formatPaise(p.amountPaise)}</span>
                        {p.voidedAt ? (
                          <span className="text-xs">voided {clock(p.voidedAt)}</span>
                        ) : (
                          open && (
                            <button
                              type="button"
                              aria-label={`Void the ${formatPaise(p.amountPaise)} purchase`}
                              onClick={(e) => {
                                e.stopPropagation()
                                dispatch({ type: 'confirmVoid', purchase: p })
                              }}
                              className={`flex size-10 items-center justify-center rounded-md border-2 border-zinc-700 text-zinc-300 hover:border-rose-400 hover:text-rose-300 ${FOCUS_RING}`}
                            >
                              <Trash2 className="size-4" aria-hidden />
                            </button>
                          )
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-sm text-zinc-400">
                        {p.lines.map((l) => `${l.description}${l.quantity ? ` ${l.quantity}` : ''} ${formatPaise(l.amountPaise)}`).join(' · ')}
                        {p.note && ` — ${p.note}`}
                      </p>
                    </li>
                  )
                })}
                {summary.purchases.length === 0 && <li className="p-6 text-center text-zinc-500">No {summary.center.name} supply purchases today.</li>}
              </ul>
            </section>
          </div>

          <p className="text-sm text-zinc-500">
            <Kbd>←</Kbd>/<Kbd>→</Kbd> or <Kbd>1</Kbd>–<Kbd>9</Kbd> switch centers · <Kbd>Ins</Kbd> new purchase · <Kbd>↑</Kbd>/<Kbd>↓</Kbd> select · <Kbd>Del</Kbd> void ·{' '}
            <Kbd>R</Kbd> refresh · <Kbd>Esc</Kbd> dashboard. Refreshes every 15 s. Drawer purchases also lower Day End&rsquo;s expected cash.
          </p>
        </main>
      )}

      {state.form && (
        <PurchaseModal
          form={state.form}
          centers={centers}
          peakRunning={state.peakRunning}
          error={state.saveError ?? purchaseFormError(state.form, state.peakRunning)}
          serverError={state.saveError !== null}
          saving={state.saving}
          onChange={(form) => dispatch({ type: 'form', form })}
          onSave={savePurchase}
          onClose={() => dispatch({ type: 'form', form: null })}
        />
      )}
      {state.centerForm && (
        <CenterModal
          form={state.centerForm}
          original={undefined}
          error={state.saveError ?? centerFormError(state.centerForm, state.departments)}
          showError={state.saveError !== null}
          saving={state.saving}
          onEdit={(patch) => dispatch({ type: 'editCenter', patch })}
          onSave={saveCenter}
          onClose={() => dispatch({ type: 'centerForm', form: null })}
        />
      )}
      {state.confirmVoid && (
        <Modal
          title="Void this purchase?"
          onClose={() => dispatch({ type: 'confirmVoid', purchase: null })}
          onKey={(e) => {
            if (e.key !== 'Enter') return false
            voidPurchase()
            return true
          }}
          footer={
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => dispatch({ type: 'confirmVoid', purchase: null })} className="min-h-12 rounded-md border-2 border-zinc-600 px-5 font-bold">
                Keep (Esc)
              </button>
              <button type="button" onClick={voidPurchase} className="min-h-12 rounded-md bg-rose-500 px-5 font-black text-zinc-950">
                Void (Enter)
              </button>
            </div>
          }
        >
          <p className="text-lg">
            {formatPaise(state.confirmVoid.amountPaise)} {state.confirmVoid.vendorName ? `from ${state.confirmVoid.vendorName}` : ''} ·{' '}
            {state.confirmVoid.paidFrom === 'DRAWER' ? 'paid from the drawer (the cash comes back into the expected figure)' : 'paid outside'}
          </p>
          <p className="mt-2 text-sm text-zinc-400">A void is a negating record; the original stays on file.</p>
        </Modal>
      )}
    </div>
  )
}

function PurchaseModal({
  form,
  centers,
  peakRunning,
  error,
  serverError,
  saving,
  onChange,
  onSave,
  onClose,
}: {
  form: PurchaseForm
  /** Active non-liquor centers a purchase can belong to. */
  centers: Array<{ code: string; name: string; tracksStock: boolean }>
  peakRunning: boolean
  error: string | null
  serverError: boolean
  saving: boolean
  onChange: (form: PurchaseForm) => void
  onSave: () => void
  onClose: () => void
}) {
  const total = purchaseTotal(form)
  const focusNewLine = useRef(false)
  useEffect(() => {
    if (!focusNewLine.current) return
    focusNewLine.current = false
    document.querySelector<HTMLInputElement>('[data-last-line] [data-line-description]')?.focus()
  })
  return (
    <Modal
      title="New purchase"
      width="max-w-4xl"
      onClose={onClose}
      onKey={(e) => {
        if (e.key !== 'F9') return false
        onSave()
        return true
      }}
      footer={
        <div className="flex items-center gap-3">
          <p className={`min-w-0 flex-1 text-sm font-semibold ${serverError ? 'text-rose-300' : 'text-amber-300'}`}>{error ?? 'F9 saves · Esc cancels'}</p>
          <span className="font-mono text-2xl font-black tabular-nums">{total === null ? '—' : formatPaise(total)}</span>
          <button type="button" onClick={onClose} className="min-h-12 rounded-md border-2 border-zinc-600 px-5 font-bold">
            Cancel (Esc)
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || error !== null}
            className="min-h-12 rounded-md bg-emerald-500 px-5 font-black text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {saving ? 'Saving…' : 'Save (F9)'}
          </button>
        </div>
      }
    >
      <div>
        <span className="text-sm font-semibold text-zinc-300">Revenue center</span>
        <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label="Revenue center">
          {centers.map((c) => (
            <button
              key={c.code}
              type="button"
              role="radio"
              aria-checked={form.department === c.code}
              onClick={() => onChange({ ...form, department: c.code })}
              className={`min-h-12 rounded-md border-2 px-4 font-bold ${form.department === c.code ? departmentChip(c.code) : 'border-zinc-600 text-zinc-200 hover:border-zinc-400'} ${FOCUS_RING}`}
            >
              {c.name}
            </button>
          ))}
        </div>
        {centers.find((c) => c.code === form.department)?.tracksStock && (
          <p className="mt-1 rounded-md border-l-4 border-sky-500 bg-sky-500/10 px-3 py-1.5 text-sm text-sky-200">
            Buying stock to sell (e.g. Gold Flake cartons)? Record it in Purchase (GRN) so the shelf count rises — it counts here automatically. Use this for supplies
            (ice, cups, packaging).
          </p>
        )}
      </div>
      <div className="mt-4 grid grid-cols-[1fr_auto] gap-4">
        <label className="block">
          <span className="text-sm font-semibold text-zinc-300">Vendor (optional)</span>
          <input
            data-autofocus
            value={form.vendor}
            maxLength={80}
            autoComplete="off"
            onChange={(e) => onChange({ ...form, vendor: e.target.value })}
            placeholder="e.g. Raju Chicken Centre, Metro"
            className="mt-1 w-full rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 py-3 text-lg outline-none focus:border-amber-400"
          />
        </label>
        <div>
          <span className="text-sm font-semibold text-zinc-300">Paid from</span>
          <div className="mt-1 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Paid from">
            {(['DRAWER', 'OUTSIDE'] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={form.paidFrom === p}
                disabled={p === 'DRAWER' && peakRunning}
                onClick={() => onChange({ ...form, paidFrom: p })}
                className={`min-h-[3.25rem] rounded-md border-2 px-5 text-lg font-black disabled:cursor-not-allowed disabled:opacity-40 ${
                  form.paidFrom === p ? 'border-emerald-400 bg-emerald-400 text-zinc-950' : 'border-zinc-600 text-zinc-200'
                } ${FOCUS_RING}`}
              >
                {p === 'DRAWER' ? 'Drawer' : 'Outside'}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-1 text-sm text-zinc-400">
        {peakRunning
          ? 'A peak is running: drawer purchases wait until it ends (the peak count would miss them).'
          : form.paidFrom === 'DRAWER'
            ? 'Cash from the till: Day End expects that much less in the drawer.'
            : 'Paid by the owner, bank, credit or UPI: only the Kitchen P&L counts it.'}
      </p>

      <div className="mt-4 grid grid-cols-[1fr_9rem_10rem_3rem] gap-2 text-xs font-bold tracking-widest text-zinc-500 uppercase">
        <span>What was bought</span>
        <span>Quantity</span>
        <span>Amount ₹</span>
        <span />
      </div>
      <div className="mt-1 flex max-h-80 flex-col gap-2 overflow-y-auto">
        {form.lines.map((line, i) => (
          <div key={line.key} className="grid grid-cols-[1fr_9rem_10rem_3rem] gap-2" {...(i === form.lines.length - 1 ? { 'data-last-line': true } : {})}>
            <input
              data-line-description
              value={line.description}
              aria-label={`Line ${i + 1} item`}
              autoComplete="off"
              onChange={(e) => onChange(setLine(form, line.key, { description: e.target.value }))}
              placeholder="e.g. Chicken"
              className="min-h-12 rounded-md border-2 border-zinc-700 bg-zinc-950 px-3 text-lg outline-none focus:border-amber-400"
            />
            <input
              value={line.quantity}
              aria-label={`Line ${i + 1} quantity`}
              autoComplete="off"
              onChange={(e) => onChange(setLine(form, line.key, { quantity: e.target.value }))}
              placeholder="5 kg"
              className="min-h-12 rounded-md border-2 border-zinc-700 bg-zinc-950 px-3 text-lg outline-none focus:border-amber-400"
            />
            <input
              value={line.amount}
              aria-label={`Line ${i + 1} amount`}
              inputMode="decimal"
              autoComplete="off"
              onChange={(e) => onChange(setLine(form, line.key, { amount: e.target.value }))}
              onKeyDown={(e) => {
                // Enter on the last amount adds the next line.
                if (e.key === 'Enter' && i === form.lines.length - 1 && form.lines.length < MAX_LINES) {
                  e.preventDefault()
                  focusNewLine.current = true
                  onChange(addLine(form))
                }
              }}
              placeholder="0"
              className="min-h-12 rounded-md border-2 border-zinc-700 bg-zinc-950 px-3 text-right font-mono text-lg tabular-nums outline-none focus:border-amber-400"
            />
            <button
              type="button"
              aria-label={`Remove line ${i + 1}`}
              onClick={() => onChange(removeLine(form, line.key))}
              className="flex min-h-12 items-center justify-center rounded-md border-2 border-zinc-700 text-zinc-400 hover:border-rose-400 hover:text-rose-300"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            focusNewLine.current = true
            onChange(addLine(form))
          }}
          disabled={form.lines.length >= MAX_LINES}
          className={`flex min-h-12 items-center gap-2 rounded-md border-2 border-zinc-600 px-4 font-bold hover:border-zinc-300 disabled:opacity-40 ${FOCUS_RING}`}
        >
          <Plus className="size-4" aria-hidden /> Add line
        </button>
        <span className="text-sm text-zinc-500">Enter on the last amount adds a line · quantities are labels like “5 kg”</span>
      </div>
      <label className="mt-4 block">
        <span className="text-sm font-semibold text-zinc-300">Note (optional)</span>
        <input
          value={form.note}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => onChange({ ...form, note: e.target.value })}
          className="mt-1 w-full rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 py-2.5 outline-none focus:border-amber-400"
        />
      </label>
    </Modal>
  )
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function CenterNote({ title, icon, children }: { title: string; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      {icon ?? <Store className="size-10 text-zinc-500" aria-hidden />}
      <h2 className="text-2xl font-bold">{title}</h2>
      {children}
    </div>
  )
}
