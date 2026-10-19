import { describe, expect, it } from 'vitest'
import type { SkuLookup } from '../api/types'
import { EMPTY_SEARCH, highlightedFor, searchQuery, searchView, skuSearchReducer } from './skuSearch'

const sku = (id: string, displayName: string): SkuLookup => ({
  id,
  skuCode: id.toUpperCase(),
  barcode: null,
  displayName,
  sizeCode: 'UNIT',
  pricePaise: 100_00n,
  purchasePricePaise: null,
  caseSize: 1,
  onHandQty: 0,
  isActive: true,
  department: 'KITCHEN',
  departmentName: 'Kitchen',
  tracksStock: false,
  itemCategory: { id: 'food', name: 'FOOD' },
})

const RESULTS = [sku('ch65', 'Chicken 65 — Half'), sku('chil', 'Chilli Chicken'), sku('chiv', 'Chivas Regal — Full')]

describe('skuSearch', () => {
  it('derives a query from the buffer: two characters or more, tidied', () => {
    expect(searchQuery('c')).toBeNull()
    expect(searchQuery('  Chi  65 ')).toBe('chi 65')
    expect(searchView(EMPTY_SEARCH, 'c')).toMatchObject({ open: false, loading: false })
    expect(searchView(EMPTY_SEARCH, 'chi')).toMatchObject({ query: 'chi', open: true, loading: true, results: [] })
  })

  it('shows results only for the query they answer, highlights the first, and moves within bounds', () => {
    const state = skuSearchReducer(EMPTY_SEARCH, { type: 'results', query: 'chi', results: RESULTS })
    expect(searchView(state, 'CHI')).toMatchObject({ loading: false, highlighted: 0, results: RESULTS })
    expect(searchView(state, 'chic')).toMatchObject({ loading: true, results: [] }) // an older answer is ignored
    const moved = skuSearchReducer(skuSearchReducer(skuSearchReducer(state, { type: 'move', delta: 1 }), { type: 'move', delta: 1 }), { type: 'move', delta: 1 })
    expect(moved.highlighted).toBe(2)
    expect(skuSearchReducer(moved, { type: 'move', delta: -1 }).highlighted).toBe(1)
    expect(skuSearchReducer(EMPTY_SEARCH, { type: 'move', delta: 1 })).toBe(EMPTY_SEARCH)
  })

  it('gives Enter the highlighted result, only when the list answers that code', () => {
    const state = skuSearchReducer(skuSearchReducer(EMPTY_SEARCH, { type: 'results', query: 'chi', results: RESULTS }), { type: 'move', delta: 1 })
    expect(highlightedFor(state, ' chi ')?.id).toBe('chil')
    expect(highlightedFor(state, 'chiv')).toBeNull()
    expect(highlightedFor(skuSearchReducer(EMPTY_SEARCH, { type: 'results', query: 'zz', results: [] }), 'zz')).toBeNull()
  })
})
