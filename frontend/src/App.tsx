import { useCallback, useState } from 'react'
import BillingScreen from './billing/BillingScreen'
import CaptainOrdersScreen from './components/CaptainOrdersScreen'
import CatalogScreen from './components/CatalogScreen'
import Dashboard from './components/Dashboard'
import DayEndScreen from './components/DayEndScreen'
import ExpenseScreen from './components/ExpenseScreen'
import PurchaseScreen from './components/PurchaseScreen'
import { DEFAULT_RECENT, pushRecent, type PosActionId } from './components/dashboard/actions'

type View = 'dashboard' | 'billing' | 'captain-orders' | 'day-end' | 'expenses' | 'purchase' | 'catalog'

export default function App() {
  const [view, setView] = useState<View>('dashboard')
  const [recent, setRecent] = useState<PosActionId[]>([...DEFAULT_RECENT])
  const onUse = useCallback((id: PosActionId) => setRecent((prev) => pushRecent(prev, id)), [])
  const openBilling = useCallback(() => setView('billing'), [])
  const openCaptainOrders = useCallback(() => setView('captain-orders'), [])
  const openDayEnd = useCallback(() => setView('day-end'), [])
  const openExpenses = useCallback(() => setView('expenses'), [])
  const openPurchase = useCallback(() => setView('purchase'), [])
  const openCatalog = useCallback(() => setView('catalog'), [])
  const exitToDashboard = useCallback(() => setView('dashboard'), [])

  if (view === 'billing') return <BillingScreen onExit={exitToDashboard} />
  if (view === 'captain-orders') return <CaptainOrdersScreen onExit={exitToDashboard} />
  if (view === 'expenses') return <ExpenseScreen onExit={exitToDashboard} onOpenDayEnd={openDayEnd} />
  if (view === 'purchase') return <PurchaseScreen onExit={exitToDashboard} onOpenDayEnd={openDayEnd} />
  if (view === 'catalog') return <CatalogScreen onExit={exitToDashboard} />
  if (view === 'day-end') {
    return <DayEndScreen onExit={exitToDashboard} onOpenBilling={openBilling} onOpenCaptainOrders={openCaptainOrders} />
  }
  return (
    <Dashboard
      recent={recent}
      onUse={onUse}
      onOpenBilling={openBilling}
      onOpenCaptainOrders={openCaptainOrders}
      onOpenDayEnd={openDayEnd}
      onOpenExpenses={openExpenses}
      onOpenPurchase={openPurchase}
      onOpenCatalog={openCatalog}
    />
  )
}
