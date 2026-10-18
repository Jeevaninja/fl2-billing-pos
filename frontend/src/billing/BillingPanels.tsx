import type { ReactNode } from 'react'
import { CheckCircle2, CircleAlert, CreditCard, ScanBarcode, UserRound, UsersRound } from 'lucide-react'
import type { BillDetail, MemberSummary, PeakSessionView, SizeCode, WaiterSummary } from '../api/types'
import { Kbd } from '../components/ui'
import { FOCUS_RING, keepFocus } from '../lib/ui'
import type { ScanState } from '../hooks/scanBuffer'
import { formatPaise } from '../lib/money'
import type { Flash, ItemRow, PeakEntry, PendingScan, Receipt } from './billingReducer'
import { TrustBadge } from './PickerDialogs'
import { StartPeakButton } from '../components/peak/PeakControls'

const SIZE_LABEL: Record<SizeCode, string> = { FULL: 'Full', HALF: 'Half', QUARTER: 'Qtr', BEER_650: '650', BEER_330: '330' }

export function SizeChip({ size }: { size: SizeCode }) {
  return <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs font-bold text-zinc-200">{SIZE_LABEL[size]}</span>
}

// ── Scan bar ─────────────────────────────────────────────────────────────────

export function ScanBar({ scan, flash, enabled, qtyLabel }: { scan: ScanState; flash: Flash | null; enabled: boolean; qtyLabel?: string | undefined }) {
  return (
    <div className="flex items-center gap-4 border-b-2 border-zinc-800 bg-zinc-900 px-4 py-3">
      <ScanBarcode className="size-7 shrink-0 text-amber-400" aria-hidden />
      <div
        className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 font-mono text-2xl"
        aria-label="Scan buffer"
        aria-live="off"
      >
        {scan.qtyEdit && (
          <>
            <span className="min-w-0 truncate text-base text-amber-300">Qty · {qtyLabel ?? 'this line'}</span>
            <span className="ml-auto shrink-0 font-sans text-sm whitespace-nowrap text-zinc-400">Enter pay · +/− · Esc cancel</span>
          </>
        )}
        {scan.quantity !== null && <span className="rounded bg-amber-400 px-2 text-lg font-black text-zinc-950">{scan.quantity} ×</span>}
        <span className="truncate">{scan.text}</span>
        {scan.qtyEdit ? null : enabled ? (
          <span className="h-7 w-0.5 animate-pulse bg-amber-400" aria-hidden />
        ) : (
          <span className="text-base text-zinc-500">paused</span>
        )}
        {scan.text === '' && scan.quantity === null && scan.qtyEdit === null && enabled && (
          <span className="truncate text-base whitespace-nowrap text-zinc-500">Scan, or type a SKU code + Enter · 3* = qty 3</span>
        )}
      </div>
      <FlashLine flash={flash} />
    </div>
  )
}

export function FlashLine({ flash }: { flash: Flash | null }) {
  if (!flash) return <div className="w-[38%] shrink-0" />
  const ok = flash.kind === 'ok'
  return (
    <div
      key={flash.seq}
      role={ok ? 'status' : 'alert'}
      className={`flex w-[38%] shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold ${
        ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
      }`}
    >
      {ok ? <CheckCircle2 className="size-5 shrink-0" aria-hidden /> : <CircleAlert className="size-5 shrink-0" aria-hidden />}
      <span className="line-clamp-2">{flash.text}</span>
    </div>
  )
}

// ── Items grid ───────────────────────────────────────────────────────────────

/** The quantity being typed: a fresh value (the row's own) is highlighted, as the next digit replaces it. */
function QtyBox({ edit }: { edit: NonNullable<ScanState['qtyEdit']> }) {
  return (
    <span aria-label={`Quantity ${edit.text || 'blank'}`} className="inline-flex min-w-14 items-center justify-end gap-0.5 rounded border-2 border-amber-400 bg-zinc-950 px-2 py-0.5">
      <span className={edit.fresh ? 'rounded-sm bg-amber-400 px-0.5 text-zinc-950' : ''}>{edit.text}</span>
      <span className="h-6 w-0.5 animate-pulse bg-amber-400" aria-hidden />
    </span>
  )
}

export function ItemsGrid({
  rows,
  pending,
  selectedKey,
  onSelect,
  receipt,
  empty,
  qtyEdit = null,
}: {
  rows: ItemRow[]
  pending: PendingScan[]
  selectedKey: string | null
  onSelect: (key: string) => void
  receipt: Receipt | null
  /** The selected row's quantity being typed (Enter → qty), shown in place of its Qty. */
  qtyEdit?: ScanState['qtyEdit']
  /** Shown instead of the scan hint / receipt when there are no rows. */
  empty?: ReactNode
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 bg-zinc-900 text-xs tracking-widest text-zinc-400 uppercase">
          <tr>
            <th className="w-12 px-4 py-2">#</th>
            <th className="px-2 py-2">SKU</th>
            <th className="px-2 py-2">Item</th>
            <th className="px-2 py-2">Size</th>
            <th className="px-2 py-2 text-right">Qty</th>
            <th className="px-2 py-2 text-right">Price</th>
            <th className="px-4 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody className="text-lg">
          {rows.map((row, i) => {
            const selected = row.key === selectedKey
            return (
              <tr
                key={row.key}
                onClick={() => onSelect(row.key)}
                aria-selected={selected}
                className={`cursor-pointer border-b border-zinc-800 ${selected ? 'bg-amber-400/15 outline-2 -outline-offset-2 outline-amber-400' : 'hover:bg-zinc-900'}`}
              >
                <td className="px-4 py-2.5 font-mono text-zinc-500">{i + 1}</td>
                <td className="px-2 py-2.5 font-mono text-sm text-zinc-400">{row.skuCode}</td>
                <td className="px-2 py-2.5 font-semibold">{row.displayName}</td>
                <td className="px-2 py-2.5">
                  <SizeChip size={row.sizeCode} />
                </td>
                <td className="px-2 py-2.5 text-right font-mono text-xl font-bold tabular-nums">
                  {selected && qtyEdit ? <QtyBox edit={qtyEdit} /> : row.quantity}
                </td>
                <td className="px-2 py-2.5 text-right font-mono text-zinc-300 tabular-nums">{formatPaise(row.unitPricePaise)}</td>
                <td className="px-4 py-2.5 text-right font-mono font-bold tabular-nums">{formatPaise(row.amountPaise)}</td>
              </tr>
            )
          })}
          {pending.map((p) => (
            <tr key={`pending-${p.id}`} className="border-b border-zinc-800 text-zinc-500 italic">
              <td className="px-4 py-2.5">…</td>
              <td className="px-2 py-2.5 font-mono text-sm" colSpan={3}>
                adding {p.code}
              </td>
              <td className="px-2 py-2.5 text-right font-mono">{p.quantity}</td>
              <td colSpan={2} />
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && pending.length === 0 && (empty ?? <EmptyBill receipt={receipt} />)}
    </div>
  )
}

function EmptyBill({ receipt }: { receipt: Receipt | null }) {
  if (receipt) {
    return (
      <div className="m-6 rounded-lg border-2 border-emerald-500/60 bg-emerald-500/10 p-6">
        <p className="text-sm font-bold tracking-widest text-emerald-300 uppercase">Bill #{receipt.billNo} settled</p>
        <p className="mt-2 font-mono text-3xl font-black">{formatPaise(receipt.totalPaise)}</p>
        <p className="mt-1 text-zinc-300">{receipt.summary}</p>
        {receipt.changePaise > 0n && (
          <p className="mt-3 font-mono text-2xl font-bold text-emerald-300">Change: {formatPaise(receipt.changePaise)}</p>
        )}
        <p className="mt-4 text-sm text-zinc-400">Scan the next bottle to start a new bill.</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-2 p-12 text-center text-zinc-500">
      <ScanBarcode className="size-12" aria-hidden />
      <p className="text-lg">Scan a bottle to start the bill</p>
    </div>
  )
}

const FOOTER_KEYS: Record<'NORMAL' | 'PEAK', Array<[string[], string]>> = {
  NORMAL: [
    [['↑', '↓'], 'select'],
    [['+'], 'add one'],
    [['−'], 'remove one'],
    [['Enter'], 'qty → pay'],
    [['F1'], 'new'],
    [['F3'], 'hold · new tab'],
    [['PgUp', 'PgDn'], 'switch tab'],
    [['F2'], 'member'],
    [['F4'], 'waiter'],
    [['F9'], 'pay'],
    [['Esc'], 'dashboard'],
  ],
  PEAK: [
    [['3*'], 'qty prefix'],
    [['Ctrl Z'], 'undo last scan'],
    [['Esc'], 'dashboard'],
  ],
}

export function GridFooter({ mode }: { mode: 'NORMAL' | 'PEAK' }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t-2 border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-300">
      {FOOTER_KEYS[mode].map(([keys, label]) => (
        <span key={label}>
          {keys.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}{' '}
          {label}
        </span>
      ))}
    </div>
  )
}

// ── Side panel (NORMAL) ──────────────────────────────────────────────────────

interface SidePanelProps {
  detail: BillDetail | null
  pendingMember: MemberSummary | null
  pendingWaiter: WaiterSummary | null
  lines: number
  bottles: number
  onMember: () => void
  onWaiter: () => void
  onPay: () => void
  /** Shown when no peak session is running. */
  onStartPeak?: (() => void) | undefined
}

export function SidePanel({ detail, pendingMember, pendingWaiter, lines, bottles, onMember, onWaiter, onPay, onStartPeak }: SidePanelProps) {
  const member = detail?.member ?? pendingMember
  const waiter = detail?.waiter ?? pendingWaiter
  const waiterLocked = (detail?.tenderedPaise ?? 0n) > 0n
  const total = detail?.bill.totalPaise ?? 0n
  const canPay = detail !== null && lines > 0

  return (
    <aside className="flex w-[36%] max-w-md min-w-80 shrink-0 flex-col gap-3 border-l-2 border-zinc-800 bg-zinc-900 p-4" aria-label="Bill details">
      <Card label="Member" shortcut="F2" icon={<UserRound className="size-5" aria-hidden />} onClick={onMember}>
        {member ? (
          <>
            <span className="font-bold">{member.displayName}</span>
            <span className="font-mono text-sm text-zinc-400">{member.membershipNo}</span>
          </>
        ) : (
          <span className="text-zinc-400">Walk-in</span>
        )}
      </Card>

      <Card label="Waiter" shortcut="F4" icon={<UsersRound className="size-5" aria-hidden />} onClick={onWaiter} disabled={waiterLocked}>
        {waiter ? (
          <>
            <span className="flex items-center gap-2">
              <span className="font-bold">{waiter.displayName}</span>
              <TrustBadge trusted={detail?.bill.waiterTrustedAtBilling ?? waiter.isTrusted} />
            </span>
            <span className="font-mono text-sm text-zinc-400">
              Outstanding {formatPaise(waiter.outstandingPaise)}
              {waiter.creditLimitPaise !== null && ` / ${formatPaise(waiter.creditLimitPaise)}`}
            </span>
          </>
        ) : (
          <span className="text-zinc-400">— counter sale</span>
        )}
      </Card>

      <div className="rounded-lg border-2 border-zinc-700 bg-zinc-950 p-4">
        <div className="flex justify-between text-sm text-zinc-400">
          <span>Lines {lines}</span>
          <span>Bottles {bottles}</span>
        </div>
        {detail && detail.tenderedPaise > 0n && (
          <div className="mt-2 flex justify-between font-mono text-sm text-zinc-300">
            <span>Paid</span>
            <span>{formatPaise(detail.tenderedPaise)}</span>
          </div>
        )}
        <div className="mt-2 flex items-baseline justify-between">
          <span className="text-sm font-bold tracking-widest text-zinc-400 uppercase">{detail && detail.tenderedPaise > 0n ? 'Due' : 'Total'}</span>
          <span className="font-mono text-4xl font-black tabular-nums" aria-live="polite">
            {formatPaise(detail ? detail.duePaise : total)}
          </span>
        </div>
      </div>

      {onStartPeak && <StartPeakButton onClick={onStartPeak} className="mt-auto justify-center py-2.5" />}
      <button
        type="button"
        {...keepFocus}
        onClick={onPay}
        disabled={!canPay}
        className={`${onStartPeak ? '' : 'mt-auto '}flex items-center justify-between rounded-lg px-5 py-5 text-2xl font-black disabled:cursor-not-allowed disabled:opacity-40 ${
          canPay ? 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400' : 'bg-zinc-800 text-zinc-400'
        } ${FOCUS_RING}`}
      >
        <span className="flex items-center gap-3">
          <CreditCard className="size-7" aria-hidden /> Pay
        </span>
        <Kbd>F9</Kbd>
      </button>
      <p className="text-center text-xs text-zinc-500">
        {waiter ? (detail?.bill.waiterTrustedAtBilling ?? waiter.isTrusted) ? 'Cash · UPI · Partial · Collect later' : 'Exact Cash or UPI only' : 'Cash · UPI · Split'}
      </p>
    </aside>
  )
}

function Card({
  label,
  shortcut,
  icon,
  onClick,
  disabled = false,
  children,
}: {
  label: string
  shortcut: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      {...keepFocus}
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'Locked after the first payment' : undefined}
      className={`flex items-start gap-3 rounded-lg border-2 border-zinc-700 bg-zinc-950 p-3 text-left hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`}
    >
      <span className="mt-0.5 text-zinc-400">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-bold tracking-widest text-zinc-400 uppercase">{label}</span>
        {children}
      </span>
      <Kbd>{shortcut}</Kbd>
    </button>
  )
}

// ── PEAK mode ────────────────────────────────────────────────────────────────

export function PeakTicker({ ticker, pending }: { ticker: PeakEntry[]; pending: PendingScan[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 bg-zinc-900 text-xs tracking-widest text-zinc-400 uppercase">
          <tr>
            <th className="px-4 py-2">Bill</th>
            <th className="px-2 py-2">Item</th>
            <th className="px-2 py-2">Size</th>
            <th className="px-2 py-2 text-right">Qty</th>
            <th className="px-2 py-2 text-right">Amount</th>
            <th className="px-4 py-2 text-right">Time</th>
          </tr>
        </thead>
        <tbody className="text-lg">
          {pending.map((p) => (
            <tr key={`pending-${p.id}`} className="border-b border-zinc-800 text-zinc-500 italic">
              <td className="px-4 py-2.5">…</td>
              <td className="px-2 py-2.5 font-mono text-sm" colSpan={2}>
                recording {p.code}
              </td>
              <td className="px-2 py-2.5 text-right font-mono">{p.quantity}</td>
              <td colSpan={2} />
            </tr>
          ))}
          {ticker.map((e, i) => (
            <tr key={e.billId} className={`border-b border-zinc-800 ${e.undone ? 'text-zinc-600 line-through' : i === 0 ? 'bg-violet-500/10' : ''}`}>
              <td className="px-4 py-2.5 font-mono">#{e.billNo}</td>
              <td className="px-2 py-2.5 font-semibold">{e.displayName}</td>
              <td className="px-2 py-2.5">
                <SizeChip size={e.sizeCode} />
              </td>
              <td className="px-2 py-2.5 text-right font-mono font-bold">{e.quantity}</td>
              <td className="px-2 py-2.5 text-right font-mono font-bold tabular-nums">{formatPaise(e.amountPaise)}</td>
              <td className="px-4 py-2.5 text-right font-mono text-sm text-zinc-400">
                {new Date(e.at).toLocaleTimeString('en-IN', { hour12: false })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ticker.length === 0 && pending.length === 0 && (
        <div className="flex flex-col items-center gap-2 p-12 text-center text-zinc-500">
          <ScanBarcode className="size-12" aria-hidden />
          <p className="text-lg">Peak mode: every scan is saved as its own bill. No payment screen.</p>
        </div>
      )}
    </div>
  )
}

export function PeakSide({ session, scans, onUndo, canUndo }: { session: PeakSessionView; scans: number; onUndo: () => void; canUndo: boolean }) {
  return (
    <aside className="flex w-[36%] max-w-md min-w-80 shrink-0 flex-col gap-3 border-l-2 border-zinc-800 bg-zinc-900 p-4" aria-label="Peak session">
      <div className="rounded-lg border-2 border-violet-400/60 bg-violet-500/10 p-4">
        <p className="text-xs font-bold tracking-widest text-violet-300 uppercase">Peak session #{session.sessionNo}</p>
        <p className="mt-1 text-sm text-zinc-300">Started {new Date(session.startedAt).toLocaleTimeString('en-IN', { hour12: false })}</p>
        <dl className="mt-3 grid grid-cols-2 gap-y-1 font-mono text-sm">
          <dt className="text-zinc-400">Start cash</dt>
          <dd className="text-right">{formatPaise(session.startCashPaise)}</dd>
          <dt className="text-zinc-400">Start UPI</dt>
          <dd className="text-right">{formatPaise(session.startUpiPaise)}</dd>
        </dl>
      </div>
      <div className="rounded-lg border-2 border-zinc-700 bg-zinc-950 p-4">
        <div className="flex justify-between text-sm text-zinc-400">
          <span>Scans this visit</span>
          <span>{scans}</span>
        </div>
        <div className="mt-2 flex items-baseline justify-between">
          <span className="text-sm font-bold tracking-widest text-zinc-400 uppercase">Expected drawer total</span>
          <span className="font-mono text-3xl font-black tabular-nums">{formatPaise(session.expectedDrawerCashPaise)}</span>
        </div>
        <p className="mt-2 text-xs text-zinc-500">Cash that should be in the till now: start cash + peak sales − in-peak expenses. A sale paid by UPI lowers it; the session still reconciles cash + UPI together when it ends.</p>
      </div>
      <button
        type="button"
        {...keepFocus}
        onClick={onUndo}
        disabled={!canUndo}
        className={`mt-auto flex items-center justify-between rounded-lg border-2 border-zinc-600 px-5 py-4 text-lg font-bold hover:border-zinc-300 disabled:opacity-40 ${FOCUS_RING}`}
      >
        Undo last scan
        <Kbd>Ctrl Z</Kbd>
      </button>
      <p className="text-center text-xs text-zinc-500">Member and waiter tagging are off during peak.</p>
    </aside>
  )
}
