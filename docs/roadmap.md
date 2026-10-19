# FL2 POS — Upcoming Roadmap (logged 2026-10-18)

These phases were logged alongside Phase 17 so that today's architecture leaves room for them. Item 1 is built
(Phase 18). Item 3's department architecture landed in Phase 19 (unified billing, split ledger), and the Kitchen Kiosk
(Kitchen P&L, kitchen purchases) in Phase 21; kitchen ingredient stock and item 2 are **not** implemented yet. Each will get its own schema and component plan, approved before any code is written
(CLAUDE.md protocol).

## 1. Settings expansion — custom expense categories ✅ Done in Phase 18

Built as `expense_categories` (migration `0012`) with the Settings → Expense Categories screen and a searchable
Expense picker (plan `docs/ui/phase18-expense-categories-plan.md`). The notes below are kept for history.

A UI under the header **Settings** gear (added in Phase 17, which already holds Inventory Catalog) to create and
manage custom expense categories.

Today's constraints:
- Expense categories are a fixed list (`EXPENSE_CATEGORIES`, migration `0006_expense_category`, CHECK-constrained).
- The Expense screen hard-codes six category chips (keys 1–6).
- Moving to custom categories means a category table (append-only / deactivate rather than delete), a migration
  of the CHECK constraint to a foreign key, and an Expense screen that no longer assumes six fixed chips.

## 2. HR / Payroll module

- Employee attendance marking
- Payroll tracking
- Salary advance tracking

All three tie directly to the P&L.

Architecture notes:
- **Staff:** the `staff` table exists, but there is no staff login yet; the till's cashier is fixed by
  `FL2_CASHIER_ID`. Attendance and payroll will need employee records beyond till staff (waiters are a separate
  `waiters` table today).
- **Money:** salary advances are cash leaving the drawer. Like bank deposits (Phase 14), they need their own
  ledger and a term in `pos_day_expected_cash`, not an `OTHER` expense. Payroll and advances feed the P&L.
- **No P&L report exists yet:** Reports is still to be built.

## 3. Kitchen / Food module

- A separate **Kitchen Kiosk** to track food inventory, purchases and expenses.
- **Food sales go on a separate P&L from FL2 liquor sales.** They are still rung up on the **same unified billing
  session** by the waiter.

**Phase 19 (built, `0013_departments`, plan `docs/ui/phase19-departments-plan.md`):** LIQUOR / KITCHEN / ANCILLARY
departments on products (snapshotted on every bill line) and on expense categories (or Shared); Kitchen items sell
without stock tracking; KOTs route BAR / KITCHEN through a KOT ledger (F6 at the counter); Day End shows sales by
department while the drawer and Expected cash stay unified. Still to build: the Kitchen Kiosk (food inventory with its
own units, kitchen purchases), and a P&L report per department.

**Phase 21 (built, `0015_kitchen_purchases`, plan `docs/ui/phase21-kitchen-kiosk-plan.md`):** a Kitchen Kiosk tile with
the daily Kitchen P&L (sales − Kitchen expenses − kitchen purchases; Shared overheads excluded) and a kitchen purchase
ledger (lines with free-text quantities, paid from the drawer or outside; drawer purchases lower expected cash). Still
to build: ingredient stock with its own units / recipes, a date-range P&L (with Reports).

Architecture notes:
- **One bill, two P&Ls:** a bill can then carry both liquor and food lines. Liquor and food revenue, stock and
  expenses must be separable per line, for example a `department` (`LIQUOR` / `FOOD`) on the catalog and the bill
  lines, while bill totals and tenders stay unified.
- **Food stock isn't liquor stock:** the whole-bottle rules (whole integers, sealed bottles) are liquor rules,
  and food inventory will need its own units and stock ledger.
- **KOT routing:** liquor goes to the counter printer today, and food KOTs would route to the kitchen.
- **CLAUDE.md constraints still apply:** no tax / GST engine, no table layouts, integer paise.
