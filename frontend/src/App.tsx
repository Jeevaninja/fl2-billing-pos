import { useCallback, useState } from 'react'
import BillingScreen from './billing/BillingScreen'
import Dashboard from './components/Dashboard'
import { DEFAULT_RECENT, pushRecent, type PosActionId } from './components/dashboard/actions'

type View = 'dashboard' | 'billing'

export default function App() {
  const [view, setView] = useState<View>('dashboard')
  const [recent, setRecent] = useState<PosActionId[]>([...DEFAULT_RECENT])
  const onUse = useCallback((id: PosActionId) => setRecent((prev) => pushRecent(prev, id)), [])
  const openBilling = useCallback(() => setView('billing'), [])
  const exitBilling = useCallback(() => setView('dashboard'), [])

  return view === 'billing' ? (
    <BillingScreen onExit={exitBilling} />
  ) : (
    <Dashboard recent={recent} onUse={onUse} onOpenBilling={openBilling} />
  )
}
