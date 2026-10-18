import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react'
import { AlertTriangle, ArrowLeft, Landmark, RefreshCw, Sunrise, WifiOff, Zap } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { BankDepositEntry } from '../api/types'
import { FlashLine } from '../billing/BillingPanels'
import { counterErrorMessage } from '../billing/errors'
import { Modal } from '../billing/Modal'
import {
  bankDepositReducer,
  formError,
  formPayload,
  initialBankDepositState,
  MAX_REFERENCE,
  overDrawerWarning,
  todayTotals,
} from '../deposit/bankDepositReducer'
import { beep } from '../lib/beep'
import { formatPaise } from '../lib/money'
import { FOCUS_RING, keepFocus } from '../lib/ui'
import { RupeeField } from './RupeeField'
import { Kbd, LiveClock } from './ui'

const POLL_MS = 15_000

interface BankDepositScreenProps {
  onExit: () => void
  onOpenDayEnd: () => void
  /** Where Esc goes: the Dashboard, or back to Day End when opened from there. */
  exitLabel?: string
}

/**
 * Bank deposits (cash drops) for the open day: cash taken out of the drawer to be banked, e.g. for
 * an RTGS vendor payment. It lowers Day End's expected cash but is neither an expense nor revenue.
 * Every entry is stamped by the server with the till's cashier; a void appends a negating row.
 */
export default function BankDepositScreen({ onExit, onOpenDayEnd, exitLabel = 'Dashboard' }: BankDepositScreenProps) {
  const [state, dispatch] = useReducer(bankDepositReducer, initialBankDepositState)
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
      dispatch({
        type: 'till',
        cashier: context.cashier.displayName,
        date: context.businessDay?.businessDate ?? null,
        peakRunning: context.peakSession !== null,
      })
      if (!context.businessDay) {
        dispatch({ type: 'noDay' })
        return
      }
      const [entries, summary] = await Promise.all([api.listBankDeposits(), api.dayEnd()])
      dispatch({ type: 'loaded', entries, expectedCashPaise: summary.breakdown.expectedCashPaise })
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
      .addBankDeposit(payload.amount, payload.reference)
      .then((deposit) => {
        dispatch({ type: 'recorded' })
        flash('ok', `Recorded bank deposit ${formatPaise(deposit.amountPaise)}${deposit.reference ? ` · ${deposit.reference}` : ''}`)
        amountRef.current?.focus()
      })
      .catch((err: unknown) => {
        dispatch({ type: 'submitting', on: false })
        flash('error', counterErrorMessage(err))
      })
      .finally(() => void refresh())
  }, [flash, refresh])

  const voidDeposit = useCallback(
    (entry: BankDepositEntry) => {
      dispatch({ type: 'confirmVoid', id: null })
      api
        .voidBankDeposit(entry.id)
        .then(() => flash('ok', `Voided bank deposit ${formatPaise(entry.amountPaise)}`))
        .catch((err: unknown) => flash('error', counterErrorMessage(err)))
        .finally(() => void refresh())
    },
    [flash, refresh],
  )

  // Esc leaves (when no dialog is open).
  const dialogOpen = state.confirmVoidId !== null
  useEffect(() => {
    if (dialogOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onExit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen, onExit])

  const { till } = state
  const totals = todayTotals(state.entries)
  const error = formError(state)
  const warning = overDrawerWarning(state)
  const confirming = state.entries.find((e) => e.id === state.confirmVoidId)

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
        <h1 className="text-lg font-bold tracking-wide uppercase">Bank deposits</h1>
        {till && (
          <span className="text-sm text-zinc-400">
            {till.date ? `Day ${till.date} · ` : ''}Cashier: {till.cashier}
          </span>
        )}
        {state.load === 'ready' && (
          <span className="rounded bg-indigo-400 px-2.5 py-1 text-sm font-black tracking-widest text-zinc-950 uppercase">
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

      {state.load === 'loading' && <CenterNote title="Loading bank deposits…" />}
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
          <p className="text-zinc-300">Deposits are taken from the drawer of the open day. Open the day first.</p>
          <button type="button" onClick={onOpenDayEnd} className="mt-2 rounded-md bg-amber-400 px-5 py-3 text-lg font-bold text-zinc-950 hover:bg-amber-300">
            Go to Day End
          </button>
        </CenterNote>
      )}

      {(state.load === 'ready' || (state.load === 'offline' && state.entries.length > 0)) && (
        <div className="flex min-h-0 flex-1">
          <section className="flex w-[46%] max-w-2xl min-w-96 shrink-0 flex-col gap-5 overflow-y-auto border-r-2 border-zinc-800 bg-zinc-900 p-5" aria-label="New bank deposit">
            <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">New bank deposit</h2>
            {state.peakRunning ? (
              <div className="flex items-start gap-3 rounded-lg border-2 border-amber-400 bg-zinc-950 p-4 text-amber-200">
                <Zap className="mt-0.5 size-5 shrink-0 text-amber-400" aria-hidden />
                <p>
                  A peak session is running. End it before taking cash out for the bank, so the peak&rsquo;s drawer count stays exact.
                </p>
              </div>
            ) : (
              <>
                <p className="text-sm text-zinc-400">
                  Cash taken out of the drawer for the bank (e.g. an RTGS vendor payment). It lowers Day End&rsquo;s expected cash; it isn&rsquo;t an expense and
                  doesn&rsquo;t change sales.
                </p>
                <RupeeField label="Amount taken from the drawer" value={state.amount} onChange={(text) => dispatch({ type: 'amount', text })} onEnter={record} inputRef={amountRef} size="lg" autoFocus />
                {state.expectedCashPaise !== null && (
                  <p className="-mt-3 text-sm text-zinc-400">
                    Expected in the drawer now: <span className="font-mono font-semibold text-zinc-200">{formatPaise(state.expectedCashPaise)}</span>
                  </p>
                )}
                {warning && (
                  <p className="-mt-2 flex items-center gap-2 text-sm text-amber-300">
                    <AlertTriangle className="size-4 shrink-0" aria-hidden /> {warning}
                  </p>
                )}
                <label className="block">
                  <span className="text-sm font-semibold text-zinc-300">Reference (optional)</span>
                  <input
                    value={state.reference}
                    maxLength={MAX_REFERENCE}
                    autoComplete="off"
                    onChange={(e) => dispatch({ type: 'reference', text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        record()
                      }
                    }}
                    placeholder="e.g. RTGS to Sri Balaji"
                    className="mt-1 w-full rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 py-3 text-lg outline-none focus:border-amber-400"
                  />
                </label>
                <div className="text-sm text-zinc-400">
                  Taken by <span className="font-semibold text-zinc-200">{till?.cashier ?? '—'}</span> (this till)
                </div>
                <button
                  type="button"
                  onClick={record}
                  disabled={state.submitting || error !== null}
                  className={`flex min-h-16 items-center justify-between rounded-lg bg-indigo-400 px-5 text-xl font-black text-zinc-950 hover:bg-indigo-300 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-400 ${FOCUS_RING}`}
                >
                  <span className="flex items-center gap-3">
                    <Landmark className="size-6" aria-hidden /> {state.submitting ? 'Recording…' : 'Record deposit'}
                  </span>
                  <Kbd>Enter</Kbd>
                </button>
                {error && state.amount.trim() !== '' && <p className="-mt-3 text-center text-sm text-amber-300">{error}</p>}
              </>
            )}
          </section>

          <main className="flex min-w-0 flex-1 flex-col" aria-label="Today's bank deposits">
            <div className="flex min-h-16 items-center border-b-2 border-zinc-800 bg-zinc-900 px-4 py-2">
              <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">Today's bank deposits</h2>
              <span className="ml-auto" />
              <FlashLine flash={state.flash} />
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {state.entries.map((e) => (
                <DepositRow key={e.id} entry={e} onVoid={() => dispatch({ type: 'confirmVoid', id: e.id })} />
              ))}
              {state.entries.length === 0 && <li className="p-12 text-center text-lg text-zinc-500">No bank deposits today.</li>}
            </ul>
            <p className="border-t-2 border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-400">
              Voids are kept on record and struck through. A void puts the amount back into the drawer&rsquo;s expected cash.
            </p>
          </main>
        </div>
      )}

      {confirming && (
        <Modal
          title={`Void bank deposit ${formatPaise(confirming.amountPaise)}?`}
          onClose={() => dispatch({ type: 'confirmVoid', id: null })}
          onKey={(e) => {
            if (e.key !== 'Enter') return false
            voidDeposit(confirming)
            return true
          }}
          footer={
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => dispatch({ type: 'confirmVoid', id: null })} className="min-h-12 rounded-md border-2 border-zinc-600 px-5 font-bold">
                Keep (Esc)
              </button>
              <button type="button" onClick={() => voidDeposit(confirming)} className="min-h-12 rounded-md bg-rose-500 px-5 font-bold text-zinc-950">
                Void (Enter)
              </button>
            </div>
          }
        >
          <p className="text-zinc-300">
            Only void a deposit that was keyed by mistake (the cash never left the drawer). A matching negative entry is added, so the drawer&rsquo;s expected cash
            goes back up by {formatPaise(confirming.amountPaise)}. The original stays on record.
          </p>
          {confirming.reference && <p className="mt-2 text-zinc-400">“{confirming.reference}”</p>}
        </Modal>
      )}
    </div>
  )
}

function DepositRow({ entry, onVoid }: { entry: BankDepositEntry; onVoid: () => void }) {
  const voided = entry.voidedAt !== null
  return (
    <li className={`flex min-h-16 items-center gap-4 border-b border-zinc-800 px-4 py-2 ${voided ? 'text-zinc-500' : ''}`}>
      <span className="w-14 shrink-0 font-mono text-sm text-zinc-400">
        {new Date(entry.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
      </span>
      <Landmark className="size-5 shrink-0 text-indigo-300" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{entry.reference ?? <span className="text-zinc-500">No reference</span>}</span>
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
