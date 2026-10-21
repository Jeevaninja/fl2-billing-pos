import { useCallback, useState } from 'react'
import BillingScreen from './billing/BillingScreen'
import Dashboard from './components/Dashboard'
import { lazyScreen } from './lib/lazyScreen'
import { DEFAULT_RECENT, pushRecent, type PosActionId } from './components/dashboard/actions'
import type { LedgerFocus } from './captain/waiterLedgerReducer'
import type { CountDraft } from './dayend/dayEndReducer'
import type { JumpTarget } from './orders/ordersView'

// Back-office screens: split out of the startup bundle (Phase 25).
const BankDepositScreen = lazyScreen(() => import('./components/BankDepositScreen'))
const WaiterLedgerScreen = lazyScreen(() => import('./components/WaiterLedgerScreen'))
const CatalogScreen = lazyScreen(() => import('./components/CatalogScreen'))
const DayEndScreen = lazyScreen(() => import('./components/DayEndScreen'))
const ExpenseCategoriesScreen = lazyScreen(() => import('./components/ExpenseCategoriesScreen'))
const ItemCategoriesScreen = lazyScreen(() => import('./components/ItemCategoriesScreen'))
const RevenueCentersScreen = lazyScreen(() => import('./components/RevenueCentersScreen'))
const RevenueCentersSettingsScreen = lazyScreen(() => import('./components/RevenueCentersSettingsScreen'))
const ExpenseScreen = lazyScreen(() => import('./components/ExpenseScreen'))
const OrdersScreen = lazyScreen(() => import('./components/OrdersScreen'))
const PurchaseScreen = lazyScreen(() => import('./components/PurchaseScreen'))
const ReportsScreen = lazyScreen(() => import('./components/ReportsScreen'))
const StaffScreen = lazyScreen(() => import('./components/StaffScreen'))

type View = 'dashboard' | 'billing' | 'captain-orders' | 'day-end' | 'expenses' | 'bank-deposits' | 'purchase' | 'catalog' | 'orders' | 'expense-categories' | 'item-categories' | 'revenue-centers' | 'center-settings' | 'reports' | 'staff'

export default function App() {
  const [view, setView] = useState<View>('dashboard')
  const [recent, setRecent] = useState<PosActionId[]>([...DEFAULT_RECENT])
  /** Day End's typed count, kept while the cashier steps out (e.g. to add a late expense). */
  const [countDraft, setCountDraft] = useState<CountDraft | null>(null)
  /** Set when Expenses (F6) or Bank deposits was opened from Day End: its Esc goes back there. */
  const [fromDayEnd, setFromDayEnd] = useState(false)
  /** Orders → "Jump to bill": the billing tab or Waiter Ledger bill to land on, used once. */
  const [billingFocus, setBillingFocus] = useState<string | null>(null)
  const [ledgerFocus, setLedgerFocus] = useState<LedgerFocus | null>(null)
  const onUse = useCallback((id: PosActionId) => setRecent((prev) => pushRecent(prev, id)), [])
  const openBilling = useCallback(() => {
    setBillingFocus(null)
    setView('billing')
  }, [])
  const openCaptainOrders = useCallback(() => {
    setLedgerFocus(null)
    setView('captain-orders')
  }, [])
  const openOrders = useCallback(() => setView('orders'), [])
  const openExpenseCategories = useCallback(() => setView('expense-categories'), [])
  const openItemCategories = useCallback(() => setView('item-categories'), [])
  const openRevenueCenters = useCallback(() => setView('revenue-centers'), [])
  const openCenterSettings = useCallback(() => setView('center-settings'), [])
  const openReports = useCallback(() => setView('reports'), [])
  const openStaff = useCallback(() => setView('staff'), [])
  const jumpFromOrders = useCallback((target: Exclude<JumpTarget, { kind: 'none' }>) => {
    if (target.kind === 'billing') {
      setBillingFocus(target.billId)
      setView('billing')
    } else {
      setLedgerFocus({ waiterId: target.waiterId, billId: target.billId })
      setView('captain-orders')
    }
  }, [])
  const openDayEnd = useCallback(() => setView('day-end'), [])
  const openExpenses = useCallback(() => {
    setFromDayEnd(false)
    setView('expenses')
  }, [])
  const openExpensesFromDayEnd = useCallback(() => {
    setFromDayEnd(true)
    setView('expenses')
  }, [])
  const openBankDeposits = useCallback(() => {
    setFromDayEnd(false)
    setView('bank-deposits')
  }, [])
  const openBankDepositsFromDayEnd = useCallback(() => {
    setFromDayEnd(true)
    setView('bank-deposits')
  }, [])
  const openPurchase = useCallback(() => setView('purchase'), [])
  const openCatalog = useCallback(() => setView('catalog'), [])
  const exitToDashboard = useCallback(() => setView('dashboard'), [])

  if (view === 'billing') return <BillingScreen onExit={exitToDashboard} focusBillId={billingFocus} />
  if (view === 'captain-orders') return <WaiterLedgerScreen onExit={exitToDashboard} focus={ledgerFocus} />
  if (view === 'orders') return <OrdersScreen onExit={exitToDashboard} onJump={jumpFromOrders} />
  if (view === 'expenses') return (
      <ExpenseScreen
        onExit={fromDayEnd ? openDayEnd : exitToDashboard}
        onOpenDayEnd={openDayEnd}
        exitLabel={fromDayEnd ? 'Day End' : 'Dashboard'}
      />
    )
  if (view === 'bank-deposits') return (
      <BankDepositScreen
        onExit={fromDayEnd ? openDayEnd : exitToDashboard}
        onOpenDayEnd={openDayEnd}
        exitLabel={fromDayEnd ? 'Day End' : 'Dashboard'}
      />
    )
  if (view === 'purchase') return <PurchaseScreen onExit={exitToDashboard} onOpenDayEnd={openDayEnd} />
  if (view === 'catalog') return <CatalogScreen onExit={exitToDashboard} />
  if (view === 'expense-categories') return <ExpenseCategoriesScreen onExit={exitToDashboard} />
  if (view === 'item-categories') return <ItemCategoriesScreen onExit={exitToDashboard} />
  if (view === 'revenue-centers') return <RevenueCentersScreen onExit={exitToDashboard} />
  if (view === 'center-settings') return <RevenueCentersSettingsScreen onExit={exitToDashboard} />
  if (view === 'reports') return <ReportsScreen onExit={exitToDashboard} />
  if (view === 'staff') return <StaffScreen onExit={exitToDashboard} />
  if (view === 'day-end') {
    return (
      <DayEndScreen
        onExit={exitToDashboard}
        onOpenBilling={openBilling}
        onOpenCaptainOrders={openCaptainOrders}
        onOpenExpenses={openExpensesFromDayEnd}
        onOpenBankDeposits={openBankDepositsFromDayEnd}
        countDraft={countDraft}
        onCountDraft={setCountDraft}
      />
    )
  }
  return (
    <Dashboard
      recent={recent}
      onUse={onUse}
      onOpenBilling={openBilling}
      onOpenCaptainOrders={openCaptainOrders}
      onOpenDayEnd={openDayEnd}
      onOpenExpenses={openExpenses}
      onOpenBankDeposits={openBankDeposits}
      onOpenPurchase={openPurchase}
      onOpenCatalog={openCatalog}
      onOpenOrders={openOrders}
      onOpenExpenseCategories={openExpenseCategories}
      onOpenItemCategories={openItemCategories}
      onOpenRevenueCenters={openRevenueCenters}
      onOpenCenterSettings={openCenterSettings}
      onOpenReports={openReports}
      onOpenStaff={openStaff}
    />
  )
}
