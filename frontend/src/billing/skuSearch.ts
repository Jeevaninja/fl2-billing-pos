/**
 * Billing type-to-search (Phase 21), pure. The query is derived from the scan buffer during render;
 * this state only holds the results that came back for a query and the highlighted row, so a slow
 * response for an older query is simply ignored.
 *
 * Enter resolves (BillingScreen.scan): an exact barcode / SKU code wins, else the highlighted result
 * (the first, unless ↑/↓ moved it), else "Not found".
 */
import type { SkuLookup } from '../api/types'

export const MIN_SEARCH_LENGTH = 2
export const SEARCH_LIMIT = 8
export const SEARCH_DEBOUNCE_MS = 120

export interface SkuSearchState {
  /** The query `results` answer. */
  query: string | null
  results: SkuLookup[]
  highlighted: number
}

export const EMPTY_SEARCH: SkuSearchState = { query: null, results: [], highlighted: 0 }

export type SkuSearchAction = { type: 'results'; query: string; results: SkuLookup[] } | { type: 'move'; delta: 1 | -1 }

/** The search a buffer asks for: trimmed, spaces collapsed, lower-cased; null below two characters. */
export function searchQuery(text: string): string | null {
  const query = text.trim().replace(/\s+/g, ' ').toLowerCase()
  return query.length >= MIN_SEARCH_LENGTH ? query : null
}

export function skuSearchReducer(state: SkuSearchState, action: SkuSearchAction): SkuSearchState {
  switch (action.type) {
    case 'results':
      return { query: action.query, results: action.results, highlighted: 0 }
    case 'move': {
      if (state.results.length === 0) return state
      const last = state.results.length - 1
      return { ...state, highlighted: Math.min(last, Math.max(0, state.highlighted + action.delta)) }
    }
  }
}

export interface SearchView {
  query: string | null
  /** Results for the current query; empty while they are loading or when nothing matched. */
  results: SkuLookup[]
  highlighted: number
  loading: boolean
  /** The list is on screen: the scan buffer's idle reset is off. */
  open: boolean
}

/** What the screen shows for the current buffer text. */
export function searchView(state: SkuSearchState, text: string): SearchView {
  const query = searchQuery(text)
  if (query === null) return { query, results: [], highlighted: 0, loading: false, open: false }
  const answered = state.query === query
  const results = answered ? state.results : []
  return { query, results, highlighted: answered ? state.highlighted : 0, loading: !answered, open: true }
}

/** The result Enter adds when the code is no exact match: the highlighted one, if the list answers this code. */
export function highlightedFor(state: SkuSearchState, code: string): SkuLookup | null {
  const query = searchQuery(code)
  if (query === null || state.query !== query) return null
  return state.results[state.highlighted] ?? null
}
