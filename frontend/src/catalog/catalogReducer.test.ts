import { describe, expect, it } from 'vitest'
import type { CatalogProduct, CatalogSku } from '../api/types'
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
  skuPatch,
  suggestPrefix,
  type CatalogAction,
  type CatalogState,
  type EditProductForm,
  type EditSkuForm,
  type NewProductForm,
} from './catalogReducer'

const run = (state: CatalogState, ...actions: CatalogAction[]) => actions.reduce(catalogReducer, state)

function sku(over: Partial<CatalogSku> = {}): CatalogSku {
  return {
    id: 'sku-f',
    productId: 'p-hw',
    skuCode: 'HWHS-F',
    barcode: '8900000000001',
    displayName: 'House Whisky — Full',
    sizeCode: 'FULL',
    pricePaise: 1_800_00n,
    purchasePricePaise: 1_100_00n,
    caseSize: 12,
    onHandQty: 48,
    isActive: true,
    ...over,
  }
}

const WHISKY: CatalogProduct = {
  id: 'p-hw',
  name: 'House Whisky',
  category: 'WHISKY',
  isActive: true,
  skus: [sku(), sku({ id: 'sku-q', skuCode: 'HWHS-Q', barcode: null, displayName: 'House Whisky — Quarter', sizeCode: 'QUARTER', pricePaise: 500_00n, purchasePricePaise: null, caseSize: 64 })],
}
const LAGER: CatalogProduct = {
  id: 'p-lg',
  name: 'House Lager',
  category: 'BEER',
  isActive: true,
  skus: [sku({ id: 'sku-650', productId: 'p-lg', skuCode: 'HLAG-650', barcode: null, displayName: 'House Lager — 650', sizeCode: 'BEER_650', caseSize: 12 })],
}

const ready = run(initialCatalogState, { type: 'loaded', products: [LAGER, WHISKY], query: '', includeInactive: false })

function newForm(state: CatalogState): NewProductForm {
  if (state.form?.kind !== 'newProduct') throw new Error('expected the new-liquor form')
  return state.form
}

describe('list and selection', () => {
  it('flattens liquors and their sizes into rows, and moves the selection within them', () => {
    expect(catalogRows(ready.products).map((r) => (r.kind === 'product' ? r.product.name : r.sku.skuCode))).toEqual([
      'House Lager',
      'HLAG-650',
      'House Whisky',
      'HWHS-F',
      'HWHS-Q',
    ])
    expect(run(ready, { type: 'move', delta: 3 }).selected).toBe(3)
    expect(run(ready, { type: 'move', delta: 99 }).selected).toBe(4)
    expect(run(ready, { type: 'move', delta: -1 }).selected).toBe(0)
  })

  it('drops results for a filter that has moved on', () => {
    const typing = run(ready, { type: 'query', text: 'rum' })
    expect(run(typing, { type: 'loaded', products: [], query: '', includeInactive: false }).products).toHaveLength(2)
    expect(run(typing, { type: 'loaded', products: [], query: 'rum', includeInactive: false }).products).toEqual([])
    const inactive = run(ready, { type: 'includeInactive', on: true })
    expect(run(inactive, { type: 'loaded', products: [], query: '', includeInactive: false }).products).toHaveLength(2)
  })

  it('opens the editor that matches the selected row', () => {
    expect(run(ready, { type: 'select', index: 2 }, { type: 'openSelected' }).form).toMatchObject({ kind: 'editProduct', name: 'House Whisky' })
    expect(run(ready, { type: 'select', index: 4 }, { type: 'openSelected' }).form).toMatchObject({
      kind: 'editSku',
      sale: '500',
      buy: '',
      caseSize: '64',
      barcode: '',
    })
  })

  it('goes offline before the first load, but only flashes once the list is up', () => {
    expect(run(initialCatalogState, { type: 'failed', message: 'down' }).load).toBe('offline')
    expect(run(ready, { type: 'failed', message: 'down' })).toMatchObject({ load: 'ready', flash: { kind: 'error', text: 'down' } })
  })
})

describe('new liquor', () => {
  it('suggests a code prefix from the name until the operator edits it', () => {
    expect(suggestPrefix('Royal Stag')).toBe('ROST')
    expect(suggestPrefix('Kingfisher')).toBe('KING')
    expect(suggestPrefix("  Officer's   Choice Blue ")).toBe('OFCH')
    let state = run(ready, { type: 'openNew' }, { type: 'field', field: 'name', value: 'Royal Stag' })
    expect(newForm(state).codePrefix).toBe('ROST')
    state = run(state, { type: 'field', field: 'codePrefix', value: 'rs-9!' }, { type: 'field', field: 'name', value: 'Royal Stag Barrel' })
    expect(newForm(state).codePrefix).toBe('RS9')
  })

  it('ticking a size pre-fills its case size (12 / 32 / 64)', () => {
    const state = run(
      ready,
      { type: 'openNew' },
      { type: 'field', field: 'sizeOn', size: 'FULL', value: true },
      { type: 'field', field: 'sizeOn', size: 'HALF', value: true },
      { type: 'field', field: 'sizeOn', size: 'QUARTER', value: true },
      { type: 'field', field: 'sizeOn', size: 'BEER_330', value: true },
    )
    const { sizes } = newForm(state)
    expect([sizes.FULL.caseSize, sizes.HALF.caseSize, sizes.QUARTER.caseSize, sizes.BEER_330.caseSize]).toEqual(['12', '32', '64', '24'])
  })

  it('typing a price into an unticked size ticks it with its default case size', () => {
    const typed = run(ready, { type: 'openNew' }, { type: 'field', field: 'sale', size: 'HALF', value: '520' })
    expect(newForm(typed).sizes.HALF).toMatchObject({ on: true, sale: '520', caseSize: '32' })
    const typedCase = run(ready, { type: 'openNew' }, { type: 'field', field: 'caseSize', size: 'HALF', value: '24' })
    expect(newForm(typedCase).sizes.HALF).toMatchObject({ on: true, caseSize: '24' })
  })

  it('validates and builds the payload in paise, only for ticked sizes', () => {
    let state = run(ready, { type: 'openNew' })
    expect(formError(state.form!)).toBe('Enter the liquor name')
    state = run(state, { type: 'field', field: 'name', value: '  Royal   Stag ' })
    expect(formError(state.form!)).toBe('Tick at least one size')
    state = run(state, { type: 'field', field: 'sale', size: 'QUARTER', value: '260' })
    expect(newForm(state).sizes.QUARTER).toMatchObject({ on: true, caseSize: '64' })
    expect(formError(state.form!)).toBeNull()
    state = run(state, { type: 'field', field: 'caseSize', size: 'QUARTER', value: '' })
    expect(formError(state.form!)).toBe('ROST-Q: case size must be 1 to 1000 bottles')
    state = run(state, { type: 'field', field: 'caseSize', size: 'QUARTER', value: '64' })
    expect(formError(state.form!)).toBeNull()
    state = run(
      state,
      { type: 'field', field: 'buy', size: 'QUARTER', value: '180.50' },
      { type: 'field', field: 'barcode', size: 'QUARTER', value: ' 8901111000018 ' },
      { type: 'field', field: 'sizeOn', size: 'FULL', value: true },
      { type: 'field', field: 'sale', size: 'FULL', value: '1,000' },
      { type: 'field', field: 'category', value: 'WHISKY' },
    )
    expect(newProductPayload(newForm(state))).toEqual({
      name: 'Royal Stag',
      category: 'WHISKY',
      codePrefix: 'ROST',
      skus: [
        { sizeCode: 'FULL', salePrice: 1_000_00n, purchasePrice: null, caseSize: 12, barcode: null },
        { sizeCode: 'QUARTER', salePrice: 260_00n, purchasePrice: 180_50n, caseSize: 64, barcode: '8901111000018' },
      ],
    })
  })

  it('refuses a ₹0 sale price, a bad purchase price, a case size over 1000 and a short prefix', () => {
    const base = run(ready, { type: 'openNew' }, { type: 'field', field: 'name', value: 'X Gin' }, { type: 'field', field: 'sizeOn', size: 'FULL', value: true })
    expect(formError(run(base, { type: 'field', field: 'sale', size: 'FULL', value: '0' }).form!)).toBe('XGI-F: the sale price must be more than ₹0')
    const priced = run(base, { type: 'field', field: 'sale', size: 'FULL', value: '900' })
    expect(formError(run(priced, { type: 'field', field: 'buy', size: 'FULL', value: '1.234' }).form!)).toMatch(/purchase price/)
    expect(formError(run(priced, { type: 'field', field: 'caseSize', size: 'FULL', value: '1001' }).form!)).toMatch(/case size/)
    expect(formError(run(priced, { type: 'field', field: 'caseSize', size: 'FULL', value: '0' }).form!)).toMatch(/case size/)
    expect(formError(run(priced, { type: 'field', field: 'codePrefix', value: 'X' }).form!)).toMatch(/Code prefix/)
  })
})

describe('editing', () => {
  it('a liquor patch carries only what changed, and flags deactivation', () => {
    const state = run(ready, { type: 'openEditProduct', product: WHISKY })
    const form = state.form as EditProductForm
    expect(productPatch(form)).toEqual({})
    const renamed = run(state, { type: 'field', field: 'name', value: ' Royal  Whisky ' }, { type: 'field', field: 'isActive', value: false })
    expect(productPatch(renamed.form as EditProductForm)).toEqual({ name: 'Royal Whisky', isActive: false })
    expect(deactivates(renamed.form!)).toBe(true)
    expect(formError(run(state, { type: 'field', field: 'name', value: ' ' }).form!)).toBe('Enter the liquor name')
  })

  it('a size patch carries only what changed; empty purchase price and barcode clear them', () => {
    const state = run(ready, { type: 'openEditSku', product: WHISKY, sku: WHISKY.skus[0]! })
    expect(skuPatch(state.form as EditSkuForm)).toEqual({})
    const edited = run(
      state,
      { type: 'field', field: 'sale', value: '1,950.50' },
      { type: 'field', field: 'buy', value: '' },
      { type: 'field', field: 'caseSize', value: '6' },
      { type: 'field', field: 'barcode', value: '' },
    )
    expect(skuPatch(edited.form as EditSkuForm)).toEqual({ salePrice: 1_950_50n, purchasePrice: null, caseSize: 6, barcode: null })
    expect(deactivates(edited.form!)).toBe(false)
    expect(deactivates(run(edited, { type: 'field', field: 'isActive', value: false }).form!)).toBe(true)
  })

  it('adding a size picks the first missing one with its default case size', () => {
    const state = run(ready, { type: 'openAddSku', product: WHISKY })
    expect(state.form).toMatchObject({ kind: 'addSku', sizeCode: 'HALF', caseSize: '32' })
    const beer = run(state, { type: 'field', field: 'sizeCode', value: 'BEER_330' }, { type: 'field', field: 'sale', value: '150' })
    expect(beer.form).toMatchObject({ sizeCode: 'BEER_330', caseSize: '24' })
    expect(addSkuPayload(beer.form as never)).toEqual({ sizeCode: 'BEER_330', salePrice: 150_00n, purchasePrice: null, caseSize: 24, barcode: null })

    const inactive = run(ready, { type: 'openAddSku', product: { ...WHISKY, isActive: false } })
    expect(inactive.form).toBeNull()
    expect(inactive.flash?.text).toMatch(/inactive/)
  })
})

describe('save results', () => {
  it('a save replaces the liquor in name order, selects it and closes the form', () => {
    const renamed = { ...WHISKY, name: 'Amrut' }
    const state = run(ready, { type: 'openEditProduct', product: WHISKY }, { type: 'submitting', on: true }, { type: 'saved', product: renamed, text: 'Saved Amrut' })
    expect(state.products.map((p) => p.name)).toEqual(['Amrut', 'House Lager'])
    expect(state).toMatchObject({ form: null, submitting: false, selected: 0, flash: { kind: 'ok', text: 'Saved Amrut' } })
  })

  it('a duplicate keeps the form open and marks the clashing field until it is edited', () => {
    expect(conflictField('skus_barcode_unique')).toBe('barcode')
    expect(conflictField('products_name_unique')).toBe('name')
    expect(conflictField('something_else')).toBeNull()
    expect(conflictField(undefined)).toBeNull()

    const open = run(ready, { type: 'openEditSku', product: WHISKY, sku: WHISKY.skus[0]! }, { type: 'submitting', on: true })
    const clash = run(open, { type: 'conflict', field: 'barcode', message: 'duplicate' })
    expect(clash).toMatchObject({
      conflict: 'barcode',
      saveError: 'That barcode is already on another SKU',
      submitting: false,
      flash: { text: 'That barcode is already on another SKU' },
    })
    expect(clash.form).not.toBeNull()
    expect(run(clash, { type: 'field', field: 'sale', value: '1' })).toMatchObject({ conflict: 'barcode', saveError: null })
    expect(run(clash, { type: 'field', field: 'barcode', value: '1' }).conflict).toBeNull()
    expect(run(open, { type: 'conflict', field: null, message: 'Not allowed: x' }).saveError).toBe('Not allowed: x')
  })

  it('will not close while a save is in flight', () => {
    const busy = run(ready, { type: 'openNew' }, { type: 'submitting', on: true }, { type: 'close' })
    expect(busy.form).not.toBeNull()
  })
})
