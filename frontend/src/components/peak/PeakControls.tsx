import { useRef, useState } from 'react'
import { Zap } from 'lucide-react'
import { api } from '../../api/client'
import type { PeakReconciliation, PeakSession, PeakSessionView } from '../../api/types'
import { counterErrorMessage } from '../../billing/errors'
import { Modal } from '../../billing/Modal'
import { formatPaise } from '../../lib/money'
import { FOCUS_RING, keepFocus } from '../../lib/ui'
import { describeVariance, parseReadings } from '../../peak/peakMath'
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
        since {formatClock(session.startedAt)} · expected so far <span className="font-mono">{formatPaise(session.runningExpectedPaise)}</span>
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

/** Two drawer readings with Enter moving cash → UPI → submit. */
function Readings({ cash, upi, onCash, onUpi, onSubmit }: { cash: string; upi: string; onCash: (t: string) => void; onUpi: (t: string) => void; onSubmit: () => void }) {
  const upiRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex flex-col gap-3">
      <RupeeField label="Cash in the drawer now" value={cash} onChange={onCash} onEnter={() => upiRef.current?.focus()} dataAutofocus />
      <RupeeField label="UPI reading now (0 if none)" value={upi} onChange={onUpi} onEnter={onSubmit} inputRef={upiRef} />
    </div>
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
          <button type="button" onClick={submit} disabled={saving} className="rounded-md bg-amber-400 px-5 py-2 font-bold text-zinc-950 disabled:opacity-50">
            {saving ? 'Starting…' : 'Start peak'}
          </button>
        </div>
      }
    >
      <p className="mb-4 text-zinc-300">
        During peak every scan is saved as its own bill with no payment screen. The drawer is reconciled against these readings when the session ends.
      </p>
      <Readings cash={cash} upi={upi} onCash={setCash} onUpi={setUpi} onSubmit={submit} />
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
export function PeakEndDialog({ session, onEnded, onClose }: EndProps) {
  const [cash, setCash] = useState('')
  const [upi, setUpi] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<PeakReconciliation | null>(null)

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
            <button type="button" onClick={onClose} className="rounded-md bg-emerald-500 px-5 py-2 font-bold text-zinc-950">
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
          <button type="button" onClick={submit} disabled={saving} className="rounded-md bg-violet-500 px-5 py-2 font-bold text-zinc-950 disabled:opacity-50">
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
        <dt className="text-zinc-400">Expected so far</dt>
        <dd className="text-right">{formatPaise(session.runningExpectedPaise)}</dd>
      </dl>
      <Readings cash={cash} upi={upi} onCash={setCash} onUpi={setUpi} onSubmit={submit} />
      <p className="mt-3 text-sm text-zinc-400">Enter the full drawer and UPI readings, not the difference.</p>
      {error && <p className="mt-3 text-sm font-semibold text-rose-400">{error}</p>}
    </Modal>
  )
}
