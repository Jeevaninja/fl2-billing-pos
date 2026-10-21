import { useEffect, useRef, useState } from 'react'
import { Zap } from 'lucide-react'
import { api } from '../../api/client'
import type { Paise, PeakReconciliation, PeakSession, PeakSessionView, PeakStartBaseline } from '../../api/types'
import { counterErrorMessage } from '../../billing/errors'
import { Modal } from '../../billing/Modal'
import { formatPaise } from '../../lib/money'
import { FOCUS_RING, keepFocus } from '../../lib/ui'
import { compareReading, describeBaseline, describeVariance, parseReadings, peakSplit, type ReadingComparison } from '../../peak/peakMath'
import { RupeeField } from '../RupeeField'
import { Kbd } from '../ui'

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Persistent strip while a peak session runs; shown on the Dashboard and the Billing screen. */
export function PeakBanner({ session, onEnd }: { session: PeakSessionView; onEnd: () => void }) {
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b-2 border-amber-400 bg-amber-400 px-5 py-2 text-zinc-950">
      <Zap className="size-5 shrink-0" aria-hidden />
      <span className="font-black tracking-widest uppercase">Peak #{session.sessionNo} running</span>
      <span className="font-semibold">
        since {formatClock(session.startedAt)} · expected drawer total <span className="font-mono">{formatPaise(session.expectedDrawerCashPaise)}</span>
      </span>
      <button
        type="button"
        {...keepFocus}
        onClick={onEnd}
        className={`ml-auto flex items-center gap-2 rounded-md bg-zinc-950 px-3 py-1.5 font-bold text-amber-300 hover:bg-zinc-800 ${FOCUS_RING}`}
      >
        End peak session <Kbd>F8</Kbd>
      </button>
    </div>
  )
}

/** The idle-state button that opens PeakStartDialog. */
export function StartPeakButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      {...keepFocus}
      onClick={onClick}
      className={`flex items-center gap-2 rounded-md border-2 border-amber-400 px-3 py-1.5 font-bold text-amber-300 hover:bg-amber-400 hover:text-zinc-950 ${FOCUS_RING} ${className}`}
    >
      <Zap className="size-4" aria-hidden /> Start peak <Kbd>F8</Kbd>
    </button>
  )
}

/** Two drawer readings with Enter moving cash → UPI → submit; optional live comparisons under each. */
function Readings({
  cash,
  upi,
  onCash,
  onUpi,
  onSubmit,
  hints,
}: {
  cash: string
  upi: string
  onCash: (t: string) => void
  onUpi: (t: string) => void
  onSubmit: () => void
  hints?: { cash: ReadingComparison; upi: ReadingComparison }
}) {
  const upiRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex flex-col gap-3">
      <div>
        <RupeeField label="Cash in the drawer now" value={cash} onChange={onCash} onEnter={() => upiRef.current?.focus()} dataAutofocus />
        {hints && <ComparisonHint comparison={hints.cash} />}
      </div>
      <div>
        <RupeeField label="UPI reading now (0 if none)" value={upi} onChange={onUpi} onEnter={onSubmit} inputRef={upiRef} />
        {hints && <ComparisonHint comparison={hints.upi} />}
      </div>
    </div>
  )
}

function ComparisonHint({ comparison }: { comparison: ReadingComparison }) {
  if (comparison.kind === 'none') return <span className="mt-1 block h-5" aria-hidden />
  const tone = comparison.kind === 'match' ? 'text-emerald-400' : comparison.kind === 'short' ? 'text-rose-400' : 'text-amber-300'
  return (
    <span role="status" className={`mt-1 block h-5 text-sm font-semibold ${tone}`}>
      {comparison.label}
    </span>
  )
}

type BaselineState = { kind: 'loading' } | { kind: 'ready'; baseline: PeakStartBaseline } | { kind: 'failed' }

/** The read-only expected figures shown before the cashier counts. */
function ExpectedFigures({ state }: { state: BaselineState }) {
  if (state.kind === 'failed') {
    return <p className="mb-4 rounded-md border-2 border-zinc-700 px-3 py-2 text-sm text-zinc-400">Expected figures unavailable — count and start as usual.</p>
  }
  const b = state.kind === 'ready' ? state.baseline : null
  const terms = b ? describeBaseline(b) : null
  return (
    <dl className="mb-4 flex flex-col gap-2 rounded-lg border-2 border-zinc-700 bg-zinc-950 p-3">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="font-semibold text-zinc-300">Expected cash in drawer</dt>
          <dd className="font-mono text-xl font-black tabular-nums">{b ? formatPaise(b.expectedCashPaise) : '…'}</dd>
        </div>
        {terms && <p className="text-xs text-zinc-500">{terms.cash}</p>}
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="font-semibold text-zinc-300">Expected UPI so far</dt>
          <dd className="font-mono text-xl font-black tabular-nums">{b ? formatPaise(b.expectedUpiPaise) : '…'}</dd>
        </div>
        {terms && <p className="text-xs text-zinc-500">{terms.upi}</p>}
      </div>
    </dl>
  )
}

interface StartProps {
  businessDayId: string
  onStarted: (session: PeakSession) => void
  onClose: () => void
}

/** Declares the drawer cash and UPI readings and starts a peak session. */
export function PeakStartDialog({ businessDayId, onStarted, onClose }: StartProps) {
  const [cash, setCash] = useState('')
  const [upi, setUpi] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [baseline, setBaseline] = useState<BaselineState>({ kind: 'loading' })

  useEffect(() => {
    let live = true
    api
      .peakBaseline()
      .then((b) => live && setBaseline({ kind: 'ready', baseline: b }))
      .catch(() => live && setBaseline({ kind: 'failed' }))
    return () => {
      live = false
    }
  }, [])
  const expected = baseline.kind === 'ready' ? baseline.baseline : null

  const submit = () => {
    if (saving) return
    const readings = parseReadings(cash, upi)
    if (!readings.ok) {
      setError(readings.error)
      return
    }
    setSaving(true)
    api
      .startPeak(businessDayId, readings.cash, readings.upi)
      .then(onStarted)
      .catch((err: unknown) => {
        setError(counterErrorMessage(err))
        setSaving(false)
      })
  }

  return (
    <Modal
      title="Start a peak session"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-zinc-400">
            <Kbd>Enter</Kbd> next / start
          </span>
          <button type="button" onClick={submit} disabled={saving} className="rounded-md bg-amber-400 px-5 py-2 font-bold text-zinc-950 disabled:opacity-50 enabled:hover:brightness-110">
            {saving ? 'Starting…' : 'Start peak'}
          </button>
        </div>
      }
    >
      <p className="mb-4 text-zinc-300">
        During peak every scan is saved as its own bill with no payment screen. The drawer is reconciled against these readings when the session ends.
      </p>
      <ExpectedFigures state={baseline} />
      <Readings
        cash={cash}
        upi={upi}
        onCash={setCash}
        onUpi={setUpi}
        onSubmit={submit}
        hints={{ cash: compareReading(cash, expected?.expectedCashPaise ?? null), upi: compareReading(upi, expected?.expectedUpiPaise ?? null) }}
      />
      {error && <p className="mt-3 text-sm font-semibold text-rose-400">{error}</p>}
    </Modal>
  )
}

interface EndProps {
  session: PeakSessionView
  /** Called as soon as the server has ended the session (refresh context here). */
  onEnded: (result: PeakReconciliation) => void
  onClose: () => void
}

/** Takes the closing readings, ends the session, then shows the reconciliation and its variance. */
export function PeakEndDialog({ session: snapshot, onEnded, onClose }: EndProps) {
  const [cash, setCash] = useState('')
  const [upi, setUpi] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<PeakReconciliation | null>(null)
  // The snapshot can be a poll old: re-read the running session's sales and expected on open.
  const [fresh, setFresh] = useState<PeakSessionView | null>(null)
  useEffect(() => {
    let live = true
    api
      .context()
      .then((c) => live && c.peakSession?.id === snapshot.id && setFresh(c.peakSession))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [snapshot.id])
  const session = fresh ?? snapshot
  const split = peakSplit(session, cash, upi)

  const submit = () => {
    if (saving || result) return
    const readings = parseReadings(cash, upi)
    if (!readings.ok) {
      setError(readings.error)
      return
    }
    setSaving(true)
    api
      .endPeak(session.id, readings.cash, readings.upi)
      .then((r) => {
        setResult(r)
        onEnded(r)
      })
      .catch((err: unknown) => {
        setError(counterErrorMessage(err))
        setSaving(false)
      })
  }

  if (result) {
    const b = result.breakdown
    const v = describeVariance(b.variancePaise)
    const derivedUpi = b.upiDeltaPaise - b.billUpiPaise - b.waiterUpiPaise
    const tone = v.kind === 'short' ? 'text-rose-400' : v.kind === 'over' ? 'text-amber-300' : 'text-emerald-400'
    return (
      <Modal
        title={`Peak #${session.sessionNo} reconciled`}
        onClose={onClose}
        onKey={(e) => {
          if (e.key !== 'Enter') return false
          onClose()
          return true
        }}
        footer={
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="rounded-md bg-emerald-500 px-5 py-2 font-bold text-zinc-950 enabled:hover:brightness-110">
              Done (Enter)
            </button>
          </div>
        }
      >
        <dl className="grid grid-cols-2 gap-y-1 font-mono text-lg">
          <dt className="font-sans text-zinc-300">Expected</dt>
          <dd className="text-right tabular-nums">{formatPaise(b.expectedPaise)}</dd>
          <dt className="font-sans text-zinc-300">Cash change</dt>
          <dd className="text-right tabular-nums">{formatPaise(b.cashDeltaPaise)}</dd>
          <dt className="font-sans text-zinc-300">UPI change</dt>
          <dd className="text-right tabular-nums">{formatPaise(b.upiDeltaPaise)}</dd>
          <dt className="font-sans text-zinc-300">Actual</dt>
          <dd className="text-right tabular-nums">{formatPaise(b.actualPaise)}</dd>
        </dl>
        <SplitLines salesPaise={b.peakBillsPaise} upiPaise={derivedUpi} cashPaise={b.peakBillsPaise - derivedUpi} />
        <div className="mt-4 flex items-baseline justify-between border-t-2 border-zinc-700 pt-3">
          <span className="text-sm font-bold tracking-widest text-zinc-400 uppercase">Variance</span>
          <span className={`font-mono text-3xl font-black ${tone}`}>{v.label}</span>
        </div>
        <p className="mt-3 text-sm text-zinc-400">The counter is back in normal billing. This variance is frozen with the session and shown again at Day End.</p>
      </Modal>
    )
  }

  return (
    <Modal
      title={`End peak session #${session.sessionNo}`}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-zinc-400">
            <Kbd>Enter</Kbd> next / end and reconcile
          </span>
          <button type="button" onClick={submit} disabled={saving} className="rounded-md bg-violet-500 px-5 py-2 font-bold text-zinc-950 disabled:opacity-50 enabled:hover:brightness-110">
            {saving ? 'Ending…' : 'End peak'}
          </button>
        </div>
      }
    >
      <dl className="mb-4 grid grid-cols-2 gap-y-1 font-mono text-sm">
        <dt className="text-zinc-400">Started at</dt>
        <dd className="text-right">{formatClock(session.startedAt)}</dd>
        <dt className="text-zinc-400">Started with cash</dt>
        <dd className="text-right">{formatPaise(session.startCashPaise)}</dd>
        <dt className="text-zinc-400">Started with UPI</dt>
        <dd className="text-right">{formatPaise(session.startUpiPaise)}</dd>
        <dt className="text-zinc-400">Expected drawer total</dt>
        <dd className="text-right">{formatPaise(session.expectedDrawerCashPaise)}</dd>
      </dl>
      <div className="mb-4 flex items-baseline justify-between rounded-lg border-2 border-zinc-700 bg-zinc-950 px-4 py-2">
        <span className="font-semibold text-zinc-300">Total peak sales</span>
        <span className="font-mono text-2xl font-black tabular-nums">{formatPaise(session.runningSalesPaise)}</span>
      </div>
      <Readings cash={cash} upi={upi} onCash={setCash} onUpi={setUpi} onSubmit={submit} />
      <SplitLines
        salesPaise={split.salesPaise}
        upiPaise={split.upiPaise}
        cashPaise={split.cashPaise}
        variancePaise={split.variancePaise}
        inWindowUpiPaise={session.runningInWindowUpiPaise}
      />
      <p className="mt-3 text-sm text-zinc-400">Enter the full drawer and UPI readings, not the difference.</p>
      {error && <p className="mt-3 text-sm font-semibold text-rose-400">{error}</p>}
    </Modal>
  )
}

/**
 * Peak sales split by tender: UPI from the reading (less UPI recorded in the window), cash = sales −
 * UPI, so the two always add up to the sales. Shown live while ending, and on the result.
 */
function SplitLines({
  salesPaise,
  upiPaise,
  cashPaise,
  variancePaise,
  inWindowUpiPaise,
}: {
  salesPaise: Paise
  upiPaise: Paise | null
  cashPaise: Paise | null
  variancePaise?: Paise | null
  inWindowUpiPaise?: Paise
}) {
  const v = variancePaise === undefined || variancePaise === null ? null : describeVariance(variancePaise)
  const tone = v?.kind === 'short' ? 'text-rose-400' : v?.kind === 'over' ? 'text-amber-300' : 'text-emerald-400'
  return (
    <dl className="mt-3 grid grid-cols-2 gap-y-1 rounded-lg bg-zinc-950 px-4 py-2 font-mono text-sm" aria-label="Derived peak split">
      <dt className="font-sans text-zinc-300">Derived peak UPI</dt>
      <dd className="text-right tabular-nums">{upiPaise === null ? <span className="text-zinc-600">type the UPI reading</span> : formatPaise(upiPaise)}</dd>
      <dt className="font-sans text-zinc-300">Derived peak cash</dt>
      <dd className={`text-right tabular-nums ${cashPaise !== null && cashPaise < 0n ? 'text-amber-300' : ''}`}>
        {cashPaise === null ? <span className="text-zinc-600">—</span> : formatPaise(cashPaise)}
      </dd>
      <dt className="font-sans text-xs text-zinc-500">Cash + UPI = peak sales</dt>
      <dd className="text-right text-xs text-zinc-500 tabular-nums">{formatPaise(salesPaise)}</dd>
      {inWindowUpiPaise !== undefined && inWindowUpiPaise !== 0n && (
        <dd className="col-span-2 font-sans text-xs text-zinc-500">
          UPI reading less {formatPaise(inWindowUpiPaise)} taken on bills / repayments during the peak
        </dd>
      )}
      {cashPaise !== null && cashPaise < 0n && (
        <dd className="col-span-2 font-sans text-xs font-semibold text-amber-300">UPI reading is above the peak sales — check it</dd>
      )}
      {v && (
        <>
          <dt className="font-sans text-zinc-300">Variance preview</dt>
          <dd className={`text-right font-bold tabular-nums ${tone}`}>{v.label}</dd>
        </>
      )}
    </dl>
  )
}
