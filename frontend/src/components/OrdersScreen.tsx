import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, CornerDownLeft, Printer, RefreshCw, Users, WifiOff, Zap } from 'lucide-react'
import { api } from '../api/client'
import type { OrderDetail, OrderSummary } from '../api/types'
import { FlashLine, SizeChip } from '../billing/BillingPanels'
import type { Flash } from '../billing/billingReducer'
import { counterErrorMessage } from '../billing/errors'
import { Modal } from '../billing/Modal'
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts'
import { beep } from '../lib/beep'
import { formatPaise } from '../lib/money'
import { FOCUS_RING, formatTime, keepFocus } from '../lib/ui'
import {
  chipCounts,
  FILTERS,
  findByNumber,
  jumpTarget,
  moveKey,
  orderRows,
  settlementLines,
  STATUS_LABEL,
  waitersInOrders,
  whoLabel,
  type JumpTarget,
  type OrderRow,
  type OrdersFilter,
  type PeakGroup,
} from '../orders/ordersView'
import { Kbd, LiveClock } from './ui'

const POLL_MS = 10_000

interface ListState {
  load: 'loading' | 'ready' | 'offline'
  offlineMessage: string | null
  orders: OrderSummary[]
  cashierId: string | null
}

type ListAction = { type: 'loaded'; orders: OrderSummary[]; cashierId: string } | { type: 'failed'; message: string }

/** A failed poll keeps the last list (shown under an OFFLINE pill). */
function listReducer(state: ListState, action: ListAction): ListState {
  return action.type === 'loaded'
    ? { load: 'ready', offlineMessage: null, orders: action.orders, cashierId: action.cashierId }
    : { ...state, load: 'offline', offlineMessage: action.message }
}

const TONE: Record<'amber' | 'green' | 'zinc' | 'rose' | 'violet', string> = {
  amber: 'bg-amber-400 text-zinc-950',
  green: 'bg-emerald-500 text-zinc-950',
  zinc: 'bg-zinc-700 text-zinc-200',
  rose: 'bg-rose-500 text-zinc-950',
  violet: 'bg-violet-500 text-zinc-950',
}

/**
 * Orders (Phase 17): today's bills newest first with quick filters, each bill's itemised receipt and
 * settlement story, Reprint (F8) and Jump to bill (Enter / F9) for open bills. Peak bills fold into
 * one row per session except under the Peak and Voided filters. Polls every 10 s.
 */
export default function OrdersScreen({ onExit, onJump }: { onExit: () => void; onJump: (target: Exclude<JumpTarget, { kind: 'none' }>) => void }) {
  const [{ load, offlineMessage, orders, cashierId }, dispatchList] = useReducer(listReducer, { load: 'loading', offlineMessage: null, orders: [], cashierId: null })
  const [filter, setFilter] = useState<OrdersFilter>('ALL')
  const [waiterId, setWaiterId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detail, setDetail] = useState<OrderDetail | null>(null)
  const [digits, setDigits] = useState('')
  const [waiterMenu, setWaiterMenu] = useState(false)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [flashState, setFlashState] = useState<Flash | null>(null)

  const rows = useMemo(() => orderRows(orders, filter, waiterId, expanded), [orders, filter, waiterId, expanded])
  const counts = useMemo(() => chipCounts(orders, waiterId), [orders, waiterId])
  const waiters = useMemo(() => waitersInOrders(orders), [orders])
  // The selection falls back to the first row when nothing (or a row that is no longer shown) is picked.
  const activeKey = rows.some((r) => r.key === selectedKey) ? selectedKey : (rows[0]?.key ?? null)
  const selectedRow = rows.find((r) => r.key === activeKey) ?? null
  const selectedOrder = selectedRow?.kind === 'bill' ? selectedRow.order : null

  const flash = useCallback((kind: Flash['kind'], text: string) => {
    beep(kind)
    setFlashState((f) => ({ kind, text, seq: (f?.seq ?? 0) + 1 }))
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [list, context] = await Promise.all([api.orders(), api.context()])
      dispatchList({ type: 'loaded', orders: list, cashierId: context.cashier.id })
    } catch (err) {
      dispatchList({ type: 'failed', message: counterErrorMessage(err) })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // The selected bill's detail, re-read when it changes or the list refreshes (status may move on).
  const detailFor = selectedOrder?.billId ?? null
  const detailStamp = selectedOrder ? `${selectedOrder.status}|${selectedOrder.duePaise}|${selectedOrder.voidedAt ?? ''}` : ''
  useEffect(() => {
    if (!detailFor) return
    let live = true
    api
      .order(detailFor)
      .then((d) => live && setDetail(d))
      .catch((err: unknown) => live && flash('error', counterErrorMessage(err)))
    return () => {
      live = false
    }
  }, [detailFor, detailStamp, flash])

  // ── Actions ────────────────────────────────────────────────────────────────

  const pickFilter = useCallback((f: OrdersFilter) => {
    setFilter(f)
    setDigits('')
  }, [])

  const toggleGroup = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const jump = useCallback(() => {
    if (!selectedOrder) return
    const target = jumpTarget(selectedOrder, cashierId)
    if (target.kind === 'none') flash('error', target.reason)
    else onJump(target)
  }, [selectedOrder, cashierId, onJump, flash])

  const reprint = useCallback(() => {
    if (!selectedOrder) {
      flash('error', 'Pick a bill to reprint')
      return
    }
    const no = selectedOrder.billNo
    api
      .reprintOrder(selectedOrder.billId)
      .then((r) => {
        setReceipt(r.text)
        flash('ok', `Bill #${no} reprinted as DUPLICATE`)
      })
      .catch((err: unknown) => flash('error', counterErrorMessage(err)))
  }, [selectedOrder, flash])

  /** Typed bill number + Enter: select it, switching to All (and expanding its peak session) if needed. */
  const goToNumber = useCallback(() => {
    const found = findByNumber(orders, digits)
    setDigits('')
    if (!found) {
      flash('error', `No bill #${digits} today`)
      return
    }
    if (!orderRows(orders, filter, waiterId, expanded).some((r) => r.key === found.billId)) {
      setFilter(found.mode === 'PEAK' ? 'PEAK' : 'ALL')
      setWaiterId(null)
    }
    setSelectedKey(found.billId)
  }, [orders, digits, filter, waiterId, expanded, flash])

  // ── Keyboard ───────────────────────────────────────────────────────────────

  const keysLive = receipt === null && !waiterMenu

  useGlobalShortcuts({ F8: reprint, F9: jump }, keysLive)

  useEffect(() => {
    if (!keysLive) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        event.preventDefault()
        setSelectedKey(moveKey(rows, activeKey, key === 'ArrowUp' ? -1 : 1))
        return
      }
      if (key === 'Escape') {
        event.preventDefault()
        if (digits !== '') setDigits('')
        else onExit()
        return
      }
      if (/^\d$/.test(key)) {
        event.preventDefault()
        setDigits((d) => (d + key).slice(0, 6))
        return
      }
      if (key === 'Backspace' && digits !== '') {
        event.preventDefault()
        setDigits((d) => d.slice(0, -1))
        return
      }
      if (key === 'Enter') {
        event.preventDefault()
        if (digits !== '') goToNumber()
        else if (selectedRow?.kind === 'peak') toggleGroup(selectedRow.key)
        else jump()
        return
      }
      const filterKey = FILTERS.find((f) => f.key === key.toUpperCase())
      if (filterKey) {
        event.preventDefault()
        pickFilter(filterKey.id)
      } else if (key === 'w' || key === 'W') {
        event.preventDefault()
        setWaiterMenu(true)
      } else if (key === 'r' || key === 'R') {
        event.preventDefault()
        void refresh()
      } else if ((key === 'ArrowRight' || key === 'ArrowLeft') && selectedRow?.kind === 'peak') {
        event.preventDefault()
        if (selectedRow.expanded !== (key === 'ArrowRight')) toggleGroup(selectedRow.key)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [keysLive, rows, activeKey, digits, selectedRow, onExit, goToNumber, toggleGroup, jump, pickFilter, refresh])

  // ── Layout ─────────────────────────────────────────────────────────────────

  const waiterName = waiters.find((w) => w.id === waiterId)
  const target = selectedOrder ? jumpTarget(selectedOrder, cashierId) : null

  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b-2 border-amber-400 bg-zinc-900 px-5">
        <button type="button" {...keepFocus} onClick={onExit} className="flex items-center gap-2 rounded px-1 text-zinc-300 hover:text-zinc-50" aria-label="Back to dashboard (Esc)">
          <ArrowLeft className="size-5" aria-hidden />
          <span className="rounded bg-amber-400 px-2 py-0.5 text-lg font-black tracking-tight text-zinc-950">FL2</span>
        </button>
        <h1 className="text-lg font-bold tracking-wide uppercase">Orders</h1>
        {load !== 'loading' && <span className="text-sm text-zinc-400">{orders.length} bills today</span>}
        {load === 'offline' && (
          <span className="flex items-center gap-1.5 rounded bg-rose-500/20 px-2 py-1 text-sm font-bold text-rose-300">
            <WifiOff className="size-4" aria-hidden /> Offline — showing last list
          </span>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm">
          <button type="button" {...keepFocus} onClick={() => void refresh()} className="flex items-center gap-2 rounded-md border border-zinc-600 px-2 py-1 font-semibold text-zinc-300 hover:border-zinc-300">
            <RefreshCw className="size-4" aria-hidden /> Refresh <Kbd>R</Kbd>
          </button>
          <LiveClock />
          <span className="flex items-center gap-1 text-zinc-400">
            <Kbd>Esc</Kbd> Dashboard
          </span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b-2 border-zinc-800 bg-zinc-900 px-4 py-2" role="toolbar" aria-label="Filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            {...keepFocus}
            onClick={() => pickFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`flex items-center gap-2 rounded-full border-2 px-3 py-1 text-sm font-bold ${filter === f.id ? 'border-amber-400 bg-amber-400 text-zinc-950' : 'border-zinc-700 text-zinc-300 hover:border-zinc-400'}`}
          >
            {f.label}
            <span className={`rounded-full px-1.5 font-mono text-xs ${filter === f.id ? 'bg-zinc-950/20' : 'bg-zinc-800'}`}>{counts[f.id]}</span>
            <Kbd>{f.key}</Kbd>
          </button>
        ))}
        <button
          type="button"
          {...keepFocus}
          onClick={() => setWaiterMenu(true)}
          className={`ml-2 flex items-center gap-2 rounded-full border-2 px-3 py-1 text-sm font-bold ${waiterId ? 'border-sky-400 bg-sky-400 text-zinc-950' : 'border-zinc-700 text-zinc-300 hover:border-zinc-400'}`}
        >
          <Users className="size-4" aria-hidden />
          {waiterName ? `${waiterName.code} ${waiterName.displayName}` : 'Any waiter'}
          <Kbd>W</Kbd>
        </button>
        <span className="ml-auto flex items-center gap-2 text-sm text-zinc-400">
          {digits !== '' ? (
            <span className="rounded-md border-2 border-amber-400 bg-zinc-950 px-2 py-0.5 font-mono text-lg font-bold text-amber-300" aria-live="polite">
              #{digits}
              <span className="ml-1 text-xs font-sans text-zinc-400">Enter</span>
            </span>
          ) : (
            <>Type a bill number to jump to it</>
          )}
        </span>
        <FlashLine flash={flashState} />
      </div>

      {load === 'loading' && <CenterNote title="Loading today's bills…" />}
      {load === 'offline' && orders.length === 0 && (
        <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />}>
          <p className="text-zinc-300">{offlineMessage}</p>
        </CenterNote>
      )}
      {load === 'ready' && orders.length === 0 && <CenterNote title="No bills yet today" />}

      {orders.length > 0 && (
        <div className="flex min-h-0 flex-1">
          <OrderList rows={rows} selectedKey={activeKey} onSelect={setSelectedKey} onToggle={toggleGroup} />
          <main className="flex min-w-0 flex-1 flex-col" aria-label="Bill details">
            {selectedRow?.kind === 'peak' && <PeakGroupPanel group={selectedRow.group} expanded={selectedRow.expanded} onToggle={() => toggleGroup(selectedRow.key)} />}
            {selectedOrder && (
              <BillPanel order={selectedOrder} detail={detail?.summary.billId === selectedOrder.billId ? detail : null} target={target} onJump={jump} onReprint={reprint} />
            )}
            {!selectedRow && <CenterNote title={rows.length === 0 ? 'No bills match this filter' : 'Pick a bill'} />}
          </main>
        </div>
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

      {waiterMenu && (
        <WaiterMenu
          waiters={waiters}
          selectedId={waiterId}
          onPick={(id) => {
            setWaiterId(id)
            setWaiterMenu(false)
          }}
          onClose={() => setWaiterMenu(false)}
        />
      )}
      {receipt !== null && (
        <Modal title="Reprinted — DUPLICATE" onClose={() => setReceipt(null)} onKey={(e) => (e.key === 'Enter' ? (setReceipt(null), true) : false)} width="max-w-xl">
          <p className="mb-3 text-sm text-zinc-400">Sent to the counter printer. This is exactly what it prints.</p>
          <pre className="overflow-x-auto rounded-md bg-zinc-100 p-4 font-mono text-[13px] leading-snug text-zinc-900">{receipt}</pre>
        </Modal>
      )}
    </div>
  )
}

const FOOTER_KEYS: Array<[string[], string]> = [
  [['↑', '↓'], 'move'],
  [['A', 'O', 'S', 'P', 'V'], 'filter'],
  [['W'], 'waiter'],
  [['0-9'], 'bill no.'],
  [['Enter'], 'jump / expand'],
  [['F8'], 'reprint'],
  [['R'], 'refresh'],
  [['Esc'], 'dashboard'],
]

function StatusChip({ status }: { status: OrderSummary['status'] }) {
  const { label, tone } = STATUS_LABEL[status]
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-black tracking-wider whitespace-nowrap uppercase ${TONE[tone]}`}>{label}</span>
}

// ── List (left) ──────────────────────────────────────────────────────────────

function OrderList({ rows, selectedKey, onSelect, onToggle }: { rows: OrderRow[]; selectedKey: string | null; onSelect: (key: string) => void; onToggle: (key: string) => void }) {
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedKey])
  return (
    <aside className="flex w-[44%] max-w-2xl min-w-96 shrink-0 flex-col border-r-2 border-zinc-800 bg-zinc-900" aria-label="Today's bills">
      <div className="grid grid-cols-[4.5rem_3.5rem_minmax(0,1fr)_3rem_7rem_8.5rem] gap-2 border-b border-zinc-800 px-4 py-2 text-[11px] font-bold tracking-widest text-zinc-400 uppercase">
        <span>Bill</span>
        <span>Time</span>
        <span>Who</span>
        <span className="text-right">Btl</span>
        <span className="text-right">Total</span>
        <span className="text-right">Status</span>
      </div>
      {rows.length === 0 && <p className="px-4 py-6 text-center text-zinc-400">No bills match this filter.</p>}
      <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Bills">
        {rows.map((row) => {
          const selected = row.key === selectedKey
          const base = `grid w-full grid-cols-[4.5rem_3.5rem_minmax(0,1fr)_3rem_7rem_8.5rem] items-center gap-2 border-b border-zinc-800 px-4 py-2.5 text-left ${
            selected ? 'bg-amber-400/15 outline-2 -outline-offset-2 outline-amber-400' : 'hover:bg-zinc-800'
          }`
          if (row.kind === 'peak') {
            const g = row.group
            return (
              <li key={row.key} role="option" aria-selected={selected}>
                <button type="button" {...keepFocus} onClick={() => (selected ? onToggle(row.key) : onSelect(row.key))} className={`${base} bg-violet-500/10`}>
                  <span className="flex items-center gap-1 font-bold text-violet-300">
                    {row.expanded ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
                    <Zap className="size-4" aria-hidden />
                  </span>
                  <span className="font-mono text-sm text-zinc-400">{formatTime(new Date(g.lastAt)).slice(0, 5)}</span>
                  <span className="truncate font-semibold">
                    Peak #{g.sessionNo} · {g.sales} bill{g.sales === 1 ? '' : 's'}
                    {g.voided > 0 && <span className="text-rose-300"> · {g.voided} voided</span>}
                  </span>
                  <span className="text-right font-mono text-sm">{g.bottles}</span>
                  <span className="text-right font-mono font-bold tabular-nums">{formatPaise(g.totalPaise)}</span>
                  <span className="text-right">
                    <StatusChip status={g.running ? 'PEAK_PENDING' : 'PEAK_RECONCILED'} />
                  </span>
                </button>
              </li>
            )
          }
          const o = row.order
          return (
            <li key={row.key} role="option" aria-selected={selected}>
              <button type="button" {...keepFocus} onClick={() => onSelect(row.key)} className={`${base} ${row.nested ? 'pl-9' : ''}`}>
                <span className={`font-mono text-lg font-bold ${o.status === 'VOIDED' ? 'text-zinc-500 line-through' : ''}`}>#{o.billNo}</span>
                <span className="font-mono text-sm text-zinc-400">{formatTime(new Date(o.createdAt)).slice(0, 5)}</span>
                <span className="truncate text-sm">
                  {whoLabel(o)}
                  {o.member && <span className="text-zinc-400"> · {o.member.displayName}</span>}
                </span>
                <span className="text-right font-mono text-sm">{o.bottles}</span>
                <span className="text-right font-mono font-bold tabular-nums">{formatPaise(o.status === 'OPEN' && o.duePaise !== o.totalPaise ? o.duePaise : o.totalPaise)}</span>
                <span className="text-right">
                  <StatusChip status={o.status} />
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

// ── Detail (right) ───────────────────────────────────────────────────────────

function BillPanel({
  order,
  detail,
  target,
  onJump,
  onReprint,
}: {
  order: OrderSummary
  detail: OrderDetail | null
  target: JumpTarget | null
  onJump: () => void
  onReprint: () => void
}) {
  const lines = detail ? settlementLines(detail) : []
  return (
    <>
      <div className="flex min-h-16 flex-wrap items-center gap-3 border-b-2 border-zinc-800 bg-zinc-900 px-4 py-2">
        <h2 className="font-mono text-2xl font-black">Bill #{order.billNo}</h2>
        <StatusChip status={order.status} />
        <span className="text-sm text-zinc-400">
          {formatTime(new Date(order.createdAt)).slice(0, 5)} · {order.mode === 'PEAK' ? `Peak #${order.peakSessionNo ?? '?'}` : order.source === 'WAITER_APP' ? 'Captain app' : 'Counter'}
          {order.waiter && ` · ${order.waiter.code} ${order.waiter.displayName}`}
          {detail && ` · by ${detail.cashier}`}
          {order.member && ` · ${order.member.membershipNo} ${order.member.displayName}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" {...keepFocus} onClick={onReprint} className={`flex items-center gap-2 rounded-md border-2 border-zinc-600 px-3 py-1.5 font-bold hover:border-zinc-300 ${FOCUS_RING}`}>
            <Printer className="size-4" aria-hidden /> Reprint <Kbd>F8</Kbd>
          </button>
          {order.status === 'OPEN' && (
            <button
              type="button"
              {...keepFocus}
              onClick={onJump}
              disabled={target?.kind === 'none'}
              title={target?.kind === 'none' ? target.reason : undefined}
              className={`flex items-center gap-2 rounded-md bg-amber-400 px-3 py-1.5 font-black text-zinc-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500 ${FOCUS_RING}`}
            >
              <CornerDownLeft className="size-4" aria-hidden />
              {target?.kind === 'ledger' ? 'Open in Waiter Ledger' : target?.kind === 'none' ? target.reason : 'Jump to bill'} <Kbd>F9</Kbd>
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!detail && <p className="text-zinc-400">Loading bill…</p>}
        {detail && (
          <>
            <table className="w-full text-left">
              <thead className="text-[11px] font-bold tracking-widest text-zinc-400 uppercase">
                <tr className="border-b border-zinc-800">
                  <th className="py-2 pr-2">SKU</th>
                  <th className="py-2 pr-2">Item</th>
                  <th className="py-2 pr-2">Size</th>
                  <th className="py-2 pr-2 text-right">Qty</th>
                  <th className="py-2 pr-2 text-right">Price</th>
                  <th className="py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {detail.detail.items.map((item) => {
                  const cancel = item.quantity < 0
                  return (
                    <tr key={item.id} className={`border-b border-zinc-900 ${cancel ? 'text-rose-300/80' : ''}`}>
                      <td className="py-1.5 pr-2 font-mono text-sm text-zinc-400">{item.skuCode}</td>
                      <td className={`py-1.5 pr-2 ${cancel ? 'line-through' : 'font-semibold'}`}>
                        {item.displayName}
                        {cancel && <span className="ml-2 text-xs no-underline">{item.restock ? 'cancelled' : 'broken — not restocked'}</span>}
                      </td>
                      <td className="py-1.5 pr-2">
                        <SizeChip size={item.sizeCode} />
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono">{item.quantity}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-zinc-300">{formatPaise(item.unitPricePaise)}</td>
                      <td className="py-1.5 text-right font-mono font-bold">{formatPaise(item.lineTotalPaise)}</td>
                    </tr>
                  )
                })}
                {detail.detail.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-zinc-400">
                      Nothing scanned yet.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="pt-3 text-sm text-zinc-400">
                    {order.lines} line{order.lines === 1 ? '' : 's'} · {order.bottles} bottle{order.bottles === 1 ? '' : 's'}
                  </td>
                  <td colSpan={2} className="pt-3 text-right text-sm font-bold tracking-widest text-zinc-400 uppercase">
                    Total
                  </td>
                  <td className="pt-3 text-right font-mono text-2xl font-black">{formatPaise(order.totalPaise)}</td>
                </tr>
              </tfoot>
            </table>

            <h3 className="mt-6 mb-2 text-xs font-bold tracking-widest text-zinc-400 uppercase">Settlement</h3>
            <ul className="flex flex-col gap-1.5">
              {lines.map((line, i) => (
                <li
                  key={i}
                  className={`rounded-md border-l-4 bg-zinc-900 px-3 py-2 ${
                    line.startsWith('Unsettled') ? 'border-amber-400 text-amber-200' : line.startsWith('Voided') ? 'border-rose-500 text-rose-200' : 'border-emerald-500'
                  }`}
                >
                  {line}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  )
}

function PeakGroupPanel({ group, expanded, onToggle }: { group: PeakGroup; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <Zap className="size-10 text-violet-400" aria-hidden />
      <h2 className="text-2xl font-bold">
        Peak #{group.sessionNo} · {formatTime(new Date(group.firstAt)).slice(0, 5)}–{formatTime(new Date(group.lastAt)).slice(0, 5)}
      </h2>
      <p className="text-zinc-300">
        {group.sales} bill{group.sales === 1 ? '' : 's'} · {group.bottles} bottles · <span className="font-mono font-bold">{formatPaise(group.totalPaise)}</span>
        {group.voided > 0 && <span className="text-rose-300"> · {group.voided} voided scan{group.voided === 1 ? '' : 's'}</span>}
      </p>
      <p className="max-w-md text-sm text-zinc-400">
        Peak bills take no tender: the session {group.running ? 'is still running and settles' : 'was settled'} by counting the drawer cash and UPI at its end.
      </p>
      <button type="button" {...keepFocus} onClick={onToggle} className="rounded-md border-2 border-violet-400 px-4 py-2 font-bold text-violet-200 hover:bg-violet-500/10">
        {expanded ? 'Hide' : 'Show'} its bills <Kbd>Enter</Kbd>
      </button>
    </div>
  )
}

function WaiterMenu({
  waiters,
  selectedId,
  onPick,
  onClose,
}: {
  waiters: Array<{ id: string; code: string; displayName: string }>
  selectedId: string | null
  onPick: (id: string | null) => void
  onClose: () => void
}) {
  const options: Array<{ id: string | null; label: string }> = [{ id: null, label: 'Any waiter' }, ...waiters.map((w) => ({ id: w.id, label: `${w.code} ${w.displayName}` }))]
  const [index, setIndex] = useState(() => Math.max(0, options.findIndex((o) => o.id === selectedId)))
  return (
    <Modal
      title="Filter by waiter"
      onClose={onClose}
      width="max-w-sm"
      onKey={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          setIndex((i) => Math.min(options.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1))))
          return true
        }
        if (e.key === 'Enter') {
          onPick(options[index]?.id ?? null)
          return true
        }
        return false
      }}
    >
      <ul className="flex flex-col gap-1" role="listbox" aria-label="Waiters">
        {options.map((o, i) => (
          <li key={o.id ?? 'any'} role="option" aria-selected={i === index}>
            <button
              type="button"
              onClick={() => onPick(o.id)}
              onMouseEnter={() => setIndex(i)}
              className={`w-full rounded-md border-2 px-3 py-2 text-left font-semibold ${i === index ? 'border-amber-400 bg-zinc-800' : 'border-transparent bg-zinc-950'}`}
            >
              {o.label}
            </button>
          </li>
        ))}
      </ul>
      {waiters.length === 0 && <p className="mt-2 text-sm text-zinc-400">No waiter has a bill today.</p>}
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
