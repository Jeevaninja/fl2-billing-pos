import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, Delete, KeyRound, LoaderCircle, Lock, ShieldCheck } from 'lucide-react'
import { api, ApiError } from '../api/client'
import type { StaffSummary } from '../api/types'
import { Modal } from '../billing/Modal'
import { buttonClass, FOCUS_RING } from '../lib/ui'
import { Kbd } from '../components/ui'
import { canSubmit, feedbackFor, formatCountdown, initialPinPad, initials, PIN_MAX, PIN_MIN, pinPadReducer, ROLE_LABEL } from './pinPad'

interface PinPadDialogProps {
  title: string
  /** What is being authorised, shown above the pad (e.g. the opening float). */
  summary: ReactNode
  confirmLabel: string
  /** Resolves when authorised (the parent closes the dialog); rejects with the API's refusal. */
  onAuthorize: (staff: StaffSummary, pin: string) => Promise<void>
  onClose: () => void
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

/**
 * Phase 25 (D5): pick who is authorising, then a numeric keypad. Typing works too: digits, Backspace,
 * Enter; in the picker, 1–9 pick a person. Esc steps back to the picker, then closes.
 */
export function PinPadDialog({ title, summary, confirmLabel, onAuthorize, onClose }: PinPadDialogProps) {
  const [state, dispatch] = useReducer(pinPadReducer, initialPinPad)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    api
      .pinHolders()
      .then((holders) => live.current && dispatch({ type: 'holders', holders }))
      .catch((err: unknown) => live.current && setLoadError(err instanceof ApiError ? err.message : 'cannot load staff'))
    return () => {
      live.current = false
    }
  }, [])

  // Lockout countdown.
  const lockedUntil = state.feedback.kind === 'locked' ? state.feedback.until : null
  useEffect(() => {
    if (lockedUntil === null) return
    const timer = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= lockedUntil) dispatch({ type: 'unlocked' })
    }, 1000)
    return () => clearInterval(timer)
  }, [lockedUntil])

  const submit = useCallback(() => {
    if (!canSubmit(state) || !state.picked) return
    const { picked, digits } = state
    dispatch({ type: 'submit' })
    onAuthorize(picked, digits).catch((err: unknown) => {
      if (!live.current) return
      const e = err instanceof ApiError ? err : { code: 'ERROR', message: 'something went wrong — try again' }
      dispatch({ type: 'failed', feedback: feedbackFor(e, Date.now()) })
      setNow(Date.now())
    })
  }, [state, onAuthorize])

  const back = () => {
    if (state.picked && (state.holders?.length ?? 0) > 1 && !state.busy) dispatch({ type: 'unpick' })
    else if (!state.busy) onClose()
  }

  const onKey = (e: KeyboardEvent): boolean => {
    if (!state.picked) {
      const n = Number(e.key)
      const staff = Number.isInteger(n) && n >= 1 ? state.holders?.[n - 1] : undefined
      if (!staff) return false
      dispatch({ type: 'pick', staff })
      return true
    }
    if (/^\d$/.test(e.key)) dispatch({ type: 'digit', digit: e.key })
    else if (e.key === 'Backspace') dispatch({ type: 'backspace' })
    else if (e.key === 'Delete') dispatch({ type: 'clear' })
    else if (e.key === 'Enter') submit()
    else return false
    return true
  }

  const locked = state.feedback.kind === 'locked'

  return (
    <Modal title={title} onClose={back} onKey={onKey} width="max-w-md">
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm text-zinc-300">{summary}</div>

        {loadError && <p className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-4 py-3 font-semibold text-rose-200">{loadError}</p>}
        {!loadError && state.holders === null && (
          <p className="flex items-center gap-2 py-8 text-zinc-400">
            <LoaderCircle className="size-5 animate-spin" aria-hidden /> Loading staff…
          </p>
        )}
        {state.holders?.length === 0 && (
          <p className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 py-3 text-amber-100">
            No one has a PIN yet. An admin can set one in <strong>Settings → Staff &amp; PINs</strong>.
          </p>
        )}

        {state.holders && state.holders.length > 0 && !state.picked && (
          <section aria-label="Who is authorising?">
            <p className="mb-2 text-xs font-bold tracking-widest text-zinc-400 uppercase">Who is authorising?</p>
            <ul className="grid grid-cols-2 gap-2">
              {state.holders.map((staff, i) => (
                <li key={staff.id}>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'pick', staff })}
                    data-autofocus={i === 0 ? true : undefined}
                    className={`flex w-full items-center gap-3 rounded-xl border border-zinc-700 bg-zinc-850 p-3 text-left hover:-translate-y-0.5 hover:border-amber-400/70 hover:bg-zinc-800 hover:shadow-tile-hover ${FOCUS_RING}`}
                  >
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-amber-400/15 font-black text-amber-300 ring-1 ring-amber-400/40">
                      {initials(staff.displayName)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-bold">{staff.displayName}</span>
                      <span className="block text-xs text-zinc-400">{ROLE_LABEL[staff.role]}</span>
                    </span>
                    {i < 9 && <Kbd>{i + 1}</Kbd>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {state.picked && (
          <section aria-label={`PIN for ${state.picked.displayName}`} className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              {(state.holders?.length ?? 0) > 1 && (
                <button type="button" onClick={back} aria-label="Choose someone else" className={`rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 ${FOCUS_RING}`}>
                  <ChevronLeft className="size-5" aria-hidden />
                </button>
              )}
              <span className="flex size-10 items-center justify-center rounded-full bg-amber-400/15 text-sm font-black text-amber-300 ring-1 ring-amber-400/40">
                {initials(state.picked.displayName)}
              </span>
              <span>
                <span className="block font-bold">{state.picked.displayName}</span>
                <span className="block text-xs text-zinc-400">{ROLE_LABEL[state.picked.role]} · enter your PIN</span>
              </span>
            </div>

            <div key={state.shake} className={`flex justify-center gap-3 py-1 ${state.shake > 0 ? 'motion-safe:animate-shake' : ''}`} aria-live="polite" aria-label={`${state.digits.length} digits entered`}>
              {Array.from({ length: Math.min(PIN_MAX, Math.max(PIN_MIN, state.digits.length)) }, (_, i) => (
                <span
                  key={i}
                  className={`size-4 rounded-full border-2 transition-colors ${i < state.digits.length ? 'border-amber-400 bg-amber-400 shadow-[0_0_12px_rgb(251_191_36/0.6)]' : 'border-zinc-600'}`}
                  aria-hidden
                />
              ))}
            </div>

            <p
              className={`min-h-6 text-center text-sm font-semibold ${state.feedback.kind === 'none' ? 'text-zinc-500' : state.feedback.kind === 'locked' ? 'text-amber-200' : 'text-rose-300'}`}
              role={state.feedback.kind === 'none' ? undefined : 'alert'}
            >
              {state.feedback.kind === 'none' && `${PIN_MIN}–${PIN_MAX} digits`}
              {state.feedback.kind === 'wrong' && state.feedback.message}
              {state.feedback.kind === 'error' && state.feedback.message}
              {state.feedback.kind === 'locked' && (
                <span className="inline-flex items-center gap-1.5">
                  <Lock className="size-4" aria-hidden /> Locked — try again in {formatCountdown(state.feedback.until - now)}
                </span>
              )}
            </p>

            <div className="grid grid-cols-3 gap-2" role="group" aria-label="Keypad">
              {KEYS.map((k) => (
                <PadKey key={k} label={k} disabled={locked || state.busy} onPress={() => dispatch({ type: 'digit', digit: k })}>
                  {k}
                </PadKey>
              ))}
              <PadKey label="Clear" disabled={state.busy || state.digits === ''} onPress={() => dispatch({ type: 'clear' })} subtle>
                <span className="text-sm font-bold tracking-wide uppercase">Clear</span>
              </PadKey>
              <PadKey label="0" disabled={locked || state.busy} onPress={() => dispatch({ type: 'digit', digit: '0' })}>
                0
              </PadKey>
              <PadKey label="Backspace" disabled={state.busy || state.digits === ''} onPress={() => dispatch({ type: 'backspace' })} subtle>
                <Delete className="size-6" aria-hidden />
              </PadKey>
            </div>

            <button type="button" onClick={submit} disabled={!canSubmit(state)} className={`${buttonClass('primary', 'xl')} w-full justify-between`}>
              <span className="flex items-center gap-2">
                {state.busy ? <LoaderCircle className="size-6 animate-spin" aria-hidden /> : <ShieldCheck className="size-6" aria-hidden />}
                {state.busy ? 'Checking…' : confirmLabel}
              </span>
              <Kbd>Enter</Kbd>
            </button>
          </section>
        )}

        <p className="flex items-center gap-1.5 text-xs text-zinc-500">
          <KeyRound className="size-3.5" aria-hidden /> Five wrong PINs lock that person’s PIN for five minutes.
        </p>
      </div>
    </Modal>
  )
}

function PadKey({ label, disabled, onPress, subtle = false, children }: { label: string; disabled: boolean; onPress: () => void; subtle?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onPress}
      // Keep focus off the key so Enter always submits rather than re-pressing the last key.
      onMouseDown={(e) => e.preventDefault()}
      className={`flex h-16 items-center justify-center rounded-xl border font-mono text-2xl font-bold tabular-nums disabled:opacity-30 ${
        subtle ? 'border-transparent bg-transparent text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100' : 'border-zinc-700 bg-zinc-850 hover:border-zinc-500 hover:bg-zinc-800 active:bg-zinc-700'
      } ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}
