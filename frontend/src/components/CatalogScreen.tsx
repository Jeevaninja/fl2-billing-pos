import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react'
import { ArrowLeft, Pencil, Plus, RefreshCw, Search, WifiOff } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { CatalogItem, Department, DepartmentCode, ItemCategory } from '../api/types'
import { FlashLine } from '../billing/BillingPanels'
import { counterErrorMessage } from '../billing/errors'
import { Modal } from '../billing/Modal'
import {
  catalogReducer,
  catalogRows,
  conflictField,
  deactivates,
  effectiveDepartment,
  existingBrand,
  formError,
  initialCatalogState,
  itemPatch,
  newItemPayload,
  selectedItem,
  sizeChoices,
  skuCodePreview,
  type CatalogState,
  type ConflictField,
  type EditItemForm,
  type ItemField,
  type ItemForm,
  type NewItemForm,
} from '../catalog/catalogReducer'
import { beep } from '../lib/beep'
import { formatPaise } from '../lib/money'
import { departmentChip, departmentName } from '../lib/departments'
import { FOCUS_RING, keepFocus, sizeNameFor } from '../lib/ui'
import { Kbd, LiveClock } from './ui'

interface CatalogScreenProps {
  onExit: () => void
}

const GRID = 'grid grid-cols-[7.5rem_1fr_9rem_8rem_8rem_4.5rem_6.5rem_6rem_3.5rem] items-center gap-3'

/**
 * Inventory Catalog (Phase 20): items listed under their item category, like the TASMAC / FL2 stock
 * report — a FULL header with every 750 ml brand, then HALF, QUARTER, BEER… Search filters every
 * category at once. Ins adds an item straight into a category; Enter edits the highlighted one.
 * Nothing is deleted: an item is deactivated instead. Stock changes only through Purchase (GRN),
 * apart from an optional opening stock when an item is created.
 */
export default function CatalogScreen({ onExit }: CatalogScreenProps) {
  const [state, dispatch] = useReducer(catalogReducer, initialCatalogState)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  const flash = useCallback((kind: 'ok' | 'error', text: string) => {
    beep(kind)
    dispatch({ type: 'flash', kind, text })
  }, [])

  const load = useCallback(async () => {
    try {
      const [items, categories, departments] = await Promise.all([api.listItems(), api.listItemCategories(true), api.listDepartments(true)])
      dispatch({ type: 'loaded', items, categories, departments })
    } catch (err) {
      dispatch({ type: 'failed', message: counterErrorMessage(err) })
    }
  }, [])

  useEffect(() => {
    void load()
    searchRef.current?.focus()
  }, [load])

  const highlighted = selectedItem(state)
  // Keep the highlighted row in view as ↑/↓ move it.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [highlighted?.id])

  const save = useCallback(async () => {
    const current = stateRef.current
    const form = current.form
    if (!form || current.submitting) return
    const error = formError(current, form)
    if (error) {
      flash('error', error)
      return
    }
    let request: Promise<CatalogItem>
    let done: (item: CatalogItem) => string
    if (form.kind === 'new') {
      const payload = newItemPayload(form, current.items, current.categories)
      if (typeof payload === 'string') return
      request = api.createItem(payload)
      done = (item) =>
        `Added ${item.displayName} to ${item.itemCategory.name}${
          !item.tracksStock ? ' · Kitchen items sell without stock' : payload.openingQty ? ` · ${payload.openingQty} opening stock` : ' · receive stock through Purchase'
        }`
    } else {
      const patch = itemPatch(form, current.categories)
      if (typeof patch === 'string' || Object.keys(patch).length === 0) {
        dispatch({ type: 'close' })
        return
      }
      request = api.updateItem(form.item.id, patch)
      done = (item) => (patch.isActive === false ? `Deactivated ${item.displayName}` : `Saved ${item.displayName}`)
    }
    dispatch({ type: 'submitting', on: true })
    try {
      const item = await request
      beep('ok')
      dispatch({ type: 'saved', item, text: done(item) })
      void load() // brand renames and category counts touch other rows
      searchRef.current?.focus()
    } catch (err) {
      beep('error')
      const field = err instanceof ApiError && err.code === 'PS012' ? conflictField(err.constraint) : null
      dispatch({ type: 'conflict', field, message: counterErrorMessage(err) })
    }
  }, [flash, load])

  // Page keys (the form's modal owns the keyboard while open).
  const formOpen = state.form !== null
  useEffect(() => {
    if (formOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const current = stateRef.current
      if (current.load !== 'ready') {
        if (event.key === 'Escape') onExit()
        return
      }
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          event.preventDefault()
          dispatch({ type: 'move', delta: event.key === 'ArrowDown' ? 1 : -1 })
          return
        case 'Enter':
          if (event.target instanceof HTMLButtonElement) return
          event.preventDefault()
          dispatch({ type: 'openSelected' })
          return
        case 'Insert':
          event.preventDefault()
          dispatch({ type: 'openNew' })
          return
        case 'Escape':
          event.preventDefault()
          if (current.query !== '') dispatch({ type: 'query', text: '' })
          else onExit()
          return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [formOpen, onExit])

  const rows = catalogRows(state)
  const itemCount = rows.filter((r) => r.kind === 'item').length
  const categoryCount = rows.filter((r) => r.kind === 'header').length

  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b-2 border-amber-400 bg-zinc-900 px-5">
        <button
          type="button"
          {...keepFocus}
          onClick={onExit}
          className="flex items-center gap-2 rounded px-1 text-zinc-300 hover:text-zinc-50"
          aria-label="Back to dashboard (Esc)"
        >
          <ArrowLeft className="size-5" aria-hidden />
          <span className="rounded bg-amber-400 px-2 py-0.5 text-lg font-black tracking-tight text-zinc-950">FL2</span>
        </button>
        <h1 className="text-lg font-bold tracking-wide uppercase">Inventory Catalog</h1>
        {state.load === 'ready' && (
          <span className="rounded bg-teal-400 px-2.5 py-1 text-sm font-black tracking-widest text-zinc-950 uppercase">
            {itemCount} item{itemCount === 1 ? '' : 's'} · {categoryCount} categor{categoryCount === 1 ? 'y' : 'ies'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm">
          <LiveClock />
          <span className="flex items-center gap-1 text-zinc-400">
            <Kbd>Esc</Kbd> Dashboard
          </span>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b-2 border-zinc-800 bg-zinc-900 px-5 py-3">
        <label className="flex w-full max-w-md items-center rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 focus-within:border-amber-400">
          <Search className="size-5 shrink-0 text-zinc-400" aria-hidden />
          <input
            ref={searchRef}
            value={state.query}
            autoComplete="off"
            aria-label="Search items by name, SKU code or barcode"
            placeholder="Search name, SKU code or barcode"
            onChange={(e) => dispatch({ type: 'query', text: e.target.value })}
            className="w-full bg-transparent px-2 py-2.5 text-lg outline-none"
          />
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-zinc-300 select-none">
          <input
            type="checkbox"
            checked={state.includeInactive}
            onChange={(e) => dispatch({ type: 'includeInactive', on: e.target.checked })}
            className="size-5 accent-amber-400"
          />
          Show inactive
        </label>
        <FlashLine flash={state.flash} />
        <button
          type="button"
          onClick={() => dispatch({ type: 'openNew' })}
          className={`ml-auto flex min-h-12 items-center gap-3 rounded-lg bg-teal-400 px-5 text-lg font-black text-zinc-950 hover:bg-teal-300 ${FOCUS_RING}`}
        >
          <Plus className="size-5" aria-hidden /> New item <Kbd>Ins</Kbd>
        </button>
      </div>

      {state.load === 'loading' && <CenterNote title="Loading catalog…" />}
      {state.load === 'offline' && (
        <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />}>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 inline-flex items-center gap-2 rounded-md border-2 border-zinc-600 px-4 py-2 font-bold hover:border-zinc-300"
          >
            <RefreshCw className="size-4" aria-hidden /> Retry now
          </button>
        </CenterNote>
      )}

      {state.load === 'ready' && (
        <main className="flex min-h-0 flex-1 flex-col" aria-label="Catalog">
          <div className={`${GRID} border-b border-zinc-800 px-5 py-2 text-xs font-bold tracking-widest text-zinc-500 uppercase`}>
            <span>Code</span>
            <span>Item</span>
            <span>Size</span>
            <span className="text-right">Sale</span>
            <span className="text-right">Purchase</span>
            <span className="text-right">Case</span>
            <span className="text-right">On hand</span>
            <span>Status</span>
            <span />
          </div>
          <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Items by category">
            {rows.map((row) => {
              if (row.kind === 'header') {
                const { category } = row
                return (
                  <li key={`h-${category.id}`} role="presentation" className="sticky top-0 z-10 flex min-h-12 items-center gap-3 border-y-2 border-zinc-700 bg-zinc-800 px-5">
                    <span className="text-xl font-black tracking-widest uppercase">{category.name}</span>
                    <DepartmentChip department={category.defaultDepartment} name={departmentName(state.departments, category.defaultDepartment)} />
                    <span className="ml-auto font-mono text-sm text-zinc-300 tabular-nums">
                      {row.count} item{row.count === 1 ? '' : 's'}
                      {category.defaultDepartment !== 'KITCHEN' && ` · ${row.onHand} on hand`}
                    </span>
                    <RowButton label={`New item in ${category.name}`} onClick={() => dispatch({ type: 'openNew', categoryId: category.id })} disabled={!category.isActive}>
                      <Plus className="size-4" aria-hidden /> Item
                    </RowButton>
                  </li>
                )
              }
              const { item } = row
              const selected = highlighted?.id === item.id
              const live = item.isActive && item.brandActive
              return (
                <li
                  key={item.id}
                  role="option"
                  aria-selected={selected}
                  onClick={() => dispatch({ type: 'openEdit', item })}
                  className={`${GRID} min-h-14 cursor-pointer border-b border-zinc-800 px-5 ${
                    selected ? 'bg-amber-400/10 outline-2 -outline-offset-2 outline-amber-400/60' : 'hover:bg-zinc-900'
                  } ${live ? '' : 'text-zinc-500'}`}
                >
                  <span className="font-mono text-sm font-bold">{item.skuCode}</span>
                  <span className="min-w-0">
                    <span className={`block truncate text-lg font-bold ${live ? '' : 'line-through'}`}>{item.brandName}</span>
                    {item.barcode && <span className="block truncate font-mono text-xs text-zinc-500">{item.barcode}</span>}
                  </span>
                  <span className="truncate text-sm text-zinc-300">{sizeNameFor(item.sizeCode, item.department)}</span>
                  <span className="text-right font-mono font-bold tabular-nums">{formatPaise(item.pricePaise)}</span>
                  <span className="text-right font-mono tabular-nums text-zinc-300">{item.purchasePricePaise === null ? '—' : formatPaise(item.purchasePricePaise)}</span>
                  <span className="text-right font-mono tabular-nums">{item.tracksStock ? item.caseSize : '—'}</span>
                  <span className={`text-right tabular-nums ${item.tracksStock ? 'font-mono font-bold' : 'text-xs text-zinc-500'}`}>{item.tracksStock ? item.onHandQty : 'not tracked'}</span>
                  <span>{live ? <span className="text-sm font-semibold text-emerald-400">● active</span> : <InactiveBadge />}</span>
                  <RowButton label={`Edit ${item.displayName}`} onClick={() => dispatch({ type: 'openEdit', item })} iconOnly>
                    <Pencil className="size-4" aria-hidden />
                  </RowButton>
                </li>
              )
            })}
            {rows.length === 0 && (
              <li className="p-12 text-center text-lg text-zinc-500">
                {state.query.trim() ? `Nothing matches “${state.query.trim()}”.` : 'The catalog is empty — add the first item.'}
              </li>
            )}
          </ul>
          <p className="border-t-2 border-zinc-800 bg-zinc-900 px-5 py-2 text-sm text-zinc-500">
            <Kbd>↑</Kbd>/<Kbd>↓</Kbd> select · <Kbd>Enter</Kbd> edit · <Kbd>Ins</Kbd> new item (in the highlighted category) · <Kbd>Esc</Kbd> clear search / back.
            Categories are set up in Settings → Item Categories. Stock comes in through Purchase.
          </p>
        </main>
      )}

      {state.form && (
        <ItemFormModal
          state={state}
          form={state.form}
          onField={(change) => dispatch({ type: 'field', ...change })}
          onClose={() => dispatch({ type: 'close' })}
          onSave={() => void save()}
        />
      )}
    </div>
  )
}

// ── Form modal ──────────────────────────────────────────────────────────────

interface FormModalProps {
  state: CatalogState
  form: ItemForm
  onField: (change: ItemField) => void
  onClose: () => void
  onSave: () => void
}

function ItemFormModal({ state, form, onField, onClose, onSave }: FormModalProps) {
  const error = formError(state, form)
  const retiring = deactivates(form)
  const { saveError, submitting, conflict } = state
  return (
    <Modal
      title={form.kind === 'new' ? 'New item' : `Edit ${form.item.displayName}`}
      width="max-w-3xl"
      onClose={onClose}
      onKey={(e) => {
        if (e.key !== 'Enter' && e.key !== 'F9') return false
        if (e.target instanceof HTMLButtonElement && e.key === 'Enter') return false
        onSave()
        return true
      }}
      footer={
        <div className="flex items-center gap-3">
          <p className={`min-w-0 flex-1 text-sm font-semibold ${saveError ? 'text-rose-300' : 'text-amber-300'}`} aria-live="polite">
            {saveError ?? error ?? ''}
          </p>
          <button type="button" onClick={onClose} className="min-h-12 rounded-md border-2 border-zinc-600 px-5 font-bold">
            Cancel (Esc)
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={submitting || error !== null}
            className={`min-h-12 rounded-md px-5 font-bold text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-400 ${retiring ? 'bg-rose-400' : 'bg-teal-400'}`}
          >
            {submitting ? 'Saving…' : retiring ? 'Deactivate & save (Enter)' : 'Save (Enter)'}
          </button>
        </div>
      }
    >
      {form.kind === 'new' ? (
        <NewItemFields state={state} form={form} conflict={conflict} onField={onField} />
      ) : (
        <EditItemFields state={state} form={form} conflict={conflict} onField={onField} />
      )}
      {retiring && form.kind === 'edit' && (
        <p className="mt-4 rounded-md border-2 border-rose-500/60 bg-rose-500/10 p-3 text-rose-200">
          Deactivate {form.item.displayName}? It can no longer be billed or received. Stock stays on record, and you can reactivate it later.
        </p>
      )}
    </Modal>
  )
}

interface FieldsProps<F> {
  state: CatalogState
  form: F
  conflict: ConflictField | null
  onField: (change: ItemField) => void
}

function NewItemFields({ state, form, conflict, onField }: FieldsProps<NewItemForm>) {
  const category = state.categories.find((c) => c.id === form.categoryId)
  const brand = existingBrand(state.items, form.name)
  const department = effectiveDepartment(form, state.items)
  const choices = category ? sizeChoices(category, department) : []
  const kitchen = department === 'KITCHEN'
  const prefix = brand ? brand.prefix : form.codePrefix
  return (
    <div className="flex flex-col gap-4">
      <CategoryPicker categories={state.categories} value={form.categoryId} onChange={(value) => onField({ field: 'categoryId', value })} />
      <div className="grid grid-cols-[1fr_11rem] gap-4">
        <TextInput label="Item name" value={form.name} onChange={(value) => onField({ field: 'name', value })} invalid={conflict === 'name' || conflict === 'size'} autofocus maxLength={80} placeholder="e.g. 1848, Royal Stag" />
        {brand ? (
          <div>
            <span className="text-sm font-semibold text-zinc-300">SKU code</span>
            <p className="mt-1 flex min-h-[3.25rem] items-center rounded-md border-2 border-zinc-800 px-3 font-mono text-lg text-zinc-300">
              {form.sizeCode ? skuCodePreview(prefix, form.sizeCode) : `${prefix}-…`}
            </p>
          </div>
        ) : (
          <TextInput
            label={`Code prefix${form.sizeCode && prefix ? ` → ${skuCodePreview(prefix, form.sizeCode)}` : ''}`}
            value={form.codePrefix}
            onChange={(value) => onField({ field: 'codePrefix', value })}
            invalid={conflict === 'codePrefix'}
            maxLength={10}
            placeholder="e.g. 1848"
            mono
          />
        )}
      </div>
      <p className="-mt-2 text-sm text-zinc-400">
        {brand
          ? `Adds a ${form.sizeCode ? sizeNameFor(form.sizeCode, department) : 'size'} to ${brand.name} (${departmentName(state.departments, brand.department)}) — it already has ${brand.sizes.map((s) => sizeNameFor(s, brand.department)).join(', ')}.`
          : form.name.trim()
            ? `New brand “${form.name.trim()}”.`
            : 'Type the brand name; an existing brand gets this as another size.'}
      </p>

      {choices.length > 0 ? (
        <div>
          <span className="text-sm font-semibold text-zinc-300">Size</span>
          <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label="Size">
            {choices.map((size) => (
              <ChoiceChip key={size} on={form.sizeCode === size} onClick={() => onField({ field: 'sizeCode', value: size })} invalid={conflict === 'size'}>
                {sizeNameFor(size, department)}
              </ChoiceChip>
            ))}
          </div>
        </div>
      ) : (
        form.sizeCode && (
          <p className="text-sm text-zinc-300">
            Size <span className="font-bold">{sizeNameFor(form.sizeCode, department)}</span> <span className="text-zinc-500">(from {category?.name})</span>
          </p>
        )
      )}

      {!brand && <DepartmentPicker departments={state.departments} value={form.department} onChange={(value) => onField({ field: 'department', value })} />}

      <div className={`grid gap-4 ${kitchen ? 'grid-cols-3' : 'grid-cols-5'}`}>
        <TextInput label="Sale ₹" value={form.sale} onChange={(value) => onField({ field: 'sale', value })} inputMode="decimal" mono />
        <TextInput label="Purchase ₹ (opt.)" value={form.buy} onChange={(value) => onField({ field: 'buy', value })} inputMode="decimal" mono />
        {!kitchen && <TextInput label="Per case" value={form.caseSize} onChange={(value) => onField({ field: 'caseSize', value })} inputMode="numeric" mono />}
        <TextInput label="Barcode (opt.)" value={form.barcode} onChange={(value) => onField({ field: 'barcode', value })} invalid={conflict === 'barcode'} maxLength={40} mono />
        {!kitchen && <TextInput label="Opening stock" value={form.opening} onChange={(value) => onField({ field: 'opening', value })} inputMode="numeric" placeholder="0" mono />}
      </div>
      <p className="text-sm text-zinc-400">
        {kitchen
          ? 'Kitchen items are not stock-tracked: they sell without stock and print a KOT to the kitchen.'
          : 'Opening stock is entered once, now (e.g. at go-live); after that stock comes in only through Purchase. The purchase price pre-fills the GRN unit cost.'}
      </p>
    </div>
  )
}

function EditItemFields({ state, form, conflict, onField }: FieldsProps<EditItemForm>) {
  const { item } = form
  const name = form.name.trim().replace(/\s+/g, ' ')
  const other = name.toLowerCase() !== item.brandName.toLowerCase() ? existingBrand(state.items, name) : null
  const kitchen = item.department === 'KITCHEN'
  return (
    <div className="flex flex-col gap-4">
      <p className="text-zinc-300">
        <span className="font-mono">{item.skuCode}</span> · {sizeNameFor(item.sizeCode, item.department)} · <DepartmentChip department={item.department} name={item.departmentName} /> ·{' '}
        {item.tracksStock ? `${item.onHandQty} on hand (changes only through Purchase)` : 'stock not tracked'}
      </p>
      <TextInput label="Item name" value={form.name} onChange={(value) => onField({ field: 'name', value })} invalid={conflict === 'name' || conflict === 'size'} autofocus maxLength={80} />
      {name !== item.brandName && name !== '' && (
        <p className="-mt-2 text-sm text-amber-200">
          {name.toLowerCase() === item.brandName.toLowerCase()
            ? `Renames the brand on every size of ${item.brandName}.`
            : other
              ? `Moves this item to the existing brand ${other.name} (${departmentName(state.departments, other.department)}); other sizes of ${item.brandName} stay.`
              : `Moves this item to a new brand “${name}”; other sizes of ${item.brandName} stay.`}
        </p>
      )}
      <CategoryPicker categories={state.categories} value={form.categoryId} onChange={(value) => onField({ field: 'categoryId', value })} />
      <div className={`grid gap-4 ${kitchen ? 'grid-cols-3' : 'grid-cols-4'}`}>
        <TextInput label="Sale ₹" value={form.sale} onChange={(value) => onField({ field: 'sale', value })} inputMode="decimal" mono />
        <TextInput label="Purchase ₹ (opt.)" value={form.buy} onChange={(value) => onField({ field: 'buy', value })} inputMode="decimal" mono />
        {!kitchen && <TextInput label="Per case" value={form.caseSize} onChange={(value) => onField({ field: 'caseSize', value })} inputMode="numeric" mono />}
        <TextInput label="Barcode (opt.)" value={form.barcode} onChange={(value) => onField({ field: 'barcode', value })} invalid={conflict === 'barcode'} maxLength={40} mono />
      </div>
      <ActiveToggle on={form.isActive} onChange={(value) => onField({ field: 'isActive', value })} />
      <p className="text-sm text-zinc-400">
        A new sale price applies from the next scan; bills already rung up keep their price and name. The revenue center ({item.departmentName}) belongs to the brand
        and applies to every size of {item.brandName}. Size and SKU code can&rsquo;t be changed.
      </p>
    </div>
  )
}

// ── Small controls ──────────────────────────────────────────────────────────

function CategoryPicker({ categories, value, onChange }: { categories: ItemCategory[]; value: string; onChange: (value: string) => void }) {
  const shown = categories.filter((c) => c.isActive || c.id === value)
  return (
    <div>
      <span className="text-sm font-semibold text-zinc-300">Category</span>
      <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label="Category">
        {shown.map((c) => (
          <ChoiceChip key={c.id} on={value === c.id} onClick={() => onChange(c.id)}>
            <span className="tracking-wide uppercase">{c.name}</span>
          </ChoiceChip>
        ))}
      </div>
    </div>
  )
}

/** Revenue-center switch for a new brand: which P&L its sales go to, and where its KOT prints. */
function DepartmentPicker({ departments, value, onChange }: { departments: Department[]; value: DepartmentCode; onChange: (value: DepartmentCode) => void }) {
  return (
    <div>
      <span className="text-sm font-semibold text-zinc-300">Revenue center (P&amp;L) — from the category, change if needed</span>
      <div className="mt-1 grid grid-cols-4 gap-2" role="radiogroup" aria-label="Department">
        {departments.filter((d) => d.isActive || d.code === value).map(({ code: d, name }) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={value === d}
            onClick={() => onChange(d)}
            className={`min-h-12 rounded-md border-2 px-3 text-lg font-black ${value === d ? departmentChip(d) : 'border-zinc-600 text-zinc-300 hover:border-zinc-400'} ${FOCUS_RING}`}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  )
}

function DepartmentChip({ department, name }: { department: DepartmentCode; name: string }) {
  return <span className={`rounded border px-2 py-0.5 text-xs font-bold tracking-widest uppercase ${departmentChip(department)}`}>{name}</span>
}

function ChoiceChip({ on, onClick, invalid = false, children }: { on: boolean; onClick: () => void; invalid?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      onClick={onClick}
      aria-checked={on}
      className={`min-h-12 rounded-md border-2 px-4 font-bold ${
        on ? 'border-teal-400 bg-teal-400 text-zinc-950' : invalid ? 'border-rose-500 text-zinc-200' : 'border-zinc-600 text-zinc-200 hover:border-zinc-400'
      } ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}

function ActiveToggle({ on, onChange }: { on: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center gap-3 select-none">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="size-6 accent-teal-400" />
      <span className="font-semibold">{on ? 'Active — can be billed and received' : 'Inactive — hidden from billing and GRN'}</span>
    </label>
  )
}

interface TextInputProps {
  label: string
  value: string
  onChange: (value: string) => void
  invalid?: boolean
  autofocus?: boolean
  maxLength?: number
  placeholder?: string
  inputMode?: 'decimal' | 'numeric'
  mono?: boolean
}

function TextInput({ label, value, onChange, invalid = false, autofocus = false, maxLength, placeholder, inputMode, mono = false }: TextInputProps) {
  return (
    <label className="block min-w-0">
      <span className="block truncate text-sm font-semibold text-zinc-300">{label}</span>
      <input
        value={value}
        autoComplete="off"
        maxLength={maxLength}
        placeholder={placeholder}
        inputMode={inputMode}
        {...(autofocus ? { 'data-autofocus': true } : {})}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 w-full rounded-md border-2 bg-zinc-950 px-3 py-2.5 text-lg outline-none focus:border-amber-400 ${mono ? 'font-mono tabular-nums' : ''} ${
          invalid ? 'border-rose-500' : 'border-zinc-600'
        }`}
      />
    </label>
  )
}

function RowButton({ label, onClick, disabled = false, iconOnly = false, children }: { label: string; onClick: () => void; disabled?: boolean; iconOnly?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`flex min-h-11 items-center justify-center gap-1.5 rounded-md border-2 border-zinc-700 font-bold text-zinc-300 hover:border-teal-400 hover:text-teal-300 disabled:cursor-not-allowed disabled:opacity-40 ${
        iconOnly ? 'size-11' : 'px-3'
      } ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}

function InactiveBadge() {
  return <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-bold tracking-widest text-zinc-400 uppercase">inactive</span>
}

function CenterNote({ title, icon, children }: { title: string; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      {icon}
      <h2 className="text-2xl font-bold">{title}</h2>
      {children}
    </div>
  )
}
