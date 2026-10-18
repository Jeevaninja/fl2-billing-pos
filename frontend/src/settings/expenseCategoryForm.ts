/**
 * Settings → Expense Categories (Phase 18): pure helpers behind the list and the add / edit modal.
 * The server is the judge (PS012 duplicate, PS002 last active); these catch the obvious early.
 */
import type { ExpenseCategory, ExpenseCategoryPatch } from '../api/types'

export const MAX_NAME = 40

export interface CategoryForm {
  /** null for a new category. */
  id: string | null
  name: string
  noteRequired: boolean
  isActive: boolean
}

export const NEW_CATEGORY: CategoryForm = { id: null, name: '', noteRequired: false, isActive: true }

export function formFor(category: ExpenseCategory): CategoryForm {
  return { id: category.id, name: category.name, noteRequired: category.noteRequired, isActive: category.isActive }
}

/** Trimmed, inner runs of spaces collapsed — the server stores names the same way. */
export function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

/** The first problem with the form, or null when it can be saved. */
export function categoryFormError(form: CategoryForm, categories: readonly ExpenseCategory[]): string | null {
  const name = cleanName(form.name)
  if (name === '') return 'Enter a name'
  if (name.length > MAX_NAME) return `At most ${MAX_NAME} characters`
  const clash = categories.find((c) => c.id !== form.id && c.name.toLowerCase() === name.toLowerCase())
  if (clash) return `“${clash.name}” already exists${clash.isActive ? '' : ' (disabled — enable it instead)'}`
  if (form.id !== null && !form.isActive) {
    const original = categories.find((c) => c.id === form.id)
    const othersActive = categories.some((c) => c.id !== form.id && c.isActive)
    if (original?.isActive && !othersActive) return `${original.name} is the last active category — add or enable another first`
  }
  return null
}

/** Only what changed on an existing category; {} when nothing did. */
export function categoryPatch(original: ExpenseCategory, form: CategoryForm): ExpenseCategoryPatch {
  const patch: ExpenseCategoryPatch = {}
  const name = cleanName(form.name)
  if (name !== original.name) patch.name = name
  if (form.noteRequired !== original.noteRequired) patch.noteRequired = form.noteRequired
  if (form.isActive !== original.isActive) patch.isActive = form.isActive
  return patch
}

/** Active categories in picker order (their quick key is the position), then disabled ones when shown. */
export function visibleCategories(categories: readonly ExpenseCategory[], showDisabled: boolean): ExpenseCategory[] {
  const byOrder = [...categories].sort((a, b) => a.sortOrder - b.sortOrder)
  const active = byOrder.filter((c) => c.isActive)
  return showDisabled ? [...active, ...byOrder.filter((c) => !c.isActive)] : active
}

/** The Expense screen's quick key for an active category ('1'–'9'), or null. */
export function quickKeyFor(categories: readonly ExpenseCategory[], id: string): string | null {
  const at = visibleCategories(categories, false).findIndex((c) => c.id === id)
  return at >= 0 && at < 9 ? String(at + 1) : null
}
