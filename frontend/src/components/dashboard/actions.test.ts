import { describe, expect, it } from 'vitest'
import { ACTIONS, HERO_TILE, MODULE_TILES, SETTINGS_ACTIONS } from './actions'

describe('dashboard tiles (Phase 25, D7)', () => {
  it('puts Billing first as the two-row hero and fills the 5 × 2 grid exactly', () => {
    expect(MODULE_TILES[0]).toBe(HERO_TILE)
    expect(HERO_TILE).toBe('billing')
    const cells = MODULE_TILES.length - 1 + 2 // the hero takes two cells
    expect(cells).toBe(5 * 2)
    expect(cells % 2).toBe(0) // and the 2-column narrow layout
  })

  it('reads row 1 then row 2 the way the plan laid it out, Reports next to Day End', () => {
    expect(MODULE_TILES.slice(1, 5)).toEqual(['captain-orders', 'expense', 'bank-deposit', 'purchase'])
    expect(MODULE_TILES.slice(5)).toEqual(['revenue-centers', 'orders', 'day-end', 'reports'])
  })

  it('moves Reports out of Settings, adds Staff & PINs there, and never lists a screen twice', () => {
    expect(SETTINGS_ACTIONS).not.toContain('reports')
    expect(SETTINGS_ACTIONS).toContain('staff')
    expect(MODULE_TILES.filter((id) => SETTINGS_ACTIONS.includes(id))).toEqual([])
    expect(new Set(MODULE_TILES).size).toBe(MODULE_TILES.length)
    for (const id of [...MODULE_TILES, ...SETTINGS_ACTIONS]) expect(ACTIONS[id].label).toBeTruthy()
  })
})
