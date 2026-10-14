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
