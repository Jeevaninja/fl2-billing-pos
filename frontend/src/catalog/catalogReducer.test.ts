import { describe, expect, it } from 'vitest'
import type { CatalogItem, ItemCategory } from '../api/types'
import {
  catalogReducer,
  catalogRows,
  conflictField,
  deactivates,
  existingBrand,
  filterItems,
  formError,
  initialCatalogState,
  itemPatch,
  newItemPayload,
  selectedItem,
  sizeChoices,
  suggestPrefix,
  type CatalogAction,
  type CatalogState,
  type EditItemForm,
  type NewItemForm,
} from './catalogReducer'

const run = (state: CatalogState, ...actions: CatalogAction[]) => actions.reduce(catalogReducer, state)

function category(id: string, name: string, sortOrder: number, over: Partial<ItemCategory> = {}): ItemCategory {
  return { id, name, sortOrder, isActive: true, defaultSizeCode: null, defaultDepartment: 'LIQUOR', systemKey: null, itemCount: 0, onHandQty: 0, ...over }
}

const FULL = category('c-full', 'FULL', 1, { defaultSizeCode: 'FULL' })
const QUARTER = category('c-qtr', 'QUARTER', 2, { defaultSizeCode: 'QUARTER' })
const BEER = category('c-beer', 'BEER', 3, { defaultSizeCode: 'BEER_650' })
const FOOD = category('c-food', 'FOOD', 4, { defaultSizeCode: 'UNIT', defaultDepartment: 'KITCHEN' })
const CATEGORIES = [BEER, FOOD, FULL, QUARTER] // arrives out of order: the reducer sorts

function item(id: string, brandName: string, cat: ItemCategory, over: Partial<CatalogItem> = {}): CatalogItem {
  const sizeCode = over.sizeCode ?? cat.defaultSizeCode ?? 'FULL'
  return {
    id,
    skuCode: `${brandName.slice(0, 4).toUpperCase()}-${sizeCode[0]}`,
    barcode: null,
    displayName: `${brandName} — ${sizeCode}`,
    sizeCode,
    pricePaise: 1000_00n,
    purchasePricePaise: null,
    caseSize: 12,
    onHandQty: 10,
    isActive: true,
    department: cat.defaultDepartment,
    departmentName: cat.defaultDepartment === 'KITCHEN' ? 'Kitchen' : 'Liquor',
    tracksStock: cat.defaultDepartment !== 'KITCHEN',
    itemCategory: { id: cat.id, name: cat.name },
    productId: `p-${brandName}`,
    brandName,
    productCategory: 'WHISKY',
    brandActive: true,
    volumeMl: null,
    exciseGroup: null,
    ...over,
  }
}

const ITEMS = [
  item('i1', '1848', FULL, { skuCode: '1848-F', onHandQty: 36, barcode: '8901848' }),
  item('i2', 'Royal Stag', FULL, { skuCode: 'ROST-F', onHandQty: 12 }),
  item('i3', '1848', QUARTER, { skuCode: '1848-Q', onHandQty: 64 }),
  item('i4', 'Old Monk', QUARTER, { skuCode: 'OLMO-Q', isActive: false }),
  item('i5', 'Momos', FOOD, { skuCode: 'MOMO-U', onHandQty: 0 }),
]

const ready = run(initialCatalogState, { type: 'loaded', items: ITEMS, categories: CATEGORIES })
const newForm = (s: CatalogState) => s.form as NewItemForm

describe('grouping and search', () => {
  it('lists items under category headers in report order, with counts and stock; empty categories drop out', () => {
    const rows = catalogRows(ready)
    expect(rows.map((r) => (r.kind === 'header' ? `# ${r.category.name} ${r.count}/${r.onHand}` : r.item.skuCode))).toEqual([
      '# FULL 2/48',
      '1848-F',
      'ROST-F',
      '# QUARTER 1/64',
      '1848-Q',
      '# FOOD 1/0',
      'MOMO-U',
    ])
    expect(catalogRows({ ...ready, includeInactive: true }).filter((r) => r.kind === 'item')).toHaveLength(5)
  })

  it('searches across every category: name, SKU code prefix, exact barcode', () => {
    expect(filterItems(ITEMS, '1848', false).map((i) => i.id)).toEqual(['i1', 'i3'])
    expect(filterItems(ITEMS, 'rost-', false).map((i) => i.id)).toEqual(['i2'])
    expect(filterItems(ITEMS, '8901848', false).map((i) => i.id)).toEqual(['i1'])
    expect(catalogRows({ ...ready, query: 'momo' }).map((r) => r.kind)).toEqual(['header', 'item'])
  })

  it('moves the selection over items only, skipping headers, and keeps it while shown', () => {
    expect(selectedItem(ready)?.id).toBe('i1')
    const moved = run(ready, { type: 'move', delta: 1 }, { type: 'move', delta: 1 })
    expect(selectedItem(moved)?.id).toBe('i3') // past the QUARTER header
    expect(selectedItem(run(moved, { type: 'move', delta: 9 }))?.id).toBe('i5')
    expect(selectedItem(run(moved, { type: 'query', text: 'royal' }))?.id).toBe('i2') // filtered out → first shown
  })
})

describe('new item', () => {
  it('opens in the highlighted category with its default size, department and case size', () => {
    const inQuarter = run(ready, { type: 'select', id: 'i3' }, { type: 'openNew' })
    expect(newForm(inQuarter)).toMatchObject({ categoryId: 'c-qtr', sizeCode: 'QUARTER', caseSize: '64', department: 'LIQUOR' })
    const food = run(ready, { type: 'openNew', categoryId: 'c-food' })
    expect(newForm(food)).toMatchObject({ sizeCode: 'UNIT', caseSize: '1', department: 'KITCHEN' })
    // Switching category re-derives the size and department.
    expect(newForm(run(food, { type: 'field', field: 'categoryId', value: 'c-beer' }))).toMatchObject({ sizeCode: 'BEER_650', caseSize: '12', department: 'LIQUOR' })
  })

  it('builds the payload for a new brand with a suggested prefix and opening stock', () => {
    const state = run(
      ready,
      { type: 'openNew', categoryId: 'c-qtr' },
      { type: 'field', field: 'name', value: '  Magic   Moments ' },
      { type: 'field', field: 'sale', value: '300' },
      { type: 'field', field: 'buy', value: '210.50' },
      { type: 'field', field: 'opening', value: '48' },
    )
    expect(newForm(state).codePrefix).toBe('MAMO')
    expect(newItemPayload(newForm(state), ITEMS, CATEGORIES)).toEqual({
      categoryId: 'c-qtr',
      name: 'Magic Moments',
      sizeCode: 'QUARTER',
      salePrice: 300_00n,
      purchasePrice: 210_50n,
      caseSize: 64,
      barcode: null,
      codePrefix: 'MAMO',
      openingQty: 48,
      department: 'LIQUOR',
    })
    expect(suggestPrefix('1848')).toBe('1848')
  })

  it('adds a size to an existing brand: its prefix and department, no duplicate size', () => {
    const half = run(ready, { type: 'openNew', categoryId: 'c-beer' }, { type: 'field', field: 'name', value: '1848' }, { type: 'field', field: 'sale', value: '250' })
    expect(existingBrand(ITEMS, '1848 ')).toEqual({ name: '1848', department: 'LIQUOR', sizes: ['FULL', 'QUARTER'], prefix: '1848' })
    const payload = newItemPayload(newForm(half), ITEMS, CATEGORIES)
    expect(payload).toMatchObject({ name: '1848', sizeCode: 'BEER_650' })
    expect(payload).not.toHaveProperty('codePrefix')
    expect(payload).not.toHaveProperty('department')
    const dup = run(ready, { type: 'openNew', categoryId: 'c-qtr' }, { type: 'field', field: 'name', value: '1848' }, { type: 'field', field: 'sale', value: '400' })
    expect(formError(dup, dup.form!)).toBe('1848 already has a Quarter 180ml — edit it instead')
  })

  it('offers sizes only where a choice exists, and refuses stock for Kitchen items', () => {
    expect(sizeChoices(QUARTER, 'LIQUOR')).toEqual([])
    expect(sizeChoices(BEER, 'LIQUOR')).toEqual(['BEER_650', 'BEER_330'])
    expect(sizeChoices(FOOD, 'KITCHEN')).toEqual(['FULL', 'HALF', 'UNIT'])
    expect(sizeChoices(category('c-x', 'SPECIALS', 9), 'LIQUOR')).toHaveLength(6)
    const dish = run(ready, { type: 'openNew', categoryId: 'c-food' }, { type: 'field', field: 'name', value: 'Chilli Paneer' }, { type: 'field', field: 'sale', value: '240' })
    expect(newItemPayload(newForm(dish), ITEMS, CATEGORIES)).toMatchObject({ caseSize: 1, department: 'KITCHEN', sizeCode: 'UNIT' })
    expect(formError(dish, run(dish, { type: 'field', field: 'opening', value: '5' }).form!)).toBe('Kitchen items have no stock')
    // A beer brand chosen into FOOD with a bottle size falls back to choosing a plate.
    const plain = run(ready, { type: 'openNew', categoryId: 'c-beer' }, { type: 'field', field: 'department', value: 'KITCHEN' })
    expect(newForm(plain).sizeCode).toBeNull()
    expect(formError(plain, plain.form!)).toBe('Enter the item name')
  })

  it('validates name, prefix, prices and case size', () => {
    const base = run(ready, { type: 'openNew', categoryId: 'c-full' }, { type: 'field', field: 'name', value: 'Blenders Pride' })
    expect(formError(base, base.form!)).toBe('Enter the sale price')
    const priced = run(base, { type: 'field', field: 'sale', value: '1,450' })
    expect(formError(priced, priced.form!)).toBeNull()
    expect(formError(priced, run(priced, { type: 'field', field: 'codePrefix', value: 'x' }).form!)).toMatch(/Code prefix/)
    expect(formError(priced, run(priced, { type: 'field', field: 'caseSize', value: '1001' }).form!)).toMatch(/Case size/)
    expect(formError(priced, run(priced, { type: 'field', field: 'sale', value: '0' }).form!)).toMatch(/more than ₹0/)
  })
})

describe('edit item and save results', () => {
  it('patches only what changed, including a rename and a category move', () => {
    const state = run(ready, { type: 'openEdit', item: ITEMS[2]! })
    const form = state.form as EditItemForm
    expect(itemPatch(form, CATEGORIES)).toEqual({})
    const edited = run(
      state,
      { type: 'field', field: 'name', value: '1848 Gold' },
      { type: 'field', field: 'categoryId', value: 'c-full' },
      { type: 'field', field: 'sale', value: '420' },
      { type: 'field', field: 'barcode', value: '' },
      { type: 'field', field: 'isActive', value: false },
    )
    expect(itemPatch(edited.form as EditItemForm, CATEGORIES)).toEqual({ name: '1848 Gold', categoryId: 'c-full', salePrice: 420_00n, isActive: false })
    expect(deactivates(edited.form!)).toBe(true)
  })

  it('edits the excise bottle volume and group (whole ml only)', () => {
    const tin = { ...ITEMS[2]!, volumeMl: 330, exciseGroup: 'TIN_BEER' as const }
    const state = run(ready, { type: 'openEdit', item: tin })
    expect(state.form).toMatchObject({ volume: '330', exciseGroup: 'TIN_BEER' })
    const tin500 = run(state, { type: 'field', field: 'volume', value: '500 ml' })
    expect((tin500.form as EditItemForm).volume).toBe('500')
    expect(itemPatch(tin500.form as EditItemForm, CATEGORIES)).toEqual({ volumeMl: 500 })
    const none = run(state, { type: 'field', field: 'volume', value: '' }, { type: 'field', field: 'exciseGroup', value: '' })
    expect(itemPatch(none.form as EditItemForm, CATEGORIES)).toEqual({ volumeMl: null, exciseGroup: null })
    expect(itemPatch(run(state, { type: 'field', field: 'volume', value: '' }).form as EditItemForm, CATEGORIES)).toMatch(/bottle volume/)
    expect(itemPatch(run(state, { type: 'field', field: 'volume', value: '0' }).form as EditItemForm, CATEGORIES)).toMatch(/whole number of ml/)
  })

  it('a save replaces the item in report order and selects it; a duplicate marks the field', () => {
    const open = run(ready, { type: 'openEdit', item: ITEMS[1]! }, { type: 'submitting', on: true })
    const moved = { ...ITEMS[1]!, itemCategory: { id: 'c-qtr', name: 'QUARTER' } }
    const saved = run(open, { type: 'saved', item: moved, text: 'Saved' })
    expect(saved.form).toBeNull()
    expect(saved.selectedId).toBe('i2')
    expect(catalogRows(saved).filter((r) => r.kind === 'item').map((r) => (r.kind === 'item' ? r.item.id : ''))).toEqual(['i1', 'i3', 'i2', 'i5'])

    expect(conflictField('skus_barcode_unique')).toBe('barcode')
    const clash = run(ready, { type: 'openEdit', item: ITEMS[0]! }, { type: 'conflict', field: 'barcode', message: 'x' })
    expect(clash).toMatchObject({ conflict: 'barcode', saveError: 'That barcode is already on another item' })
    expect(run(clash, { type: 'field', field: 'barcode', value: '1' }).conflict).toBeNull()
    expect(run(run(ready, { type: 'openNew' }, { type: 'submitting', on: true }), { type: 'close' }).form).not.toBeNull()
  })
})
