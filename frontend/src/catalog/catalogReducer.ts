/**
 * CatalogScreen (Inventory Catalog) state machine. Pure and unit-tested: the liquor list, search
 * and selection, and the four forms: new liquor (with its sizes), edit liquor, add size and edit
 * size. Prices are parsed to whole paise and case sizes to whole numbers; no floats.
 */
import type {
  CatalogProduct,
  CatalogSku,
  NewProductPayload,
  NewSkuPayload,
  Paise,
  ProductCategory,
  ProductPatch,
  SizeCode,
  SkuPatchPayload,
} from '../api/types'
import type { Flash } from '../billing/billingReducer'
import { paiseToRupeeInput, parseRupeesToPaise } from '../lib/money'
import { SIZE_ORDER } from '../lib/ui'

/** Bottles per case pre-filled when a size is ticked (Indian distribution cases); editable. */
export const DEFAULT_CASE_SIZE: Readonly<Record<SizeCode, number>> = { FULL: 12, HALF: 32, QUARTER: 64, BEER_650: 12, BEER_330: 24 }
export const MAX_CASE_SIZE = 1000
const SIZE_SUFFIX: Readonly<Record<SizeCode, string>> = { FULL: 'F', HALF: 'H', QUARTER: 'Q', BEER_650: '650', BEER_330: '330' }
const MAX_NAME = 80

/** The price, case size and barcode fields of one size, as typed. */
export interface SizeFields {
  sale: string
  buy: string
  caseSize: string
  barcode: string
}

export interface NewProductForm {
  kind: 'newProduct'
  name: string
  category: ProductCategory
  codePrefix: string
  /** Once the operator edits the prefix it stops following the name. */
  prefixTouched: boolean
  sizes: Record<SizeCode, SizeFields & { on: boolean }>
}

export interface EditProductForm {
  kind: 'editProduct'
  product: CatalogProduct
  name: string
  category: ProductCategory
  isActive: boolean
}

export interface AddSkuForm extends SizeFields {
  kind: 'addSku'
  product: CatalogProduct
  sizeCode: SizeCode | null
}

export interface EditSkuForm extends SizeFields {
  kind: 'editSku'
  product: CatalogProduct
  sku: CatalogSku
  isActive: boolean
}

export type CatalogForm = NewProductForm | EditProductForm | AddSkuForm | EditSkuForm

/** Which field a duplicate (PS012) was about, from the constraint that fired. */
export type ConflictField = 'name' | 'codePrefix' | 'barcode' | 'size'

const CONFLICT_BY_CONSTRAINT: Readonly<Record<string, ConflictField>> = {
  products_name_unique: 'name',
  skus_sku_code_unique: 'codePrefix',
  skus_barcode_unique: 'barcode',
  skus_product_size_unique: 'size',
}

const CONFLICT_TEXT: Readonly<Record<ConflictField, string>> = {
  name: 'A liquor with this name already exists',
  codePrefix: 'That SKU code is already used — choose another code prefix',
  barcode: 'That barcode is already on another SKU',
  size: 'This liquor already has that size',
}

export function conflictField(constraint: string | undefined): ConflictField | null {
  return constraint === undefined ? null : (CONFLICT_BY_CONSTRAINT[constraint] ?? null)
}

/** One row of the list: a liquor, or one of its sizes. ↑/↓ move through these. */
export type CatalogRow = { kind: 'product'; product: CatalogProduct } | { kind: 'sku'; product: CatalogProduct; sku: CatalogSku }

export interface CatalogState {
  load: 'loading' | 'ready' | 'offline'
  products: CatalogProduct[]
  query: string
  includeInactive: boolean
  /** Index into catalogRows(products). */
  selected: number
  form: CatalogForm | null
  conflict: ConflictField | null
  /** Why the last save was refused, shown inside the open form; cleared on the next edit. */
  saveError: string | null
  submitting: boolean
  flash: Flash | null
}

export const initialCatalogState: CatalogState = {
  load: 'loading',
  products: [],
  query: '',
  includeInactive: false,
  selected: 0,
  form: null,
  conflict: null,
  saveError: null,
  submitting: false,
  flash: null,
}

/** The field changes a form accepts; `size` / `sizeOn` address one size row of a new liquor. */
export type FormField =
  | { field: 'name' | 'codePrefix'; value: string }
  | { field: 'category'; value: ProductCategory }
  | { field: 'isActive'; value: boolean }
  | { field: 'sizeCode'; value: SizeCode }
  | { field: keyof SizeFields; value: string; size?: SizeCode }
  | { field: 'sizeOn'; value: boolean; size: SizeCode }

export type CatalogAction =
  /** Products for `query` / `includeInactive`; dropped if the filter has moved on. */
  | { type: 'loaded'; products: CatalogProduct[]; query: string; includeInactive: boolean }
  | { type: 'failed'; message: string }
  | { type: 'query'; text: string }
  | { type: 'includeInactive'; on: boolean }
  | { type: 'select'; index: number }
  | { type: 'move'; delta: number }
  | { type: 'openNew' }
  /** Opens the editor for the selected row (liquor or size). */
  | { type: 'openSelected' }
  | { type: 'openEditProduct'; product: CatalogProduct }
  | { type: 'openEditSku'; product: CatalogProduct; sku: CatalogSku }
  | { type: 'openAddSku'; product: CatalogProduct }
  | ({ type: 'field' } & FormField)
  | { type: 'close' }
  | { type: 'submitting'; on: boolean }
  /** A save went through: the server's copy of the liquor replaces the list's. */
  | { type: 'saved'; product: CatalogProduct; text: string }
  | { type: 'conflict'; field: ConflictField | null; message: string }
  | { type: 'flash'; kind: Flash['kind']; text: string }

export function catalogRows(products: readonly CatalogProduct[]): CatalogRow[] {
  return products.flatMap((product): CatalogRow[] => [{ kind: 'product', product }, ...product.skus.map((sku) => ({ kind: 'sku' as const, product, sku }))])
}

/** Suggested SKU code prefix: the first two letters of the first two words, or the first four of one ("Royal Stag" → ROST). */
export function suggestPrefix(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const prefix = words.length === 1 ? words[0]!.slice(0, 4) : words.slice(0, 2).map((w) => w.slice(0, 2)).join('')
  return prefix.slice(0, 10)
}

export function skuCodePreview(prefix: string, size: SizeCode): string {
  return `${prefix}-${SIZE_SUFFIX[size]}`
}

const EMPTY_SIZE: SizeFields = { sale: '', buy: '', caseSize: '', barcode: '' }

function newProductForm(): NewProductForm {
  const sizes = Object.fromEntries(SIZE_ORDER.map((s) => [s, { ...EMPTY_SIZE, on: false }])) as NewProductForm['sizes']
  return { kind: 'newProduct', name: '', category: 'WHISKY', codePrefix: '', prefixTouched: false, sizes }
}

function skuFields(sku: CatalogSku): SizeFields {
  return {
    sale: paiseToRupeeInput(sku.pricePaise),
    buy: sku.purchasePricePaise === null ? '' : paiseToRupeeInput(sku.purchasePricePaise),
    caseSize: String(sku.caseSize),
    barcode: sku.barcode ?? '',
  }
}

// ── Validation and payloads ──

interface ParsedSize {
  salePrice: Paise
  purchasePrice: Paise | null
  caseSize: number
  barcode: string | null
}

/** Checks one size's fields; returns the parsed values or the first problem, prefixed with `label`. */
function parseSize(fields: SizeFields, label: string): ParsedSize | string {
  const sale = parseRupeesToPaise(fields.sale)
  if (fields.sale.trim() === '' || sale === null) return `${label}: enter the sale price`
  if (sale <= 0n) return `${label}: the sale price must be more than ₹0`
  let purchasePrice: Paise | null = null
  if (fields.buy.trim() !== '') {
    purchasePrice = parseRupeesToPaise(fields.buy)
    if (purchasePrice === null) return `${label}: enter the purchase price in rupees, or leave it empty`
  }
  const caseSize = Number(fields.caseSize)
  if (!/^\d+$/.test(fields.caseSize.trim()) || caseSize < 1 || caseSize > MAX_CASE_SIZE) {
    return `${label}: case size must be 1 to ${MAX_CASE_SIZE} bottles`
  }
  const barcode = fields.barcode.trim()
  if (/\s/.test(barcode) || barcode.length > 40) return `${label}: barcode must be up to 40 characters with no spaces`
  return { salePrice: sale, purchasePrice, caseSize, barcode: barcode === '' ? null : barcode }
}

function checkName(name: string): string | null {
  const text = name.trim()
  if (text === '') return 'Enter the liquor name'
  if (text.length > MAX_NAME) return `Name must be at most ${MAX_NAME} characters`
  return null
}

/** What stops a new liquor from being saved, or null. */
export function newProductError(form: NewProductForm): string | null {
  const result = newProductPayloadOrError(form)
  return typeof result === 'string' ? result : null
}

export function newProductPayload(form: NewProductForm): NewProductPayload | null {
  const result = newProductPayloadOrError(form)
  return typeof result === 'string' ? null : result
}

function newProductPayloadOrError(form: NewProductForm): NewProductPayload | string {
  const nameError = checkName(form.name)
  if (nameError) return nameError
  const prefix = form.codePrefix.trim().toUpperCase()
  if (!/^[A-Z0-9]{2,10}$/.test(prefix)) return 'Code prefix must be 2–10 letters or digits, e.g. HWHS'
  const on = SIZE_ORDER.filter((s) => form.sizes[s].on)
  if (on.length === 0) return 'Tick at least one size'
  const skus: NewSkuPayload[] = []
  for (const size of on) {
    const parsed = parseSize(form.sizes[size], skuCodePreview(prefix, size))
    if (typeof parsed === 'string') return parsed
    skus.push({ sizeCode: size, ...parsed })
  }
  return { name: form.name.trim().replace(/\s+/g, ' '), category: form.category, codePrefix: prefix, skus }
}

/** The changed fields of a liquor edit (empty when nothing changed), or an error. */
export function productPatch(form: EditProductForm): ProductPatch | string {
  const nameError = checkName(form.name)
  if (nameError) return nameError
  const patch: ProductPatch = {}
  const name = form.name.trim().replace(/\s+/g, ' ')
  if (name !== form.product.name) patch.name = name
  if (form.category !== form.product.category) patch.category = form.category
  if (form.isActive !== form.product.isActive) patch.isActive = form.isActive
  return patch
}

export function addSkuPayload(form: AddSkuForm): NewSkuPayload | string {
  if (!form.sizeCode) return 'Choose a size'
  const parsed = parseSize(form, 'New size')
  return typeof parsed === 'string' ? parsed : { sizeCode: form.sizeCode, ...parsed }
}

/** The changed fields of a size edit (empty when nothing changed), or an error. */
export function skuPatch(form: EditSkuForm): SkuPatchPayload | string {
  const parsed = parseSize(form, form.sku.skuCode)
  if (typeof parsed === 'string') return parsed
  const { sku } = form
  const patch: SkuPatchPayload = {}
  if (parsed.salePrice !== sku.pricePaise) patch.salePrice = parsed.salePrice
  if (parsed.purchasePrice !== sku.purchasePricePaise) patch.purchasePrice = parsed.purchasePrice
  if (parsed.caseSize !== sku.caseSize) patch.caseSize = parsed.caseSize
  if (parsed.barcode !== sku.barcode) patch.barcode = parsed.barcode
  if (form.isActive !== sku.isActive) patch.isActive = form.isActive
  return patch
}

/** The form's current blocking problem, or null when it can be saved. */
export function formError(form: CatalogForm): string | null {
  switch (form.kind) {
    case 'newProduct':
      return newProductError(form)
    case 'editProduct': {
      const patch = productPatch(form)
      return typeof patch === 'string' ? patch : null
    }
    case 'addSku': {
      const payload = addSkuPayload(form)
      return typeof payload === 'string' ? payload : null
    }
    case 'editSku': {
      const patch = skuPatch(form)
      return typeof patch === 'string' ? patch : null
    }
  }
}

/** True when the save would retire something that is active now (the modal asks to confirm). */
export function deactivates(form: CatalogForm): boolean {
  if (form.kind === 'editProduct') return form.product.isActive && !form.isActive
  if (form.kind === 'editSku') return form.sku.isActive && !form.isActive
  return false
}

// ── Reducer ──

function flash(state: CatalogState, kind: Flash['kind'], text: string): Flash {
  return { kind, text, seq: (state.flash?.seq ?? 0) + 1 }
}

function applyField(form: CatalogForm, change: FormField): CatalogForm {
  switch (change.field) {
    case 'name':
      if (form.kind === 'newProduct') {
        return { ...form, name: change.value, codePrefix: form.prefixTouched ? form.codePrefix : suggestPrefix(change.value) }
      }
      return form.kind === 'editProduct' ? { ...form, name: change.value } : form
    case 'codePrefix':
      return form.kind === 'newProduct'
        ? { ...form, codePrefix: change.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10), prefixTouched: true }
        : form
    case 'category':
      return form.kind === 'newProduct' || form.kind === 'editProduct' ? { ...form, category: change.value } : form
    case 'isActive':
      return form.kind === 'editProduct' || form.kind === 'editSku' ? { ...form, isActive: change.value } : form
    case 'sizeCode':
      // Choosing a size resets its case size to that size's default.
      return form.kind === 'addSku' ? { ...form, sizeCode: change.value, caseSize: String(DEFAULT_CASE_SIZE[change.value]) } : form
    case 'sizeOn': {
      if (form.kind !== 'newProduct') return form
      const row = form.sizes[change.size]
      const caseSize = change.value && row.caseSize === '' ? String(DEFAULT_CASE_SIZE[change.size]) : row.caseSize
      return { ...form, sizes: { ...form.sizes, [change.size]: { ...row, on: change.value, caseSize } } }
    }
    case 'sale':
    case 'buy':
    case 'caseSize':
    case 'barcode': {
      const value =
        change.field === 'caseSize' ? change.value.replace(/\D/g, '').slice(0, 4)
        : change.field === 'barcode' ? change.value.trim()
        : change.value.replace(/[^\d.,]/g, '')
      if (form.kind === 'newProduct') {
        if (!change.size) return form
        const row = form.sizes[change.size]
        // Typing into a size's fields ticks it, pre-filling its case size as ticking does.
        const caseSize = row.on || row.caseSize !== '' ? row.caseSize : String(DEFAULT_CASE_SIZE[change.size])
        return { ...form, sizes: { ...form.sizes, [change.size]: { ...row, on: true, caseSize, [change.field]: value } } }
      }
      return form.kind === 'addSku' || form.kind === 'editSku' ? { ...form, [change.field]: value } : form
    }
  }
}

/** Replaces (or adds, in name order) a liquor in the list after a save. */
function upsert(products: readonly CatalogProduct[], product: CatalogProduct): CatalogProduct[] {
  const rest = products.filter((p) => p.id !== product.id)
  return [...rest, product].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

export function catalogReducer(state: CatalogState, action: CatalogAction): CatalogState {
  switch (action.type) {
    case 'loaded': {
      if (action.query !== state.query.trim() || action.includeInactive !== state.includeInactive) return state
      const last = Math.max(0, catalogRows(action.products).length - 1)
      return { ...state, load: 'ready', products: action.products, selected: Math.min(state.selected, last) }
    }
    case 'failed':
      return { ...state, load: state.load === 'ready' ? 'ready' : 'offline', flash: flash(state, 'error', action.message) }
    case 'query':
      return { ...state, query: action.text, selected: 0 }
    case 'includeInactive':
      return { ...state, includeInactive: action.on, selected: 0 }
    case 'select':
      return { ...state, selected: action.index }
    case 'move': {
      const last = Math.max(0, catalogRows(state.products).length - 1)
      return { ...state, selected: Math.min(last, Math.max(0, state.selected + action.delta)) }
    }
    case 'openNew':
      return { ...state, form: newProductForm(), conflict: null, saveError: null }
    case 'openSelected': {
      const row = catalogRows(state.products)[state.selected]
      if (!row) return state
      return catalogReducer(state, row.kind === 'product' ? { type: 'openEditProduct', product: row.product } : { type: 'openEditSku', product: row.product, sku: row.sku })
    }
    case 'openEditProduct': {
      const { product } = action
      return { ...state, form: { kind: 'editProduct', product, name: product.name, category: product.category, isActive: product.isActive }, conflict: null, saveError: null }
    }
    case 'openEditSku':
      return { ...state, form: { kind: 'editSku', product: action.product, sku: action.sku, isActive: action.sku.isActive, ...skuFields(action.sku) }, conflict: null, saveError: null }
    case 'openAddSku': {
      const taken = new Set(action.product.skus.map((s) => s.sizeCode))
      const sizeCode = SIZE_ORDER.find((s) => !taken.has(s)) ?? null
      if (!action.product.isActive) return { ...state, flash: flash(state, 'error', `${action.product.name} is inactive — reactivate it first`) }
      if (sizeCode === null) return { ...state, flash: flash(state, 'error', `${action.product.name} already has every size`) }
      return {
        ...state,
        form: { kind: 'addSku', product: action.product, sizeCode, ...EMPTY_SIZE, caseSize: String(DEFAULT_CASE_SIZE[sizeCode]) },
        conflict: null,
        saveError: null,
      }
    }
    case 'field': {
      if (!state.form) return state
      const { type: _type, ...change } = action
      const clears = state.conflict !== null && (change.field === state.conflict || (state.conflict === 'size' && change.field === 'sizeCode'))
      return { ...state, form: applyField(state.form, change as FormField), conflict: clears ? null : state.conflict, saveError: null }
    }
    case 'close':
      return state.submitting ? state : { ...state, form: null, conflict: null, saveError: null }
    case 'submitting':
      return { ...state, submitting: action.on }
    case 'saved': {
      const products = upsert(state.products, action.product)
      const selected = Math.max(0, catalogRows(products).findIndex((r) => r.kind === 'product' && r.product.id === action.product.id))
      return { ...state, products, selected, form: null, conflict: null, saveError: null, submitting: false, flash: flash(state, 'ok', action.text) }
    }
    case 'conflict': {
      const text = action.field ? CONFLICT_TEXT[action.field] : action.message
      return { ...state, submitting: false, conflict: action.field, saveError: text, flash: flash(state, 'error', text) }
    }
    case 'flash':
      return { ...state, flash: flash(state, action.kind, action.text) }
  }
}
