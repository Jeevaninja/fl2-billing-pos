import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react'
import { ArrowLeft, Boxes, Pencil, Plus, RefreshCw, Search, WifiOff } from 'lucide-react'
import { ApiError, api } from '../api/client'
import { PRODUCT_CATEGORIES, type CatalogProduct, type ProductCategory } from '../api/types'
import { FlashLine } from '../billing/BillingPanels'
import { counterErrorMessage } from '../billing/errors'
import { Modal } from '../billing/Modal'
import {
  addSkuPayload,
  catalogReducer,
  catalogRows,
  conflictField,
  deactivates,
  formError,
  initialCatalogState,
  newProductPayload,
  productPatch,
  skuCodePreview,
  skuPatch,
  type AddSkuForm,
  type CatalogForm,
  type ConflictField,
  type EditProductForm,
  type EditSkuForm,
  type FormField,
  type NewProductForm,
  type SizeFields,
} from '../catalog/catalogReducer'
import { beep } from '../lib/beep'
import { formatPaise } from '../lib/money'
import { FOCUS_RING, keepFocus, SIZE_NAME, SIZE_ORDER } from '../lib/ui'
import { Kbd, LiveClock } from './ui'

const SEARCH_DEBOUNCE_MS = 150

const CATEGORY_LABEL: Record<ProductCategory, string> = {
  WHISKY: 'Whisky',
  RUM: 'Rum',
  VODKA: 'Vodka',
  BRANDY: 'Brandy',
  GIN: 'Gin',
  WINE: 'Wine',
  BEER: 'Beer',
  OTHER: 'Other',
}

interface CatalogScreenProps {
  onExit: () => void
}

/**
 * Inventory Catalog: create and edit liquors, their sealed sizes, sale and purchase prices and case
 * sizes. ↑/↓ move through the list, Enter edits the selected liquor or size, Ins adds a liquor,
 * Esc clears the search or leaves. Nothing is deleted: a liquor or size is deactivated instead.
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

  const load = useCallback(async (query: string, includeInactive: boolean) => {
    try {
      dispatch({ type: 'loaded', products: await api.listCatalog(query, includeInactive), query, includeInactive })
    } catch (err) {
      dispatch({ type: 'failed', message: counterErrorMessage(err) })
    }
  }, [])

  // (Re)load whenever the search or the inactive filter changes; typing is debounced.
  const { query, includeInactive } = state
  useEffect(() => {
    const timer = setTimeout(() => void load(query.trim(), includeInactive), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, includeInactive, load])

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Keep the selected row in view as ↑/↓ move it.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [state.selected])

  const save = useCallback(async () => {
    const current = stateRef.current
    const form = current.form
    if (!form || current.submitting) return
    const error = formError(form)
    if (error) {
      flash('error', error)
      return
    }
    let request: Promise<CatalogProduct>
    let done: (p: CatalogProduct) => string
    switch (form.kind) {
      case 'newProduct':
        request = api.createProduct(newProductPayload(form)!)
        done = (p) => `Added ${p.name} · ${p.skus.length} size${p.skus.length === 1 ? '' : 's'} at 0 stock — receive them through Purchase`
        break
      case 'editProduct': {
        const patch = productPatch(form)
        if (typeof patch === 'string' || Object.keys(patch).length === 0) {
          dispatch({ type: 'close' })
          return
        }
        request = api.updateProduct(form.product.id, patch)
        done = (p) => (patch.isActive === false ? `Deactivated ${p.name} and its sizes` : `Saved ${p.name}`)
        break
      }
      case 'addSku': {
        const payload = addSkuPayload(form)
        if (typeof payload === 'string') return
        request = api.addSku(form.product.id, payload)
        done = (p) => `Added ${SIZE_NAME[payload.sizeCode]} to ${p.name}`
        break
      }
      case 'editSku': {
        const patch = skuPatch(form)
        if (typeof patch === 'string' || Object.keys(patch).length === 0) {
          dispatch({ type: 'close' })
          return
        }
        request = api.updateSku(form.sku.id, patch)
        done = () => `Saved ${form.sku.skuCode}`
        break
      }
    }
    dispatch({ type: 'submitting', on: true })
    try {
      const product = await request
      beep('ok')
      dispatch({ type: 'saved', product, text: done(product) })
      void load(stateRef.current.query.trim(), stateRef.current.includeInactive)
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

  const rows = catalogRows(state.products)
  const sizeCount = state.products.reduce((n, p) => n + p.skus.length, 0)

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
            {state.products.length} liquor{state.products.length === 1 ? '' : 's'} · {sizeCount} size{sizeCount === 1 ? '' : 's'}
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
            aria-label="Search liquors by name, SKU code or barcode"
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
          <Plus className="size-5" aria-hidden /> New liquor <Kbd>Ins</Kbd>
        </button>
      </div>

      {state.load === 'loading' && <CenterNote title="Loading catalog…" />}
      {state.load === 'offline' && (
        <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />}>
          <button
            type="button"
            onClick={() => void load(state.query.trim(), state.includeInactive)}
            className="mt-2 inline-flex items-center gap-2 rounded-md border-2 border-zinc-600 px-4 py-2 font-bold hover:border-zinc-300"
          >
            <RefreshCw className="size-4" aria-hidden /> Retry now
          </button>
        </CenterNote>
      )}

      {state.load === 'ready' && (
        <main className="flex min-h-0 flex-1 flex-col" aria-label="Catalog">
          <div className="grid grid-cols-[7rem_1fr_9rem_9rem_5rem_6rem_6rem_3.5rem] items-center gap-3 border-b border-zinc-800 px-5 py-2 text-xs font-bold tracking-widest text-zinc-500 uppercase">
            <span>Code</span>
            <span>Size</span>
            <span className="text-right">Sale</span>
            <span className="text-right">Purchase</span>
            <span className="text-right">Case</span>
            <span className="text-right">On hand</span>
            <span>Status</span>
            <span />
          </div>
          <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Liquors and sizes">
            {rows.map((row, i) => {
              const selected = state.selected === i
              const base = `cursor-pointer border-b border-zinc-800 px-5 ${selected ? 'bg-amber-400/10 outline-2 -outline-offset-2 outline-amber-400/60' : 'hover:bg-zinc-900'}`
              if (row.kind === 'product') {
                const { product } = row
                return (
                  <li
                    key={product.id}
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      dispatch({ type: 'select', index: i })
                      dispatch({ type: 'openEditProduct', product })
                    }}
                    className={`flex min-h-14 items-center gap-3 bg-zinc-900/60 pt-2 ${base}`}
                  >
                    <Boxes className="size-5 shrink-0 text-teal-400" aria-hidden />
                    <span className={`text-xl font-extrabold ${product.isActive ? '' : 'text-zinc-500 line-through'}`}>{product.name}</span>
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-bold tracking-widest text-zinc-300 uppercase">{CATEGORY_LABEL[product.category]}</span>
                    {!product.isActive && <InactiveBadge />}
                    <span className="ml-auto flex gap-2">
                      <RowButton
                        label={`Add a size to ${product.name}`}
                        onClick={() => dispatch({ type: 'openAddSku', product })}
                        disabled={!product.isActive || product.skus.length >= SIZE_ORDER.length}
                      >
                        <Plus className="size-4" aria-hidden /> Size
                      </RowButton>
                      <RowButton label={`Edit ${product.name}`} onClick={() => dispatch({ type: 'openEditProduct', product })}>
                        <Pencil className="size-4" aria-hidden /> Edit
                      </RowButton>
                    </span>
                  </li>
                )
              }
              const { sku, product } = row
              return (
                <li
                  key={sku.id}
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    dispatch({ type: 'select', index: i })
                    dispatch({ type: 'openEditSku', product, sku })
                  }}
                  className={`grid min-h-14 grid-cols-[7rem_1fr_9rem_9rem_5rem_6rem_6rem_3.5rem] items-center gap-3 ${base} ${sku.isActive ? '' : 'text-zinc-500'}`}
                >
                  <span className="font-mono text-sm font-bold">{sku.skuCode}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{SIZE_NAME[sku.sizeCode]}</span>
                    {sku.barcode && <span className="block truncate font-mono text-xs text-zinc-500">{sku.barcode}</span>}
                  </span>
                  <span className="text-right font-mono font-bold tabular-nums">{formatPaise(sku.pricePaise)}</span>
                  <span className="text-right font-mono tabular-nums text-zinc-300">{sku.purchasePricePaise === null ? '—' : formatPaise(sku.purchasePricePaise)}</span>
                  <span className="text-right font-mono tabular-nums">{sku.caseSize}</span>
                  <span className="text-right font-mono tabular-nums">{sku.onHandQty}</span>
                  <span>{sku.isActive ? <span className="text-sm font-semibold text-emerald-400">● active</span> : <InactiveBadge />}</span>
                  <RowButton label={`Edit ${sku.skuCode}`} onClick={() => dispatch({ type: 'openEditSku', product, sku })} iconOnly>
                    <Pencil className="size-4" aria-hidden />
                  </RowButton>
                </li>
              )
            })}
            {rows.length === 0 && (
              <li className="p-12 text-center text-lg text-zinc-500">
                {state.query.trim() ? `Nothing matches “${state.query.trim()}”.` : 'The catalog is empty — add the first liquor.'}
              </li>
            )}
          </ul>
          <p className="border-t-2 border-zinc-800 bg-zinc-900 px-5 py-2 text-sm text-zinc-500">
            <Kbd>↑</Kbd>/<Kbd>↓</Kbd> select · <Kbd>Enter</Kbd> edit · <Kbd>Ins</Kbd> new liquor · <Kbd>Esc</Kbd> clear search / back. New sizes start at 0
            stock; receive them through Purchase.
          </p>
        </main>
      )}

      {state.form && (
        <CatalogFormModal
          form={state.form}
          conflict={state.conflict}
          saveError={state.saveError}
          submitting={state.submitting}
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
  form: CatalogForm
  conflict: ConflictField | null
  saveError: string | null
  submitting: boolean
  onField: (change: FormField) => void
  onClose: () => void
  onSave: () => void
}

const TITLE: Record<CatalogForm['kind'], (form: CatalogForm) => string> = {
  newProduct: () => 'New liquor',
  editProduct: (f) => `Edit ${(f as EditProductForm).product.name}`,
  addSku: (f) => `Add a size to ${(f as AddSkuForm).product.name}`,
  editSku: (f) => `Edit ${(f as EditSkuForm).sku.skuCode}`,
}

function CatalogFormModal({ form, conflict, saveError, submitting, onField, onClose, onSave }: FormModalProps) {
  const error = formError(form)
  const retiring = deactivates(form)
  return (
    <Modal
      title={TITLE[form.kind](form)}
      width={form.kind === 'newProduct' ? 'max-w-5xl' : 'max-w-2xl'}
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
      {form.kind === 'newProduct' && <NewProductFields form={form} conflict={conflict} onField={onField} />}
      {form.kind === 'editProduct' && <EditProductFields form={form} conflict={conflict} onField={onField} />}
      {form.kind === 'addSku' && <AddSkuFields form={form} conflict={conflict} onField={onField} />}
      {form.kind === 'editSku' && <EditSkuFields form={form} conflict={conflict} onField={onField} />}
      {retiring && (
        <p className="mt-4 rounded-md border-2 border-rose-500/60 bg-rose-500/10 p-3 text-rose-200">
          {form.kind === 'editProduct'
            ? `Deactivate ${form.product.name}? None of its sizes can be billed or received any more. Stock stays on record, and you can reactivate it later.`
            : `Deactivate ${(form as EditSkuForm).sku.skuCode}? It can no longer be billed or received. Stock stays on record.`}
        </p>
      )}
    </Modal>
  )
}

interface FieldsProps<F> {
  form: F
  conflict: ConflictField | null
  onField: (change: FormField) => void
}

function NewProductFields({ form, conflict, onField }: FieldsProps<NewProductForm>) {
  const prefix = form.codePrefix || '…'
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[1fr_12rem] gap-4">
        <TextInput label="Liquor name" value={form.name} onChange={(value) => onField({ field: 'name', value })} invalid={conflict === 'name'} autofocus maxLength={80} placeholder="e.g. Royal Stag" />
        <TextInput
          label="Code prefix"
          value={form.codePrefix}
          onChange={(value) => onField({ field: 'codePrefix', value })}
          invalid={conflict === 'codePrefix'}
          maxLength={10}
          placeholder="e.g. ROST"
          mono
        />
      </div>
      <CategoryPicker value={form.category} onChange={(value) => onField({ field: 'category', value })} />
      <div>
        <span className="text-sm font-semibold text-zinc-300">Sizes — tick each size you stock</span>
        <div className="mt-1 grid grid-cols-[13rem_1fr_1fr_6rem_1fr] gap-x-3 gap-y-2 text-xs font-bold tracking-widest text-zinc-500 uppercase">
          <span>Size · SKU code</span>
          <span>Sale ₹</span>
          <span>Purchase ₹ (optional)</span>
          <span>Case</span>
          <span>Barcode (optional)</span>
          {SIZE_ORDER.map((size) => {
            const row = form.sizes[size]
            const set = (field: keyof SizeFields) => (value: string) => onField({ field, value, size })
            return (
              <SizeRow key={size} on={row.on}>
                <label className="flex min-h-12 cursor-pointer items-center gap-3 text-base font-semibold tracking-normal text-zinc-100 normal-case select-none">
                  <input type="checkbox" checked={row.on} onChange={(e) => onField({ field: 'sizeOn', size, value: e.target.checked })} className="size-6 accent-teal-400" />
                  <span>
                    <span className="block">{SIZE_NAME[size]}</span>
                    <span className="block font-mono text-xs text-zinc-500">{skuCodePreview(prefix, size)}</span>
                  </span>
                </label>
                <CellInput value={row.sale} onChange={set('sale')} label={`${SIZE_NAME[size]} sale price`} inputMode="decimal" />
                <CellInput value={row.buy} onChange={set('buy')} label={`${SIZE_NAME[size]} purchase price`} inputMode="decimal" />
                <CellInput value={row.caseSize} onChange={set('caseSize')} label={`${SIZE_NAME[size]} bottles per case`} inputMode="numeric" />
                <CellInput value={row.barcode} onChange={set('barcode')} label={`${SIZE_NAME[size]} barcode`} invalid={conflict === 'barcode' && row.barcode !== ''} />
              </SizeRow>
            )
          })}
        </div>
      </div>
      <p className="text-sm text-zinc-400">
        Case size is how many sealed bottles come in one supplier case (Full 12 · Half 32 · Quarter 64 by default). The purchase price pre-fills the GRN unit cost.
      </p>
    </div>
  )
}

function EditProductFields({ form, conflict, onField }: FieldsProps<EditProductForm>) {
  return (
    <div className="flex flex-col gap-4">
      <TextInput label="Liquor name" value={form.name} onChange={(value) => onField({ field: 'name', value })} invalid={conflict === 'name'} autofocus maxLength={80} placeholder="" />
      <CategoryPicker value={form.category} onChange={(value) => onField({ field: 'category', value })} />
      <ActiveToggle on={form.isActive} onChange={(value) => onField({ field: 'isActive', value })} />
      <p className="text-sm text-zinc-400">
        Renaming updates every size's name ({form.product.skus.map((s) => s.skuCode).join(', ') || 'no sizes yet'}). Bills already rung up keep the old name.
      </p>
    </div>
  )
}

function AddSkuFields({ form, conflict, onField }: FieldsProps<AddSkuForm>) {
  const taken = new Set(form.product.skus.map((s) => s.sizeCode))
  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className="text-sm font-semibold text-zinc-300">Size</span>
        <div className="mt-1 flex flex-wrap gap-2">
          {SIZE_ORDER.filter((s) => !taken.has(s)).map((size) => (
            <ChoiceChip key={size} on={form.sizeCode === size} onClick={() => onField({ field: 'sizeCode', value: size })} invalid={conflict === 'size'}>
              {SIZE_NAME[size]}
            </ChoiceChip>
          ))}
        </div>
      </div>
      <SizeFieldsGrid form={form} conflict={conflict} onField={onField} />
    </div>
  )
}

function EditSkuFields({ form, conflict, onField }: FieldsProps<EditSkuForm>) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-zinc-300">
        <span className="font-semibold text-zinc-100">{form.sku.displayName}</span> · {SIZE_NAME[form.sku.sizeCode]} · <span className="font-mono">{form.sku.skuCode}</span> ·{' '}
        {form.sku.onHandQty} on hand
      </p>
      <SizeFieldsGrid form={form} conflict={conflict} onField={onField} />
      <ActiveToggle on={form.isActive} onChange={(value) => onField({ field: 'isActive', value })} />
      <p className="text-sm text-zinc-400">A new sale price applies from the next scan; bills already rung up keep their price. SKU code and size can't be changed.</p>
    </div>
  )
}

function SizeFieldsGrid({ form, conflict, onField }: FieldsProps<SizeFields>) {
  const set = (field: keyof SizeFields) => (value: string) => onField({ field, value })
  return (
    <div className="grid grid-cols-2 gap-4">
      <TextInput label="Sale price ₹ (per bottle)" value={form.sale} onChange={set('sale')} inputMode="decimal" autofocus mono />
      <TextInput label="Purchase price ₹ (optional)" value={form.buy} onChange={set('buy')} inputMode="decimal" mono />
      <TextInput label="Bottles per case" value={form.caseSize} onChange={set('caseSize')} inputMode="numeric" mono />
      <TextInput label="Barcode (optional)" value={form.barcode} onChange={set('barcode')} invalid={conflict === 'barcode'} maxLength={40} mono />
    </div>
  )
}

// ── Small controls ──────────────────────────────────────────────────────────

function CategoryPicker({ value, onChange }: { value: ProductCategory; onChange: (value: ProductCategory) => void }) {
  return (
    <div>
      <span className="text-sm font-semibold text-zinc-300">Category</span>
      <div className="mt-1 flex flex-wrap gap-2">
        {PRODUCT_CATEGORIES.map((c) => (
          <ChoiceChip key={c} on={value === c} onClick={() => onChange(c)}>
            {CATEGORY_LABEL[c]}
          </ChoiceChip>
        ))}
      </div>
    </div>
  )
}

function ChoiceChip({ on, onClick, invalid = false, children }: { on: boolean; onClick: () => void; invalid?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`min-h-11 rounded-md border-2 px-4 font-bold ${
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
    <label className="block">
      <span className="text-sm font-semibold text-zinc-300">{label}</span>
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

function CellInput({ value, onChange, label, inputMode, invalid = false }: { value: string; onChange: (v: string) => void; label: string; inputMode?: 'decimal' | 'numeric'; invalid?: boolean }) {
  return (
    <input
      value={value}
      aria-label={label}
      autoComplete="off"
      inputMode={inputMode}
      onChange={(e) => onChange(e.target.value)}
      className={`min-h-12 w-full rounded-md border-2 bg-zinc-950 px-3 font-mono text-base font-normal tracking-normal text-zinc-100 tabular-nums outline-none focus:border-amber-400 ${
        invalid ? 'border-rose-500' : 'border-zinc-700'
      }`}
    />
  )
}

/** One size row of the new-liquor grid; dimmed until ticked. */
function SizeRow({ on, children }: { on: boolean; children: ReactNode }) {
  return <div className={`contents ${on ? '' : '[&>*:not(:first-child)]:opacity-50'}`}>{children}</div>
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
