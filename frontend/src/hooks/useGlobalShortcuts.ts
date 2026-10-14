import { useEffect, useRef } from 'react'

export type ShortcutKey = 'F1' | 'F2' | 'F9'
export type ShortcutMap = Partial<Record<ShortcutKey, () => void>>

/**
 * Binds function-key shortcuts on `window` for as long as the caller is mounted.
 * Handlers are read through a ref, so passing a fresh object each render does not
 * re-subscribe. Bound keys suppress the browser default (F1 opens help in Chrome)
 * and ignore auto-repeat so a held key fires once.
 */
export function useGlobalShortcuts(map: ShortcutMap): void {
  const mapRef = useRef(map)
  useEffect(() => {
    mapRef.current = map
  })

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const handler = mapRef.current[event.key as ShortcutKey]
      if (!handler) return
      event.preventDefault()
      if (event.repeat) return
      handler()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
