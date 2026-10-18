import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, CheckCircle2, CircleAlert, Lock, RefreshCw, Sunrise, WifiOff } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { CounterTender, DayEndSummary, OwingWaiter, Paise, PeakSessionView, TenderAdjustmentEntry } from '../api/types'
import { FlashLine } from '../billing/BillingPanels'
import { counterErrorMessage } from '../billing/errors'
import { Modal } from '../billing/Modal'
import { TrustBadge } from '../billing/PickerDialogs'
import {
  blockerCount,
  countedPaise,
  dayEndReducer,
  dayEndView,
  initialDayEndStateFrom,
  lockBlock,
  type CountDraft,
  openCounterBills,
  variancePreview,
  waiterBalanceBlock,
} from '../dayend/dayEndReducer'
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts'
import { beep } from '../lib/beep'
import { formatPaise, parseRupeesToPaise } from '../lib/money'
import { describeShift } from '../dayend/tallyForm'
import { SalesBreakdownCard } from './dayend/SalesBreakdownCard'
import { TallyDialog } from './dayend/TallyDialog'
import { PeakEndDialog } from './peak/PeakControls'
import { RupeeField } from './RupeeField'
import { FOCUS_RING, keepFocus } from '../lib/ui'
import { Kbd, LiveClock } from './ui'

const POLL_MS = 10_000

interface DayEndScreenProps {
  onExit: () => void
  onOpenBilling: () => void
  onOpenCaptainOrders: () => void
  /** F6: add a late expense; the Expense screen's Esc comes back here. */
  onOpenExpenses: () => void
  /** Add a bank deposit (cash drop); its Esc comes back here too. */
  onOpenBankDeposits: () => void
  /** The count typed before the screen was left, and where to keep it as it changes. */
  countDraft: CountDraft | null
  onCountDraft: (draft: CountDraft | null) => void
}

/**
 * Day End: a checklist of everything that blocks the close (open bills, a running peak, waiter
 * balances) with actions to clear them, the expected-cash breakdown, the drawer count and the lock.
 * Once locked — or when no day is open — the screen offers Day Open with an opening float.
 */
export default function DayEndScreen({ onExit, onOpenBilling, onOpenCaptainOrders, onOpenExpenses, onOpenBankDeposits, countDraft, onCountDraft }: DayEndScreenProps) {
  const [state, dispatch] = useReducer(dayEndReducer, countDraft, initialDayEndStateFrom)
  const [busy, setBusy] = useState(false)
  const view = dayEndView(state)
  const summary = state.summary
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  // Keep the typed count with the App, so a trip to Expenses (F6) and back doesn't lose it.
  useEffect(() => {
    onCountDraft(state.countedDayId && state.counted !== '' ? { dayId: state.countedDayId, counted: state.counted } : null)
  }, [state.counted, state.countedDayId, onCountDraft])

  const flash = useCallback((kind: 'ok' | 'error', text: string) => {
    beep(kind)
    dispatch({ type: 'flash', kind, text })
  }, [])

  const refresh = useCallback(async () => {
    try {
      dispatch({ type: 'loaded', summary: await api.dayEnd() })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_FOUND') dispatch({ type: 'noDay' })
      else dispatch({ type: 'failed', message: counterErrorMessage(err) })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      const { dialog, summary: current } = stateRef.current
      if (dialog === null && current?.day.status !== 'CLOSED') void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  /** One write at a time; the checklist is always re-read afterwards, success or not. */
  const write = useCallback(
    async (task: () => Promise<string>) => {
      if (busy) return
      setBusy(true)
      try {
        flash('ok', await task())
      } catch (err) {
        flash('error', counterErrorMessage(err))
      } finally {
        setBusy(false)
        await refresh()
      }
    },
    [busy, flash, refresh],
  )

  const repay = (waiter: OwingWaiter, amount: Paise, tender: CounterTender) => {
    dispatch({ type: 'dialog', dialog: null })
    void write(async () => {
      const { outstandingPaise } = await api.repayWaiter(waiter.id, amount, tender)
      return `${waiter.displayName} paid ${formatPaise(amount)} by ${tender === 'CASH' ? 'cash' : 'UPI'} · still owes ${formatPaise(outstandingPaise)}`
    })
  }

  const lockDay = () => {
    const current = stateRef.current
    const counted = countedPaise(current)
    if (!current.summary || counted === null) return
    const dayId = current.summary.day.id
    dispatch({ type: 'dialog', dialog: null })
    void write(async () => {
      const closed = await api.closeDay(dayId, counted)
      dispatch({ type: 'loaded', summary: closed })
      return `Day ${closed.day.businessDate} locked · variance ${formatPaise(closed.day.cashVariancePaise ?? 0n)}`
    })
  }

  const openDay = (float: Paise) =>
    void write(async () => {
      const day = await api.openDay(float)
      return `Day ${day.businessDate} opened with a ${formatPaise(day.openingFloatPaise)} float`
    })

  const adjustTender = (cashDelta: Paise, reason: string) => {
    const dayId = stateRef.current.summary?.day.id
    if (!dayId) return
    dispatch({ type: 'dialog', dialog: null })
    void write(async () => {
      await api.adjustTenderSplit(dayId, cashDelta, reason)
      return `Tally adjusted: ${describeShift(cashDelta)} · total sales unchanged`
    })
  }

  const voidAdjustment = (adjustment: TenderAdjustmentEntry) => {
    dispatch({ type: 'dialog', dialog: null })
    void write(async () => {
      await api.voidTenderAdjustment(adjustment.id)
      return `Voided: ${describeShift(adjustment.cashDeltaPaise)}`
    })
  }

  const askLock = useCallback(() => {
    const reason = lockBlock(stateRef.current)
    if (reason) flash('error', reason)
    else dispatch({ type: 'dialog', dialog: { kind: 'confirm' } })
  }, [flash])

  // ── Keyboard ───────────────────────────────────────────────────────────────

  const keysLive = state.dialog === null
  useGlobalShortcuts(
    {
      F6: () => view === 'OPEN' && onOpenExpenses(),
      F7: () => view === 'OPEN' && dispatch({ type: 'dialog', dialog: { kind: 'tally' } }),
      F9: () => view === 'OPEN' && askLock(),
    },
    keysLive,
  )
  useEffect(() => {
    if (!keysLive) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onExit()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [keysLive, onExit])

  // ── Layout ─────────────────────────────────────────────────────────────────

  const closeDialog = () => dispatch({ type: 'dialog', dialog: null })
  const blockers = summary && view === 'OPEN' ? blockerCount(summary) : 0
  const dialog = state.dialog
  const repayWaiter = dialog?.kind === 'repay' ? summary?.blockers.waitersOwing.find((w) => w.id === dialog.waiterId) : undefined

  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b-2 border-amber-400 bg-zinc-900 px-5">
        <button
          type="button"
          {...keepFocus}
          onClick={onExit}
          className="flex items-center gap-2 rounded px-1 text-zinc-300 hover:text-zinc-50"
          aria-label="Back to dashboard (Esc)"
        >
          <ArrowLeft className="size-5" aria-hidden />
          <span className="rounded bg-amber-400 px-2 py-0.5 text-lg font-black tracking-tight text-zinc-950">FL2</span>
        </button>
        <h1 className="text-lg font-bold tracking-wide uppercase">Day End</h1>
        {summary && (
          <span className="text-sm text-zinc-400">
            Day {summary.day.businessDate} · opened {formatClock(summary.day.openedAt)}
          </span>
        )}
        <StatusBadge view={view} blockers={blockers} />
        <div className="ml-auto flex items-center gap-4 text-sm">
          <LiveClock />
          <span className="flex items-center gap-1 text-zinc-400">
            <Kbd>Esc</Kbd> Dashboard
          </span>
        </div>
      </header>

      {view === 'LOADING' && <CenterNote title="Loading the day…" />}
      {view === 'OFFLINE' && (
        <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />}>
          <p className="text-zinc-300">{state.offlineMessage}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-4 inline-flex items-center gap-2 rounded-md border-2 border-zinc-600 px-4 py-2 font-bold hover:border-zinc-300"
          >
            <RefreshCw className="size-4" aria-hidden /> Retry now
          </button>
        </CenterNote>
      )}
      {view === 'NO_DAY' && (
        <div className="flex flex-1 items-center justify-center p-8">
          <OpenDayPanel busy={busy} onOpen={openDay} note="No business day has been opened on this till yet." />
        </div>
      )}

      {summary && (view === 'OPEN' || view === 'CLOSED') && (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[46%] max-w-2xl min-w-96 shrink-0 flex-col gap-3 overflow-y-auto border-r-2 border-zinc-800 bg-zinc-900 p-4">
            {view === 'OPEN' ? (
              <Checklist
                summary={summary}
                busy={busy}
                onRepay={(waiterId) => dispatch({ type: 'dialog', dialog: { kind: 'repay', waiterId } })}
                onEndPeak={(session) => dispatch({ type: 'dialog', dialog: { kind: 'endPeak', session } })}
                onOpenBilling={onOpenBilling}
                onOpenCaptainOrders={onOpenCaptainOrders}
              />
            ) : (
              <>
                <ClosedDayCard summary={summary} />
                <SalesBreakdownCard sales={summary.sales} adjustments={summary.tenderAdjustments} />
              </>
            )}
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-16 items-center border-b-2 border-zinc-800 bg-zinc-900 px-4 py-2">
              <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">{view === 'OPEN' ? 'Sales & cash count' : 'Next day'}</h2>
              <span className="ml-auto" />
              <FlashLine flash={state.flash} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {view === 'OPEN' ? (
                <>
                  <div className="mx-auto mb-4 max-w-2xl">
                    <SalesBreakdownCard
                      sales={summary.sales}
                      adjustments={summary.tenderAdjustments}
                      onAdjust={() => dispatch({ type: 'dialog', dialog: { kind: 'tally' } })}
                      onVoid={(adjustment) => dispatch({ type: 'dialog', dialog: { kind: 'voidAdjustment', adjustment } })}
                    />
                  </div>
                  <CashCount
                    summary={summary}
                    counted={state.counted}
                    variance={variancePreview(state)}
                    block={lockBlock(state)}
                    busy={busy}
                    onCounted={(text) => dispatch({ type: 'counted', text })}
                    onLock={askLock}
                    onAddExpense={onOpenExpenses}
                    onAddDeposit={onOpenBankDeposits}
                  />
                </>
              ) : (
                <OpenDayPanel busy={busy} onOpen={openDay} note={`Day ${summary.day.businessDate} is locked. Count the float into the drawer to start the next day.`} />
              )}
            </div>
          </main>
        </div>
      )}

      {dialog?.kind === 'confirm' && summary && (
        <ConfirmLock summary={summary} counted={countedPaise(state) ?? 0n} variance={variancePreview(state) ?? 0n} onConfirm={lockDay} onClose={closeDialog} />
      )}
      {dialog?.kind === 'tally' && summary && (
        <TallyDialog normal={summary.sales.normal} busy={busy} onConfirm={adjustTender} onClose={closeDialog} />
      )}
      {dialog?.kind === 'voidAdjustment' && (
        <Modal
          title="Void this adjustment?"
          onClose={closeDialog}
          onKey={(e) => {
            if (e.key !== 'Enter') return false
            voidAdjustment(dialog.adjustment)
            return true
          }}
          footer={
            <div className="flex justify-end gap-3">
              <button type="button" onClick={closeDialog} className="rounded-md border-2 border-zinc-600 px-4 py-2 font-bold">
                Keep (Esc)
              </button>
              <button type="button" onClick={() => voidAdjustment(dialog.adjustment)} className="rounded-md bg-rose-500 px-4 py-2 font-bold text-zinc-950">
                Void (Enter)
              </button>
            </div>
          }
        >
          <p>
            <span className="font-mono font-bold">{describeShift(dialog.adjustment.cashDeltaPaise)}</span> — {dialog.adjustment.reason}
          </p>
          <p className="mt-2 text-sm text-zinc-400">A reversing entry is added; the original stays in the audit log.</p>
        </Modal>
      )}
      {repayWaiter && <RepayDialog waiter={repayWaiter} onConfirm={repay} onClose={closeDialog} />}
      {dialog?.kind === 'endPeak' && (
        <PeakEndDialog
          session={dialog.session}
          onEnded={(r) => {
            flash('ok', `Peak #${r.session.sessionNo} ended · variance ${formatPaise(r.breakdown.variancePaise)}`)
            void refresh()
          }}
          onClose={closeDialog}
        />
      )}
    </div>
  )
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function StatusBadge({ view, blockers }: { view: string; blockers: number }) {
  const [text, tone] =
    view === 'OPEN'
      ? blockers > 0
        ? [`Blocked (${blockers})`, 'bg-rose-500']
        : ['Ready to close', 'bg-emerald-500']
      : view === 'CLOSED'
        ? ['Locked', 'bg-zinc-400']
        : view === 'NO_DAY'
          ? ['No day open', 'bg-amber-400']
          : [null, '']
  if (!text) return null
  return <span className={`rounded px-2.5 py-1 text-sm font-black tracking-widest text-zinc-950 uppercase ${tone}`}>{text}</span>
}

// ── Checklist (left) ─────────────────────────────────────────────────────────

interface ChecklistProps {
  summary: DayEndSummary
  busy: boolean
  onRepay: (waiterId: string) => void
  onEndPeak: (session: PeakSessionView) => void
  onOpenBilling: () => void
  onOpenCaptainOrders: () => void
}

function Checklist({ summary, busy, onRepay, onEndPeak, onOpenBilling, onOpenCaptainOrders }: ChecklistProps) {
  const { runningPeakSession: peak, waitersOwing, openBills } = summary.blockers
  const bills = openCounterBills(summary)
  const peakBills = openBills.length - bills.length

  const owed = waiterBalanceBlock(summary)
  const { openBillsPaise, creditPaise } = summary.blockers.waiterBalance

  return (
    <>
      <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">Before closing</h2>

      <CheckItem ok={owed === null} title={owed ?? 'Waiter balances are ₹0'}>
        {owed && (
          <div className="mt-2 flex items-center gap-3">
            <span className="text-sm text-zinc-300">
              <span className="font-mono">{formatPaise(openBillsPaise)}</span> on open bills · <span className="font-mono">{formatPaise(creditPaise)}</span> on collect-later credit
            </span>
            <SmallButton onClick={onOpenCaptainOrders} primary>
              Waiter Ledger
            </SmallButton>
          </div>
        )}
      </CheckItem>

      <CheckItem ok={bills.length === 0} title={bills.length === 0 ? 'No open bills' : `${bills.length} open bill${bills.length === 1 ? '' : 's'}`}>
        {bills.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1">
            {bills.map((b) => (
              <li key={b.billId} className="flex items-center gap-2 rounded-md bg-zinc-900 px-3 py-2">
                <span className="font-mono font-bold">#{b.billNo}</span>
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-bold text-zinc-300 uppercase">{b.source === 'WAITER_APP' ? 'Captain' : 'Counter'}</span>
                {b.waiter && <span className="truncate text-sm text-zinc-300">{b.waiter.code} {b.waiter.displayName}</span>}
                <span className="ml-auto font-mono font-bold tabular-nums">{formatPaise(b.duePaise)}</span>
                <SmallButton onClick={b.waiter || b.source === 'WAITER_APP' ? onOpenCaptainOrders : onOpenBilling}>
                  {b.waiter || b.source === 'WAITER_APP' ? 'Waiter Ledger' : 'Billing'}
                </SmallButton>
              </li>
            ))}
          </ul>
        )}
        {bills.length > 0 && <p className="mt-2 text-sm text-zinc-400">Settle them, or cancel every line and close the ₹0 bill.</p>}
      </CheckItem>

      <CheckItem ok={peak === null} title={peak ? `Peak session #${peak.sessionNo} is running` : 'No peak session running'}>
        {peak && (
          <div className="mt-2 flex items-center gap-3">
            <span className="text-sm text-zinc-300">
              Since {formatClock(peak.startedAt)} · expected drawer total <span className="font-mono">{formatPaise(peak.expectedDrawerCashPaise)}</span>
              {peakBills > 0 && ` · ${peakBills} peak bill${peakBills === 1 ? '' : 's'} to reconcile`}
            </span>
            <SmallButton onClick={() => onEndPeak(peak)} disabled={busy} primary>
              End peak…
            </SmallButton>
          </div>
        )}
        {summary.peakSessions.length > 0 && (
          <ul className="mt-2 flex flex-col gap-0.5 text-sm text-zinc-400">
            {summary.peakSessions.map((s) => (
              <li key={s.id} className="flex flex-wrap font-mono">
                <span>
                  Peak #{s.sessionNo} {formatClock(s.startedAt)}–{formatClock(s.endedAt)}
                </span>
                <span className="ml-auto pl-3">sales {formatPaise(s.salesPaise)}</span>
                <span className={`pl-3 ${s.variancePaise < 0n ? 'text-rose-300' : s.variancePaise > 0n ? 'text-amber-300' : ''}`}>
                  variance {formatPaise(s.variancePaise)}
                </span>
                {s.peakCashPaise < 0n && <span className="basis-full text-right font-sans text-amber-300">UPI readings exceed sales — check the UPI readings</span>}
              </li>
            ))}
          </ul>
        )}
      </CheckItem>

      <CheckItem
        ok={waitersOwing.length === 0}
        title={
          waitersOwing.length === 0
            ? 'No collect-later credit outstanding'
            : `${waitersOwing.length} waiter${waitersOwing.length === 1 ? '' : 's'} owe${waitersOwing.length === 1 ? 's' : ''} collect-later credit`
        }
      >
        {waitersOwing.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1">
            {waitersOwing.map((w) => (
              <li key={w.id} className="flex items-center gap-2 rounded-md bg-zinc-900 px-3 py-2">
                <span className="font-mono text-zinc-400">{w.code}</span>
                <span className="truncate font-semibold">{w.displayName}</span>
                <TrustBadge trusted={w.isTrusted} />
                {!w.isActive && <span className="text-xs text-zinc-500 uppercase">inactive</span>}
                <span className="ml-auto font-mono font-bold tabular-nums">{formatPaise(w.outstandingPaise)}</span>
                <SmallButton onClick={() => onRepay(w.id)} disabled={busy} primary>
                  Repayment…
                </SmallButton>
              </li>
            ))}
          </ul>
        )}
      </CheckItem>
    </>
  )
}

function CheckItem({ ok, title, children }: { ok: boolean; title: string; children?: ReactNode }) {
  return (
    <section className={`rounded-lg border-2 p-3 ${ok ? 'border-zinc-800 bg-zinc-950' : 'border-rose-500/60 bg-rose-500/10'}`}>
      <h3 className="flex items-center gap-2 font-bold">
        {ok ? <CheckCircle2 className="size-5 text-emerald-400" aria-hidden /> : <CircleAlert className="size-5 text-rose-400" aria-hidden />}
        {title}
      </h3>
      {children}
    </section>
  )
}

function SmallButton({ onClick, disabled = false, primary = false, children }: { onClick: () => void; disabled?: boolean; primary?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-bold disabled:opacity-40 ${FOCUS_RING} ${
        primary ? 'bg-amber-400 text-zinc-950 hover:bg-amber-300' : 'border-2 border-zinc-600 hover:border-zinc-300'
      }`}
    >
      {children}
    </button>
  )
}

// ── Cash count (right) ───────────────────────────────────────────────────────

interface CashCountProps {
  summary: DayEndSummary
  counted: string
  variance: Paise | null
  block: string | null
  busy: boolean
  onCounted: (text: string) => void
  onLock: () => void
  onAddExpense: () => void
  onAddDeposit: () => void
}

function CashCount({ summary, counted, variance, block, busy, onCounted, onLock, onAddExpense, onAddDeposit }: CashCountProps) {
  const b = summary.breakdown
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <dl className="rounded-lg border-2 border-zinc-700 bg-zinc-950 p-4 font-mono text-lg">
        <Row label="Opening float" value={b.openingFloatPaise} />
        <Row label="Normal cash sales" value={b.normalCashPaise} />
        <Row label="Peak cash (counted)" value={b.peakCashPaise} />
        <Row label="Waiter cash repayments" value={b.waiterCashPaise} />
        <Row label="Cash expenses" value={-b.cashExpensesPaise} />
        <Row label="Bank deposits" value={-b.bankDepositsPaise} />
        {b.tenderAdjustmentPaise !== 0n && <Row label="Tally adjustments (Cash ⇄ UPI)" value={b.tenderAdjustmentPaise} />}
        <div className="mt-2 flex items-baseline justify-between border-t-2 border-zinc-700 pt-2">
          <dt className="font-sans text-sm font-bold tracking-widest text-zinc-400 uppercase">Expected cash</dt>
          <dd className="text-3xl font-black tabular-nums">{formatPaise(b.expectedCashPaise)}</dd>
        </div>
        <div className="mt-1 flex justify-between text-sm text-zinc-500">
          <dt className="font-sans">UPI today (information, not counted)</dt>
          <dd className="tabular-nums">{formatPaise(b.upiTotalPaise)}</dd>
        </div>
      </dl>

      <button
        type="button"
        {...keepFocus}
        onClick={onAddExpense}
        className={`-mt-2 flex items-center justify-between rounded-md border-2 border-dashed border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-400 ${FOCUS_RING}`}
      >
        Forgot an expense? Add it — you&rsquo;ll come straight back with your count kept
        <span className="flex items-center gap-1 font-bold">
          Add expense <Kbd>F6</Kbd>
        </span>
      </button>
      <button
        type="button"
        {...keepFocus}
        onClick={onAddDeposit}
        className={`-mt-2 flex items-center justify-between rounded-md border-2 border-dashed border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-400 ${FOCUS_RING}`}
      >
        Cash taken to the bank? Record it here, not as an expense
        <span className="font-bold">Add bank deposit</span>
      </button>

      <RupeeField
        label="Counted cash in the drawer"
        value={counted}
        onChange={onCounted}
        onEnter={onLock}
        autoFocus
      />

      <div className="flex items-baseline justify-between rounded-lg border-2 border-zinc-700 bg-zinc-950 px-4 py-3">
        <span className="text-sm font-bold tracking-widest text-zinc-400 uppercase">Variance</span>
        <VarianceText variance={variance} />
      </div>

      <button
        type="button"
        {...keepFocus}
        onClick={onLock}
        disabled={busy || block !== null}
        className={`flex items-center justify-between rounded-lg bg-emerald-500 px-5 py-4 text-xl font-black text-zinc-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-400 ${FOCUS_RING}`}
      >
        <span className="flex items-center gap-3">
          <Lock className="size-6" aria-hidden /> Confirm &amp; Lock Day
        </span>
        <Kbd>F9</Kbd>
      </button>
      {block && <p className="-mt-2 text-center text-sm text-amber-300">{block}</p>}
    </div>
  )
}

function Row({ label, value }: { label: string; value: Paise }) {
  return (
    <div className="flex justify-between py-0.5">
      <dt className="font-sans text-zinc-300">{label}</dt>
      <dd className="tabular-nums">{formatPaise(value)}</dd>
    </div>
  )
}

function VarianceText({ variance }: { variance: Paise | null }) {
  if (variance === null) return <span className="font-mono text-2xl text-zinc-500">—</span>
  const [tone, note] = variance < 0n ? ['text-rose-400', 'short'] : variance > 0n ? ['text-amber-300', 'over'] : ['text-emerald-400', 'exact']
  return (
    <span className={`font-mono text-3xl font-black tabular-nums ${tone}`}>
      {formatPaise(variance)} <span className="font-sans text-base font-bold">({note})</span>
    </span>
  )
}

// ── Closed day and Day Open ──────────────────────────────────────────────────

function ClosedDayCard({ summary }: { summary: DayEndSummary }) {
  const { day, breakdown } = summary
  return (
    <div className="rounded-lg border-2 border-zinc-600 bg-zinc-950 p-4">
      <p className="flex items-center gap-2 text-sm font-bold tracking-widest text-zinc-300 uppercase">
        <Lock className="size-4" aria-hidden /> Day {day.businessDate} locked {day.closedAt && `at ${formatClock(day.closedAt)}`}
      </p>
      <dl className="mt-3 font-mono text-lg">
        <Row label="Opening float" value={breakdown.openingFloatPaise} />
        <Row label="Normal cash sales" value={breakdown.normalCashPaise} />
        <Row label="Peak cash (counted)" value={breakdown.peakCashPaise} />
        <Row label="Waiter cash repayments" value={breakdown.waiterCashPaise} />
        <Row label="Cash expenses" value={-breakdown.cashExpensesPaise} />
        <Row label="Bank deposits" value={-breakdown.bankDepositsPaise} />
        {breakdown.tenderAdjustmentPaise !== 0n && <Row label="Tally adjustments (Cash ⇄ UPI)" value={breakdown.tenderAdjustmentPaise} />}
        <div className="mt-2 border-t-2 border-zinc-700 pt-2">
          <Row label="Expected cash" value={day.expectedCashPaise ?? breakdown.expectedCashPaise} />
          {day.countedCashPaise !== null && <Row label="Counted cash" value={day.countedCashPaise} />}
        </div>
      </dl>
      {day.cashVariancePaise !== null && (
        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-sm font-bold tracking-widest text-zinc-400 uppercase">Variance</span>
          <VarianceText variance={day.cashVariancePaise} />
        </div>
      )}
      <p className="mt-3 text-sm text-zinc-500">The day is frozen: no further bills, payments, repayments, expenses or bank deposits can be added to it.</p>
    </div>
  )
}

function OpenDayPanel({ busy, onOpen, note }: { busy: boolean; onOpen: (float: Paise) => void; note: string }) {
  const [text, setText] = useState('')
  const float = text.trim() === '' ? null : parseRupeesToPaise(text)
  const submit = () => {
    if (float !== null && !busy) onOpen(float)
  }
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 rounded-lg border-2 border-amber-400/60 bg-amber-400/5 p-5">
      <h2 className="flex items-center gap-2 text-2xl font-bold">
        <Sunrise className="size-7 text-amber-400" aria-hidden /> Open a new day
      </h2>
      <p className="text-zinc-300">{note}</p>
      <RupeeField label="Opening float (cash in the drawer now)" value={text} onChange={setText} onEnter={submit} autoFocus />
      <button
        type="button"
        onClick={submit}
        disabled={busy || float === null}
        className={`flex items-center justify-between rounded-lg bg-amber-400 px-5 py-4 text-xl font-black text-zinc-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
      >
        Open day {float !== null && `with ${formatPaise(float)}`}
        <Kbd>Enter</Kbd>
      </button>
    </div>
  )
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

function ConfirmLock({ summary, counted, variance, onConfirm, onClose }: { summary: DayEndSummary; counted: Paise; variance: Paise; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal
      title={`Lock day ${summary.day.businessDate}?`}
      onClose={onClose}
      onKey={(e) => {
        if (e.key !== 'Enter' && e.key !== 'F9') return false
        onConfirm()
        return true
      }}
      footer={
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="rounded-md border-2 border-zinc-600 px-4 py-2 font-bold">
            Back (Esc)
          </button>
          <button type="button" onClick={onConfirm} className="rounded-md bg-emerald-500 px-4 py-2 font-bold text-zinc-950">
            Lock day (Enter)
          </button>
        </div>
      }
    >
      <dl className="font-mono text-lg">
        <Row label="Expected cash" value={summary.breakdown.expectedCashPaise} />
        <Row label="Counted cash" value={counted} />
      </dl>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="text-sm font-bold tracking-widest text-zinc-400 uppercase">Variance</span>
        <VarianceText variance={variance} />
      </div>
      <p className="mt-4 text-zinc-300">This freezes the day. No more bills, payments, repayments or expenses can be added to it, and the till needs a new Day Open before billing again.</p>
    </Modal>
  )
}

function RepayDialog({ waiter, onConfirm, onClose }: { waiter: OwingWaiter; onConfirm: (w: OwingWaiter, amount: Paise, tender: CounterTender) => void; onClose: () => void }) {
  const [text, setText] = useState(() => toRupeeText(waiter.outstandingPaise))
  const [tender, setTender] = useState<CounterTender>('CASH')
  const amount = text.trim() === '' ? null : parseRupeesToPaise(text)
  const error = amount === null || amount <= 0n ? 'Enter the amount received' : amount > waiter.outstandingPaise ? `${waiter.displayName} owes only ${formatPaise(waiter.outstandingPaise)}` : null
  const confirm = () => {
    if (error === null && amount !== null) onConfirm(waiter, amount, tender)
  }
  return (
    <Modal
      title={`Repayment from ${waiter.displayName}`}
      onClose={onClose}
      onKey={(e) => {
        if (e.key === 'Enter') {
          confirm()
          return true
        }
        if (!e.ctrlKey && !e.metaKey && (e.key === 'c' || e.key === 'C' || e.key === 'u' || e.key === 'U')) {
          setTender(e.key.toLowerCase() === 'c' ? 'CASH' : 'UPI')
          return true
        }
        return false
      }}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-zinc-400">
            <Kbd>C</Kbd> cash · <Kbd>U</Kbd> UPI · <Kbd>Enter</Kbd> record
          </span>
          <button type="button" onClick={confirm} disabled={error !== null} className="rounded-md bg-emerald-500 px-5 py-2 font-bold text-zinc-950 disabled:opacity-50">
            Record {amount !== null && error === null ? formatPaise(amount) : ''}
          </button>
        </div>
      }
    >
      <p className="mb-3 text-zinc-300">
        {waiter.code} owes <span className="font-mono font-bold">{formatPaise(waiter.outstandingPaise)}</span>.
      </p>
      <RupeeField label="Amount received" value={text} onChange={setText} dataAutofocus />
      <div className="mt-3 flex gap-2" role="radiogroup" aria-label="Tender">
        {(['CASH', 'UPI'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={t === tender}
            onClick={() => setTender(t)}
            className={`flex-1 rounded-md border-2 px-4 py-2 font-bold ${t === tender ? 'border-amber-400 bg-amber-400 text-zinc-950' : 'border-zinc-700'}`}
          >
            {t === 'CASH' ? 'Cash' : 'UPI'} <Kbd>{t === 'CASH' ? 'C' : 'U'}</Kbd>
          </button>
        ))}
      </div>
      {error && amount !== null && <p className="mt-3 text-sm font-semibold text-rose-400">{error}</p>}
    </Modal>
  )
}

function toRupeeText(paise: Paise): string {
  const fraction = (paise % 100n).toString().padStart(2, '0')
  return `${paise / 100n}${fraction === '00' ? '' : `.${fraction}`}`
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
