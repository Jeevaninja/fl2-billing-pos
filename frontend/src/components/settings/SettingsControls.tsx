import type { ReactNode } from 'react'
import { FOCUS_RING } from '../../lib/ui'

/** Large touch switch used by the Settings category modals. */
export function Toggle({ on, onClick, title, hint }: { on: boolean; onClick: () => void; title: string; hint: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`hover:border-zinc-500 flex min-h-16 flex-col items-start justify-center rounded-lg border-2 px-4 text-left ${on ? 'border-amber-400 bg-amber-400/15' : 'border-zinc-700 bg-zinc-950'}`}
    >
      <span className="flex items-center gap-2 text-lg font-bold">
        <span className={`inline-block size-4 rounded-full ${on ? 'bg-amber-400' : 'bg-zinc-600'}`} aria-hidden />
        {title}
      </span>
      <span className="text-sm text-zinc-400">{hint}</span>
    </button>
  )
}

export function IconButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex size-12 items-center justify-center rounded-lg border-2 border-zinc-600 hover:border-zinc-300 disabled:cursor-not-allowed disabled:opacity-30 ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}

export function CenterNote({ title, icon }: { title: string; icon: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      {icon}
      <h2 className="text-2xl font-bold">{title}</h2>
    </div>
  )
}
