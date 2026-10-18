import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react'
import { ArrowLeft, ReceiptIndianRupee, RefreshCw, Search, Sunrise, WifiOff, Zap } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { ExpenseEntry } from '../api/types'
import { FlashLine } from '../billing/BillingPanels'
import { counterErrorMessage } from '../billing/errors'
import { Modal } from '../billing/Modal'
import {
  categoryForKey,
  expenseReducer,
  formError,
  formPayload,
  initialExpenseState,
  pickerMatches,
  quickKey,
  selectedCategory,
  todayTotals,
} from '../expense/expenseReducer'
import { beep } from '../lib/beep'
import { formatPaise } from '../lib/money'
import { FOCUS_RING, keepFocus } from '../lib/ui'
import { RupeeField } from './RupeeField'
import { Kbd, LiveClock } from './ui'

const POLL_MS = 15_000

interface ExpenseScreenProps {
  onExit: () => void
  onOpenDayEnd: () => void
  /** Where Esc goes: the Dashboard, or back to Day End when opened from there (F6). */
  exitLabel?: string
}

/**
 * Petty-cash expenses for the open day: a touch-first form (category chips, amount, note) and the
 * day's list with Void. Every entry is stamped by the server with the till's cashier; a void
 * appends a negating row, so nothing is ever edited or deleted.
 */
export default function ExpenseScreen({ onExit, onOpenDayEnd, exitLabel = 'Dashboard' }: ExpenseScreenProps) {
  const [state, dispatch] = useReducer(expenseReducer, initialExpenseState)
  const amountRef = useRef<HTMLInputElement>(null)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  const flash = useCallback((kind: 'ok' | 'error', text: string) => {
    beep(kind)
    dispatch({ type: 'flash', kind, text })
  }, [])

  const refresh = useCallback(async () => {
    try {
      const context = await api.context()
      dispatch({ type: 'till', cashier: context.cashier.displayName, date: context.businessDay?.businessDate ?? null })
      if (!context.businessDay) {
        dispatch({ type: 'noDay' })
        return
      }
      const [entries, categories] = await Promise.all([api.listExpenses(), api.listExpenseCategories()])
      dispatch({ type: 'categories', categories })
      dispatch({ type: 'loaded', entries })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_FOUND') dispatch({ type: 'noDay' })
      else dispatch({ type: 'failed', message: counterErrorMessage(err) })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const record = useCallback(() => {
    const current = stateRef.current
    if (current.submitting) return
    const payload = formPayload(current)
    if (!payload) {
      flash('error', formError(current) ?? 'Check the form')
      return
    }
    dispatch({ type: 'submitting', on: true })
    api
      .addExpense(payload.amount, payload.categoryId, payload.description)
      .then((expense) => {
        dispatch({ type: 'recorded' })
        flash('ok', `Recorded ${formatPaise(expense.amountPaise)} · ${expense.category.name}${expense.peakSessionId ? ' (during peak)' : ''}`)
        amountRef.current?.focus()
      })
      .catch((err: unknown) => {
        dispatch({ type: 'submitting', on: false })
        flash('error', counterErrorMessage(err))
      })
      .finally(() => void refresh())
  }, [flash, refresh])

  const voidExpense = useCallback(
    (entry: ExpenseEntry) => {
      dispatch({ type: 'confirmVoid', id: null })
      api
        .voidExpense(entry.id)
        .then(() => flash('ok', `Voided ${formatPaise(entry.amountPaise)} · ${entry.category.name}`))
        .catch((err: unknown) => flash('error', counterErrorMessage(err)))
        .finally(() => void refresh())
    },
    [flash, refresh],
  )

  const pickCategory = useCallback((id: string) => {
    dispatch({ type: 'category', id })
    amountRef.current?.focus()
  }, [])

  // Keys: 1–9 pick the first nine categories when no text field has focus; Esc leaves (when no dialog is open).
  const dialogOpen = state.confirmVoidId !== null
  useEffect(() => {
    if (dialogOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onExit()
        return
      }
      const inField = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
      const category = categoryForKey(stateRef.current, event.key)
      if (category && !inField && stateRef.current.load === 'ready') {
        event.preventDefault()
        pickCategory(category.id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen, onExit, pickCategory])

  const { till } = state
  const totals = todayTotals(state.entries)
  const error = formError(state)
  const confirming = state.entries.find((e) => e.id === state.confirmVoidId)
  const picked = selectedCategory(state)
  const matches = pickerMatches(state)
  const searching = state.query.trim() !== '' && state.query.trim().toLowerCase() !== picked?.name.toLowerCase()

  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b-2 border-amber-400 bg-zinc-900 px-5">
        <button
          type="button"
          {...keepFocus}
          onClick={onExit}
          className="flex items-center gap-2 rounded px-1 text-zinc-300 hover:text-zinc-50"
          aria-label={`Back to ${exitLabel} (Esc)`}
        >
          <ArrowLeft className="size-5" aria-hidden />
          <span className="rounded bg-amber-400 px-2 py-0.5 text-lg font-black tracking-tight text-zinc-950">FL2</span>
        </button>
        <h1 className="text-lg font-bold tracking-wide uppercase">Expenses</h1>
        {till && (
          <span className="text-sm text-zinc-400">
            {till.date ? `Day ${till.date} · ` : ''}Cashier: {till.cashier}
          </span>
        )}
        {state.load === 'ready' && (
          <span className="rounded bg-rose-500 px-2.5 py-1 text-sm font-black tracking-widest text-zinc-950 uppercase">
            Today {formatPaise(totals.totalPaise)} ({totals.count})
          </span>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm">
          <LiveClock />
          <span className="flex items-center gap-1 text-zinc-400">
            <Kbd>Esc</Kbd> {exitLabel}
          </span>
        </div>
      </header>

      {state.load === 'loading' && <CenterNote title="Loading expenses…" />}
      {state.load === 'offline' && state.entries.length === 0 && (
        <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />}>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-2 inline-flex items-center gap-2 rounded-md border-2 border-zinc-600 px-4 py-2 font-bold hover:border-zinc-300"
          >
            <RefreshCw className="size-4" aria-hidden /> Retry now
          </button>
        </CenterNote>
      )}
      {state.load === 'noDay' && (
        <CenterNote title="No business day is open" icon={<Sunrise className="size-10 text-amber-400" aria-hidden />}>
          <p className="text-zinc-300">Expenses are paid from the drawer of the open day. Open the day first.</p>
          <button type="button" onClick={onOpenDayEnd} className="mt-2 rounded-md bg-amber-400 px-5 py-3 text-lg font-bold text-zinc-950 hover:bg-amber-300">
            Go to Day End
          </button>
        </CenterNote>
      )}

      {(state.load === 'ready' || (state.load === 'offline' && state.entries.length > 0)) && (
        <div className="flex min-h-0 flex-1">
          <section className="flex w-[46%] max-w-2xl min-w-96 shrink-0 flex-col gap-5 overflow-y-auto border-r-2 border-zinc-800 bg-zinc-900 p-5" aria-label="New expense">
            <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">New cash expense</h2>
            <div>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-300">Category</span>
                <div className="mt-1 flex items-center gap-2 rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 focus-within:border-amber-400">
                  <Search className="size-5 shrink-0 text-zinc-500" aria-hidden />
                  <input
                    autoFocus
                    role="combobox"
                    aria-expanded="true"
                    aria-controls="expense-categories"
                    aria-autocomplete="list"
                    value={state.query}
                    autoComplete="off"
                    onChange={(e) => dispatch({ type: 'query', text: e.target.value })}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        dispatch({ type: 'highlight', delta: e.key === 'ArrowDown' ? 1 : -1 })
                      } else if (e.key === 'Enter') {
                        e.preventDefault()
                        const target = searching ? matches[state.highlighted] : (picked ?? matches[state.highlighted])
                        if (target) pickCategory(target.id)
                        else flash('error', `No category matches “${state.query.trim()}”`)
                      }
                    }}
                    placeholder="Type to search, or press 1–9"
                    className="w-full bg-transparent py-3 text-lg outline-none"
                  />
                </div>
              </label>
              {state.categories === null && <p className="mt-2 text-sm text-zinc-400">Loading categories…</p>}
              {state.categories?.length === 0 && <p className="mt-2 text-sm text-amber-300">No active categories — add one in Settings → Expense Categories.</p>}
              {searching && matches.length === 0 && <p className="mt-2 text-sm text-zinc-400">No category matches.</p>}
              <div id="expense-categories" className="mt-2 grid grid-cols-3 gap-2" role="listbox" aria-label="Categories">
                {matches.map((c, i) => {
                  const key = quickKey(state, c.id)
                  const chosen = state.categoryId === c.id
                  const lit = searching && i === state.highlighted
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={chosen}
                      onClick={() => pickCategory(c.id)}
                      className={`flex min-h-16 items-center justify-between gap-2 rounded-lg border-2 px-4 text-left text-lg font-bold ${FOCUS_RING} ${
                        chosen ? 'border-amber-400 bg-amber-400 text-zinc-950' : lit ? 'border-amber-400 bg-zinc-800' : 'border-zinc-700 bg-zinc-950 hover:border-zinc-400'
                      }`}
                    >
                      <span className="leading-tight">{c.name}</span>
                      {key && <Kbd>{key}</Kbd>}
                    </button>
                  )
                })}
              </div>
            </div>
            <RupeeField label="Amount paid from the drawer" value={state.amount} onChange={(text) => dispatch({ type: 'amount', text })} onEnter={record} inputRef={amountRef} size="lg" />
            <label className="block">
              <span className="text-sm font-semibold text-zinc-300">Note {picked?.noteRequired ? `(required for ${picked.name})` : '(optional)'}</span>
              <input
                value={state.note}
                maxLength={200}
                autoComplete="off"
                onChange={(e) => dispatch({ type: 'note', text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    record()
                  }
                }}
                placeholder="e.g. Bags of ice for the bar"
                className="mt-1 w-full rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 py-3 text-lg outline-none focus:border-amber-400"
              />
            </label>
            <div className="text-sm text-zinc-400">
              Paid by <span className="font-semibold text-zinc-200">{till?.cashier ?? '—'}</span> (this till)
            </div>
            <button
              type="button"
              onClick={record}
              disabled={state.submitting || error !== null}
              className={`flex min-h-16 items-center justify-between rounded-lg bg-rose-500 px-5 text-xl font-black text-zinc-950 hover:bg-rose-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-400 ${FOCUS_RING}`}
            >
              <span className="flex items-center gap-3">
                <ReceiptIndianRupee className="size-6" aria-hidden /> {state.submitting ? 'Recording…' : 'Record expense'}
              </span>
              <Kbd>Enter</Kbd>
            </button>
            {error && picked !== null && <p className="-mt-3 text-center text-sm text-amber-300">{error}</p>}
          </section>

          <main className="flex min-w-0 flex-1 flex-col" aria-label="Today's expenses">
            <div className="flex min-h-16 items-center border-b-2 border-zinc-800 bg-zinc-900 px-4 py-2">
              <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">Today's expenses</h2>
              <span className="ml-auto" />
              <FlashLine flash={state.flash} />
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {state.entries.map((e) => (
                <ExpenseRow key={e.id} entry={e} onVoid={() => dispatch({ type: 'confirmVoid', id: e.id })} />
              ))}
              {state.entries.length === 0 && <li className="p-12 text-center text-lg text-zinc-500">No expenses recorded today.</li>}
            </ul>
            <p className="border-t-2 border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-400">
              <Zap className="inline size-4 text-amber-400" aria-hidden /> paid during a peak session (inside the peak's own cash count) · Voids are kept on record and
              struck through.
            </p>
          </main>
        </div>
      )}

      {confirming && (
        <Modal
          title={`Void ${formatPaise(confirming.amountPaise)} · ${confirming.category.name}?`}
          onClose={() => dispatch({ type: 'confirmVoid', id: null })}
          onKey={(e) => {
            if (e.key !== 'Enter') return false
            voidExpense(confirming)
            return true
          }}
          footer={
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => dispatch({ type: 'confirmVoid', id: null })} className="min-h-12 rounded-md border-2 border-zinc-600 px-5 font-bold">
                Keep (Esc)
              </button>
              <button type="button" onClick={() => voidExpense(confirming)} className="min-h-12 rounded-md bg-rose-500 px-5 font-bold text-zinc-950">
                Void (Enter)
              </button>
            </div>
          }
        >
          <p className="text-zinc-300">
            A matching negative entry is added, so the drawer's expected cash goes back up by {formatPaise(confirming.amountPaise)}. The original stays on
            record.
          </p>
          {confirming.description && <p className="mt-2 text-zinc-400">“{confirming.description}”</p>}
        </Modal>
      )}
    </div>
  )
}

function ExpenseRow({ entry, onVoid }: { entry: ExpenseEntry; onVoid: () => void }) {
  const voided = entry.voidedAt !== null
  return (
    <li className={`flex min-h-16 items-center gap-4 border-b border-zinc-800 px-4 py-2 ${voided ? 'text-zinc-500' : ''}`}>
      <span className="w-14 shrink-0 font-mono text-sm text-zinc-400">
        {new Date(entry.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
      </span>
      <span className="w-40 shrink-0 truncate font-bold">{entry.category.name}</span>
      <span className="min-w-0 flex-1 truncate">{entry.description ?? ''}</span>
      {entry.peakSessionId && <Zap className="size-4 shrink-0 text-amber-400" aria-label="Paid during a peak session" />}
      <span className={`shrink-0 font-mono text-lg font-bold tabular-nums ${voided ? 'line-through' : ''}`}>{formatPaise(entry.amountPaise)}</span>
      {voided ? (
        <span className="w-20 shrink-0 text-center text-sm font-bold uppercase">Voided</span>
      ) : (
        <button type="button" onClick={onVoid} className={`min-h-12 w-20 shrink-0 rounded-md border-2 border-zinc-600 font-bold hover:border-rose-400 hover:text-rose-300 ${FOCUS_RING}`}>
          Void
        </button>
      )}
    </li>
  )
}

function CenterNote({ title, icon, children }: { title: string; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      {icon}
      <h2 className="text-2xl font-bold">{title}</h2>
      {children}
    </div>
  )
}
