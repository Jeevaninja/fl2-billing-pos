import { useEffect, useState, type ReactNode } from 'react'
import { Clock } from 'lucide-react'
import { formatTime } from '../lib/ui'

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-zinc-500 border-b-2 bg-zinc-800 px-1.5 py-0.5 font-mono text-xs font-bold text-zinc-100">
      {children}
    </kbd>
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
