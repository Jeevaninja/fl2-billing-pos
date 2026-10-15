import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, CreditCard, Minus, PackageX, RefreshCw, Smartphone, UserRound, UsersRound, WifiOff } from 'lucide-react'
import { api } from '../api/client'
import type { BillDetail, MemberSummary } from '../api/types'
import { FlashLine, ItemsGrid } from '../billing/BillingPanels'
import { groupItems, totals, type Receipt } from '../billing/billingReducer'
import { counterErrorMessage } from '../billing/errors'
import { describePlan, type PayPlan } from '../billing/payment'
import { PaymentDialog } from '../billing/PaymentDialog'
import { MemberDialog, TrustBadge } from '../billing/PickerDialogs'
import { captainOrdersReducer, editBlock, formatAge, initialCaptainOrdersState, selectedOrder } from '../captain/captainOrdersReducer'
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts'
import { beep } from '../lib/beep'
import { formatPaise } from '../lib/money'
import { FOCUS_RING, keepFocus } from '../lib/ui'
import { Kbd, LiveClock } from './ui'

const POLL_MS = 5_000
const AGE_TICK_MS = 15_000

/**
 * The cashier's queue of open Captain-app orders: pick one, correct it (cancel bottles, attach a
 * member), then settle it through the waiter flow. Polls every 5 s; polling pauses while a dialog
 * is open so the order being paid can't change under the cashier.
 */
export default function CaptainOrdersScreen({ onExit }: { onExit: () => void }) {
  const [state, dispatch] = useReducer(captainOrdersReducer, initialCaptainOrdersState)
  const order = selectedOrder(state)
  const rows = useMemo(() => groupItems(order?.items ?? []), [order])
  const now = useNow(AGE_TICK_MS)
  const [busy, setBusy] = useState(0)

  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })
  const queue = useRef<Promise<void>>(Promise.resolve())
  // A poll that started before a write may carry stale bills, so writes bump this and polls that
  // straddle one are dropped. activeWrites covers polls that start while a write is in flight.
  const writeSeq = useRef(0)
  const activeWrites = useRef(0)
  const polling = useRef(false)
  const pollAgain = useRef(false)

  const flash = useCallback((kind: 'ok' | 'error', text: string) => {
    beep(kind)
    dispatch({ type: 'flash', kind, text })
  }, [])

  const refresh = useCallback(async () => {
    if (polling.current) {
      pollAgain.current = true
      return
    }
    polling.current = true
    try {
      do {
        pollAgain.current = false
        const seq = writeSeq.current
        try {
          const orders = await api.captainOrders()
          if (seq === writeSeq.current && activeWrites.current === 0) dispatch({ type: 'ordersLoaded', orders, at: Date.now() })
        } catch (err) {
          dispatch({ type: 'ordersFailed', message: counterErrorMessage(err) })
        }
      } while (pollAgain.current)
    } finally {
      polling.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      if (stateRef.current.dialog === null) void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // New orders: one beep per refresh that brought any.
  useEffect(() => {
    if (state.freshIds.size > 0) beep('ok')
  }, [state.freshIds])

  /** Runs a write after every earlier one; failures flash, and the list is always re-read after. */
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
      const { selectedKey } = stateRef.current
      const detail = selectedOrder(stateRef.current)
      if (!detail) return
      const blocked = editBlock(detail)
      if (blocked) {
        flash('error', blocked)
        return
      }
      const row = groupItems(detail.items).find((r) => r.key === selectedKey)
      if (!row?.cancelItemId) {
        flash('error', 'Select a line first (Tab, then ↑ ↓)')
        return
      }
      const itemId = row.cancelItemId
      run(async () => {
        await api.cancelItem(detail.bill.id, itemId, 1, restock)
        dispatch({ type: 'orderUpdated', detail: await api.getBill(detail.bill.id) })
        flash('ok', `Removed 1 × ${row.displayName} from #${detail.bill.billNo}${restock ? ' — back in stock' : ' — written off as broken'}`)
      })
    },
    [run, flash],
  )

  const pickMember = useCallback(
    (member: MemberSummary | null) => {
      dispatch({ type: 'dialog', dialog: null })
      const detail = selectedOrder(stateRef.current)
      if (!detail) return
      run(async () => {
        await api.setMember(detail.bill.id, member?.id ?? null)
        dispatch({ type: 'orderUpdated', detail: await api.getBill(detail.bill.id) })
        flash('ok', member ? `Member ${member.displayName} attached to #${detail.bill.billNo}` : `#${detail.bill.billNo} is now walk-in`)
      })
    },
    [run, flash],
  )

  const openPayment = useCallback(() => {
    const detail = selectedOrder(stateRef.current)
    if (!detail) {
      flash('error', 'No order selected')
      return
    }
    if (groupItems(detail.items).length > 0) {
      dispatch({ type: 'dialog', dialog: 'payment' })
      return
    }
    if (detail.bill.totalPaise !== 0n) {
      flash('error', `Order #${detail.bill.billNo} has nothing left to settle`)
      return
    }
    run(async () => {
      await api.closeEmpty(detail.bill.id)
      dispatch({ type: 'orderGone', billId: detail.bill.id, receipt: null })
      flash('ok', `Empty order #${detail.bill.billNo} closed`)
    })
  }, [run, flash])

  const pay = useCallback(
    (plan: PayPlan) => {
      const detail = selectedOrder(stateRef.current)
      if (!detail) return
      dispatch({ type: 'dialog', dialog: null }) // closing first makes a double Enter harmless
      run(async () => {
        const billId = detail.bill.id
        if (plan.kind === 'counter') {
          await api.settle(billId, plan.payments)
        } else {
          for (const step of plan.steps) await api.settleWaiter(billId, plan.waiterId, step.tender, step.amount)
        }
        const receipt = { billNo: detail.bill.billNo, totalPaise: detail.bill.totalPaise, changePaise: plan.changePaise, summary: describePlan(plan, detail) }
        dispatch({ type: 'orderGone', billId, receipt })
        flash('ok', `Order #${detail.bill.billNo} settled${plan.changePaise > 0n ? ` · change ${formatPaise(plan.changePaise)}` : ''}`)
      })
    },
    [run, flash],
  )

  // ── Keyboard ───────────────────────────────────────────────────────────────

  const keysLive = state.dialog === null

  useGlobalShortcuts(
    {
      F2: () => (stateRef.current.selectedId ? dispatch({ type: 'dialog', dialog: 'member' }) : flash('error', 'No order selected')),
      F9: openPayment,
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
        dispatch({ type: 'focus', pane: stateRef.current.focus === 'list' ? 'detail' : 'list' })
        return
      }
      if (key === 'Escape') {
        event.preventDefault()
        onExit()
        return
      }
      if (event.repeat) return // a held key must not cancel a run of bottles
      if (key === 'Enter' && !onButton) {
        event.preventDefault()
        openPayment()
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
  }, [keysLive, onExit, openPayment, refresh, cancelLine])

  // ── Layout ─────────────────────────────────────────────────────────────────

  const closeDialog = () => dispatch({ type: 'dialog', dialog: null })
  const count = state.orders.length

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
        <h1 className="text-lg font-bold tracking-wide uppercase">Captain Orders</h1>
        {state.load !== 'loading' && (
          <span className="rounded bg-sky-500 px-2.5 py-1 text-sm font-black tracking-widest text-zinc-950 uppercase">{count} open</span>
        )}
        {state.load === 'offline' ? (
          <span className="flex items-center gap-1.5 rounded bg-rose-500/20 px-2 py-1 text-sm font-bold text-rose-300">
            <WifiOff className="size-4" aria-hidden /> Offline — showing last list
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

      {state.load === 'loading' && <CenterNote title="Loading Captain orders…" />}
      {state.load === 'offline' && count === 0 && (
        <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />}>
          <p className="text-zinc-300">{state.offlineMessage}</p>
          <p className="mt-1 text-sm text-zinc-400">Retrying every 5 s, or press R.</p>
        </CenterNote>
      )}
      {state.load === 'ready' && count === 0 && (
        <CenterNote title="No open Captain orders" icon={<Smartphone className="size-10 text-zinc-500" aria-hidden />}>
          <p className="text-zinc-400">Orders sent from waiters' handsets appear here within 5 seconds.</p>
          {state.receipt && <ReceiptBanner receipt={state.receipt} />}
        </CenterNote>
      )}

      {count > 0 && (
        <div className="flex min-h-0 flex-1">
          <OrderList
            orders={state.orders}
            selectedId={state.selectedId}
            freshIds={state.freshIds}
            focused={state.focus === 'list'}
            now={now}
            onSelect={(id) => {
              dispatch({ type: 'select', id })
              dispatch({ type: 'focus', pane: 'list' })
            }}
          />
          <main className="flex min-w-0 flex-1 flex-col" aria-label="Order details">
            <div className="flex min-h-16 items-center gap-4 border-b-2 border-zinc-800 bg-zinc-900 px-4 py-2">
              <h2 className="shrink-0 font-mono text-xl font-bold">{order ? `Order #${order.bill.billNo}` : 'Select an order'}</h2>
              {order && (
                <span className="truncate text-sm text-zinc-400">
                  {order.bill.captainDeviceId ?? 'handset'} · placed{' '}
                  {new Date(order.bill.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                </span>
              )}
              <span className="ml-auto" />
              <FlashLine flash={state.flash} />
            </div>
            {state.receipt && (
              <div className="px-4 pt-3">
                <ReceiptBanner receipt={state.receipt} />
              </div>
            )}
            {order && (
              <>
                <div className={`flex min-h-0 flex-1 flex-col border-2 ${state.focus === 'detail' ? 'border-amber-400/60' : 'border-transparent'}`}>
                  <ItemsGrid
                    rows={rows}
                    pending={[]}
                    selectedKey={state.selectedKey}
                    onSelect={(key) => dispatch({ type: 'selectLine', key })}
                    receipt={null}
                    empty={
                      <p className="p-12 text-center text-lg text-zinc-400">
                        Every line was cancelled. Press <Kbd>F9</Kbd> to close this ₹0 order.
                      </p>
                    }
                  />
                </div>
                <OrderActions detail={order} canCancel={rows.length > 0} busy={busy > 0} onCancel={cancelLine} onMember={() => dispatch({ type: 'dialog', dialog: 'member' })} onPay={openPayment} />
              </>
            )}
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

      {state.dialog === 'payment' && order && <PaymentDialog detail={order} busy={busy > 0} onConfirm={pay} onClose={closeDialog} />}
      {state.dialog === 'member' && <MemberDialog onPick={pickMember} onClose={closeDialog} />}
    </div>
  )
}

const FOOTER_KEYS: Array<[string[], string]> = [
  [['↑', '↓'], 'select'],
  [['Tab'], 'orders ⇄ lines'],
  [['−'], 'remove one (restock)'],
  [['X'], 'broken (no restock)'],
  [['F2'], 'member'],
  [['F9'], 'settle'],
  [['R'], 'refresh'],
  [['Esc'], 'dashboard'],
]

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

// ── Order list ───────────────────────────────────────────────────────────────

interface OrderListProps {
  orders: BillDetail[]
  selectedId: string | null
  freshIds: ReadonlySet<string>
  focused: boolean
  now: number
  onSelect: (id: string) => void
}

function OrderList({ orders, selectedId, freshIds, focused, now, onSelect }: OrderListProps) {
  return (
    <aside
      className={`flex w-[42%] max-w-xl min-w-80 shrink-0 flex-col border-r-2 bg-zinc-900 ${focused ? 'border-amber-400/60' : 'border-zinc-800'}`}
      aria-label="Open Captain orders"
    >
      <h2 className="border-b border-zinc-800 px-4 py-3 text-xs font-bold tracking-widest text-zinc-400 uppercase">Oldest first</h2>
      <ul className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Orders">
        {orders.map((o) => {
          const selected = o.bill.id === selectedId
          const { bottles } = totals(o)
          return (
            <li key={o.bill.id} role="option" aria-selected={selected}>
              <button
                type="button"
                {...keepFocus}
                onClick={() => onSelect(o.bill.id)}
                className={`flex w-full flex-col gap-1 border-b border-zinc-800 px-4 py-3 text-left ${
                  selected ? 'bg-amber-400/15 outline-2 -outline-offset-2 outline-amber-400' : freshIds.has(o.bill.id) ? 'bg-sky-500/20' : 'hover:bg-zinc-800'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-lg font-bold">#{o.bill.billNo}</span>
                  {o.waiter && (
                    <>
                      <span className="font-mono text-sm text-zinc-400">{o.waiter.code}</span>
                      <span className="truncate font-semibold">{o.waiter.displayName}</span>
                      <TrustBadge trusted={o.bill.waiterTrustedAtBilling ?? o.waiter.isTrusted} />
                    </>
                  )}
                  <span className="ml-auto font-mono text-lg font-bold tabular-nums">{formatPaise(o.duePaise)}</span>
                </span>
                <span className="flex items-center gap-2 text-sm text-zinc-400">
                  <span>{o.bill.captainDeviceId ?? 'handset'}</span>·<span>{bottles} {bottles === 1 ? 'bottle' : 'bottles'}</span>
                  {o.member && <>· <span className="truncate text-zinc-300">{o.member.displayName}</span></>}
                  {o.tenderedPaise > 0n && <>· <span className="text-amber-300">part-paid</span></>}
                  <span className={`ml-auto font-mono ${freshIds.has(o.bill.id) ? 'font-bold text-sky-300' : ''}`}>{formatAge(o.bill.createdAt, now)}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

// ── Detail: waiter, member, totals and actions ───────────────────────────────

interface OrderActionsProps {
  detail: BillDetail
  canCancel: boolean
  busy: boolean
  onCancel: (restock: boolean) => void
  onMember: () => void
  onPay: () => void
}

function OrderActions({ detail, canCancel, busy, onCancel, onMember, onPay }: OrderActionsProps) {
  const { waiter, member } = detail
  const trusted = detail.bill.waiterTrustedAtBilling ?? waiter?.isTrusted ?? false
  const blocked = editBlock(detail)
  const { lines, bottles } = totals(detail)
  const empty = lines === 0

  return (
    <div className="grid shrink-0 grid-cols-[1fr_1fr_auto] gap-3 border-t-2 border-zinc-800 bg-zinc-900 p-3">
      <InfoCard label="Waiter" icon={<UsersRound className="size-5" aria-hidden />}>
        {waiter ? (
          <>
            <span className="flex items-center gap-2">
              <span className="font-mono text-zinc-400">{waiter.code}</span>
              <span className="truncate font-bold">{waiter.displayName}</span>
              <TrustBadge trusted={trusted} />
            </span>
            <span className="font-mono text-sm text-zinc-400">
              Outstanding {formatPaise(waiter.outstandingPaise)}
              {waiter.creditLimitPaise !== null && ` / ${formatPaise(waiter.creditLimitPaise)}`}
            </span>
          </>
        ) : (
          <span className="text-zinc-400">—</span>
        )}
      </InfoCard>

      <button
        type="button"
        {...keepFocus}
        onClick={onMember}
        className={`flex items-start gap-3 rounded-lg border-2 border-zinc-700 bg-zinc-950 p-3 text-left hover:border-zinc-400 ${FOCUS_RING}`}
      >
        <UserRound className="mt-0.5 size-5 text-zinc-400" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs font-bold tracking-widest text-zinc-400 uppercase">Member</span>
          {member ? (
            <>
              <span className="truncate font-bold">{member.displayName}</span>
              <span className="font-mono text-sm text-zinc-400">{member.membershipNo}</span>
            </>
          ) : (
            <span className="text-zinc-400">Walk-in — none attached</span>
          )}
        </span>
        <Kbd>F2</Kbd>
      </button>

      <div className="row-span-2 flex w-64 flex-col gap-2">
        <div className="rounded-lg border-2 border-zinc-700 bg-zinc-950 p-3">
          <div className="flex justify-between text-sm text-zinc-400">
            <span>Lines {lines}</span>
            <span>Bottles {bottles}</span>
          </div>
          {detail.tenderedPaise > 0n && (
            <div className="mt-1 flex justify-between font-mono text-sm text-zinc-300">
              <span>Paid</span>
              <span>{formatPaise(detail.tenderedPaise)}</span>
            </div>
          )}
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-sm font-bold tracking-widest text-zinc-400 uppercase">Due</span>
            <span className="font-mono text-3xl font-black tabular-nums" aria-live="polite">
              {formatPaise(detail.duePaise)}
            </span>
          </div>
        </div>
        <button
          type="button"
          {...keepFocus}
          onClick={onPay}
          disabled={busy}
          className={`flex flex-1 items-center justify-between rounded-lg bg-emerald-500 px-4 py-3 text-xl font-black text-zinc-950 hover:bg-emerald-400 disabled:opacity-50 ${FOCUS_RING}`}
        >
          <span className="flex items-center gap-2">
            <CreditCard className="size-6" aria-hidden /> {empty ? 'Close ₹0' : 'Settle'}
          </span>
          <Kbd>F9</Kbd>
        </button>
        <p className="text-center text-xs text-zinc-500">{trusted ? 'Cash · UPI · Partial · Collect later' : 'Exact Cash or UPI only'}</p>
      </div>

      <div className="col-span-2 flex items-center gap-3">
        <ActionButton disabled={!canCancel || blocked !== null || busy} onClick={() => onCancel(true)} shortcut="−">
          <Minus className="size-4" aria-hidden /> Remove one
        </ActionButton>
        <ActionButton disabled={!canCancel || blocked !== null || busy} onClick={() => onCancel(false)} shortcut="X">
          <PackageX className="size-4" aria-hidden /> Broken (no restock)
        </ActionButton>
        {blocked && <span className="text-sm text-amber-300">{blocked}</span>}
      </div>
    </div>
  )
}

function InfoCard({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border-2 border-zinc-800 bg-zinc-950 p-3">
      <span className="mt-0.5 text-zinc-400">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-bold tracking-widest text-zinc-400 uppercase">{label}</span>
        {children}
      </span>
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
      className={`flex items-center gap-2 rounded-md border-2 border-zinc-600 px-3 py-2 font-bold hover:border-zinc-300 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
    >
      {children}
      <Kbd>{shortcut}</Kbd>
    </button>
  )
}

function ReceiptBanner({ receipt }: { receipt: Receipt }) {
  return (
    <div className="mt-2 rounded-lg border-2 border-emerald-500/60 bg-emerald-500/10 px-4 py-3 text-left">
      <p className="text-sm font-bold tracking-widest text-emerald-300 uppercase">
        Order #{receipt.billNo} settled · {formatPaise(receipt.totalPaise)}
      </p>
      <p className="text-zinc-300">{receipt.summary}</p>
      {receipt.changePaise > 0n && <p className="mt-1 font-mono text-2xl font-bold text-emerald-300">Change: {formatPaise(receipt.changePaise)}</p>}
    </div>
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
