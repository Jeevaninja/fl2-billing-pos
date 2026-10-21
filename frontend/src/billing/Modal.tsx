import { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  title: string
  onClose: () => void
  /** Extra key handling; return true when the key was used. Esc always closes. */
  onKey?: (event: KeyboardEvent) => boolean
  children: ReactNode
  footer?: ReactNode
  width?: string
  /** 'right': a full-height panel that slides in from the right edge (the waiter sidebar). */
  placement?: 'center' | 'right'
}

/**
 * Keyboard-owned dialog. While open it handles keys at the window (capture phase), so its shortcuts
 * work wherever focus is — even after the focused field unmounts. The page's scan buffer and F-keys
 * are disabled meanwhile; closing hands keys back with nothing to refocus.
 */
export function Modal({ title, onClose, onKey, children, footer, width = 'max-w-lg', placement = 'center' }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)
  const handlers = useRef({ onClose, onKey })
  useEffect(() => {
    handlers.current = { onClose, onKey }
  })

  useEffect(() => {
    const target = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current
    target?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        handlers.current.onClose()
      } else if (handlers.current.onKey?.(event)) {
        event.preventDefault()
      } else if (/^F\d+$/.test(event.key)) {
        event.preventDefault() // no browser help/search while a dialog is up
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return (
    <div
      className={`fixed inset-0 z-50 flex bg-black/70 backdrop-blur-[2px] motion-safe:animate-fade-in ${placement === 'right' ? 'justify-end' : 'items-center justify-center p-4'}`}
      onMouseDown={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex w-full ${width} flex-col bg-zinc-900 shadow-dialog outline-none ${
          placement === 'right'
            ? 'h-full border-l border-zinc-700 motion-safe:animate-slide-in-right'
            : 'max-h-full rounded-xl border border-zinc-700 motion-safe:animate-pop-in'
        }`}
      >
        <div className="flex items-center justify-between gap-4 border-b border-zinc-800 px-5 py-3.5">
          <h2 className="text-lg font-bold tracking-tight">{title}</h2>
          <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
            <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">Esc</kbd> to close
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="rounded-b-xl border-t border-zinc-800 bg-zinc-950/40 px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  )
}
