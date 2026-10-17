import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, RefreshCw, WifiOff } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { BillDetail, CounterContext, MemberSummary, PeakSessionView, WaiterSummary } from '../api/types'
import { Kbd, LiveClock } from '../components/ui'
import { keepFocus } from '../lib/ui'
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts'
import { useScanBuffer, type QtyTarget } from '../hooks/useScanBuffer'
import type { ScanEffect } from '../hooks/scanBuffer'
import { beep } from '../lib/beep'
import { formatPaise } from '../lib/money'
import { GridFooter, ItemsGrid, PeakSide, PeakTicker, ScanBar, SidePanel } from './BillingPanels'
import { billingReducer, cancelPlan, groupItems, initialBillingState, screenMode, stockLeft, totals, type Receipt } from './billingReducer'
import { CounterError, counterErrorMessage } from './errors'
import { Modal } from './Modal'
import { describePlan, type PayPlan } from './payment'
import { PaymentDialog } from './PaymentDialog'
import { MemberDialog, WaiterDialog } from './PickerDialogs'
import { PeakBanner, PeakEndDialog, PeakStartDialog } from '../components/peak/PeakControls'
import { describeVariance } from '../peak/peakMath'

/** The end dialog keeps its own session snapshot: it stays up to show the result after the session ends. */
type PeakDialog = { kind: 'start'; businessDayId: string } | { kind: 'end'; session: PeakSessionView } | null

const CONTEXT_POLL_MS = 15_000

/**
 * Counter billing. Keys come from window-level listeners (scan buffer + F-keys), so no input ever
 * needs focus. Every write runs through one serial queue, so a scanner burst is applied in order.
 */
export default function BillingScreen({ onExit }: { onExit: () => void }) {
  const [state, dispatch] = useReducer(billingReducer, initialBillingState)
  const [peakDialog, setPeakDialog] = useState<PeakDialog>(null)
  const mode = screenMode(state)
  const rows = useMemo(() => groupItems(state.bill?.items ?? []), [state.bill])
  const { lines, bottles } = totals(state.bill)

  // Synchronous mirrors for queued work: the queue may run before React re-renders.
  const billRef = useRef<BillDetail | null>(null)
  const contextRef = useRef<CounterContext | null>(null)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })
  const queue = useRef<Promise<void>>(Promise.resolve())
  const scanSeq = useRef(0)
  const loadedOnce = useRef(false)
  const busyRef = useRef(0)

  const setBill = useCallback((detail: BillDetail, focusSkuId?: string) => {
    billRef.current = detail
    dispatch(focusSkuId === undefined ? { type: 'billLoaded', detail } : { type: 'billLoaded', detail, focusSkuId })
  }, [])

  const finishBill = useCallback((receipt: Receipt | null) => {
    billRef.current = null
    dispatch({ type: 'billFinished', receipt })
  }, [])

  const flash = useCallback((kind: 'ok' | 'error', text: string) => {
    beep(kind)
    dispatch({ type: 'flash', kind, text })
  }, [])

  const refreshContext = useCallback(async () => {
    try {
      const context = await api.context()
      // Resume the cashier's open bill only on the first successful load (also after being offline).
      const resume = !loadedOnce.current && busyRef.current === 0
      loadedOnce.current = true
      contextRef.current = context
      if (resume && context.openBill && !billRef.current) billRef.current = context.openBill
      dispatch({ type: 'contextLoaded', context, resume })
    } catch (err) {
      loadedOnce.current = false
      dispatch({ type: 'contextFailed', message: counterErrorMessage(err) })
    }
  }, [])

  useEffect(() => {
    void refreshContext()
    const timer = setInterval(() => void refreshContext(), CONTEXT_POLL_MS)
    return () => clearInterval(timer)
  }, [refreshContext])

  /** Re-reads the bill after a failed write, in case the failure means it changed elsewhere. */
  const resync = useCallback(async () => {
    const current = billRef.current
    if (!current) return
    try {
      const detail = await api.getBill(current.bill.id)
      if (detail.bill.status === 'OPEN') setBill(detail)
      else finishBill(null)
    } catch {
      // Leave the screen as it is; the next action or poll will surface the problem.
    }
  }, [setBill, finishBill])

  /** Runs a write after every earlier one, reporting failures on the scan bar. */
  const run = useCallback(
    (task: () => Promise<void>) => {
      busyRef.current += 1
      queue.current = queue.current
        .then(task)
        .catch(async (err: unknown) => {
          flash('error', counterErrorMessage(err))
          if (err instanceof ApiError && err.code === 'PS007') await refreshContext()
          else if (err instanceof ApiError) await resync()
        })
        .finally(() => {
          busyRef.current -= 1
        })
      return queue.current
    },
    [flash, refreshContext, resync],
  )

  // ── Actions ────────────────────────────────────────────────────────────────

  const scan = useCallback(
    (code: string, quantity: number) => {
      const id = ++scanSeq.current
      dispatch({ type: 'scanQueued', scan: { id, code, quantity } })
      void run(async () => {
        try {
          const context = contextRef.current
          if (!context?.businessDay) throw new CounterError('No open business day — open the day in Day End first')

          const sku = await api.lookupSku(code).catch((err: unknown) => {
            throw err instanceof ApiError && err.code === 'NOT_FOUND' ? new CounterError(`Not found: ${code}`) : err
          })
          if (!sku.isActive) throw new CounterError(`${sku.displayName} is not on sale (inactive)`)

          const session = context.peakSession
          if (session && !billRef.current) {
            const { bill, item } = await api.peakSale(session.id, sku.id, quantity)
            dispatch({
              type: 'peakSale',
              entry: {
                billId: bill.id,
                billNo: bill.billNo,
                displayName: item.displayName,
                sizeCode: item.sizeCode,
                quantity: item.quantity,
                amountPaise: bill.totalPaise,
                at: bill.createdAt,
                undone: false,
              },
            })
            flash('ok', `Peak #${bill.billNo}: ${quantity} × ${sku.displayName} · ${stockLeft(sku.onHandQty, quantity)}`)
            void refreshContext()
            return
          }

          let billId = billRef.current?.bill.id
          if (!billId) {
            const { pendingMember, pendingWaiter } = stateRef.current
            billId = (await api.createBill('NORMAL', pendingMember?.id)).id
            if (pendingWaiter) await api.tagWaiter(billId, pendingWaiter.id)
            // Track the bill before adding to it, so a failed first line (e.g. out of stock) leaves
            // an open bill the next scan reuses rather than an orphan.
            setBill(await api.getBill(billId))
          }
          await api.addItem(billId, sku.id, quantity)
          setBill(await api.getBill(billId), sku.id)
          flash('ok', `Added ${quantity} × ${sku.displayName} · ${stockLeft(sku.onHandQty, quantity)}`)
        } finally {
          dispatch({ type: 'scanDone', id })
        }
      })
    },
    [run, flash, refreshContext, setBill],
  )

  const adjustSelected = useCallback(
    (delta: 1 | -1) => {
      const { selectedKey } = stateRef.current
      const row = groupItems(billRef.current?.items ?? []).find((r) => r.key === selectedKey)
      if (!row) return
      void run(async () => {
        const billId = billRef.current?.bill.id
        if (!billId) return
        if (delta === 1) await api.addItem(billId, row.skuId, 1)
        else if (row.cancelItemId) await api.cancelItem(billId, row.cancelItemId, 1)
        setBill(await api.getBill(billId), row.skuId)
        flash('ok', `${delta === 1 ? 'Added' : 'Removed'} 1 × ${row.displayName}`)
      })
    },
    [run, setBill, flash],
  )

  const pickMember = useCallback(
    (member: MemberSummary | null) => {
      dispatch({ type: 'dialog', dialog: null })
      const billId = billRef.current?.bill.id
      if (!billId) {
        dispatch({ type: 'pendingMember', member })
        return
      }
      void run(async () => {
        await api.setMember(billId, member?.id ?? null)
        setBill(await api.getBill(billId))
        flash('ok', member ? `Member ${member.displayName} attached` : 'Member removed (walk-in)')
      })
    },
    [run, setBill, flash],
  )

  const pickWaiter = useCallback(
    (waiter: WaiterSummary) => {
      dispatch({ type: 'dialog', dialog: null })
      const billId = billRef.current?.bill.id
      if (!billId) {
        dispatch({ type: 'pendingWaiter', waiter })
        return
      }
      void run(async () => {
        await api.tagWaiter(billId, waiter.id)
        setBill(await api.getBill(billId))
        flash('ok', `Tagged to ${waiter.displayName}`)
      })
    },
    [run, setBill, flash],
  )

  const pay = useCallback(
    (plan: PayPlan) => {
      const detail = billRef.current
      if (!detail) return
      dispatch({ type: 'dialog', dialog: null }) // closing first makes a double Enter harmless
      void run(async () => {
        const billId = detail.bill.id
        if (plan.kind === 'counter') {
          await api.settle(billId, plan.payments)
        } else {
          for (const step of plan.steps) await api.settleWaiter(billId, plan.waiterId, step.tender, step.amount)
        }
        finishBill({ billNo: detail.bill.billNo, totalPaise: detail.bill.totalPaise, changePaise: plan.changePaise, summary: describePlan(plan, detail) })
        flash('ok', `Bill #${detail.bill.billNo} settled${plan.changePaise > 0n ? ` · change ${formatPaise(plan.changePaise)}` : ''}`)
      })
    },
    [run, finishBill, flash],
  )

  const abandonBill = useCallback(() => {
    dispatch({ type: 'dialog', dialog: null })
    void run(async () => {
      const detail = billRef.current
      if (!detail) return
      for (const item of detail.items) {
        if (item.quantity > 0 && item.remainingQuantity > 0) await api.cancelItem(detail.bill.id, item.id, item.remainingQuantity)
      }
      await api.closeEmpty(detail.bill.id)
      finishBill(null)
      flash('ok', `Bill #${detail.bill.billNo} cancelled`)
    })
  }, [run, finishBill, flash])

  /** Ctrl+Z in peak: the server finds this till's newest scan, so it works after a reload too. */
  const undoPeak = useCallback(() => {
    void run(async () => {
      const { undone } = await api.undoLastPeak().catch((err: unknown) => {
        throw err instanceof ApiError && err.code === 'NOT_FOUND' ? new CounterError('Nothing left to undo in this peak') : err
      })
      dispatch({ type: 'peakUndone', billId: undone.billId })
      flash('ok', `Last scan voided: ${undone.displayName} ×${undone.quantity} (peak bill #${undone.billNo})`)
      void refreshContext()
    })
  }, [run, flash, refreshContext])

  // ── Keyboard ───────────────────────────────────────────────────────────────

  const keysLive = state.dialog === null && peakDialog === null && (mode === 'NORMAL' || mode === 'PEAK')
  const peakSession = state.context?.peakSession ?? null

  const togglePeak = useCallback(() => {
    const context = contextRef.current
    if (context?.peakSession) setPeakDialog({ kind: 'end', session: context.peakSession })
    else if (context?.businessDay) setPeakDialog({ kind: 'start', businessDayId: context.businessDay.id })
  }, [])
  const canEditBill = mode === 'NORMAL'

  const openPayment = useCallback(() => {
    const detail = billRef.current
    if (!detail || groupItems(detail.items).length === 0) {
      if (detail && detail.bill.totalPaise === 0n) {
        void run(async () => {
          await api.closeEmpty(detail.bill.id)
          finishBill(null)
          flash('ok', `Empty bill #${detail.bill.billNo} closed`)
        })
      } else flash('error', 'Scan a bottle first')
      return
    }
    dispatch({ type: 'dialog', dialog: 'payment' })
  }, [run, finishBill, flash])

  const newBill = useCallback(() => {
    const detail = billRef.current
    if (!detail) {
      flash('ok', 'Ready — scan the first bottle')
      return
    }
    if (detail.bill.totalPaise === 0n && detail.tenderedPaise === 0n) {
      void run(async () => {
        await api.closeEmpty(detail.bill.id)
        finishBill(null)
      })
      return
    }
    dispatch({ type: 'dialog', dialog: 'abandon' })
  }, [run, finishBill, flash])

  useGlobalShortcuts(
    {
      F1: () => canEditBill && newBill(),
      F2: () => (canEditBill ? dispatch({ type: 'dialog', dialog: 'member' }) : flash('error', 'Members are not tagged during peak')),
      F4: () => {
        if (!canEditBill) flash('error', 'Waiters are not tagged during peak')
        else if ((billRef.current?.tenderedPaise ?? 0n) > 0n) flash('error', 'Waiter is locked after the first payment')
        else dispatch({ type: 'dialog', dialog: 'waiter' })
      },
      F8: togglePeak,
      F9: () => (canEditBill ? openPayment() : flash('error', 'Peak bills take no payment — they reconcile at session end')),
    },
    keysLive,
  )

  /** Enter → qty → Enter: brings the selected row to `quantity` bottles, then opens Payment (as F9). */
  const setQuantity = useCallback(
    (quantity: number) => {
      if (quantity < 1) {
        flash('error', 'Quantity must be at least 1 — use − to remove the line')
        return
      }
      const key = stateRef.current.selectedKey
      void run(async () => {
        const detail = billRef.current
        const row = groupItems(detail?.items ?? []).find((r) => r.key === key)
        if (!detail || !row) return
        if (quantity !== row.quantity) {
          if (quantity > row.quantity) await api.addItem(detail.bill.id, row.skuId, quantity - row.quantity)
          else {
            for (const c of cancelPlan(detail.items, row.key, row.quantity - quantity)) await api.cancelItem(detail.bill.id, c.itemId, c.quantity)
          }
          setBill(await api.getBill(detail.bill.id), row.skuId)
          flash('ok', `${row.displayName} × ${quantity}`)
        }
        openPayment()
      })
    },
    [run, setBill, flash, openPayment],
  )

  const onScanEffect = useCallback(
    (effect: ScanEffect) => {
      if (effect.type === 'commit') {
        scan(effect.code, effect.quantity)
        return
      }
      if (effect.type === 'setQty') {
        setQuantity(effect.quantity)
        return
      }
      if (!canEditBill) return
      if (effect.command === 'up') dispatch({ type: 'move', delta: -1 })
      else if (effect.command === 'down') dispatch({ type: 'move', delta: 1 })
      else adjustSelected(effect.command === 'increment' ? 1 : -1)
    },
    [scan, adjustSelected, setQuantity, canEditBill],
  )
  const selectedRow = canEditBill ? rows.find((r) => r.key === state.selectedKey) : undefined
  const qtyTarget: QtyTarget | null = selectedRow ? { key: selectedRow.key, quantity: selectedRow.quantity } : null
  const scanState = useScanBuffer(keysLive, onScanEffect, qtyTarget)

  // The scan buffer listens in the capture phase, so a non-empty buffer consumes Esc before this.
  useEffect(() => {
    if (state.dialog !== null) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onExit()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && mode === 'PEAK') {
        event.preventDefault()
        if (!event.repeat) undoPeak() // a held key voids one scan, not a run of them
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state.dialog, mode, onExit, undoPeak])

  // ── Layout ─────────────────────────────────────────────────────────────────

  const closeDialog = () => dispatch({ type: 'dialog', dialog: null })
  const billNo = state.bill?.bill.billNo

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
        <h1 className="text-lg font-bold tracking-wide uppercase">Billing</h1>
        <ModeBadge mode={mode} sessionNo={state.context?.peakSession?.sessionNo} />
        {mode === 'NORMAL' && (
          <span className="font-mono text-lg text-zinc-300">{billNo !== undefined ? `Bill #${billNo}` : 'New bill'}</span>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm">
          {state.context && <span className="text-zinc-400">Cashier: {state.context.cashier.displayName}</span>}
          {state.context?.businessDay && <span className="text-zinc-400">Day {state.context.businessDay.businessDate}</span>}
          <LiveClock />
          <span className="flex items-center gap-1 text-zinc-400">
            <Kbd>Esc</Kbd> Dashboard
          </span>
        </div>
      </header>

      {peakSession && (mode === 'NORMAL' || mode === 'PEAK') && <PeakBanner session={peakSession} onEnd={togglePeak} />}

      {mode === 'LOADING' && <CenterNote title="Connecting to the POS server…" />}
      {mode === 'OFFLINE' && (
        <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />}>
          <p className="text-zinc-300">{state.offlineMessage}</p>
          <p className="mt-1 text-sm text-zinc-400">
            Start it from the repo root with <code className="rounded bg-zinc-800 px-1">npm run api:dev</code>. Retrying every 15 s.
          </p>
          <button
            type="button"
            onClick={() => void refreshContext()}
            className="mt-4 inline-flex items-center gap-2 rounded-md border-2 border-zinc-600 px-4 py-2 font-bold hover:border-zinc-300"
          >
            <RefreshCw className="size-4" aria-hidden /> Retry now
          </button>
        </CenterNote>
      )}
      {mode === 'BLOCKED' && (
        <CenterNote title="No open business day">
          <p className="text-zinc-300">Billing starts once a manager opens the day in Day End.</p>
        </CenterNote>
      )}

      {(mode === 'NORMAL' || mode === 'PEAK') && (
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col" aria-label={mode === 'PEAK' ? 'Peak scans' : 'Bill items'}>
            <ScanBar scan={scanState} flash={state.flash} enabled={keysLive} qtyLabel={selectedRow?.displayName} />
            {mode === 'PEAK' ? (
              <PeakTicker ticker={state.ticker} pending={state.pending} />
            ) : (
              <ItemsGrid
                rows={rows}
                pending={state.pending}
                selectedKey={state.selectedKey}
                onSelect={(key) => dispatch({ type: 'select', key })}
                receipt={state.receipt}
                qtyEdit={scanState.qtyEdit}
              />
            )}
            <GridFooter mode={mode} />
          </main>
          {mode === 'PEAK' && state.context?.peakSession ? (
            <PeakSide
              session={state.context.peakSession}
              scans={state.ticker.filter((e) => !e.undone).length}
              onUndo={undoPeak}
              canUndo
            />
          ) : (
            <SidePanel
              detail={state.bill}
              pendingMember={state.pendingMember}
              pendingWaiter={state.pendingWaiter}
              lines={lines}
              bottles={bottles}
              onMember={() => dispatch({ type: 'dialog', dialog: 'member' })}
              onWaiter={() => dispatch({ type: 'dialog', dialog: 'waiter' })}
              onPay={openPayment}
              onStartPeak={peakSession ? undefined : togglePeak}
            />
          )}
        </div>
      )}

      {state.dialog === 'payment' && state.bill && (
        <PaymentDialog detail={state.bill} busy={state.pending.length > 0} onConfirm={pay} onClose={closeDialog} />
      )}
      {state.dialog === 'member' && <MemberDialog onPick={pickMember} onClose={closeDialog} />}
      {peakDialog?.kind === 'start' && (
        <PeakStartDialog
          businessDayId={peakDialog.businessDayId}
          onStarted={(session) => {
            setPeakDialog(null)
            flash('ok', `Peak #${session.sessionNo} started${billRef.current ? ' — finish this bill, then scans go to peak' : ''}`)
            void refreshContext()
          }}
          onClose={() => setPeakDialog(null)}
        />
      )}
      {peakDialog?.kind === 'end' && (
        <PeakEndDialog
          session={peakDialog.session}
          onEnded={(r) => {
            flash('ok', `Peak #${r.session.sessionNo} ended · ${describeVariance(r.breakdown.variancePaise).label}`)
            void refreshContext()
          }}
          onClose={() => setPeakDialog(null)}
        />
      )}
      {state.dialog === 'waiter' && <WaiterDialog onPick={pickWaiter} onClose={closeDialog} />}
      {state.dialog === 'abandon' && state.bill && (
        <Modal
          title={`Cancel bill #${state.bill.bill.billNo}?`}
          onClose={closeDialog}
          onKey={(e) => {
            if (e.key !== 'Enter') return false
            abandonBill()
            return true
          }}
          footer={
            <div className="flex justify-end gap-3">
              <button type="button" onClick={closeDialog} className="rounded-md border-2 border-zinc-600 px-4 py-2 font-bold">
                Keep bill (Esc)
              </button>
              <button type="button" onClick={abandonBill} className="rounded-md bg-rose-500 px-4 py-2 font-bold text-zinc-950">
                Cancel all &amp; close (Enter)
              </button>
            </div>
          }
        >
          <p>
            All {bottles} bottle(s) go back into stock as cancellation lines, then the ₹0 bill is closed. Nothing is deleted — the
            audit trail keeps every line.
          </p>
        </Modal>
      )}
    </div>
  )
}

function ModeBadge({ mode, sessionNo }: { mode: string; sessionNo: number | undefined }) {
  if (mode === 'PEAK') {
    return <span className="rounded bg-violet-500 px-2.5 py-1 text-sm font-black tracking-widest text-zinc-950 uppercase">Peak #{sessionNo}</span>
  }
  if (mode === 'NORMAL') {
    return <span className="rounded bg-emerald-500 px-2.5 py-1 text-sm font-black tracking-widest text-zinc-950 uppercase">Normal</span>
  }
  return null
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
