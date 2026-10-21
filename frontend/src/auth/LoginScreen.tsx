import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Eye, EyeOff, KeyRound, LoaderCircle, Lock, LogIn, ShieldCheck, Terminal, User } from 'lucide-react'
import { api, ApiError } from '../api/client'
import type { StaffSummary } from '../api/types'
import { buttonClass, FOCUS_RING } from '../lib/ui'
import { BrandMark, LiveClock } from '../components/ui'
import { formatCountdown } from './pinPad'

interface LoginScreenProps {
  /** False until an admin exists: the screen shows how to create one on the till. */
  adminConfigured: boolean
  /** e.g. "Your session ended…" after an expiry. */
  notice: string | null
  onSignedIn: (staff: StaffSummary) => void
}

const FIELD = `h-14 w-full rounded-xl border border-zinc-700 bg-zinc-950 pl-12 pr-4 text-lg text-zinc-50 placeholder:text-zinc-500 hover:border-zinc-500 focus:border-amber-400 ${FOCUS_RING}`

/** Phase 25 (D1): Super Admin sign-in. Nothing of the POS loads until it succeeds. */
export function LoginScreen({ adminConfigured, notice, onSignedIn }: LoginScreenProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lockedUntil, setLockedUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [shake, setShake] = useState(0)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (lockedUntil === null) return
    const timer = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= lockedUntil) {
        setLockedUntil(null)
        setError(null)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [lockedUntil])

  // After a refusal, back to the password — once the render that re-enables the field has happened
  // (focusing a disabled input is a no-op, which used to strand the cashier's next keystrokes).
  useEffect(() => {
    if (shake > 0) passwordRef.current?.focus()
  }, [shake])

  const locked = lockedUntil !== null
  const ready = username.trim() !== '' && password !== '' && !busy && !locked

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const session = await api.login(username, password)
      if (session.authenticated) onSignedIn(session.staff)
    } catch (err) {
      setPassword('')
      setShake((n) => n + 1)
      if (err instanceof ApiError && err.code === 'LOCKED') {
        setLockedUntil(Date.now() + (err.retryAfterSeconds ?? 300) * 1000)
        setNow(Date.now())
        setError('Too many wrong attempts. This account is locked for a few minutes.')
      } else {
        setError(err instanceof ApiError && err.code !== 'NETWORK' ? err.message : 'Cannot reach the POS server. Is the API running?')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-screen overflow-hidden bg-zinc-950">
      {/* Brand panel */}
      <aside className="relative hidden w-[44%] max-w-2xl flex-col justify-between overflow-hidden border-r border-zinc-800 bg-zinc-900 p-10 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_40rem_at_-10%_-10%,rgb(251_191_36/0.16),transparent_60%),radial-gradient(40rem_30rem_at_110%_110%,rgb(16_185_129/0.08),transparent_60%)]"
        />
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgb(255_255_255/0.025)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/0.025)_1px,transparent_1px)] bg-[size:48px_48px]" />
        <div className="relative flex items-center gap-3">
          <BrandMark size="lg" />
          <span className="text-sm font-bold tracking-[0.25em] text-zinc-400 uppercase">Billing &amp; POS</span>
        </div>
        <div className="relative">
          <h1 className="text-5xl leading-[1.05] font-black tracking-tight text-balance text-zinc-50">
            The counter,
            <br />
            <span className="text-amber-400">ready for service.</span>
          </h1>
          <p className="mt-5 max-w-md text-lg text-pretty text-zinc-400">Sealed-bottle billing, peak sessions, waiter ledgers and the day’s statutory reports, on one till.</p>
        </div>
        <div className="relative flex items-center justify-between text-sm text-zinc-400">
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-emerald-400" aria-hidden /> Local till · credentials never leave this machine
          </span>
          <LiveClock />
        </div>
      </aside>

      {/* Sign-in */}
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md motion-safe:animate-pop-in">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark size="lg" />
            <span className="text-sm font-bold tracking-[0.25em] text-zinc-400 uppercase">Billing &amp; POS</span>
          </div>
          <p className="text-xs font-bold tracking-widest text-amber-400 uppercase">Super Admin</p>
          <h2 className="mt-1 text-3xl font-black tracking-tight">Sign in to the till</h2>
          <p className="mt-2 text-zinc-400">The POS stays locked until an admin signs in.</p>

          {notice && (
            <p role="status" className="mt-6 rounded-xl border border-sky-400/40 bg-sky-400/10 px-4 py-3 text-sm font-medium text-sky-100">
              {notice}
            </p>
          )}

          {!adminConfigured && (
            <div className="mt-6 rounded-xl border border-amber-400/40 bg-amber-400/10 p-4 text-sm text-amber-50">
              <p className="flex items-center gap-2 font-bold">
                <Terminal className="size-4 text-amber-300" aria-hidden /> No admin has been set up yet
              </p>
              <p className="mt-1 text-amber-100/80">Stop the API on this machine, run this once, then start the API again:</p>
              <code className="mt-2 block rounded-lg bg-zinc-950/80 px-3 py-2 font-mono text-[13px] text-amber-200">npm run staff -- set-admin &lt;username&gt;</code>
            </div>
          )}

          <form onSubmit={submit} className="mt-8 flex flex-col gap-4" noValidate>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-zinc-300">Username</span>
              <span className="relative">
                <User className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-zinc-500" aria-hidden />
                <input
                  className={FIELD}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  disabled={busy}
                  placeholder="admin"
                />
              </span>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-zinc-300">Password</span>
              <span className="relative">
                <KeyRound className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-zinc-500" aria-hidden />
                <input
                  ref={passwordRef}
                  className={`${FIELD} pr-14`}
                  type={reveal ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={busy}
                  placeholder="••••••••••"
                  aria-invalid={error !== null}
                  aria-describedby={error ? 'login-error' : undefined}
                />
                <button
                  type="button"
                  onClick={() => setReveal((r) => !r)}
                  aria-label={reveal ? 'Hide password' : 'Show password'}
                  aria-pressed={reveal}
                  className={`absolute top-1/2 right-2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 ${FOCUS_RING}`}
                >
                  {reveal ? <EyeOff className="size-5" aria-hidden /> : <Eye className="size-5" aria-hidden />}
                </button>
              </span>
            </label>

            <p
              id="login-error"
              key={shake}
              role={error ? 'alert' : undefined}
              className={`min-h-6 text-sm font-semibold ${locked ? 'text-amber-200' : 'text-rose-300'} ${shake > 0 && error ? 'motion-safe:animate-shake' : ''}`}
            >
              {locked && lockedUntil !== null ? (
                <span className="inline-flex items-center gap-1.5">
                  <Lock className="size-4" aria-hidden /> Locked — try again in {formatCountdown(lockedUntil - now)}
                </span>
              ) : (
                error
              )}
            </p>

            <button type="submit" disabled={!ready} className={`${buttonClass('primary', 'xl')} w-full`}>
              {busy ? <LoaderCircle className="size-6 animate-spin" aria-hidden /> : <LogIn className="size-6" aria-hidden />}
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-8 text-center text-xs text-zinc-500">Forgot the password? Reset it on the till with the same staff command.</p>
        </div>
      </main>
    </div>
  )
}
