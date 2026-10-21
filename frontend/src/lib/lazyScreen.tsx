import { lazy, Suspense, type ComponentType } from 'react'
import { LoaderCircle } from 'lucide-react'

/**
 * Phase 25: back-office screens load on first use, so the till starts on a small bundle (the
 * Dashboard and Billing stay in it). A one-line placeholder shows while a screen's chunk arrives.
 */
export function lazyScreen<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  const Lazy = lazy(load)
  function Screen(props: P) {
    return (
      <Suspense
        fallback={
          <div className="flex min-h-screen items-center justify-center gap-2 text-zinc-400">
            <LoaderCircle className="size-5 animate-spin" aria-hidden /> Loading…
          </div>
        }
      >
        <Lazy {...props} />
      </Suspense>
    )
  }
  return Screen
}
