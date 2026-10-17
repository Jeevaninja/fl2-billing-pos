import { useEffect, useMemo, useRef, useState } from 'react'
import type { BillDetail, CounterTender } from '../api/types'
import { Kbd } from '../components/ui'
import { formatPaise, parseRupeesToPaise } from '../lib/money'
import { Modal } from './Modal'
import { amountKey, moveOption, payOptions, planPayment, type PayOption, type PayPlan } from './payment'

const OPTION_INFO: Record<PayOption, { key: string; label: string; amountLabel?: string }> = {
  cash: { key: 'C', label: 'Cash', amountLabel: 'Cash tendered — optional, Enter settles exact' },
  upi: { key: 'U', label: 'UPI' },
  split: { key: 'S', label: 'Split Cash + UPI', amountLabel: 'Cash part' },
  partial: { key: 'P', label: 'Partial', amountLabel: 'Paid now' },
  credit: { key: 'L', label: 'Collect later' },
}

const BY_KEY: Record<string, PayOption> = { c: 'cash', u: 'upi', s: 'split', p: 'partial', l: 'credit' }

interface PaymentDialogProps {
  detail: BillDetail
  busy: boolean
  onConfirm: (plan: PayPlan) => void
  onClose: () => void
}

export function PaymentDialog({ detail, busy, onConfirm, onClose }: PaymentDialogProps) {
  const options = payOptions(detail)
  const [option, setOption] = useState<PayOption>('cash')
  const [amountText, setAmountText] = useState('')
  const [partialTender, setPartialTender] = useState<CounterTender>('CASH')
  const [showError, setShowError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const info = OPTION_INFO[option]

  const amount = amountText.trim() === '' ? null : parseRupeesToPaise(amountText)
  const invalidAmount = amountText.trim() !== '' && amount === null
  const result = useMemo(() => planPayment(detail, { option, amount, partialTender }), [detail, option, amount, partialTender])

  // Split and Partial need an amount, so their field takes focus. Cash doesn't: Enter settles the
  // exact amount, and digits typed anyway go to the tendered field (see onKey) without focusing it.
  const needsAmount = option === 'split' || option === 'partial'
  useEffect(() => {
    if (needsAmount) inputRef.current?.focus()
    else if (document.activeElement === inputRef.current) inputRef.current?.blur()
  }, [option, needsAmount])

  function choose(next: PayOption) {
    if (!options.includes(next)) return
    setOption(next)
    setAmountText('')
    setShowError(false)
  }

  function confirm() {
    if (busy) return
    if (invalidAmount || !result.ok) {
      setShowError(true)
      return
    }
    onConfirm(result.plan)
  }

  const error = invalidAmount ? 'Enter rupees, e.g. 500 or 499.50' : result.ok ? null : result.error
  const due = detail.duePaise

  return (
    <Modal
      title={`Pay bill #${detail.bill.billNo}`}
      onClose={onClose}
      width="max-w-xl"
      onKey={(e) => {
        const picked = BY_KEY[e.key.toLowerCase()]
        if (picked && !e.ctrlKey && !e.metaKey && !e.altKey) {
          choose(picked)
          return true
        }
        const inField = document.activeElement === inputRef.current
        if (option === 'cash' && !inField && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const typed = amountKey(amountText, e.key)
          if (typed !== null) {
            setAmountText(typed)
            setShowError(false)
            return true
          }
        }
        if (e.key.startsWith('Arrow')) {
          // ←/→ move the caret instead while an amount is typed; ↑/↓ always switch.
          const sideways = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
          if (sideways && amountText !== '' && inField) return false
          if (sideways && amountText !== '') return true // keep a typed tender; ↑/↓ still switch
          const next = moveOption(options, option, e.key)
          if (next !== option) choose(next)
          return true
        }
        if (e.key === 'Enter' || e.key === 'F9') {
          confirm()
          return true
        }
        return false
      }}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-zinc-400">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> method · <Kbd>Enter</Kbd> or <Kbd>F9</Kbd> confirm
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={confirm}
            className="rounded-md bg-emerald-500 px-6 py-3 text-lg font-extrabold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {busy ? 'Saving…' : `Settle ${formatPaise(due)}`}
          </button>
        </div>
      }
    >
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-sm font-bold tracking-widest text-zinc-400 uppercase">Amount due</span>
        <span className="font-mono text-4xl font-black tabular-nums">{formatPaise(due)}</span>
      </div>
      {detail.tenderedPaise > 0n && (
        <p className="-mt-3 mb-4 text-right text-sm text-zinc-400">
          of {formatPaise(detail.bill.totalPaise)}, {formatPaise(detail.tenderedPaise)} already paid
        </p>
      )}

      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Payment option">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={o === option}
            onClick={() => choose(o)}
            className={`flex items-center justify-between rounded-md border-2 px-4 py-3 text-left font-bold ${
              o === option ? 'border-amber-400 bg-amber-400 text-zinc-950' : 'border-zinc-700 bg-zinc-950 hover:border-zinc-400'
            }`}
          >
            {OPTION_INFO[o].label}
            <Kbd>{OPTION_INFO[o].key}</Kbd>
          </button>
        ))}
      </div>

      {info.amountLabel && (
        <label className="mt-5 block">
          <span className="text-sm font-semibold text-zinc-300">{info.amountLabel}</span>
          <div className="mt-1 flex items-center rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 focus-within:border-amber-400">
            <span className="font-mono text-2xl text-zinc-500">₹</span>
            <input
              ref={inputRef}
              inputMode="decimal"
              placeholder={option === 'cash' ? `exact ${formatPaise(due)}` : undefined}
              autoComplete="off"
              value={amountText}
              onChange={(e) => {
                setAmountText(e.target.value.replace(/[^\d.,]/g, ''))
                setShowError(false)
              }}
              className="w-full bg-transparent px-2 py-2 font-mono text-2xl tabular-nums outline-none placeholder:text-zinc-600"
            />
          </div>
        </label>
      )}

      {option === 'partial' && (
        <div className="mt-3 flex gap-2">
          {(['CASH', 'UPI'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setPartialTender(t)}
              className={`rounded-md border-2 px-4 py-2 font-bold ${t === partialTender ? 'border-amber-400 text-amber-300' : 'border-zinc-700'}`}
            >
              Paid now by {t === 'CASH' ? 'Cash' : 'UPI'}
            </button>
          ))}
        </div>
      )}

      <div className="mt-5 min-h-12 rounded-md bg-zinc-950 px-4 py-3 font-mono text-lg">
        {result.ok && result.plan.changePaise > 0n && (
          <span className="font-bold text-emerald-400">Change to return: {formatPaise(result.plan.changePaise)}</span>
        )}
        {result.ok && option === 'split' && result.plan.kind === 'counter' && (
          <span>UPI part: {formatPaise(result.plan.payments[1]?.amount ?? 0n)}</span>
        )}
        {result.ok && option === 'partial' && amount !== null && (
          <span>On credit: {formatPaise(due - amount)}</span>
        )}
        {result.ok && option === 'credit' && <span>All {formatPaise(due)} on {detail.waiter?.displayName ?? 'waiter'}'s account</span>}
        {(showError || invalidAmount) && error && <span className="font-sans text-base font-semibold text-rose-400">{error}</span>}
      </div>
    </Modal>
  )
}
