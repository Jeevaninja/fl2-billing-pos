import { useEffect, useRef, useState } from 'react'
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
 * Returns the buffer for display. A quantity edit is dropped when the selected row changes, the
 * row goes away, or the buffer is paused.
 */
export function useScanBuffer(enabled: boolean, onEffect: (effect: ScanEffect) => void, qty: QtyTarget | null = null): ScanState {
  const [scan, setScan] = useState<ScanState>(EMPTY_SCAN)
  const stateRef = useRef(scan)
  const onEffectRef = useRef(onEffect)
  const qtyRef = useRef(qty)
  useEffect(() => {
    onEffectRef.current = onEffect
    qtyRef.current = qty
  })

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
        { qtyTarget: qtyRef.current?.quantity ?? null },
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

  return scan
}
