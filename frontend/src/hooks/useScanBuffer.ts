import { useCallback, useEffect, useRef, useState } from 'react'
import { EMPTY_SCAN, scanKey, type ScanEffect, type ScanState } from './scanBuffer'

/** True for elements that take typed text, where the scan buffer must not steal keys. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

/** The row whose quantity Enter may open for editing (normal billing); null when there is none. */
export interface QtyTarget {
  key: string
  quantity: number
}

/**
 * Listens on `window`, so scanning works with no input focused and focus can never be "lost".
 * Yields while `enabled` is false (a dialog is open) or while the user types in a real text field.
 * Returns the buffer for display, and `clear` (e.g. after a search result is tapped). A quantity edit
 * is dropped when the selected row changes, the row goes away, or the buffer is paused.
 * `searchOpen(text)` (Phase 21): whether the screen shows results for that buffer text; while it
 * does, the idle reset is off.
 */
export function useScanBuffer(
  enabled: boolean,
  onEffect: (effect: ScanEffect) => void,
  qty: QtyTarget | null = null,
  searchOpen: (text: string) => boolean = () => false,
): [ScanState, () => void] {
  const [scan, setScan] = useState<ScanState>(EMPTY_SCAN)
  const stateRef = useRef(scan)
  const onEffectRef = useRef(onEffect)
  const qtyRef = useRef(qty)
  const searchRef = useRef(searchOpen)
  useEffect(() => {
    onEffectRef.current = onEffect
    qtyRef.current = qty
    searchRef.current = searchOpen
  })
  const clear = useCallback(() => {
    stateRef.current = EMPTY_SCAN
    setScan(EMPTY_SCAN)
  }, [])

  const qtyKey = enabled ? (qty?.key ?? null) : null
  useEffect(() => {
    if (stateRef.current.qtyEdit === null) return
    stateRef.current = { ...stateRef.current, qtyEdit: null }
    setScan(stateRef.current)
  }, [qtyKey])

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isEditableTarget(event.target)) return
      const result = scanKey(
        stateRef.current,
        { key: event.key, now: event.timeStamp || performance.now(), ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey },
        { qtyTarget: qtyRef.current?.quantity ?? null, searchOpen: searchRef.current(stateRef.current.text) },
      )
      if (result.state !== stateRef.current) {
        stateRef.current = result.state
        setScan(result.state)
      }
      if (!result.handled) return
      event.preventDefault()
      if (result.effect) onEffectRef.current(result.effect)
    }
    // Capture phase: the buffer sees keys before any bubble-phase handler (e.g. Esc → leave screen).
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [enabled])

  return [scan, clear]
}
