import { useRef, useState } from 'react'
import type { Paise, SalesBreakdown } from '../../api/types'
import { Modal } from '../../billing/Modal'
import { EMPTY_TALLY, MAX_REASON, tallyResult, type TallyDirection, type TallyForm } from '../../dayend/tallyForm'
import { formatPaise } from '../../lib/money'
import { RupeeField } from '../RupeeField'
import { Kbd } from '../ui'

const DIRECTIONS: Array<{ id: TallyDirection; label: string }> = [
  { id: 'UPI_TO_CASH', label: 'UPI → Cash' },
  { id: 'CASH_TO_UPI', label: 'Cash → UPI' },
]

interface TallyDialogProps {
  normal: SalesBreakdown['normal']
  busy: boolean
  onConfirm: (cashDelta: Paise, reason: string) => void
  onClose: () => void
}

/**
 * Tally tool: reclassifies normal-bill revenue between Cash and UPI. Total sales can't change; the
 * expected drawer cash moves by the cash side. ↑/↓ switch the direction (←/→ stay with the caret).
 */
export function TallyDialog({ normal, busy, onConfirm, onClose }: TallyDialogProps) {
  const [form, setForm] = useState<TallyForm>(EMPTY_TALLY)
  const [showError, setShowError] = useState(false)
  const reasonRef = useRef<HTMLInputElement>(null)
  const result = tallyResult(normal, form)
  const update = (patch: Partial<TallyForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    setShowError(false)
  }

  const submit = () => {
    if (busy) return
    if (!result.ok) {
      setShowError(true)
      return
    }
    onConfirm(result.cashDeltaPaise, result.reason)
  }

  const toCash = form.direction === 'UPI_TO_CASH'
  const after = result.ok ? result.after : null

  return (
    <Modal
      title="Adjust Cash ⇄ UPI"
      onClose={onClose}
      width="max-w-xl"
      onKey={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          update({ direction: toCash ? 'CASH_TO_UPI' : 'UPI_TO_CASH' })
          return true
        }
        if (e.key === 'F9') {
          submit()
          return true
        }
        return false
      }}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-zinc-400">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> direction · <Kbd>Enter</Kbd> next / save
          </span>
          <button type="button" onClick={submit} disabled={busy} className="rounded-md bg-amber-400 px-5 py-2 font-bold text-zinc-950 disabled:opacity-50 enabled:hover:brightness-110">
            {busy ? 'Saving…' : 'Save adjustment'}
          </button>
        </div>
      }
    >
      <p className="mb-3 text-sm text-zinc-300">
        For a bill keyed as one tender but paid with the other. Total sales stay the same; every adjustment is kept in the audit log.
      </p>
      <dl className="mb-4 grid grid-cols-3 gap-2 rounded-lg border-2 border-zinc-700 bg-zinc-950 p-3 font-mono text-sm tabular-nums">
        <dt className="font-sans text-zinc-500" />
        <dt className="text-right font-sans text-xs font-bold tracking-wider text-zinc-500 uppercase">Now</dt>
        <dt className="text-right font-sans text-xs font-bold tracking-wider text-zinc-500 uppercase">After</dt>
        <dd className="font-sans text-zinc-300">Normal cash</dd>
        <dd className="text-right">{formatPaise(normal.cashPaise)}</dd>
        <dd className="text-right font-bold">{after ? formatPaise(after.cashPaise) : '—'}</dd>
        <dd className="font-sans text-zinc-300">Normal UPI</dd>
        <dd className="text-right">{formatPaise(normal.upiPaise)}</dd>
        <dd className="text-right font-bold">{after ? formatPaise(after.upiPaise) : '—'}</dd>
        <dd className="font-sans text-zinc-300">Total sales</dd>
        <dd className="col-span-2 text-right text-emerald-400">{formatPaise(normal.totalPaise)} — unchanged</dd>
      </dl>

      <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Direction">
        {DIRECTIONS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="radio"
            aria-checked={form.direction === d.id}
            onClick={() => update({ direction: d.id })}
            className={`rounded-md border-2 px-4 py-2.5 font-bold ${form.direction === d.id ? 'border-amber-400 bg-amber-400 text-zinc-950' : 'border-zinc-700 bg-zinc-950 hover:border-zinc-400'}`}
          >
            {d.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <RupeeField label="Amount to move" value={form.amount} onChange={(amount) => update({ amount })} onEnter={() => reasonRef.current?.focus()} dataAutofocus />
        <label className="block">
          <span className="text-sm font-semibold text-zinc-300">Reason (required)</span>
          <input
            ref={reasonRef}
            value={form.reason}
            maxLength={MAX_REASON}
            autoComplete="off"
            placeholder="e.g. Bill #42 keyed as UPI, paid in cash"
            onChange={(e) => update({ reason: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            className="mt-1 w-full rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 py-2 outline-none focus:border-amber-400"
          />
        </label>
      </div>

      {!toCash && result.ok && (
        <p className="mt-3 text-sm font-semibold text-amber-300">
          Lowers expected drawer cash by {formatPaise(-result.cashDeltaPaise)} — check the GPay statement shows this UPI.
        </p>
      )}
      {showError && !result.ok && <p className="mt-3 text-sm font-semibold text-rose-400">{result.error}</p>}
    </Modal>
  )
}
