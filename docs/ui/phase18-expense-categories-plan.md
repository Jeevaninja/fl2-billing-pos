# Phase 18 — Custom Expense Categories (Settings) — Schema + Component Plan

Status: **IMPLEMENTED (2026-10-18)**. Approved D1–D3 as recommended. **D4 as approved:** "Repairs" became
**"Repairs & Maintenance"** (it keeps the `REPAIRS` legacy code), there is no separate Maintenance category, and
**Bata / Daily Wages** was added. One migration: `0012_expense_categories`.

**As built, differences from this plan:**
- **Field name:** the expense request body keeps its `description` field (the "note").
- **Rule enforcement:** the insert trigger, not a CHECK, refuses a legacy code on a new row, so that case is a
  `PS002` with a clear message.
- **Picker:** the chips under the search box are the live matches. While the box is blank they show every
  category, with keys 1–9 on the first nine.
- **Upgrade test:** a database migrated to 0011 gets legacy-coded expenses, then 0012 runs. The old rows stay
  untouched, resolve to their categories, and Day End closes with zero variance.

## 0. What exists (and how it differs from the request)

- **Table name:** petty cash lives in **`cash_expenses`** (there is no `expenses` table).
- **Rows are append-only:** UPDATE / DELETE / TRUNCATE are forbidden by trigger. A void is a negating row.
- **Fixed categories already:** since Phase 8 (`0006`), every row has **`category text NOT NULL`**, CHECK-limited
  to `ICE, STAFF_FOOD, TRANSPORT, CLEANING, REPAIRS, OTHER`. The note is optional, except OTHER needs one.
- **The Expense screen is already category → amount → note.** Six fixed chips (keys 1–6), then the amount, then
  an optional note; the category is kept for the next entry. There is no free-text "reason" left to replace:
  this phase turns the **fixed list into a managed one**.
- **Day End math is category-blind:**
  - `pos_day_expected_cash` subtracts Σ `cash_expenses.amount_paise` outside peak windows.
  - An in-peak expense lowers that peak's expected collection instead.

  Categories only label rows, so the math needs no change. Tests will prove it still holds.
- **Settings menu (Phase 17):** the header gear currently holds Inventory Catalog. `docs/roadmap.md` item 1 is
  this phase.

## 1. Migration `0012_expense_categories.sql`

```sql
CREATE TABLE expense_categories (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  name          text        NOT NULL CONSTRAINT expense_categories_name_present CHECK (btrim(name) <> '' AND length(name) <= 40),
  is_active     boolean     NOT NULL DEFAULT true,
  note_required boolean     NOT NULL DEFAULT false,      -- D2: e.g. "Other" needs a note
  sort_order    integer     NOT NULL,                     -- order in the Expense picker; first nine get keys 1–9
  legacy_code   text        CONSTRAINT expense_categories_legacy_code_unique UNIQUE
                            CONSTRAINT expense_categories_legacy_code_valid
                            CHECK (legacy_code IN ('ICE','STAFF_FOOD','TRANSPORT','CLEANING','REPAIRS','OTHER')),  -- D1
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX expense_categories_name_unique ON expense_categories (lower(btrim(name)));
```

- **Master data, like the catalog:**
  - Name, flags and order are editable (UPDATE).
  - **No DELETE / TRUNCATE** (`pos_forbid_change`). "Delete" is **disable** (`is_active = false`).
  - `legacy_code` is immutable.
  - Every change goes to the sync outbox (`pos_outbox_capture`).
- **Seeds (D4):** the six existing categories with their `legacy_code`:
  - Ice, Staff food, Transport, Cleaning, Repairs, and Other (`note_required`)
  - plus **Bata / Daily Wages** and **Maintenance**

**`cash_expenses` changes:**
- `ADD COLUMN category_id uuid REFERENCES expense_categories (id)`. It is nullable, so existing rows stay untouched
  (D1).
- `category` becomes nullable, and its default is dropped. `CHECK ((category IS NULL) <> (category_id IS NULL))`
  means a row has exactly one of the legacy code or the new id.
- `cash_expenses_other_needs_note` is dropped. The note rule moves into the insert trigger, driven by
  `note_required`.
- **Insert trigger (replaced):**
  - **A new expense** (amount > 0) must carry `category_id` (PS002 for a legacy `category` code). The category must
    exist and be active (PS002 "category X is disabled"), and `note_required` means a note (PS002).
  - **A void** copies the original's `category` and `category_id` (whichever it had), as today.
  - Open day, peak tagging and the exact-negation rules are unchanged.

**Read helper:** every listing resolves a row's label as `coalesce(by id, by legacy_code)`. A pre-Phase-18 "ICE"
row therefore shows **"Ice"**, and later **"Ice (renamed)"** if the manager renames it, with no UPDATE to the
append-only table.

`pos_day_expected_cash`, the peak functions and the Day End close trigger are **not touched**.

## 2. Backend

**`ExpenseCategoryService`** (new):
- **`listCategories({ includeInactive })`:** ordered by `sort_order`, then name. Each row carries `usedCount`, how
  many expenses it has.
- **`createCategory({ name, noteRequired })`:** appended at the end of the order. A duplicate name (case- and
  space-insensitive) gives **PS012** (`DUPLICATE_CATALOG_ENTRY`).
- **`updateCategory(id, { name?, noteRequired?, isActive?, sortOrder? })`:**
  - Renames keep history attached, because past expenses point at the id.
  - The **last active category can't be disabled** (PS002).
  - Moving up or down swaps `sort_order` with the neighbour.

**`DayEndService.recordCashExpense`:** now takes a `categoryId`. `listCashExpenses` returns `category: { id, name }`
(resolved, legacy included). `EXPENSE_CATEGORIES` is kept only to label legacy rows.

**Routes:**

| Route | Body | → |
|---|---|---|
| `GET /api/expense-categories` | `?includeInactive=1` | list (the Expense screen asks for active only) |
| `POST /api/expense-categories` | `{ name, noteRequired? }` | create · 201 |
| `PATCH /api/expense-categories/:id` | `{ name?, noteRequired?, isActive?, move?: 'up'\|'down' }` | update |
| `POST /api/expenses` | `{ amount, categoryId, note? }` | now needs `categoryId` (400 without it) |

## 3. Settings → Expense Categories screen

- **Header gear menu:** "Expense Categories" is added under Inventory Catalog. App view `'expense-categories'`;
  Esc returns to the dashboard.
- **List:** each row shows name, a "Note required" badge, Active / Disabled, how many expenses use it, and ↑ / ↓
  order buttons. Disabled rows are dimmed and listed last; "Show disabled" toggles them.
- **Touch-friendly CRUD modals** (CLAUDE.md UI guideline): large inputs and buttons.
  - **New category (Ins):** name, plus a Note required toggle.
  - **Edit (Enter / tap):** rename, Note required, Disable / Enable. Disabling warns "Hidden from new expenses;
    past expenses keep the name".
  - A duplicate name outlines the field with the server's message.
- **Keys:** ↑/↓ select · Ins new · Enter edit · Alt+↑ / Alt+↓ reorder · Esc back.
- **Pure helpers** (`settings/expenseCategories.ts`): `formError`, `payload`, `patch` (changed fields only), and the
  reorder target.

## 4. Expense screen (Operations) — category picker

The flow stays **Category → Amount → Note (optional) → Enter**. The six fixed chips become a **category picker**
(D3):
- **Combobox:** focused on load. Typing filters by name, ↑/↓ moves, and Enter picks and moves to Amount.
- **Quick picks:** chips for the first **nine** active categories in the manager's order. Keys **1–9** pick one when
  no text field has focus, as 1–6 do today.
- The chosen category is kept for the next entry. A category marked "Note required" makes the note mandatory, and
  `formError` says so.
- The list shows the resolved category name, so legacy rows read the same as before.
- If the picked category is disabled meanwhile, the PS002 is shown and the categories are re-read.

## 5. Tests

**Backend:** `test/services/expense-categories.test.ts` (PGlite) covers:
- the seeds, with legacy codes on the six originals
- create, duplicate name (PS012, case- and space-insensitive), rename, reorder
- disable / enable, and refusing to disable the last active category
- no DELETE (PS001)

**Expenses:**
- A new expense needs an active `category_id`. A legacy code, a disabled category, or a missing note where
  required gives PS002.
- A void copies the category.
- A legacy row (inserted the old way before the migration) lists with its resolved name.
- A category renamed after use relabels its history.

**Day End math (requested):** one day with these expenses:
- a categorized expense
- a legacy-coded expense (inserted as Phase 17 data)
- a voided expense
- an in-peak expense in an ended peak

It then checks:
- `breakdown.cashExpensesPaise` and `expectedCashPaise`, against `pos_day_expected_cash` (which `getDayFigures`
  already asserts)
- the peak's expected collection
- that the day closes with zero variance

**API:** the three category routes, and `POST /api/expenses` with `categoryId`.

**Frontend:**
- the category form helpers
- the picker filter and the quick-key mapping (1–9 follow the manager's order, disabled ones skipped)
- `expenseReducer` with server categories: kept after recording, note-required validation, a stale category

**Verification:** root and frontend checks, a headless-Chrome pass (manage categories in Settings, record an
expense with a new category, Day End expected cash), then the state docs and `docs/roadmap.md` (item 1 done).

## 6. Decisions for approval

- **D1 — Old expense rows. Recommended: leave them untouched and resolve them through `legacy_code`.**
  `cash_expenses` is append-only, so back-filling `category_id` would mean disabling its guards inside the
  migration. Those rows would also change without outbox events, so the cloud copy would silently differ.
  With `legacy_code`, old rows keep their text code and the six seeded categories claim those codes. Old and new
  rows then read, group and rename the same way.
- **D2 — Note rule per category. Recommended: a "Note required" flag**, on for "Other" (as today), editable by the
  manager.
- **D3 — Picker. Recommended: a type-to-filter combobox plus quick keys 1–9** for the first nine categories in the
  manager's order. This keeps the screen keyboard-first however many categories exist. *Alternative:* a plain
  dropdown `<select>` (mouse-first, no quick keys).
- **D4 — Seeds. Recommended:** keep the six existing categories (so history keeps its names) and add **Bata / Daily
  Wages** and **Maintenance** as you listed them. "Repairs" and "Maintenance" overlap, and the manager can disable
  either. Roadmap note: once HR / Payroll exists, cash wages may move to a payroll ledger. Bata can then be
  disabled, with its history kept.
