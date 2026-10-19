import { useCallback, useEffect, useReducer, useRef } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Store, WifiOff } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { Department } from '../api/types'
import { FlashLine } from '../billing/BillingPanels'
import type { Flash } from '../billing/billingReducer'
import { counterErrorMessage } from '../billing/errors'
import { centerFormError, centerFormFor, centerPatch, NEW_CENTER, STATION_LABEL, visibleCenters, type CenterForm } from '../centers/centerForm'
import { beep } from '../lib/beep'
import { departmentChip } from '../lib/departments'
import { FOCUS_RING, keepFocus } from '../lib/ui'
import { CenterModal } from './centers/CenterModal'
import { CenterNote, IconButton } from './settings/SettingsControls'
import { Kbd, LiveClock } from './ui'

interface State {
  load: 'loading' | 'ready' | 'offline'
  departments: Department[]
  showDisabled: boolean
  selectedCode: string | null
  form: CenterForm | null
  saving: boolean
  saveError: string | null
  flash: Flash | null
}

type Action =
  | { type: 'loaded'; departments: Department[] }
  | { type: 'failed'; message: string }
  | { type: 'select'; code: string }
  | { type: 'showDisabled'; on: boolean }
  | { type: 'form'; form: CenterForm | null }
  | { type: 'edit'; patch: Partial<CenterForm> }
  | { type: 'saving'; on: boolean }
  | { type: 'saveError'; message: string }
  | { type: 'flash'; kind: Flash['kind']; text: string }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded': {
      const shown = visibleCenters(action.departments, state.showDisabled)
      const selectedCode = shown.some((d) => d.code === state.selectedCode) ? state.selectedCode : (shown[0]?.code ?? null)
      return { ...state, load: 'ready', departments: action.departments, selectedCode }
    }
    case 'failed':
      return { ...state, load: 'offline', flash: { kind: 'error', text: action.message, seq: (state.flash?.seq ?? 0) + 1 } }
    case 'select':
      return { ...state, selectedCode: action.code }
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

const INITIAL: State = { load: 'loading', departments: [], showDisabled: false, selectedCode: null, form: null, saving: false, saveError: null, flash: null }

/**
 * Settings → Revenue Centers (Phase 22): the manager's list of P&L centers — Liquor (the core bar),
 * Kitchen, Cigarettes, Cool Drinks, … Add, rename, choose where KOTs print (Bar / Kitchen / None) and
 * whether stock is tracked, disable / enable, and set the order. Centers are never deleted.
 */
export default function RevenueCentersSettingsScreen({ onExit }: { onExit: () => void }) {
  const [state, dispatch] = useReducer(reducer, INITIAL)
  const shown = visibleCenters(state.departments, state.showDisabled)
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
      dispatch({ type: 'loaded', departments: await api.listDepartments(true) })
    } catch (err) {
      dispatch({ type: 'failed', message: counterErrorMessage(err) })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(() => {
    const { form, departments, saving } = stateRef.current
    if (!form || saving) return
    const problem = centerFormError(form, departments)
    if (problem) {
      dispatch({ type: 'saveError', message: problem })
      return
    }
    const original = departments.find((d) => d.code === form.code)
    const request = original
      ? (() => {
          const patch = centerPatch(original, form)
          return Object.keys(patch).length === 0 ? Promise.resolve(original) : api.updateDepartment(original.code, patch)
        })()
      : api.createDepartment({ name: form.name, kotStation: form.kotStation, tracksStock: form.tracksStock })
    dispatch({ type: 'saving', on: true })
    request
      .then((saved) => {
        dispatch({ type: 'form', form: null })
        dispatch({ type: 'select', code: saved.code })
        flash('ok', original ? `${saved.name} saved${original.isActive && !saved.isActive ? ' — disabled' : ''}` : `${saved.name} added`)
        void refresh()
      })
      .catch((err: unknown) => dispatch({ type: 'saveError', message: err instanceof ApiError ? err.message : counterErrorMessage(err) }))
  }, [flash, refresh])

  const move = useCallback(
    (code: string, direction: 'up' | 'down') => {
      api
        .updateDepartment(code, { move: direction })
        .then(() => refresh())
        .catch((err: unknown) => flash('error', counterErrorMessage(err)))
    },
    [flash, refresh],
  )

  useEffect(() => {
    if (state.form) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return
      const s = stateRef.current
      const list = visibleCenters(s.departments, s.showDisabled)
      const at = list.findIndex((d) => d.code === s.selectedCode)
      if (event.key === 'Escape') {
        event.preventDefault()
        onExit()
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        const up = event.key === 'ArrowUp'
        const current = list[at]
        if (event.altKey && current) move(current.code, up ? 'up' : 'down')
        else {
          const next = list[Math.min(list.length - 1, Math.max(0, at + (up ? -1 : 1)))]
          if (next) dispatch({ type: 'select', code: next.code })
        }
      } else if (event.key === 'Insert') {
        event.preventDefault()
        dispatch({ type: 'form', form: NEW_CENTER })
      } else if (event.key === 'Enter') {
        const current = list[at]
        if (current && !(event.target instanceof HTMLButtonElement)) {
          event.preventDefault()
          dispatch({ type: 'form', form: centerFormFor(current) })
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state.form, onExit, move])

  const activeCount = state.departments.filter((d) => d.isActive).length
  const editing = state.form?.code ? state.departments.find((d) => d.code === state.form?.code) : undefined

  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b-2 border-amber-400 bg-zinc-900 px-5">
        <button type="button" {...keepFocus} onClick={onExit} className="flex items-center gap-2 rounded px-1 text-zinc-300 hover:text-zinc-50" aria-label="Back to dashboard (Esc)">
          <ArrowLeft className="size-5" aria-hidden />
          <span className="rounded bg-amber-400 px-2 py-0.5 text-lg font-black tracking-tight text-zinc-950">FL2</span>
        </button>
        <h1 className="text-lg font-bold tracking-wide uppercase">Revenue Centers</h1>
        {state.load === 'ready' && (
          <span className="text-sm text-zinc-400">
            {activeCount} active{state.departments.length > activeCount ? ` · ${state.departments.length - activeCount} disabled` : ''}
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
          onClick={() => dispatch({ type: 'form', form: NEW_CENTER })}
          className={`flex min-h-12 items-center gap-2 rounded-lg bg-amber-400 px-5 text-lg font-black text-zinc-950 hover:bg-amber-300 ${FOCUS_RING}`}
        >
          <Plus className="size-5" aria-hidden /> New center <Kbd>Ins</Kbd>
        </button>
        <label className="flex min-h-12 items-center gap-2 rounded-lg border-2 border-zinc-700 px-4 font-semibold">
          <input type="checkbox" checked={state.showDisabled} onChange={(e) => dispatch({ type: 'showDisabled', on: e.target.checked })} className="size-5 accent-amber-400" />
          Show disabled
        </label>
        <p className="text-sm text-zinc-400">Each center gets its own P&amp;L on the Revenue Centers screen. Brands, item categories and expense categories point at one.</p>
        <span className="ml-auto" />
        <FlashLine flash={state.flash} />
      </div>

      {state.load === 'loading' && <CenterNote title="Loading revenue centers…" icon={<Store className="size-10 text-zinc-500" aria-hidden />} />}
      {state.load === 'offline' && state.departments.length === 0 && <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />} />}

      {state.departments.length > 0 && (
        <ul className="min-h-0 flex-1 overflow-y-auto p-5" role="listbox" aria-label="Revenue centers">
          {shown.map((d, i) => {
            const selected = d.code === state.selectedCode
            const activeIndex = d.isActive ? i : -1
            return (
              <li key={d.code} role="option" aria-selected={selected} className="mb-2">
                <div
                  className={`flex min-h-16 items-center gap-4 rounded-lg border-2 px-4 py-2 ${selected ? 'border-amber-400 bg-amber-400/10' : 'border-zinc-800 bg-zinc-900'} ${d.isActive ? '' : 'opacity-60'}`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      dispatch({ type: 'select', code: d.code })
                      dispatch({ type: 'form', form: centerFormFor(d) })
                    }}
                    className="flex min-w-0 flex-1 flex-col text-left"
                  >
                    <span className="flex items-center gap-2 text-lg font-black">
                      <span className={`rounded border px-2 py-0.5 ${departmentChip(d.code)}`}>{d.name}</span>
                      <span className="font-mono text-xs font-normal text-zinc-500">{d.code}</span>
                      {d.code === 'LIQUOR' && <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[11px] font-black text-zinc-200 uppercase">Core</span>}
                      {!d.isActive && <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[11px] font-black text-zinc-200 uppercase">Disabled</span>}
                    </span>
                    <span className="text-sm text-zinc-400">
                      KOT: {STATION_LABEL[d.kotStation]} · {d.tracksStock ? `stock tracked · ${d.onHandQty} on hand` : 'no stock'} · {d.itemCount} item{d.itemCount === 1 ? '' : 's'}
                    </span>
                  </button>
                  {d.isActive && (
                    <span className="flex gap-2">
                      <IconButton label={`Move ${d.name} up`} disabled={activeIndex <= 0} onClick={() => move(d.code, 'up')}>
                        <ArrowUp className="size-5" aria-hidden />
                      </IconButton>
                      <IconButton label={`Move ${d.name} down`} disabled={activeIndex === activeCount - 1} onClick={() => move(d.code, 'down')}>
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
        <CenterModal
          form={state.form}
          original={editing}
          error={state.saveError ?? centerFormError(state.form, state.departments)}
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
