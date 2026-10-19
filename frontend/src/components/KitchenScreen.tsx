import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react'
import { ArrowLeft, ChefHat, Plus, RefreshCw, Trash2, WifiOff, X } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { KitchenPurchaseEntry, KitchenSummary } from '../api/types'
import { FlashLine } from '../billing/BillingPanels'
import type { Flash } from '../billing/billingReducer'
import { counterErrorMessage } from '../billing/errors'
import { Modal } from '../billing/Modal'
import { beep } from '../lib/beep'
import { formatPaise } from '../lib/money'
import { FOCUS_RING, keepFocus } from '../lib/ui'
import {
  addLine,
  MAX_LINES,
  newPurchaseForm,
  pnlCards,
  purchaseFormError,
  purchasePayload,
  purchaseTotal,
  removeLine,
  setLine,
  type PurchaseForm,
} from '../kitchen/purchaseForm'
import { Kbd, LiveClock } from './ui'

const POLL_MS = 15_000

interface State {
  load: 'loading' | 'ready' | 'offline' | 'noDay'
  summary: KitchenSummary | null
  peakRunning: boolean
  selectedId: string | null
  form: PurchaseForm | null
  confirmVoid: KitchenPurchaseEntry | null
  saving: boolean
  saveError: string | null
  flash: Flash | null
}

type Action =
  | { type: 'loaded'; summary: KitchenSummary; peakRunning: boolean }
  | { type: 'failed'; message: string; noDay: boolean }
  | { type: 'select'; id: string }
  | { type: 'form'; form: PurchaseForm | null }
  | { type: 'confirmVoid'; purchase: KitchenPurchaseEntry | null }
  | { type: 'saving'; on: boolean }
  | { type: 'saveError'; message: string }
  | { type: 'flash'; kind: Flash['kind']; text: string }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded': {
      const ids = action.summary.purchases.map((p) => p.id)
      return { ...state, load: 'ready', summary: action.summary, peakRunning: action.peakRunning, selectedId: ids.includes(state.selectedId ?? '') ? state.selectedId : (ids[0] ?? null) }
    }
    case 'failed':
      if (action.noDay) return { ...state, load: 'noDay' }
      return { ...state, load: state.summary ? 'ready' : 'offline', flash: { kind: 'error', text: action.message, seq: (state.flash?.seq ?? 0) + 1 } }
    case 'select':
      return { ...state, selectedId: action.id }
    case 'form':
      return { ...state, form: action.form, saving: false, saveError: null }
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

const INITIAL: State = { load: 'loading', summary: null, peakRunning: false, selectedId: null, form: null, confirmVoid: null, saving: false, saveError: null, flash: null }

/**
 * Kitchen Kiosk (Phase 21): the day's Kitchen P&L (sales − Kitchen expenses − kitchen purchases),
 * the kitchen items sold, and kitchen purchases (raw materials, apart from the liquor GRN) with a
 * touch-friendly New Purchase modal. Shows the open day, else the last closed one (read-only).
 */
export default function KitchenScreen({ onExit }: { onExit: () => void }) {
  const [state, dispatch] = useReducer(reducer, INITIAL)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  const flash = useCallback((kind: Flash['kind'], text: string) => {
    beep(kind)
    dispatch({ type: 'flash', kind, text })
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [summary, context] = await Promise.all([api.kitchenSummary(), api.context()])
      dispatch({ type: 'loaded', summary, peakRunning: context.peakSession !== null })
    } catch (err) {
      const noDay = err instanceof ApiError && err.status === 404
      dispatch({ type: 'failed', message: counterErrorMessage(err), noDay })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      if (!stateRef.current.form && !stateRef.current.confirmVoid) void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const open = state.summary?.day.status === 'OPEN'

  const save = useCallback(() => {
    const { form, peakRunning, saving } = stateRef.current
    if (!form || saving) return
    const problem = purchaseFormError(form, peakRunning)
    if (problem) {
      dispatch({ type: 'saveError', message: problem })
      return
    }
    dispatch({ type: 'saving', on: true })
    api
      .recordKitchenPurchase(purchasePayload(form))
      .then((saved) => {
        dispatch({ type: 'form', form: null })
        dispatch({ type: 'select', id: saved.id })
        flash('ok', `Purchase of ${formatPaise(saved.amountPaise)} recorded${saved.paidFrom === 'DRAWER' ? ' · paid from the drawer' : ''}`)
        void refresh()
      })
      .catch((err: unknown) => dispatch({ type: 'saveError', message: counterErrorMessage(err) }))
  }, [flash, refresh])

  const voidPurchase = useCallback(() => {
    const target = stateRef.current.confirmVoid
    if (!target) return
    dispatch({ type: 'confirmVoid', purchase: null })
    api
      .voidKitchenPurchase(target.id)
      .then(() => {
        flash('ok', `Voided the ${formatPaise(target.amountPaise)} purchase${target.vendorName ? ` from ${target.vendorName}` : ''}`)
        void refresh()
      })
      .catch((err: unknown) => flash('error', counterErrorMessage(err)))
  }, [flash, refresh])

  // Page keys (a modal owns the keyboard while open).
  const modalOpen = state.form !== null || state.confirmVoid !== null
  useEffect(() => {
    if (modalOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const s = stateRef.current
      const list = s.summary?.purchases ?? []
      const at = list.findIndex((p) => p.id === s.selectedId)
      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          onExit()
          return
        case 'Insert':
          event.preventDefault()
          if (s.summary?.day.status === 'OPEN') dispatch({ type: 'form', form: newPurchaseForm(s.peakRunning) })
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
          if (current && !current.voidedAt && s.summary?.day.status === 'OPEN') {
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
  }, [modalOpen, onExit, refresh])

  const summary = state.summary
  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b-2 border-emerald-400 bg-zinc-900 px-5">
        <button type="button" {...keepFocus} onClick={onExit} className="flex items-center gap-2 rounded px-1 text-zinc-300 hover:text-zinc-50" aria-label="Back to dashboard (Esc)">
          <ArrowLeft className="size-5" aria-hidden />
          <span className="rounded bg-amber-400 px-2 py-0.5 text-lg font-black tracking-tight text-zinc-950">FL2</span>
        </button>
        <h1 className="flex items-center gap-2 text-lg font-bold tracking-wide uppercase">
          <ChefHat className="size-5 text-emerald-400" aria-hidden /> Kitchen Kiosk
        </h1>
        {summary && (
          <span className={`rounded px-2.5 py-1 text-sm font-black tracking-widest uppercase ${open ? 'bg-emerald-400 text-zinc-950' : 'bg-zinc-700 text-zinc-200'}`}>
            {summary.day.businessDate} · {open ? 'open' : 'closed'}
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

      {state.load === 'loading' && <CenterNote title="Loading the kitchen…" />}
      {state.load === 'noDay' && <CenterNote title="No business day yet — open one in Day End" />}
      {state.load === 'offline' && (
        <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />}>
          <button type="button" onClick={() => void refresh()} className="mt-2 inline-flex items-center gap-2 rounded-md border-2 border-zinc-600 px-4 py-2 font-bold hover:border-zinc-300">
            <RefreshCw className="size-4" aria-hidden /> Retry now
          </button>
        </CenterNote>
      )}

      {summary && state.load === 'ready' && (
        <main className="flex min-h-0 flex-1 flex-col gap-4 p-5" aria-label="Kitchen P&L">
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Kitchen P&L">
            {pnlCards(summary, formatPaise).map((card) => (
              <div
                key={card.key}
                className={`rounded-lg border-2 p-4 ${card.key === 'gross' ? (card.value < 0n ? 'border-rose-500 bg-rose-500/10' : 'border-emerald-500 bg-emerald-500/10') : 'border-zinc-700 bg-zinc-900'}`}
              >
                <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">{card.label}</h2>
                <p className={`mt-1 font-mono text-3xl font-black tabular-nums ${card.value < 0n && card.key !== 'gross' ? 'text-zinc-200' : ''}`}>
                  {card.value < 0n ? '− ' : ''}
                  {formatPaise(card.value < 0n ? -card.value : card.value)}
                </p>
                <p className="mt-1 text-sm text-zinc-400">{card.hint}</p>
              </div>
            ))}
          </section>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="flex min-h-0 flex-col rounded-lg border-2 border-zinc-800 bg-zinc-900" aria-label="Kitchen items sold">
              <h2 className="border-b border-zinc-800 px-4 py-2 text-xs font-bold tracking-widest text-zinc-400 uppercase">Kitchen items sold</h2>
              <ul className="min-h-0 flex-1 overflow-y-auto">
                {summary.itemsSold.map((item) => (
                  <li key={item.skuId} className="flex min-h-11 items-center gap-3 border-b border-zinc-800 px-4">
                    <span className="min-w-0 flex-1 truncate font-semibold">{item.displayName}</span>
                    <span className="w-12 text-right font-mono tabular-nums">{item.quantity}</span>
                    <span className="w-28 text-right font-mono font-bold tabular-nums">{formatPaise(item.amountPaise)}</span>
                  </li>
                ))}
                {summary.itemsSold.length === 0 && <li className="p-6 text-center text-zinc-500">No kitchen sales counted yet today.</li>}
              </ul>
              <h2 className="border-y border-zinc-800 px-4 py-2 text-xs font-bold tracking-widest text-zinc-400 uppercase">Kitchen expenses (from the Expense screen)</h2>
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
                {summary.expenses.length === 0 && <li className="px-4 py-3 text-sm text-zinc-500">None — petty cash in a Kitchen category shows here.</li>}
              </ul>
            </section>

            <section className="flex min-h-0 flex-col rounded-lg border-2 border-zinc-800 bg-zinc-900" aria-label="Kitchen purchases">
              <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
                <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">Kitchen purchases</h2>
                {open && (
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'form', form: newPurchaseForm(state.peakRunning) })}
                    className={`ml-auto flex min-h-11 items-center gap-2 rounded-lg bg-emerald-500 px-4 font-black text-zinc-950 hover:bg-emerald-400 ${FOCUS_RING}`}
                  >
                    <Plus className="size-5" aria-hidden /> New purchase <Kbd>Ins</Kbd>
                  </button>
                )}
              </div>
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
                {summary.purchases.length === 0 && <li className="p-6 text-center text-zinc-500">No kitchen purchases recorded today.</li>}
              </ul>
            </section>
          </div>

          <p className="text-sm text-zinc-500">
            <Kbd>Ins</Kbd> new purchase · <Kbd>↑</Kbd>/<Kbd>↓</Kbd> select · <Kbd>Del</Kbd> void · <Kbd>R</Kbd> refresh · <Kbd>Esc</Kbd> dashboard. Refreshes every 15 s. Shared
            overheads (transport, repairs, wages) are not in the Kitchen P&amp;L. Drawer purchases also lower Day End&rsquo;s expected cash.
          </p>
        </main>
      )}

      {state.form && (
        <PurchaseModal
          form={state.form}
          peakRunning={state.peakRunning}
          error={state.saveError ?? purchaseFormError(state.form, state.peakRunning)}
          serverError={state.saveError !== null}
          saving={state.saving}
          onChange={(form) => dispatch({ type: 'form', form })}
          onSave={save}
          onClose={() => dispatch({ type: 'form', form: null })}
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
  peakRunning,
  error,
  serverError,
  saving,
  onChange,
  onSave,
  onClose,
}: {
  form: PurchaseForm
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
      title="New kitchen purchase"
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
      <div className="grid grid-cols-[1fr_auto] gap-4">
        <label className="block">
          <span className="text-sm font-semibold text-zinc-300">Vendor (optional)</span>
          <input
            data-autofocus
            value={form.vendor}
            maxLength={80}
            autoComplete="off"
            onChange={(e) => onChange({ ...form, vendor: e.target.value })}
            placeholder="e.g. Raju Chicken Centre"
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
      {icon ?? <ChefHat className="size-10 text-zinc-500" aria-hidden />}
      <h2 className="text-2xl font-bold">{title}</h2>
      {children}
    </div>
  )
}
