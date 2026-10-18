import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, CheckSquare, HandCoins, Minus, PackageX, RefreshCw, Smartphone, Square, UserRound, WifiOff } from 'lucide-react'
import { api } from '../api/client'
import type { BillDetail, CounterTender, LedgerReceipt, MemberSummary, Paise, Tender, WaiterLedger, WaiterLedgerRow } from '../api/types'
import { FlashLine, ItemsGrid } from '../billing/BillingPanels'
import { groupItems, totals } from '../billing/billingReducer'
import { counterErrorMessage } from '../billing/errors'
import { Modal } from '../billing/Modal'
import { MemberDialog, TrustBadge } from '../billing/PickerDialogs'
import {
  allocate,
  billsToSettle,
  cursorBill,
  editBlock,
  formatAge,
  initialWaiterLedgerStateFor,
  type LedgerFocus,
  openBills,
  receiveError,
  selectedWaiter,
  selectionTotal,
  waiterLedgerReducer,
} from '../captain/waiterLedgerReducer'
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts'
import { beep } from '../lib/beep'
import { formatPaise, parseRupeesToPaise } from '../lib/money'
import { FOCUS_RING, formatTime, keepFocus } from '../lib/ui'
import { RupeeField } from './RupeeField'
import { Kbd, LiveClock } from './ui'

const POLL_MS = 5_000
const AGE_TICK_MS = 15_000

/**
 * Waiter Ledger (Phase 16, the Captain Orders tile): every waiter's account for the day on the left;
 * on the right the selected waiter's open bills (tick and settle exactly, F9), a lump-sum payment
 * for trusted waiters (F7), and today's receipts. Captain-app orders can still be corrected line by
 * line (−, X, member). Polls every 5 s; polling pauses while a dialog is open.
 */
export default function WaiterLedgerScreen({ onExit, focus = null }: { onExit: () => void; focus?: LedgerFocus | null }) {
  const [state, dispatch] = useReducer(waiterLedgerReducer, focus, initialWaiterLedgerStateFor)
  const waiter = selectedWaiter(state)
  const bills = openBills(state)
  const cursor = cursorBill(state)
  const toSettle = billsToSettle(state)
  const rows = useMemo(() => groupItems(cursor?.items ?? []), [cursor])
  const now = useNow(AGE_TICK_MS)
  const [busy, setBusy] = useState(0)

  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })
  const queue = useRef<Promise<void>>(Promise.resolve())
  // A read that started before a write may carry stale figures, so writes bump this and reads that
  // straddle one are dropped. activeWrites covers reads that start while a write is in flight.
  const writeSeq = useRef(0)
  const activeWrites = useRef(0)

  const flash = useCallback((kind: 'ok' | 'error', text: string) => {
    beep(kind)
    dispatch({ type: 'flash', kind, text })
  }, [])

  const loadLedger = useCallback(async (waiterId: string) => {
    const seq = writeSeq.current
    try {
      const ledger = await api.waiterLedgerDetail(waiterId)
      if (seq === writeSeq.current && activeWrites.current === 0) dispatch({ type: 'ledgerLoaded', ledger })
    } catch (err) {
      dispatch({ type: 'flash', kind: 'error', text: counterErrorMessage(err) })
    }
  }, [])

  const refresh = useCallback(async () => {
    const seq = writeSeq.current
    try {
      const waiters = await api.waiterLedger()
      if (seq !== writeSeq.current || activeWrites.current > 0) return
      dispatch({ type: 'listLoaded', waiters, at: Date.now() })
      const id = stateRef.current.selectedWaiterId
      if (id && waiters.some((w) => w.id === id)) await loadLedger(id)
    } catch (err) {
      dispatch({ type: 'listFailed', message: counterErrorMessage(err) })
    }
  }, [loadLedger])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      if (stateRef.current.dialog === null) void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // A newly selected waiter's ledger loads straight away rather than on the next poll.
  useEffect(() => {
    if (state.selectedWaiterId) void loadLedger(state.selectedWaiterId)
  }, [state.selectedWaiterId, loadLedger])

  // New Captain orders: one beep per refresh that brought any.
  useEffect(() => {
    if (state.freshWaiterIds.size > 0) beep('ok')
  }, [state.freshWaiterIds])

  /** Runs a write after every earlier one; failures flash, and the figures are always re-read after. */
  const run = useCallback(
    (task: () => Promise<void>) => {
      writeSeq.current += 1
      activeWrites.current += 1
      setBusy((n) => n + 1)
      queue.current = queue.current
        .then(task)
        .catch((err: unknown) => flash('error', counterErrorMessage(err)))
        .finally(() => {
          activeWrites.current -= 1
          setBusy((n) => n - 1)
          void refresh()
        })
    },
    [flash, refresh],
  )

  // ── Actions ────────────────────────────────────────────────────────────────

  const cancelLine = useCallback(
    (restock: boolean) => {
      const s = stateRef.current
      const detail = cursorBill(s)
      if (!detail) return
      const blocked = editBlock(detail)
      if (blocked) {
        flash('error', blocked)
        return
      }
      const row = groupItems(detail.items).find((r) => r.key === s.selectedKey)
      if (!row?.cancelItemId) {
        flash('error', 'Select a line first (Tab to the lines, then ↑ ↓)')
        return
      }
      const itemId = row.cancelItemId
      run(async () => {
        await api.cancelItem(detail.bill.id, itemId, 1, restock)
        flash('ok', `Removed 1 × ${row.displayName} from #${detail.bill.billNo}${restock ? ' — back in stock' : ' — written off as broken'}`)
      })
    },
    [run, flash],
  )

  const pickMember = useCallback(
    (member: MemberSummary | null) => {
      dispatch({ type: 'dialog', dialog: null })
      const detail = cursorBill(stateRef.current)
      if (!detail) return
      run(async () => {
        await api.setMember(detail.bill.id, member?.id ?? null)
        flash('ok', member ? `Member ${member.displayName} attached to #${detail.bill.billNo}` : `#${detail.bill.billNo} is now walk-in`)
      })
    },
    [run, flash],
  )

  const openSettle = useCallback(() => {
    if (billsToSettle(stateRef.current).length === 0) flash('error', 'No open bill to settle')
    else dispatch({ type: 'dialog', dialog: 'settle' })
  }, [flash])

  const openReceive = useCallback(() => {
    const ledger = stateRef.current.ledger
    if (!ledger) flash('error', 'Pick a waiter first')
    else if (!ledger.waiter.isTrusted) flash('error', `${ledger.waiter.displayName} is bill-on-bill — tick whole bills and settle them (F9)`)
    else if (ledger.waiter.balancePaise <= 0n) flash('error', `${ledger.waiter.displayName} owes nothing`)
    else dispatch({ type: 'dialog', dialog: 'receive' })
  }, [flash])

  const settle = useCallback(
    (tender: Tender) => {
      const s = stateRef.current
      const target = billsToSettle(s)
      const w = selectedWaiter(s)
      dispatch({ type: 'dialog', dialog: null }) // closing first makes a double Enter harmless
      if (!w || target.length === 0) return
      run(async () => {
        const result = await api.settleWaiterBills(w.id, target.map((b) => b.bill.id), tender)
        dispatch({ type: 'clearChecks' })
        const nos = result.bills.map((b) => `#${b.billNo}`).join(', ')
        flash('ok', `${nos} settled · ${formatPaise(result.totalPaise)} ${tenderLabel(tender)} · ${w.displayName} owes ${formatPaise(result.balancePaise)}`)
      })
    },
    [run, flash],
  )

  const receive = useCallback(
    (amount: Paise, tender: CounterTender) => {
      const w = selectedWaiter(stateRef.current)
      dispatch({ type: 'dialog', dialog: null })
      if (!w) return
      run(async () => {
        const result = await api.receiveWaiterPayment(w.id, amount, tender)
        const settled = result.allocations.filter((a) => a.kind === 'BILL' && a.settled).length
        flash(
          'ok',
          `${formatPaise(amount)} ${tenderLabel(tender)} from ${w.displayName}${settled > 0 ? ` · ${settled} bill${settled === 1 ? '' : 's'} settled` : ''} · owes ${formatPaise(result.balancePaise)}`,
        )
      })
    },
    [run, flash],
  )

  // ── Keyboard ───────────────────────────────────────────────────────────────

  const keysLive = state.dialog === null

  useGlobalShortcuts(
    {
      F2: () => (cursorBill(stateRef.current) ? dispatch({ type: 'dialog', dialog: 'member' }) : flash('error', 'No bill highlighted')),
      F7: openReceive,
      F9: openSettle,
    },
    keysLive,
  )

  useEffect(() => {
    if (!keysLive) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key
      const onButton = event.target instanceof HTMLButtonElement
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        event.preventDefault()
        dispatch({ type: 'move', delta: key === 'ArrowUp' ? -1 : 1 })
        return
      }
      if (key === 'Tab') {
        event.preventDefault()
        dispatch({ type: 'cycleFocus' })
        return
      }
      if (key === 'Escape') {
        event.preventDefault()
        onExit()
        return
      }
      if (event.repeat) return // a held key must not cancel a run of bottles
      const s = stateRef.current
      if (key === ' ' && !onButton) {
        event.preventDefault()
        if (s.cursorBillId) dispatch({ type: 'toggleCheck', billId: s.cursorBillId })
      } else if (key === 'Enter' && !onButton) {
        event.preventDefault()
        if (s.focus === 'waiters') dispatch({ type: 'focus', pane: 'bills' })
        else openSettle()
      } else if (key === 'a' || key === 'A') {
        event.preventDefault()
        dispatch({ type: 'checkAll' })
      } else if (key === 'r' || key === 'R') {
        event.preventDefault()
        void refresh()
      } else if (key === '-' || key === 'Delete') {
        event.preventDefault()
        cancelLine(true)
      } else if (key === 'x' || key === 'X') {
        event.preventDefault()
        cancelLine(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [keysLive, onExit, openSettle, refresh, cancelLine])

  // ── Layout ─────────────────────────────────────────────────────────────────

  const closeDialog = () => dispatch({ type: 'dialog', dialog: null })
  const owing = state.waiters.filter((w) => w.balancePaise > 0n)
  const owedTotal = owing.reduce((sum, w) => sum + w.balancePaise, 0n)
  const ledgerReady = state.ledger !== null && state.ledger.waiter.id === state.selectedWaiterId

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
        <h1 className="text-lg font-bold tracking-wide uppercase">Waiter Ledger</h1>
        {state.load !== 'loading' && (
          <span className={`rounded px-2.5 py-1 text-sm font-black tracking-widest uppercase ${owing.length > 0 ? 'bg-amber-400 text-zinc-950' : 'bg-emerald-500 text-zinc-950'}`}>
            {owing.length > 0 ? `${owing.length} owe ${formatPaise(owedTotal)}` : 'All settled'}
          </span>
        )}
        {state.load === 'offline' ? (
          <span className="flex items-center gap-1.5 rounded bg-rose-500/20 px-2 py-1 text-sm font-bold text-rose-300">
            <WifiOff className="size-4" aria-hidden /> Offline — showing last figures
          </span>
        ) : (
          <UpdatedAgo at={state.lastUpdated} />
        )}
        <div className="ml-auto flex items-center gap-4 text-sm">
          <button
            type="button"
            {...keepFocus}
            onClick={() => void refresh()}
            className="flex items-center gap-2 rounded-md border border-zinc-600 px-2 py-1 font-semibold text-zinc-300 hover:border-zinc-300"
          >
            <RefreshCw className="size-4" aria-hidden /> Refresh <Kbd>R</Kbd>
          </button>
          <LiveClock />
          <span className="flex items-center gap-1 text-zinc-400">
            <Kbd>Esc</Kbd> Dashboard
          </span>
        </div>
      </header>

      {state.load === 'loading' && <CenterNote title="Loading waiter accounts…" />}
      {state.load === 'offline' && state.waiters.length === 0 && (
        <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />}>
          <p className="text-zinc-300">{state.offlineMessage}</p>
          <p className="mt-1 text-sm text-zinc-400">Retrying every 5 s, or press R.</p>
        </CenterNote>
      )}
      {state.load === 'ready' && state.waiters.length === 0 && (
        <CenterNote title="No waiter activity today" icon={<Smartphone className="size-10 text-zinc-500" aria-hidden />}>
          <p className="text-zinc-400">Captain-app orders and counter bills tagged to a waiter appear here within 5 seconds.</p>
          <FlashLine flash={state.flash} />
        </CenterNote>
      )}

      {state.waiters.length > 0 && (
        <div className="flex min-h-0 flex-1">
          <WaiterList
            waiters={state.waiters}
            selectedId={state.selectedWaiterId}
            freshIds={state.freshWaiterIds}
            focused={state.focus === 'waiters'}
            onSelect={(id) => {
              dispatch({ type: 'selectWaiter', id })
              dispatch({ type: 'focus', pane: 'waiters' })
            }}
          />

          <main className="flex min-w-0 flex-1 flex-col" aria-label="Waiter account">
            <div className="flex min-h-20 items-center gap-4 border-b-2 border-zinc-800 bg-zinc-900 px-4 py-2">
              {waiter && (
                <div className="flex min-w-0 shrink-0 flex-col">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-zinc-400">{waiter.code}</span>
                    <span className="truncate text-xl font-bold">{waiter.displayName}</span>
                    <TrustBadge trusted={waiter.isTrusted} />
                  </span>
                  <span className="text-xs text-zinc-400">{waiter.isTrusted ? 'Collect later · lump sums allowed' : 'Bill-on-bill: whole bills only'}</span>
                </div>
              )}
              {waiter && (
                <div className="flex gap-2">
                  <Figure label="Billed" amount={waiter.billedPaise} />
                  <Figure label="Paid" amount={waiter.paidPaise} />
                  <Figure label="Balance" amount={waiter.balancePaise} tone={waiter.balancePaise > 0n ? 'amber' : 'green'} big />
                </div>
              )}
              <span className="ml-auto" />
              <FlashLine flash={state.flash} />
            </div>

            <div className="flex min-h-0 flex-1">
              <section className="flex min-w-0 flex-1 flex-col">
                <OpenBills
                  bills={bills}
                  loading={!ledgerReady && state.selectedWaiterId !== null}
                  checked={state.checked}
                  cursorId={state.cursorBillId}
                  focused={state.focus === 'bills'}
                  now={now}
                  onCursor={(billId) => {
                    dispatch({ type: 'cursor', billId })
                    dispatch({ type: 'focus', pane: 'bills' })
                  }}
                  onToggle={(billId) => dispatch({ type: 'toggleCheck', billId })}
                  onToggleAll={() => dispatch({ type: 'checkAll' })}
                />
                {cursor && (
                  <>
                    <div className="flex items-center gap-3 border-y-2 border-zinc-800 bg-zinc-900 px-4 py-1.5 text-sm">
                      <span className="font-mono font-bold">Bill #{cursor.bill.billNo}</span>
                      <span className="text-zinc-400">
                        {cursor.bill.source === 'WAITER_APP' ? (cursor.bill.captainDeviceId ?? 'handset') : 'counter'} · {formatTime(new Date(cursor.bill.createdAt))}
                      </span>
                      <button
                        type="button"
                        {...keepFocus}
                        onClick={() => dispatch({ type: 'dialog', dialog: 'member' })}
                        className="ml-auto flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-0.5 hover:border-zinc-400"
                      >
                        <UserRound className="size-4 text-zinc-400" aria-hidden />
                        {cursor.member ? cursor.member.displayName : 'Walk-in'} <Kbd>F2</Kbd>
                      </button>
                    </div>
                    <div className={`flex min-h-0 flex-1 flex-col border-2 ${state.focus === 'lines' ? 'border-amber-400/60' : 'border-transparent'}`}>
                      <ItemsGrid
                        rows={rows}
                        pending={[]}
                        selectedKey={state.selectedKey}
                        onSelect={(key) => dispatch({ type: 'selectLine', key })}
                        receipt={null}
                        empty={<p className="p-8 text-center text-zinc-400">Every line was cancelled — settle it (F9) to close this ₹0 bill.</p>}
                      />
                    </div>
                    <LineActions detail={cursor} canCancel={rows.length > 0} busy={busy > 0} onCancel={cancelLine} />
                  </>
                )}
              </section>

              <aside className="flex w-80 shrink-0 flex-col gap-3 border-l-2 border-zinc-800 bg-zinc-900 p-3" aria-label="Payments">
                <button
                  type="button"
                  {...keepFocus}
                  onClick={openSettle}
                  disabled={busy > 0 || toSettle.length === 0}
                  className={`flex flex-col gap-1 rounded-lg bg-emerald-500 px-4 py-3 text-left text-zinc-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500 ${FOCUS_RING}`}
                >
                  <span className="flex items-center justify-between text-lg font-black">
                    {state.checked.size > 0 ? 'Settle selected' : 'Settle bill'} <Kbd>F9</Kbd>
                  </span>
                  <span className="font-mono text-sm font-bold">
                    {toSettle.length === 0 ? 'No open bills' : `${toSettle.map((b) => `#${b.bill.billNo}`).join(', ')} · ${formatPaise(selectionTotal(toSettle))}`}
                  </span>
                </button>

                {waiter?.isTrusted ? (
                  <button
                    type="button"
                    {...keepFocus}
                    onClick={openReceive}
                    disabled={busy > 0 || waiter.balancePaise <= 0n}
                    className={`flex items-center justify-between rounded-lg border-2 border-amber-400 px-4 py-3 text-lg font-black text-amber-300 hover:bg-amber-400/10 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:text-zinc-500 ${FOCUS_RING}`}
                  >
                    <span className="flex items-center gap-2">
                      <HandCoins className="size-5" aria-hidden /> Receive payment
                    </span>
                    <Kbd>F7</Kbd>
                  </button>
                ) : (
                  waiter && (
                    <p className="rounded-lg border-2 border-zinc-800 px-3 py-2 text-sm text-zinc-400">
                      Bill-on-bill: tick whole bills (<Kbd>Space</Kbd>) and settle them exactly — no lump sums.
                    </p>
                  )
                )}
                {state.ledger && state.ledger.creditPaise > 0n && (
                  <p className="text-sm text-zinc-300">
                    Of the balance, <span className="font-mono font-bold">{formatPaise(state.ledger.creditPaise)}</span> is collect-later credit.
                  </p>
                )}

                <h3 className="mt-1 text-xs font-bold tracking-widest text-zinc-400 uppercase">Today&apos;s payments</h3>
                <ReceiptList receipts={ledgerReady ? (state.ledger?.receipts ?? []) : []} />
              </aside>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t-2 border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-300">
              {FOOTER_KEYS.map(([keys, label]) => (
                <span key={label}>
                  {keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}{' '}
                  {label}
                </span>
              ))}
            </div>
          </main>
        </div>
      )}

      {state.dialog === 'settle' && waiter && <SettleDialog waiter={waiter} bills={toSettle} onConfirm={settle} onClose={closeDialog} />}
      {state.dialog === 'receive' && state.ledger && <ReceiveDialog ledger={state.ledger} onConfirm={receive} onClose={closeDialog} />}
      {state.dialog === 'member' && <MemberDialog onPick={pickMember} onClose={closeDialog} />}
    </div>
  )
}

const FOOTER_KEYS: Array<[string[], string]> = [
  [['↑', '↓'], 'move'],
  [['Tab'], 'waiters → bills → lines'],
  [['Space'], 'tick bill'],
  [['A'], 'tick all'],
  [['F9'], 'settle'],
  [['F7'], 'receive payment'],
  [['−'], 'remove one'],
  [['X'], 'broken'],
  [['F2'], 'member'],
  [['R'], 'refresh'],
  [['Esc'], 'dashboard'],
]

function tenderLabel(tender: Tender): string {
  return tender === 'CASH' ? 'cash' : tender === 'UPI' ? 'UPI' : 'on credit'
}

/** Re-renders the caller every `ms`, for clocks that don't need per-second precision. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

/** Isolated so the per-second tick only re-renders this label. */
function UpdatedAgo({ at }: { at: number | null }) {
  const now = useNow(1000)
  if (at === null) return null
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  return <span className="text-sm text-zinc-400">updated {seconds < 2 ? 'just now' : `${seconds}s ago`}</span>
}

function Figure({ label, amount, tone = 'plain', big = false }: { label: string; amount: Paise; tone?: 'plain' | 'amber' | 'green'; big?: boolean }) {
  const color = tone === 'amber' ? 'text-amber-300' : tone === 'green' ? 'text-emerald-300' : 'text-zinc-100'
  return (
    <div className={`flex flex-col rounded-md border-2 px-3 py-1 ${big ? 'border-zinc-600 bg-zinc-950' : 'border-zinc-800'}`}>
      <span className="text-[11px] font-bold tracking-widest text-zinc-400 uppercase">{label}</span>
      <span className={`font-mono font-black tabular-nums ${big ? 'text-2xl' : 'text-lg'} ${color}`}>{formatPaise(amount)}</span>
    </div>
  )
}

// ── Waiter list (left) ───────────────────────────────────────────────────────

function WaiterList({
  waiters,
  selectedId,
  freshIds,
  focused,
  onSelect,
}: {
  waiters: WaiterLedgerRow[]
  selectedId: string | null
  freshIds: ReadonlySet<string>
  focused: boolean
  onSelect: (id: string) => void
}) {
  return (
    <aside
      className={`flex w-[34%] max-w-lg min-w-80 shrink-0 flex-col border-r-2 bg-zinc-900 ${focused ? 'border-amber-400/60' : 'border-zinc-800'}`}
      aria-label="Waiters"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_6rem] gap-2 border-b border-zinc-800 px-4 py-2 text-[11px] font-bold tracking-widest text-zinc-400 uppercase">
        <span>Waiter</span>
        <span className="text-right">Owed</span>
        <span className="text-right">Paid</span>
        <span className="text-right">Balance</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Waiter accounts">
        {waiters.map((w) => {
          const selected = w.id === selectedId
          return (
            <li key={w.id} role="option" aria-selected={selected}>
              <button
                type="button"
                {...keepFocus}
                onClick={() => onSelect(w.id)}
                className={`grid w-full grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_6rem] items-center gap-2 border-b border-zinc-800 px-4 py-3 text-left ${
                  selected ? 'bg-amber-400/15 outline-2 -outline-offset-2 outline-amber-400' : freshIds.has(w.id) ? 'bg-sky-500/20' : 'hover:bg-zinc-800'
                }`}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-sm text-zinc-400">{w.code}</span>
                    <span className="truncate font-bold">{w.displayName}</span>
                    {freshIds.has(w.id) && <span className="size-2 shrink-0 rounded-full bg-sky-400" aria-label="new order" />}
                  </span>
                  <span className="flex items-center gap-2">
                    <TrustBadge trusted={w.isTrusted} />
                    {w.openBills > 0 && <span className="text-xs font-semibold text-amber-300">{w.openBills} open</span>}
                  </span>
                </span>
                <span className="text-right font-mono text-sm tabular-nums text-zinc-300">{formatPaise(w.billedPaise)}</span>
                <span className="text-right font-mono text-sm tabular-nums text-zinc-300">{formatPaise(w.paidPaise)}</span>
                <span className={`text-right font-mono font-bold tabular-nums ${w.balancePaise > 0n ? 'text-amber-300' : 'text-emerald-400'}`}>{formatPaise(w.balancePaise)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

// ── Open bills (right) ───────────────────────────────────────────────────────

function OpenBills({
  bills,
  loading,
  checked,
  cursorId,
  focused,
  now,
  onCursor,
  onToggle,
  onToggleAll,
}: {
  bills: BillDetail[]
  loading: boolean
  checked: ReadonlySet<string>
  cursorId: string | null
  focused: boolean
  now: number
  onCursor: (billId: string) => void
  onToggle: (billId: string) => void
  onToggleAll: () => void
}) {
  const allChecked = bills.length > 0 && bills.every((b) => checked.has(b.bill.id))
  return (
    <div className={`flex max-h-[45%] shrink-0 flex-col border-2 ${focused ? 'border-amber-400/60' : 'border-transparent'}`}>
      <div className="grid grid-cols-[2rem_4.5rem_minmax(0,1fr)_5rem_5rem_7rem] items-center gap-2 px-3 py-2 text-[11px] font-bold tracking-widest text-zinc-400 uppercase">
        <button type="button" {...keepFocus} onClick={onToggleAll} aria-label="Tick all bills (A)" className="text-zinc-300 hover:text-zinc-50">
          {allChecked ? <CheckSquare className="size-5" aria-hidden /> : <Square className="size-5" aria-hidden />}
        </button>
        <span>Bill</span>
        <span>From</span>
        <span className="text-right">Bottles</span>
        <span className="text-right">Age</span>
        <span className="text-right">Due</span>
      </div>
      {loading && <p className="px-4 py-3 text-sm text-zinc-400">Loading…</p>}
      {!loading && bills.length === 0 && <p className="px-4 py-3 text-sm text-zinc-400">No open bills.</p>}
      <ul className="min-h-0 overflow-y-auto" role="listbox" aria-label="Open bills" aria-multiselectable="true">
        {bills.map((b) => {
          const on = checked.has(b.bill.id)
          const isCursor = b.bill.id === cursorId
          const { bottles } = totals(b)
          return (
            <li key={b.bill.id} role="option" aria-selected={on}>
              <div
                className={`grid grid-cols-[2rem_4.5rem_minmax(0,1fr)_5rem_5rem_7rem] items-center gap-2 border-t border-zinc-800 px-3 py-2 ${
                  isCursor ? 'bg-amber-400/15 outline-2 -outline-offset-2 outline-amber-400' : on ? 'bg-emerald-500/10' : 'hover:bg-zinc-900'
                }`}
              >
                <button type="button" {...keepFocus} onClick={() => onToggle(b.bill.id)} aria-label={`Tick bill #${b.bill.billNo}`} className={on ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-200'}>
                  {on ? <CheckSquare className="size-5" aria-hidden /> : <Square className="size-5" aria-hidden />}
                </button>
                <button type="button" {...keepFocus} onClick={() => onCursor(b.bill.id)} className="col-span-5 grid grid-cols-subgrid items-center text-left">
                  <span className="font-mono text-lg font-bold">#{b.bill.billNo}</span>
                  <span className="truncate text-sm text-zinc-300">
                    {b.bill.source === 'WAITER_APP' ? (b.bill.captainDeviceId ?? 'handset') : 'counter'}
                    {b.member && <span className="text-zinc-400"> · {b.member.displayName}</span>}
                    {b.tenderedPaise > 0n && <span className="text-amber-300"> · part-paid {formatPaise(b.tenderedPaise)}</span>}
                  </span>
                  <span className="text-right font-mono text-sm">{bottles}</span>
                  <span className="text-right font-mono text-sm text-zinc-400">{formatAge(b.bill.createdAt, now)}</span>
                  <span className="text-right font-mono text-lg font-bold tabular-nums">{formatPaise(b.duePaise)}</span>
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function LineActions({ detail, canCancel, busy, onCancel }: { detail: BillDetail; canCancel: boolean; busy: boolean; onCancel: (restock: boolean) => void }) {
  const blocked = editBlock(detail)
  return (
    <div className="flex shrink-0 items-center gap-3 border-t-2 border-zinc-800 bg-zinc-900 px-3 py-2">
      <ActionButton disabled={!canCancel || blocked !== null || busy} onClick={() => onCancel(true)} shortcut="−">
        <Minus className="size-4" aria-hidden /> Remove one
      </ActionButton>
      <ActionButton disabled={!canCancel || blocked !== null || busy} onClick={() => onCancel(false)} shortcut="X">
        <PackageX className="size-4" aria-hidden /> Broken (no restock)
      </ActionButton>
      {blocked && <span className="text-sm text-amber-300">{blocked}</span>}
    </div>
  )
}

function ActionButton({ disabled, onClick, shortcut, children }: { disabled: boolean; onClick: () => void; shortcut: string; children: ReactNode }) {
  return (
    <button
      type="button"
      {...keepFocus}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2 rounded-md border-2 border-zinc-600 px-3 py-1.5 font-bold hover:border-zinc-300 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
    >
      {children}
      <Kbd>{shortcut}</Kbd>
    </button>
  )
}

function ReceiptList({ receipts }: { receipts: LedgerReceipt[] }) {
  if (receipts.length === 0) return <p className="text-sm text-zinc-500">No payments yet today.</p>
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
      {receipts.map((r) => (
        <li key={`${r.at}-${r.tender}`} className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-zinc-400">
              {formatTime(new Date(r.at))} · {r.tender === 'CASH' ? 'Cash' : 'UPI'}
            </span>
            <span className={`font-mono font-bold tabular-nums ${r.amountPaise < 0n ? 'text-rose-300' : 'text-emerald-300'}`}>{formatPaise(r.amountPaise)}</span>
          </div>
          <ul className="mt-1 text-xs text-zinc-300">
            {r.allocations.map((a, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>
                  {a.kind === 'BILL'
                    ? `→ #${a.billNo} ${a.settled ? 'settled' : `part · ${formatPaise(a.remainingDuePaise)} left`}`
                    : a.kind === 'CREDIT'
                      ? '→ credit balance'
                      : '↺ repayment voided'}
                </span>
                <span className="font-mono">{formatPaise(a.amountPaise)}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

function TenderChoice<T extends string>({ options, value, onChange }: { options: ReadonlyArray<[T, string, string]>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="mt-3 flex gap-2" role="radiogroup" aria-label="Tender">
      {options.map(([t, label, key]) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={t === value}
          onClick={() => onChange(t)}
          className={`flex-1 rounded-md border-2 px-3 py-2 font-bold ${t === value ? 'border-amber-400 bg-amber-400 text-zinc-950' : 'border-zinc-700'}`}
        >
          {label} <Kbd>{key}</Kbd>
        </button>
      ))}
    </div>
  )
}

function SettleDialog({ waiter, bills, onConfirm, onClose }: { waiter: WaiterLedgerRow; bills: BillDetail[]; onConfirm: (tender: Tender) => void; onClose: () => void }) {
  const [tender, setTender] = useState<Tender>('CASH')
  const total = selectionTotal(bills)
  const options: Array<[Tender, string, string]> = [
    ['CASH', 'Cash', 'C'],
    ['UPI', 'UPI', 'U'],
  ]
  if (waiter.isTrusted) options.push(['WAITER_CREDIT', 'Collect later', 'L'])
  return (
    <Modal
      title={`Settle ${bills.length} bill${bills.length === 1 ? '' : 's'} · ${waiter.displayName}`}
      onClose={onClose}
      onKey={(e) => {
        if (e.key === 'Enter') {
          onConfirm(tender)
          return true
        }
        const k = e.key.toLowerCase()
        if (k === 'c') setTender('CASH')
        else if (k === 'u') setTender('UPI')
        else if (k === 'l' && waiter.isTrusted) setTender('WAITER_CREDIT')
        else return false
        return true
      }}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-zinc-400">
            Each bill is paid exactly · <Kbd>Enter</Kbd> settle
          </span>
          <button type="button" onClick={() => onConfirm(tender)} className="rounded-md bg-emerald-500 px-5 py-2 font-bold text-zinc-950">
            Settle {formatPaise(total)}
          </button>
        </div>
      }
    >
      <ul className="flex flex-col gap-1 font-mono">
        {bills.map((b) => (
          <li key={b.bill.id} className="flex justify-between">
            <span>#{b.bill.billNo}</span>
            <span>{formatPaise(b.duePaise)}</span>
          </li>
        ))}
        <li className="mt-1 flex justify-between border-t border-zinc-700 pt-1 text-lg font-bold">
          <span>Total</span>
          <span>{formatPaise(total)}</span>
        </li>
      </ul>
      <TenderChoice options={options} value={tender} onChange={setTender} />
    </Modal>
  )
}

function ReceiveDialog({ ledger, onConfirm, onClose }: { ledger: WaiterLedger; onConfirm: (amount: Paise, tender: CounterTender) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [tender, setTender] = useState<CounterTender>('CASH')
  const amount = text.trim() === '' ? null : parseRupeesToPaise(text)
  const error = receiveError(ledger, text)
  const preview = amount !== null && amount > 0n ? allocate(ledger.openBills, ledger.creditPaise, amount) : null
  const confirm = () => {
    if (error === null && amount !== null) onConfirm(amount, tender)
  }
  const w = ledger.waiter
  return (
    <Modal
      title={`Receive payment · ${w.displayName}`}
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
        {w.code} owes <span className="font-mono font-bold">{formatPaise(w.balancePaise)}</span> — the oldest bills are paid first, then any credit.
      </p>
      <RupeeField label="Amount received" value={text} onChange={setText} dataAutofocus />
      <TenderChoice
        options={[
          ['CASH', 'Cash', 'C'],
          ['UPI', 'UPI', 'U'],
        ]}
        value={tender}
        onChange={setTender}
      />
      {preview && error === null && (
        <ul className="mt-3 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" aria-label="Where it goes">
          {preview.slices.map((s, i) => (
            <li key={i} className="flex justify-between gap-2">
              <span>{s.kind === 'BILL' ? `#${s.billNo} ${s.settled ? 'settled' : `part-paid · ${formatPaise(s.remainingDuePaise)} left`}` : 'Credit balance'}</span>
              <span className="font-mono">{formatPaise(s.amountPaise)}</span>
            </li>
          ))}
          <li className="mt-1 flex justify-between border-t border-zinc-800 pt-1 font-bold">
            <span>Balance after</span>
            <span className="font-mono">{formatPaise(w.balancePaise - (amount ?? 0n))}</span>
          </li>
        </ul>
      )}
      {error && amount !== null && <p className="mt-3 text-sm font-semibold text-rose-400">{error}</p>}
    </Modal>
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
