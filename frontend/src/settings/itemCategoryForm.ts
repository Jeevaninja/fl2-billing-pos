/**
 * Settings → Item Categories (Phase 20): pure helpers behind the list and the add / edit modal.
 * The server is the judge (PS012 duplicate, PS002 disabling a category with items); these catch the
 * obvious early.
 */
import type { DepartmentCode, ItemCategory, ItemCategoryPatch, SizeCode } from '../api/types'
import { cleanName } from './expenseCategoryForm'

export const MAX_ITEM_CATEGORY_NAME = 30

export interface ItemCategoryForm {
  /** null for a new category. */
  id: string | null
  name: string
  defaultSizeCode: SizeCode | null
  defaultDepartment: DepartmentCode
  isActive: boolean
}

export const NEW_ITEM_CATEGORY: ItemCategoryForm = { id: null, name: '', defaultSizeCode: null, defaultDepartment: 'LIQUOR', isActive: true }

export function itemCategoryFormFor(category: ItemCategory): ItemCategoryForm {
  return {
    id: category.id,
    name: category.name,
    defaultSizeCode: category.defaultSizeCode,
    defaultDepartment: category.defaultDepartment,
    isActive: category.isActive,
  }
}

/** The first problem with the form, or null when it can be saved. */
export function itemCategoryFormError(form: ItemCategoryForm, categories: readonly ItemCategory[]): string | null {
  const name = cleanName(form.name)
  if (name === '') return 'Enter a name'
  if (name.length > MAX_ITEM_CATEGORY_NAME) return `At most ${MAX_ITEM_CATEGORY_NAME} characters`
  const clash = categories.find((c) => c.id !== form.id && c.name.toLowerCase() === name.toLowerCase())
  if (clash) return `“${clash.name}” already exists${clash.isActive ? '' : ' (disabled — enable it instead)'}`
  const original = categories.find((c) => c.id === form.id)
  if (original?.isActive && !form.isActive && original.itemCount > 0) {
    return `${original.name} still has ${original.itemCount} active item${original.itemCount === 1 ? '' : 's'} — move or deactivate them first`
  }
  return null
}

/** Only what changed on an existing category; {} when nothing did. */
export function itemCategoryPatch(original: ItemCategory, form: ItemCategoryForm): ItemCategoryPatch {
  const patch: ItemCategoryPatch = {}
  const name = cleanName(form.name)
  if (name !== original.name) patch.name = name
  if (form.defaultSizeCode !== original.defaultSizeCode) patch.defaultSizeCode = form.defaultSizeCode
  if (form.defaultDepartment !== original.defaultDepartment) patch.defaultDepartment = form.defaultDepartment
  if (form.isActive !== original.isActive) patch.isActive = form.isActive
  return patch
}

/** Active categories in report order, then disabled ones when shown. */
export function visibleItemCategories(categories: readonly ItemCategory[], showDisabled: boolean): ItemCategory[] {
  const byOrder = [...categories].sort((a, b) => a.sortOrder - b.sortOrder)
  const active = byOrder.filter((c) => c.isActive)
  return showDisabled ? [...active, ...byOrder.filter((c) => !c.isActive)] : active
}
