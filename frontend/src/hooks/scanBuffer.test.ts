import { describe, expect, it } from 'vitest'
import { EMPTY_SCAN, IDLE_RESET_MS, scanKey, type ScanInput, type ScanState } from './scanBuffer'

/** Feeds keys one by one (1 ms apart unless given), returning the final state and every effect. */
function feed(keys: Array<string | ScanInput>, start: ScanState = EMPTY_SCAN) {
  let state = start
  let now = 1_000
  const effects: unknown[] = []
  for (const k of keys) {
    const input: ScanInput = typeof k === 'string' ? { key: k, now: (now += 1) } : k
    const result = scanKey(state, input)
    state = result.state
    if (result.effect) effects.push(result.effect)
  }
  return { state, effects }
}

describe('scanKey', () => {
  it('collects a barcode burst and commits it on Enter with quantity 1', () => {
    const { state, effects } = feed([...'8900000000004', 'Enter'])
    expect(effects).toEqual([{ type: 'commit', code: '8900000000004', quantity: 1 }])
    expect(state).toEqual({ ...EMPTY_SCAN, lastAt: state.lastAt })
  })

  it('accepts typed SKU codes containing a hyphen', () => {
    expect(feed([...'hrum-f', 'Enter']).effects).toEqual([{ type: 'commit', code: 'hrum-f', quantity: 1 }])
  })

  it('turns "3*" into a quantity prefix for the next scan, then resets it', () => {
    const { effects } = feed([...'3*', ...'8900000000004', 'Enter', ...'HLAG-330', 'Enter'])
    expect(effects).toEqual([
      { type: 'commit', code: '8900000000004', quantity: 3 },
      { type: 'commit', code: 'HLAG-330', quantity: 1 },
    ])
  })

  it('ignores "*" after non-numeric text or an out-of-range quantity', () => {
    expect(feed([...'AB*']).state).toMatchObject({ text: 'AB', quantity: null })
    expect(feed([...'0*']).state).toMatchObject({ text: '0', quantity: null })
    expect(feed([...'100*']).state).toMatchObject({ text: '100', quantity: null })
    expect(feed([...'99*']).state).toMatchObject({ text: '', quantity: 99 })
  })

  it('edits with Backspace: text first, then the quantity prefix', () => {
    expect(feed([...'2*', ...'AB', 'Backspace']).state).toMatchObject({ text: 'A', quantity: 2 })
    expect(feed([...'2*', 'Backspace']).state).toMatchObject({ text: '', quantity: null })
  })

  it('clears on Escape and reports it as handled; Escape on an empty buffer is not handled', () => {
    const cleared = scanKey({ ...EMPTY_SCAN, text: 'AB', lastAt: 1 }, { key: 'Escape', now: 2 })
    expect(cleared).toMatchObject({ handled: true, state: { text: '', quantity: null } })
    expect(scanKey(EMPTY_SCAN, { key: 'Escape', now: 2 }).handled).toBe(false)
  })

  it('leaves Enter unhandled on an empty buffer so focused buttons still work', () => {
    expect(scanKey(EMPTY_SCAN, { key: 'Enter', now: 1 })).toMatchObject({ handled: false })
    expect(feed(['2', '*', 'Enter']).effects).toEqual([])
  })

  it('drops a stale half-typed buffer after the idle timeout', () => {
    const { effects } = feed([
      { key: '1', now: 1_000 },
      { key: '2', now: 1_001 },
      { key: 'A', now: 1_001 + IDLE_RESET_MS + 1 },
      { key: 'Enter', now: 1_001 + IDLE_RESET_MS + 2 },
    ])
    expect(effects).toEqual([{ type: 'commit', code: 'A', quantity: 1 }])
  })

  it('maps arrows, + and − (empty buffer) to row commands', () => {
    expect(feed(['ArrowUp', 'ArrowDown', '+', '-', 'Delete']).effects).toEqual([
      { type: 'command', command: 'up' },
      { type: 'command', command: 'down' },
      { type: 'command', command: 'increment' },
      { type: 'command', command: 'decrement' },
      { type: 'command', command: 'decrement' },
    ])
  })

  it('ignores modified keys, function keys and spaces', () => {
    for (const input of [
      { key: 'z', now: 1, ctrlKey: true },
      { key: 'r', now: 1, metaKey: true },
      { key: 'a', now: 1, altKey: true },
      { key: 'F2', now: 1 },
      { key: 'Tab', now: 1 },
      { key: ' ', now: 1 },
    ]) {
      expect(scanKey(EMPTY_SCAN, input)).toEqual({ state: EMPTY_SCAN, handled: false })
    }
  })

  it('caps the buffer length', () => {
    const { state } = feed(Array.from({ length: 100 }, () => '9'))
    expect(state.text).toHaveLength(64)
  })
})

describe('scanKey quantity edit (Phase 12)', () => {
  /** Like feed(), with a selected row of `target` bottles (null = nothing editable). */
  function feedQty(keys: string[], target: number | null = 1, start: ScanState = EMPTY_SCAN) {
    let state = start
    let now = 1_000
    const effects: unknown[] = []
    const handled: boolean[] = []
    for (const key of keys) {
      const result = scanKey(state, { key, now: (now += 1) }, { qtyTarget: target })
      state = result.state
      handled.push(result.handled)
      if (result.effect) effects.push(result.effect)
    }
    return { state, effects, handled }
  }

  it('opens the selected row on Enter with an empty buffer, showing its quantity as fresh', () => {
    expect(feedQty(['Enter'], 1).state.qtyEdit).toEqual({ text: '1', fresh: true })
    expect(feedQty(['Enter'], 4).state.qtyEdit).toEqual({ text: '4', fresh: true })
  })

  it('does nothing on an empty Enter when no row can be edited', () => {
    const { state, handled } = feedQty(['Enter'], null)
    expect(state.qtyEdit).toBeNull()
    expect(handled).toEqual([false])
  })

  it('replaces the shown quantity with the first digit, appends the second, and Enter sets it', () => {
    expect(feedQty(['Enter', '2', 'Enter']).effects).toEqual([{ type: 'setQty', quantity: 2 }])
    expect(feedQty(['Enter', '1', '2', 'Enter']).effects).toEqual([{ type: 'setQty', quantity: 12 }])
    const { state } = feedQty(['Enter', '2', 'Enter'])
    expect(state.qtyEdit).toBeNull()
  })

  it('keeps the quantity on Enter, Enter (the fast path to Payment)', () => {
    expect(feedQty(['Enter', 'Enter'], 3).effects).toEqual([{ type: 'setQty', quantity: 3 }])
  })

  it('adjusts with + and −, bounded to 1–99', () => {
    expect(feedQty(['Enter', '+', '+', 'Enter'], 1).effects).toEqual([{ type: 'setQty', quantity: 3 }])
    expect(feedQty(['Enter', '-', '-', 'Enter'], 1).effects).toEqual([{ type: 'setQty', quantity: 1 }])
    expect(feedQty(['Enter', '9', '9', '+', 'Enter'], 1).effects).toEqual([{ type: 'setQty', quantity: 99 }])
  })

  it('edits with Backspace; an emptied field keeps the current quantity', () => {
    expect(feedQty(['Enter', '1', '2', 'Backspace', 'Enter']).effects).toEqual([{ type: 'setQty', quantity: 1 }])
    expect(feedQty(['Enter', 'Backspace', 'Enter'], 5).effects).toEqual([{ type: 'setQty', quantity: 5 }])
  })

  it('reports 0 but keeps the edit open', () => {
    const { state, effects } = feedQty(['Enter', '0', 'Enter'])
    expect(effects).toEqual([{ type: 'setQty', quantity: 0 }])
    expect(state.qtyEdit).toEqual({ text: '0', fresh: false })
  })

  it('cancels on Esc, and ↑ / ↓ / Delete leave the edit and act on the rows', () => {
    expect(feedQty(['Enter', '5', 'Escape']).state).toMatchObject({ qtyEdit: null, text: '' })
    expect(feedQty(['Enter', 'ArrowUp']).effects).toEqual([{ type: 'command', command: 'up' }])
    expect(feedQty(['Enter', 'Delete']).effects).toEqual([{ type: 'command', command: 'decrement' }])
  })

  it('turns a barcode fired mid-edit into a scan, never a quantity', () => {
    const { effects, state } = feedQty(['Enter', ...'8901234567890', 'Enter'])
    expect(effects).toEqual([{ type: 'commit', code: '8901234567890', quantity: 1 }])
    expect(state.qtyEdit).toBeNull()
  })

  it('turns a typed SKU code mid-edit into a scan, keeping the "N*" prefix rule', () => {
    expect(feedQty(['Enter', ...'HWHS-Q', 'Enter']).effects).toEqual([{ type: 'commit', code: 'HWHS-Q', quantity: 1 }])
    expect(feedQty(['Enter', '3', '*', ...'HWHS-Q', 'Enter']).effects).toEqual([{ type: 'commit', code: 'HWHS-Q', quantity: 3 }])
  })

  it('drops the edit when the row goes away and handles the key normally', () => {
    const open = feedQty(['Enter'], 2).state
    const result = scanKey(open, { key: 'A', now: 5_000 }, { qtyTarget: null })
    expect(result.state).toMatchObject({ qtyEdit: null, text: 'A' })
  })

  it('is not reset by the idle timeout while the cashier thinks', () => {
    const open = feedQty(['Enter'], 2).state
    const result = scanKey(open, { key: '3', now: open.lastAt + 10_000 }, { qtyTarget: 2 })
    expect(result.state.qtyEdit).toEqual({ text: '3', fresh: false })
  })
})
