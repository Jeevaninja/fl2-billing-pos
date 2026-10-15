import type { Ref } from 'react'
import { parseRupeesToPaise } from '../lib/money'

interface RupeeFieldProps {
  label: string
  value: string
  onChange: (text: string) => void
  onEnter?: () => void
  autoFocus?: boolean
  /** Marks the field for Modal's initial focus. */
  dataAutofocus?: boolean
  inputRef?: Ref<HTMLInputElement>
  /** Larger touch target (Expense screen). */
  size?: 'md' | 'lg'
}

/** Rupee amount input: digits, `.` and `,` only; parsed to paise by the caller (never a float). */
export function RupeeField({ label, value, onChange, onEnter, autoFocus = false, dataAutofocus = false, inputRef, size = 'md' }: RupeeFieldProps) {
  const invalid = value.trim() !== '' && parseRupeesToPaise(value) === null
  return (
    <label className="block">
      <span className="text-sm font-semibold text-zinc-300">{label}</span>
      <div className={`mt-1 flex items-center rounded-md border-2 bg-zinc-950 px-3 focus-within:border-amber-400 ${invalid ? 'border-rose-500' : 'border-zinc-600'}`}>
        <span className="font-mono text-2xl text-zinc-500">₹</span>
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          {...(dataAutofocus ? { 'data-autofocus': true } : {})}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onEnter) {
              e.preventDefault()
              onEnter()
            }
          }}
          className={`w-full bg-transparent px-2 font-mono tabular-nums outline-none ${size === 'lg' ? 'py-4 text-4xl' : 'py-2 text-2xl'}`}
        />
      </div>
      {invalid && <span className="mt-1 block text-sm text-rose-400">Enter rupees, e.g. 1500 or 1,500.50</span>}
    </label>
  )
}
