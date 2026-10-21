/**
 * Inventory Catalog state (Phase 20: a flat, stock-report catalog). Pure and unit-tested: items grouped
 * under their item category (FULL, HALF, QUARTER, BEER…), client-side search across every category,
 * selection over item rows, and the New Item / Edit Item forms. Prices are parsed to whole paise and
 * quantities to whole numbers; no floats.
 */
import type { CatalogItem, Department, DepartmentCode, ExciseGroup, ItemCategory, ItemPatchPayload, NewItemPayload, Paise, SizeCode } from '../api/types'
import type { Flash } from '../billing/billingReducer'
import { paiseToRupeeInput, parseRupeesToPaise } from '../lib/money'
import { SIZE_ORDER, sizeNameFor } from '../lib/ui'

/** Bottles per case pre-filled for a size (Indian distribution cases); editable. */
export const DEFAULT_CASE_SIZE: Readonly<Record<SizeCode, number>> = { FULL: 12, HALF: 32, QUARTER: 64, BEER_650: 12, BEER_330: 24, UNIT: 1 }
export const MAX_CASE_SIZE = 1000
export const MAX_OPENING_QTY = 100_000
/** Phase 26: unit labels — 1–20 characters; quick choices in the item form. */
export const MAX_UNIT_NAME = 20
export const PURCHASE_UNIT_CHOICES = ['Case', 'Packet', 'Carton', 'Box', 'Crate'] as const
export const SALE_UNIT_CHOICES = ['Bottle', 'Stick', 'Packet', 'Can', 'Unit'] as const

/** A new brand's selling unit: bottles in the bottle centers, else "Unit" (as the server defaults). */
export function defaultSaleUnit(department: DepartmentCode): string {
  return department === 'LIQUOR' || department === 'COOL_DRINKS' || department === 'WATER' ? 'Bottle' : 'Unit'
}

const SIZE_SUFFIX: Readonly<Record<SizeCode, string>> = { FULL: 'F', HALF: 'H', QUARTER: 'Q', BEER_650: '650', BEER_330: '330', UNIT: 'U' }
const MAX_NAME = 80

/** Sizes a department offers: a dish is a Full / Half plate or a single size, never a bottle size. */
export function sizesFor(department: DepartmentCode): readonly SizeCode[] {
  return department === 'KITCHEN' ? SIZE_ORDER.filter((s) => s === 'FULL' || s === 'HALF' || s === 'UNIT') : SIZE_ORDER
}

/** Kitchen items are not counted in cases (or at all): their case size is always 1. */
export function defaultCaseSize(size: SizeCode, department: DepartmentCode): number {
  return department === 'KITCHEN' ? 1 : DEFAULT_CASE_SIZE[size]
}

/**
 * The sizes the New Item form lets the operator choose in a category: every size when it has no
 * default, both beers in a beer category, plates in a Kitchen one; otherwise none (the default is
 * the size, e.g. QUARTER).
 */
export function sizeChoices(category: ItemCategory, department: DepartmentCode): readonly SizeCode[] {
  if (category.defaultSizeCode === null) return sizesFor(department)
  if (department === 'KITCHEN') return sizesFor('KITCHEN')
  if (category.defaultSizeCode === 'BEER_650' || category.defaultSizeCode === 'BEER_330') return ['BEER_650', 'BEER_330']
  return []
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

const tidy = (name: string) => name.trim().replace(/\s+/g, ' ')

// ── Brands ──

export interface BrandInfo {
  name: string
  department: DepartmentCode
  /** Sizes the brand already has. */
  sizes: SizeCode[]
  /** Its SKU code prefix ("1848" from "1848-Q"). */
  prefix: string
  /** Its first size's unit names (a new size takes them). */
  purchaseUnitName: string
  saleUnitName: string
}

/** The existing brand a typed name belongs to (case-insensitive), from the loaded items. */
export function existingBrand(items: readonly CatalogItem[], name: string): BrandInfo | null {
  const key = tidy(name).toLowerCase()
  if (key === '') return null
  const mine = items.filter((i) => i.brandName.toLowerCase() === key)
  const first = mine[0]
  if (!first) return null
  const dash = first.skuCode.lastIndexOf('-')
  return {
    name: first.brandName,
    department: first.department,
    sizes: mine.map((i) => i.sizeCode),
    prefix: dash > 0 ? first.skuCode.slice(0, dash) : '',
    purchaseUnitName: first.purchaseUnitName,
    saleUnitName: first.saleUnitName,
  }
}

// ── Forms ──

export interface NewItemForm {
  kind: 'new'
  categoryId: string
  name: string
  sizeCode: SizeCode | null
  sale: string
  buy: string
  caseSize: string
  /** Once edited, the case size stops following the size. */
  caseTouched: boolean
  /** Bought as ("Case") / sold as ("Bottle"); they follow the brand or center until edited. */
  purchaseUnit: string
  saleUnit: string
  unitsTouched: boolean
  barcode: string
  codePrefix: string
  /** Once edited, the prefix stops following the name. */
  prefixTouched: boolean
  opening: string
  /** New brands only; pre-selected from the category until the operator picks one. */
  department: DepartmentCode
  departmentTouched: boolean
}

export interface EditItemForm {
  kind: 'edit'
  item: CatalogItem
  name: string
  categoryId: string
  sale: string
  buy: string
  caseSize: string
  purchaseUnit: string
  saleUnit: string
  barcode: string
  isActive: boolean
  /** Nominal ml of one sealed bottle, for the excise ML summary ('' = not a bottle). */
  volume: string
  /** '' = not in the excise ML summary. */
  exciseGroup: ExciseGroup | ''
}

export type ItemForm = NewItemForm | EditItemForm

/** Excise ML-summary groups (Phase 24 R2), in report order. */
export const EXCISE_GROUP_OPTIONS: ReadonlyArray<{ value: ExciseGroup; label: string }> = [
  { value: 'LIQUOR', label: 'Liquor' },
  { value: 'BEER', label: 'Beer' },
  { value: 'TIN_BEER', label: 'Tin beer' },
  { value: 'WINE', label: 'Wine' },
]

export const MAX_VOLUME_ML = 5000

export type ItemField =
  | { field: 'categoryId' | 'name' | 'sale' | 'buy' | 'caseSize' | 'purchaseUnit' | 'saleUnit' | 'barcode' | 'codePrefix' | 'opening' | 'volume'; value: string }
  | { field: 'exciseGroup'; value: ExciseGroup | '' }
  | { field: 'sizeCode'; value: SizeCode }
  | { field: 'department'; value: DepartmentCode }
  | { field: 'isActive'; value: boolean }

/** Which field a duplicate (PS012) was about, from the constraint that fired. */
export type ConflictField = 'name' | 'codePrefix' | 'barcode' | 'size'

const CONFLICT_BY_CONSTRAINT: Readonly<Record<string, ConflictField>> = {
  products_name_unique: 'name',
  skus_sku_code_unique: 'codePrefix',
  skus_barcode_unique: 'barcode',
  skus_product_size_unique: 'size',
}

const CONFLICT_TEXT: Readonly<Record<ConflictField, string>> = {
  name: 'An item with this name already exists',
  codePrefix: 'That SKU code is already used — choose another code prefix',
  barcode: 'That barcode is already on another item',
  size: 'This brand already has that size — edit that item instead',
}

export function conflictField(constraint: string | undefined): ConflictField | null {
  return constraint === undefined ? null : (CONFLICT_BY_CONSTRAINT[constraint] ?? null)
}

// ── State ──

export interface CatalogState {
  load: 'loading' | 'ready' | 'offline'
  /** Every item, inactive included; filtered and grouped client-side. */
  items: CatalogItem[]
  /** Every category, disabled included, in report order. */
  categories: ItemCategory[]
  /** Every revenue center (Phase 22), disabled included, for the department switch and labels. */
  departments: Department[]
  query: string
  includeInactive: boolean
  selectedId: string | null
  form: ItemForm | null
  conflict: ConflictField | null
  /** Why the last save was refused, shown inside the open form; cleared on the next edit. */
  saveError: string | null
  submitting: boolean
  flash: Flash | null
}

export const initialCatalogState: CatalogState = {
  load: 'loading',
  items: [],
  categories: [],
  departments: [],
  query: '',
  includeInactive: false,
  selectedId: null,
  form: null,
  conflict: null,
  saveError: null,
  submitting: false,
  flash: null,
}

export type CatalogAction =
  | { type: 'loaded'; items: CatalogItem[]; categories: ItemCategory[]; departments?: Department[] }
  | { type: 'failed'; message: string }
  | { type: 'query'; text: string }
  | { type: 'includeInactive'; on: boolean }
  | { type: 'select'; id: string }
  | { type: 'move'; delta: number }
  /** New item in the given category, else the highlighted row's, else the first active one. */
  | { type: 'openNew'; categoryId?: string }
  | { type: 'openSelected' }
  | { type: 'openEdit'; item: CatalogItem }
  | ({ type: 'field' } & ItemField)
  | { type: 'close' }
  | { type: 'submitting'; on: boolean }
  /** A save went through: the server's copy of the item replaces the list's. */
  | { type: 'saved'; item: CatalogItem; text: string }
  | { type: 'conflict'; field: ConflictField | null; message: string }
  | { type: 'flash'; kind: Flash['kind']; text: string }

// ── Rows ──

export type CatalogRow = { kind: 'header'; category: ItemCategory; count: number; onHand: number } | { kind: 'item'; item: CatalogItem }

/** Items the search and the inactive filter let through: name / display name contains, SKU code prefix, exact barcode. */
export function filterItems(items: readonly CatalogItem[], query: string, includeInactive: boolean): CatalogItem[] {
  const text = query.trim().toLowerCase()
  return items.filter((i) => {
    if (!includeInactive && (!i.isActive || !i.brandActive)) return false
    if (text === '') return true
    return i.brandName.toLowerCase().includes(text) || i.displayName.toLowerCase().includes(text) || i.skuCode.toLowerCase().startsWith(text) || i.barcode === query.trim()
  })
}

/** Category headers (report order) each followed by its items; categories with nothing to show are left out. */
export function catalogRows(state: Pick<CatalogState, 'items' | 'categories' | 'query' | 'includeInactive'>): CatalogRow[] {
  const shown = filterItems(state.items, state.query, state.includeInactive)
  const order = [...state.categories].sort((a, b) => a.sortOrder - b.sortOrder)
  return order.flatMap((category): CatalogRow[] => {
    const mine = shown.filter((i) => i.itemCategory.id === category.id)
    if (mine.length === 0) return []
    const onHand = mine.reduce((n, i) => n + (i.tracksStock ? i.onHandQty : 0), 0)
    return [{ kind: 'header', category, count: mine.length, onHand }, ...mine.map((item) => ({ kind: 'item' as const, item }))]
  })
}

function itemIds(state: CatalogState): string[] {
  return catalogRows(state).flatMap((r) => (r.kind === 'item' ? [r.item.id] : []))
}

/** The highlighted item: the selected one while shown, else the first shown. Derived, so filters never strand it. */
export function selectedItem(state: CatalogState): CatalogItem | null {
  const rows = catalogRows(state).flatMap((r) => (r.kind === 'item' ? [r.item] : []))
  return rows.find((i) => i.id === state.selectedId) ?? rows[0] ?? null
}

// ── Validation and payloads ──

/** The department a new item gets: its existing brand's, else the form's. */
export function effectiveDepartment(form: NewItemForm, items: readonly CatalogItem[]): DepartmentCode {
  return existingBrand(items, form.name)?.department ?? form.department
}

interface ParsedFields {
  salePrice: Paise
  purchasePrice: Paise | null
  caseSize: number
  purchaseUnitName: string
  saleUnitName: string
  barcode: string | null
}

function parseFields(
  f: { sale: string; buy: string; caseSize: string; purchaseUnit: string; saleUnit: string; barcode: string },
  department: DepartmentCode,
): ParsedFields | string {
  const sale = parseRupeesToPaise(f.sale)
  if (f.sale.trim() === '' || sale === null) return 'Enter the sale price'
  if (sale <= 0n) return 'The sale price must be more than ₹0'
  let purchasePrice: Paise | null = null
  if (f.buy.trim() !== '') {
    purchasePrice = parseRupeesToPaise(f.buy)
    if (purchasePrice === null) return 'Enter the purchase price in rupees, or leave it empty'
  }
  const caseSize = department === 'KITCHEN' ? 1 : Number(f.caseSize)
  if (department !== 'KITCHEN' && (!/^\d+$/.test(f.caseSize.trim()) || caseSize < 1 || caseSize > MAX_CASE_SIZE)) {
    return `Units per ${tidy(f.purchaseUnit).toLowerCase() || 'case'} must be 1 to ${MAX_CASE_SIZE}`
  }
  const purchaseUnitName = tidy(f.purchaseUnit)
  const saleUnitName = tidy(f.saleUnit)
  if (purchaseUnitName === '' || purchaseUnitName.length > MAX_UNIT_NAME) return `Name the purchase unit (e.g. Case, Packet), up to ${MAX_UNIT_NAME} characters`
  if (saleUnitName === '' || saleUnitName.length > MAX_UNIT_NAME) return `Name the selling unit (e.g. Bottle, Stick), up to ${MAX_UNIT_NAME} characters`
  const barcode = f.barcode.trim()
  if (/\s/.test(barcode) || barcode.length > 40) return 'Barcode must be up to 40 characters with no spaces'
  return { salePrice: sale, purchasePrice, caseSize, purchaseUnitName, saleUnitName, barcode: barcode === '' ? null : barcode }
}

function checkName(name: string): string | null {
  const text = tidy(name)
  if (text === '') return 'Enter the item name'
  if (text.length > MAX_NAME) return `Name must be at most ${MAX_NAME} characters`
  return null
}

/** The payload for a new item, or the first problem with the form. */
export function newItemPayload(form: NewItemForm, items: readonly CatalogItem[], categories: readonly ItemCategory[]): NewItemPayload | string {
  const category = categories.find((c) => c.id === form.categoryId)
  if (!category) return 'Choose a category'
  if (!category.isActive) return `${category.name} is disabled — choose another category`
  const nameError = checkName(form.name)
  if (nameError) return nameError
  if (form.sizeCode === null) return 'Choose a size'
  const brand = existingBrand(items, form.name)
  const department = brand?.department ?? form.department
  if (brand?.sizes.includes(form.sizeCode)) return `${brand.name} already has a ${sizeNameFor(form.sizeCode, department)} — edit it instead`
  let prefix: string | undefined
  if (!brand) {
    prefix = form.codePrefix.trim().toUpperCase()
    if (!/^[A-Z0-9]{2,10}$/.test(prefix)) return 'Code prefix must be 2–10 letters or digits, e.g. 1848'
  }
  const parsed = parseFields(form, department)
  if (typeof parsed === 'string') return parsed
  let openingQty: number | undefined
  if (form.opening.trim() !== '') {
    if (department === 'KITCHEN') return 'Kitchen items have no stock'
    openingQty = Number(form.opening)
    if (!/^\d+$/.test(form.opening.trim()) || openingQty > MAX_OPENING_QTY) return `Opening stock must be 0 to ${MAX_OPENING_QTY} bottles`
    if (openingQty === 0) openingQty = undefined
  }
  return {
    categoryId: category.id,
    name: tidy(form.name),
    sizeCode: form.sizeCode,
    salePrice: parsed.salePrice,
    purchasePrice: parsed.purchasePrice,
    caseSize: parsed.caseSize,
    barcode: parsed.barcode,
    purchaseUnitName: parsed.purchaseUnitName,
    saleUnitName: parsed.saleUnitName,
    ...(prefix ? { codePrefix: prefix } : {}),
    ...(openingQty ? { openingQty } : {}),
    ...(brand ? {} : { department }),
  }
}

/** The changed fields of an item edit (empty when nothing changed), or an error. */
export function itemPatch(form: EditItemForm, categories: readonly ItemCategory[]): ItemPatchPayload | string {
  const nameError = checkName(form.name)
  if (nameError) return nameError
  const parsed = parseFields(form, form.item.department)
  if (typeof parsed === 'string') return parsed
  const { item } = form
  const patch: ItemPatchPayload = {}
  const name = tidy(form.name)
  if (name !== item.brandName) patch.name = name
  if (form.categoryId !== item.itemCategory.id) {
    const category = categories.find((c) => c.id === form.categoryId)
    if (!category?.isActive) return 'Choose an active category'
    patch.categoryId = form.categoryId
  }
  if (parsed.salePrice !== item.pricePaise) patch.salePrice = parsed.salePrice
  if (parsed.purchasePrice !== item.purchasePricePaise) patch.purchasePrice = parsed.purchasePrice
  if (parsed.caseSize !== item.caseSize) patch.caseSize = parsed.caseSize
  if (parsed.purchaseUnitName !== item.purchaseUnitName) patch.purchaseUnitName = parsed.purchaseUnitName
  if (parsed.saleUnitName !== item.saleUnitName) patch.saleUnitName = parsed.saleUnitName
  if (parsed.barcode !== item.barcode) patch.barcode = parsed.barcode
  if (form.isActive !== item.isActive) patch.isActive = form.isActive
  const volumeText = form.volume.trim()
  const volume = volumeText === '' ? null : Number(volumeText)
  if (volume !== null && (!/^\d+$/.test(volumeText) || volume < 1 || volume > MAX_VOLUME_ML)) return `Bottle volume must be a whole number of ml, 1 to ${MAX_VOLUME_ML}`
  if (volume !== item.volumeMl) patch.volumeMl = volume
  const group = form.exciseGroup === '' ? null : form.exciseGroup
  if (group !== null && volume === null) return 'Enter the bottle volume for an excise group'
  if (group !== item.exciseGroup) patch.exciseGroup = group
  return patch
}

/** The form's current blocking problem, or null when it can be saved. */
export function formError(state: Pick<CatalogState, 'items' | 'categories'>, form: ItemForm): string | null {
  const result = form.kind === 'new' ? newItemPayload(form, state.items, state.categories) : itemPatch(form, state.categories)
  return typeof result === 'string' ? result : null
}

/** True when the save would retire an item that is active now (the modal asks to confirm). */
export function deactivates(form: ItemForm): boolean {
  return form.kind === 'edit' && form.item.isActive && !form.isActive
}

// ── Reducer ──

function flash(state: CatalogState, kind: Flash['kind'], text: string): Flash {
  return { kind, text, seq: (state.flash?.seq ?? 0) + 1 }
}

function newItemForm(category: ItemCategory | undefined): NewItemForm {
  const department = category?.defaultDepartment ?? 'LIQUOR'
  const sizeCode = category?.defaultSizeCode ?? null
  return {
    kind: 'new',
    categoryId: category?.id ?? '',
    name: '',
    sizeCode,
    sale: '',
    buy: '',
    caseSize: sizeCode ? String(defaultCaseSize(sizeCode, department)) : '',
    caseTouched: false,
    purchaseUnit: 'Case',
    saleUnit: defaultSaleUnit(department),
    unitsTouched: false,
    barcode: '',
    codePrefix: '',
    prefixTouched: false,
    opening: '',
    department,
    departmentTouched: false,
  }
}

function editItemForm(item: CatalogItem): EditItemForm {
  return {
    kind: 'edit',
    item,
    name: item.brandName,
    categoryId: item.itemCategory.id,
    sale: paiseToRupeeInput(item.pricePaise),
    buy: item.purchasePricePaise === null ? '' : paiseToRupeeInput(item.purchasePricePaise),
    caseSize: String(item.caseSize),
    purchaseUnit: item.purchaseUnitName,
    saleUnit: item.saleUnitName,
    barcode: item.barcode ?? '',
    isActive: item.isActive,
    volume: item.volumeMl === null ? '' : String(item.volumeMl),
    exciseGroup: item.exciseGroup ?? '',
  }
}

/**
 * Keeps the size (and its case size) consistent with the department the new item will have, and
 * untouched unit names on the brand's (an existing brand) or the center's defaults.
 */
function settleSize(form: NewItemForm, department: DepartmentCode, brand: BrandInfo | null = null): NewItemForm {
  const sizeCode = form.sizeCode && sizesFor(department).includes(form.sizeCode) ? form.sizeCode : null
  const caseSize = form.caseTouched || !sizeCode ? form.caseSize : String(defaultCaseSize(sizeCode, department))
  const units = form.unitsTouched
    ? {}
    : { purchaseUnit: brand?.purchaseUnitName ?? 'Case', saleUnit: brand?.saleUnitName ?? defaultSaleUnit(department) }
  return { ...form, sizeCode, caseSize, ...units }
}

function applyField(state: CatalogState, form: ItemForm, change: ItemField): ItemForm {
  if (form.kind === 'edit') {
    switch (change.field) {
      case 'name':
      case 'categoryId':
      case 'sale':
      case 'buy':
      case 'barcode':
        return { ...form, [change.field]: cleanInput(change.field, change.value) }
      case 'caseSize':
        return { ...form, caseSize: cleanInput('caseSize', change.value) }
      case 'purchaseUnit':
      case 'saleUnit':
        return { ...form, [change.field]: change.value.slice(0, MAX_UNIT_NAME + 5) }
      case 'isActive':
        return { ...form, isActive: change.value }
      case 'volume':
        return { ...form, volume: change.value.replace(/\D/g, '').slice(0, 4) }
      case 'exciseGroup':
        return { ...form, exciseGroup: change.value }
      default:
        return form
    }
  }
  switch (change.field) {
    case 'categoryId': {
      const category = state.categories.find((c) => c.id === change.value)
      if (!category) return form
      const department = form.departmentTouched ? form.department : category.defaultDepartment
      const next: NewItemForm = { ...form, categoryId: category.id, department, sizeCode: category.defaultSizeCode ?? form.sizeCode, caseTouched: false }
      const brand = existingBrand(state.items, form.name)
      return settleSize(next, brand?.department ?? department, brand)
    }
    case 'name': {
      const brand = existingBrand(state.items, change.value)
      const codePrefix = brand ? brand.prefix : form.prefixTouched ? form.codePrefix : suggestPrefix(change.value)
      return settleSize({ ...form, name: change.value, codePrefix }, brand?.department ?? form.department, brand)
    }
    case 'sizeCode': {
      const department = effectiveDepartment(form, state.items)
      return { ...form, sizeCode: change.value, caseSize: form.caseTouched ? form.caseSize : String(defaultCaseSize(change.value, department)) }
    }
    case 'department': {
      const brand = existingBrand(state.items, form.name)
      return settleSize({ ...form, department: change.value, departmentTouched: true }, brand?.department ?? change.value, brand)
    }
    case 'purchaseUnit':
    case 'saleUnit':
      return { ...form, [change.field]: change.value.slice(0, MAX_UNIT_NAME + 5), unitsTouched: true }
    case 'codePrefix':
      return { ...form, codePrefix: change.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10), prefixTouched: true }
    case 'caseSize':
      return { ...form, caseSize: cleanInput('caseSize', change.value), caseTouched: true }
    case 'opening':
      return { ...form, opening: change.value.replace(/\D/g, '').slice(0, 6) }
    case 'sale':
    case 'buy':
    case 'barcode':
      return { ...form, [change.field]: cleanInput(change.field, change.value) }
    default:
      return form
  }
}

function cleanInput(field: string, value: string): string {
  if (field === 'caseSize') return value.replace(/\D/g, '').slice(0, 4)
  if (field === 'barcode') return value.trim()
  if (field === 'sale' || field === 'buy') return value.replace(/[^\d.,]/g, '')
  return value
}

/** Replaces (or adds) an item in the list after a save, keeping report order by category, brand and size. */
function upsert(state: CatalogState, item: CatalogItem): CatalogItem[] {
  const order = new Map(state.categories.map((c) => [c.id, c.sortOrder]))
  const rest = state.items.filter((i) => i.id !== item.id)
  return [...rest, item].sort(
    (a, b) =>
      (order.get(a.itemCategory.id) ?? 0) - (order.get(b.itemCategory.id) ?? 0) ||
      a.brandName.toLowerCase().localeCompare(b.brandName.toLowerCase()) ||
      SIZE_ORDER.indexOf(a.sizeCode) - SIZE_ORDER.indexOf(b.sizeCode),
  )
}

export function catalogReducer(state: CatalogState, action: CatalogAction): CatalogState {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        load: 'ready',
        items: action.items,
        categories: [...action.categories].sort((a, b) => a.sortOrder - b.sortOrder),
        departments: action.departments ?? state.departments,
      }
    case 'failed':
      return { ...state, load: state.load === 'ready' ? 'ready' : 'offline', flash: flash(state, 'error', action.message) }
    case 'query':
      return { ...state, query: action.text }
    case 'includeInactive':
      return { ...state, includeInactive: action.on }
    case 'select':
      return { ...state, selectedId: action.id }
    case 'move': {
      const ids = itemIds(state)
      if (ids.length === 0) return state
      const at = Math.max(0, ids.indexOf(selectedItem(state)?.id ?? ''))
      return { ...state, selectedId: ids[Math.min(ids.length - 1, Math.max(0, at + action.delta))] ?? null }
    }
    case 'openNew': {
      const active = state.categories.filter((c) => c.isActive)
      const wanted = action.categoryId ?? selectedItem(state)?.itemCategory.id
      const category = active.find((c) => c.id === wanted) ?? active[0]
      if (!category) return { ...state, flash: flash(state, 'error', 'Add an item category first (Settings → Item Categories)') }
      return { ...state, form: newItemForm(category), conflict: null, saveError: null }
    }
    case 'openSelected': {
      const item = selectedItem(state)
      return item ? catalogReducer(state, { type: 'openEdit', item }) : state
    }
    case 'openEdit':
      return { ...state, selectedId: action.item.id, form: editItemForm(action.item), conflict: null, saveError: null }
    case 'field': {
      if (!state.form) return state
      const { type: _type, ...change } = action
      const clears =
        state.conflict !== null &&
        (change.field === state.conflict || (state.conflict === 'size' && (change.field === 'sizeCode' || change.field === 'name')) || (state.conflict === 'name' && change.field === 'name'))
      return { ...state, form: applyField(state, state.form, change as ItemField), conflict: clears ? null : state.conflict, saveError: null }
    }
    case 'close':
      return state.submitting ? state : { ...state, form: null, conflict: null, saveError: null }
    case 'submitting':
      return { ...state, submitting: action.on }
    case 'saved':
      return {
        ...state,
        items: upsert(state, action.item),
        selectedId: action.item.id,
        form: null,
        conflict: null,
        saveError: null,
        submitting: false,
        flash: flash(state, 'ok', action.text),
      }
    case 'conflict': {
      const text = action.field ? CONFLICT_TEXT[action.field] : action.message
      return { ...state, submitting: false, conflict: action.field, saveError: text, flash: flash(state, 'error', text) }
    }
    case 'flash':
      return { ...state, flash: flash(state, action.kind, action.text) }
  }
}
