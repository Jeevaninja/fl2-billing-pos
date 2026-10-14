export const FOCUS_RING =
  'outline-none focus-visible:ring-4 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950'

export function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/** Keeps keyboard focus where it is when a button is clicked, so scans keep flowing to the page. */
export const keepFocus = { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() }
