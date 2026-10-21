import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Clock } from 'lucide-react'
import { badgeClass, buttonClass, type BadgeTone, type ButtonSize, type ButtonVariant, formatTime } from '../lib/ui'

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-6 items-center justify-center rounded-md border border-zinc-600 border-b-[3px] bg-zinc-800 px-1.5 py-0.5 font-mono text-xs leading-none font-bold text-zinc-100">
      {children}
    </kbd>
  )
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

/** Phase 25 shared button: primary (amber), secondary, success, danger, ghost. */
export function Button({ variant = 'secondary', size = 'md', className = '', type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={`${buttonClass(variant, size)} ${className}`} {...props} />
}

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={badgeClass(tone)}>{children}</span>
}

/** The FL2 wordmark used on the sign-in screen and app headers. */
export function BrandMark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span
      className={`inline-flex items-center rounded-md bg-amber-400 font-black tracking-tight text-zinc-950 shadow-[0_1px_0_0_rgb(255_255_255/0.4)_inset] ${size === 'lg' ? 'px-3 py-1 text-3xl' : 'px-2 py-0.5 text-lg'}`}
    >
      FL2
    </span>
  )
}

/** Isolated so the per-second tick only re-renders the clock. */
export function LiveClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="flex items-center gap-1.5 font-mono text-base font-semibold tabular-nums">
      <Clock className="size-4 text-zinc-400" aria-hidden />
      {formatTime(now)}
    </span>
  )
}
