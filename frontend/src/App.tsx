import { useCallback, useState } from 'react'
import BillingScreen from './billing/BillingScreen'
import BankDepositScreen from './components/BankDepositScreen'
import WaiterLedgerScreen from './components/WaiterLedgerScreen'
import CatalogScreen from './components/CatalogScreen'
import Dashboard from './components/Dashboard'
import DayEndScreen from './components/DayEndScreen'
import ExpenseScreen from './components/ExpenseScreen'
import PurchaseScreen from './components/PurchaseScreen'
import { DEFAULT_RECENT, pushRecent, type PosActionId } from './components/dashboard/actions'
import type { CountDraft } from './dayend/dayEndReducer'

type View = 'dashboard' | 'billing' | 'captain-orders' | 'day-end' | 'expenses' | 'bank-deposits' | 'purchase' | 'catalog'

export default function App() {
  const [view, setView] = useState<View>('dashboard')
  const [recent, setRecent] = useState<PosActionId[]>([...DEFAULT_RECENT])
  /** Day End's typed count, kept while the cashier steps out (e.g. to add a late expense). */
  const [countDraft, setCountDraft] = useState<CountDraft | null>(null)
  /** Set when Expenses (F6) or Bank deposits was opened from Day End: its Esc goes back there. */
  const [fromDayEnd, setFromDayEnd] = useState(false)
  const onUse = useCallback((id: PosActionId) => setRecent((prev) => pushRecent(prev, id)), [])
  const openBilling = useCallback(() => setView('billing'), [])
  const openCaptainOrders = useCallback(() => setView('captain-orders'), [])
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

  if (view === 'billing') return <BillingScreen onExit={exitToDashboard} />
  if (view === 'captain-orders') return <WaiterLedgerScreen onExit={exitToDashboard} />
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
    />
  )
}
