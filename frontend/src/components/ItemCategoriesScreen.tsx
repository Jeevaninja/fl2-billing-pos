import { useCallback, useEffect, useReducer, useRef } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, LayoutList, Plus, WifiOff } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { ItemCategory, SizeCode } from '../api/types'
import { FlashLine } from '../billing/BillingPanels'
import type { Flash } from '../billing/billingReducer'
import { counterErrorMessage } from '../billing/errors'
import { Modal } from '../billing/Modal'
import { beep } from '../lib/beep'
import { DEPARTMENT_CHIP, DEPARTMENT_NAME, DEPARTMENT_ORDER, FOCUS_RING, keepFocus, SIZE_NAME, SIZE_ORDER } from '../lib/ui'
import {
  itemCategoryFormError,
  itemCategoryFormFor,
  itemCategoryPatch,
  MAX_ITEM_CATEGORY_NAME,
  NEW_ITEM_CATEGORY,
  visibleItemCategories,
  type ItemCategoryForm,
} from '../settings/itemCategoryForm'
import { CenterNote, IconButton, Toggle } from './settings/SettingsControls'
import { Kbd, LiveClock } from './ui'

interface State {
  load: 'loading' | 'ready' | 'offline'
  categories: ItemCategory[]
  showDisabled: boolean
  selectedId: string | null
  form: ItemCategoryForm | null
  saving: boolean
  /** The server's refusal for the open form, cleared by the next edit. */
  saveError: string | null
  flash: Flash | null
}

type Action =
  | { type: 'loaded'; categories: ItemCategory[] }
  | { type: 'failed'; message: string }
  | { type: 'select'; id: string }
  | { type: 'showDisabled'; on: boolean }
  | { type: 'form'; form: ItemCategoryForm | null }
  | { type: 'edit'; patch: Partial<ItemCategoryForm> }
  | { type: 'saving'; on: boolean }
  | { type: 'saveError'; message: string }
  | { type: 'flash'; kind: Flash['kind']; text: string }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded': {
      const shown = visibleItemCategories(action.categories, state.showDisabled)
      const selectedId = shown.some((c) => c.id === state.selectedId) ? state.selectedId : (shown[0]?.id ?? null)
      return { ...state, load: 'ready', categories: action.categories, selectedId }
    }
    case 'failed':
      return { ...state, load: 'offline', flash: { kind: 'error', text: action.message, seq: (state.flash?.seq ?? 0) + 1 } }
    case 'select':
      return { ...state, selectedId: action.id }
    case 'showDisabled':
      return { ...state, showDisabled: action.on }
    case 'form':
      return { ...state, form: action.form, saveError: null, saving: false }
    case 'edit':
      return state.form ? { ...state, form: { ...state.form, ...action.patch }, saveError: null } : state
    case 'saving':
      return { ...state, saving: action.on }
    case 'saveError':
      return { ...state, saving: false, saveError: action.message }
    case 'flash':
      return { ...state, flash: { kind: action.kind, text: action.text, seq: (state.flash?.seq ?? 0) + 1 } }
  }
}

const INITIAL: State = { load: 'loading', categories: [], showDisabled: false, selectedId: null, form: null, saving: false, saveError: null, flash: null }

/**
 * Settings → Item Categories (Phase 20): the groupings the Inventory Catalog lists items under, in
 * stock-report order (FULL, HALF, QUARTER, BEER…). Each suggests a default size and department for
 * new items. Categories are never deleted; one with active items can't be disabled.
 */
export default function ItemCategoriesScreen({ onExit }: { onExit: () => void }) {
  const [state, dispatch] = useReducer(reducer, INITIAL)
  const shown = visibleItemCategories(state.categories, state.showDisabled)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  const flash = useCallback((kind: Flash['kind'], text: string) => {
    beep(kind)
    dispatch({ type: 'flash', kind, text })
  }, [])

  const refresh = useCallback(async () => {
    try {
      dispatch({ type: 'loaded', categories: await api.listItemCategories(true) })
    } catch (err) {
      dispatch({ type: 'failed', message: counterErrorMessage(err) })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(() => {
    const { form, categories, saving } = stateRef.current
    if (!form || saving) return
    const problem = itemCategoryFormError(form, categories)
    if (problem) {
      dispatch({ type: 'saveError', message: problem })
      return
    }
    const original = categories.find((c) => c.id === form.id)
    const request = original
      ? (() => {
          const patch = itemCategoryPatch(original, form)
          return Object.keys(patch).length === 0 ? Promise.resolve(original) : api.updateItemCategory(original.id, patch)
        })()
      : api.createItemCategory({ name: form.name, defaultSizeCode: form.defaultSizeCode, defaultDepartment: form.defaultDepartment })
    dispatch({ type: 'saving', on: true })
    request
      .then((saved) => {
        dispatch({ type: 'form', form: null })
        dispatch({ type: 'select', id: saved.id })
        flash('ok', original ? `${saved.name} saved${original.isActive && !saved.isActive ? ' — disabled' : ''}` : `${saved.name} added`)
        void refresh()
      })
      .catch((err: unknown) => dispatch({ type: 'saveError', message: err instanceof ApiError ? err.message : counterErrorMessage(err) }))
  }, [flash, refresh])

  const move = useCallback(
    (id: string, direction: 'up' | 'down') => {
      api
        .updateItemCategory(id, { move: direction })
        .then(() => refresh())
        .catch((err: unknown) => flash('error', counterErrorMessage(err)))
    },
    [flash, refresh],
  )

  // Keys outside the modal (the Modal owns keys while it is open).
  useEffect(() => {
    if (state.form) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return
      const s = stateRef.current
      const list = visibleItemCategories(s.categories, s.showDisabled)
      const at = list.findIndex((c) => c.id === s.selectedId)
      if (event.key === 'Escape') {
        event.preventDefault()
        onExit()
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        const up = event.key === 'ArrowUp'
        const current = list[at]
        if (event.altKey && current) move(current.id, up ? 'up' : 'down')
        else {
          const next = list[Math.min(list.length - 1, Math.max(0, at + (up ? -1 : 1)))]
          if (next) dispatch({ type: 'select', id: next.id })
        }
      } else if (event.key === 'Insert') {
        event.preventDefault()
        dispatch({ type: 'form', form: NEW_ITEM_CATEGORY })
      } else if (event.key === 'Enter') {
        const current = list[at]
        if (current && !(event.target instanceof HTMLButtonElement)) {
          event.preventDefault()
          dispatch({ type: 'form', form: itemCategoryFormFor(current) })
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state.form, onExit, move])

  const activeCount = state.categories.filter((c) => c.isActive).length
  const editing = state.form?.id ? state.categories.find((c) => c.id === state.form?.id) : undefined

  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b-2 border-amber-400 bg-zinc-900 px-5">
        <button type="button" {...keepFocus} onClick={onExit} className="flex items-center gap-2 rounded px-1 text-zinc-300 hover:text-zinc-50" aria-label="Back to dashboard (Esc)">
          <ArrowLeft className="size-5" aria-hidden />
          <span className="rounded bg-amber-400 px-2 py-0.5 text-lg font-black tracking-tight text-zinc-950">FL2</span>
        </button>
        <h1 className="text-lg font-bold tracking-wide uppercase">Item Categories</h1>
        {state.load === 'ready' && (
          <span className="text-sm text-zinc-400">
            {activeCount} active{state.categories.length > activeCount ? ` · ${state.categories.length - activeCount} disabled` : ''}
          </span>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm">
          <LiveClock />
          <span className="flex items-center gap-1 text-zinc-400">
            <Kbd>Esc</Kbd> Dashboard
          </span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3 border-b-2 border-zinc-800 bg-zinc-900 px-5 py-3">
        <button
          type="button"
          onClick={() => dispatch({ type: 'form', form: NEW_ITEM_CATEGORY })}
          className={`flex min-h-12 items-center gap-2 rounded-lg bg-amber-400 px-5 text-lg font-black text-zinc-950 hover:bg-amber-300 ${FOCUS_RING}`}
        >
          <Plus className="size-5" aria-hidden /> New category <Kbd>Ins</Kbd>
        </button>
        <label className="flex min-h-12 items-center gap-2 rounded-lg border-2 border-zinc-700 px-4 font-semibold">
          <input type="checkbox" checked={state.showDisabled} onChange={(e) => dispatch({ type: 'showDisabled', on: e.target.checked })} className="size-5 accent-amber-400" />
          Show disabled
        </label>
        <p className="text-sm text-zinc-400">The Inventory Catalog lists items under these headers, in this order — like the stock report.</p>
        <span className="ml-auto" />
        <FlashLine flash={state.flash} />
      </div>

      {state.load === 'loading' && <CenterNote title="Loading categories…" icon={<LayoutList className="size-10 text-zinc-500" aria-hidden />} />}
      {state.load === 'offline' && state.categories.length === 0 && <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />} />}

      {state.categories.length > 0 && (
        <ul className="min-h-0 flex-1 overflow-y-auto p-5" role="listbox" aria-label="Item categories">
          {shown.map((c, i) => {
            const selected = c.id === state.selectedId
            const activeIndex = c.isActive ? i : -1
            return (
              <li key={c.id} role="option" aria-selected={selected} className="mb-2">
                <div
                  className={`flex min-h-16 items-center gap-4 rounded-lg border-2 px-4 py-2 ${selected ? 'border-amber-400 bg-amber-400/10' : 'border-zinc-800 bg-zinc-900'} ${c.isActive ? '' : 'opacity-60'}`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      dispatch({ type: 'select', id: c.id })
                      dispatch({ type: 'form', form: itemCategoryFormFor(c) })
                    }}
                    className="flex min-w-0 flex-1 flex-col text-left"
                  >
                    <span className="flex items-center gap-2 text-lg font-black tracking-wide uppercase">
                      {c.name}
                      <span className={`rounded border px-1.5 py-0.5 text-[11px] font-black ${DEPARTMENT_CHIP[c.defaultDepartment]}`}>{DEPARTMENT_NAME[c.defaultDepartment]}</span>
                      {!c.isActive && <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[11px] font-black text-zinc-200">Disabled</span>}
                    </span>
                    <span className="text-sm text-zinc-400">
                      {c.itemCount === 0
                        ? 'No items yet'
                        : `${c.itemCount} item${c.itemCount === 1 ? '' : 's'}${c.defaultDepartment === 'KITCHEN' ? '' : ` · ${c.onHandQty} on hand`}`}{' '}
                      · default size{' '}
                      {c.defaultSizeCode ? SIZE_NAME[c.defaultSizeCode] : 'ask each time'}
                    </span>
                  </button>
                  {c.isActive && (
                    <span className="flex gap-2">
                      <IconButton label={`Move ${c.name} up`} disabled={activeIndex <= 0} onClick={() => move(c.id, 'up')}>
                        <ArrowUp className="size-5" aria-hidden />
                      </IconButton>
                      <IconButton label={`Move ${c.name} down`} disabled={activeIndex === activeCount - 1} onClick={() => move(c.id, 'down')}>
                        <ArrowDown className="size-5" aria-hidden />
                      </IconButton>
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t-2 border-zinc-800 bg-zinc-900 px-5 py-2 text-sm text-zinc-300">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> select
        </span>
        <span>
          <Kbd>Alt ↑</Kbd>
          <Kbd>Alt ↓</Kbd> reorder
        </span>
        <span>
          <Kbd>Enter</Kbd> edit
        </span>
        <span>
          <Kbd>Ins</Kbd> new
        </span>
        <span>
          <Kbd>Esc</Kbd> dashboard
        </span>
      </div>

      {state.form && (
        <CategoryModal
          form={state.form}
          original={editing}
          error={state.saveError ?? itemCategoryFormError(state.form, state.categories)}
          showError={state.saveError !== null}
          saving={state.saving}
          onEdit={(patch) => dispatch({ type: 'edit', patch })}
          onSave={save}
          onClose={() => dispatch({ type: 'form', form: null })}
        />
      )}
    </div>
  )
}

function CategoryModal({
  form,
  original,
  error,
  showError,
  saving,
  onEdit,
  onSave,
  onClose,
}: {
  form: ItemCategoryForm
  original: ItemCategory | undefined
  error: string | null
  showError: boolean
  saving: boolean
  onEdit: (patch: Partial<ItemCategoryForm>) => void
  onSave: () => void
  onClose: () => void
}) {
  const disabling = original?.isActive === true && !form.isActive
  const sizes: Array<SizeCode | null> = [...SIZE_ORDER, null]
  return (
    <Modal
      title={original ? `Edit ${original.name}` : 'New item category'}
      onClose={onClose}
      onKey={(e) => {
        if (e.key === 'Enter' || e.key === 'F9') {
          onSave()
          return true
        }
        return false
      }}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className={`text-sm ${error ? 'text-amber-300' : 'text-zinc-400'}`}>{error ?? 'Enter or F9 saves · Esc cancels'}</span>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || error !== null}
            className={`min-h-12 rounded-lg px-6 text-lg font-black text-zinc-950 disabled:opacity-50 ${disabling ? 'bg-rose-500' : 'bg-emerald-500'}`}
          >
            {saving ? 'Saving…' : disabling ? 'Disable & save' : original ? 'Save' : 'Add category'}
          </button>
        </div>
      }
    >
      <label className="block">
        <span className="text-sm font-semibold text-zinc-300">Name (shown as the catalog header)</span>
        <input
          data-autofocus
          value={form.name}
          maxLength={MAX_ITEM_CATEGORY_NAME + 10}
          autoComplete="off"
          onChange={(e) => onEdit({ name: e.target.value })}
          placeholder="e.g. QUARTER, CIGARETTES"
          className={`mt-1 w-full rounded-md border-2 bg-zinc-950 px-4 py-4 text-2xl uppercase outline-none focus:border-amber-400 ${showError ? 'border-rose-500' : 'border-zinc-600'}`}
        />
      </label>
      <div className="mt-4">
        <span className="text-sm font-semibold text-zinc-300">Default size for new items</span>
        <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label="Default size">
          {sizes.map((size) => (
            <button
              key={size ?? 'ASK'}
              type="button"
              role="radio"
              aria-checked={form.defaultSizeCode === size}
              onClick={() => onEdit({ defaultSizeCode: size })}
              className={`min-h-12 rounded-lg border-2 px-4 font-bold ${form.defaultSizeCode === size ? 'border-teal-400 bg-teal-400 text-zinc-950' : 'border-zinc-700 bg-zinc-950 text-zinc-300'} ${FOCUS_RING}`}
            >
              {size ? SIZE_NAME[size] : 'Ask each time'}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4">
        <span className="text-sm font-semibold text-zinc-300">Default department for new brands</span>
        <div className="mt-1 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Default department">
          {DEPARTMENT_ORDER.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={form.defaultDepartment === d}
              onClick={() => onEdit({ defaultDepartment: d })}
              className={`min-h-14 rounded-lg border-2 px-3 text-lg font-bold ${form.defaultDepartment === d ? DEPARTMENT_CHIP[d] : 'border-zinc-700 bg-zinc-950 text-zinc-300'} ${FOCUS_RING}`}
            >
              {DEPARTMENT_NAME[d]}
            </button>
          ))}
        </div>
      </div>
      {original && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Toggle on={form.isActive} onClick={() => onEdit({ isActive: !form.isActive })} title={form.isActive ? 'Active' : 'Disabled'} hint="Listed in the catalog and the New Item form" />
        </div>
      )}
      {disabling && (
        <p className="mt-4 rounded-md border-l-4 border-rose-500 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">Hidden from the catalog and the New Item form.</p>
      )}
      {original && original.name !== form.name.trim() && original.itemCount > 0 && (
        <p className="mt-3 text-sm text-zinc-400">
          Renaming changes the header over its {original.itemCount} item{original.itemCount === 1 ? '' : 's'}; item names and bills are unchanged.
        </p>
      )}
    </Modal>
  )
}
