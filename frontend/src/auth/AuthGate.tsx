import { useCallback, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import { LoaderCircle, RefreshCw, WifiOff } from 'lucide-react'
import { api, ApiError, setUnauthenticatedHandler } from '../api/client'
import type { StaffSummary } from '../api/types'
import { buttonClass } from '../lib/ui'
import { BrandMark } from '../components/ui'
import { AuthContext } from './AuthContext'
import { authReducer, initialAuth } from './authState'
import { LoginScreen } from './LoginScreen'

/**
 * Phase 25 (D1, D3): nothing of the POS renders until a Super Admin has signed in. The session lives
 * in an HttpOnly cookie, so the page only ever asks the server whether it is signed in.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, initialAuth)

  useEffect(() => {
    setUnauthenticatedHandler(() => dispatch({ type: 'expired' }))
    return () => setUnauthenticatedHandler(null)
  }, [])

  useEffect(() => {
    if (state.kind !== 'checking') return
    let live = true
    api
      .session()
      .then((session) => live && dispatch({ type: 'session', session }))
      .catch((err: unknown) => live && dispatch({ type: 'offline', message: err instanceof ApiError ? err.message : 'cannot reach the POS server' }))
    return () => {
      live = false
    }
  }, [state.kind])

  const signOut = useCallback(() => {
    // Leave the till signed out even if the server can't be told (it forgets sessions on restart).
    api.logout().catch(() => undefined)
    dispatch({ type: 'signedOut' })
  }, [])
  const onSignedIn = useCallback((staff: StaffSummary) => dispatch({ type: 'signedIn', staff }), [])
  const value = useMemo(() => (state.kind === 'signedIn' ? { staff: state.staff, signOut } : null), [state, signOut])

  if (state.kind === 'signedIn') return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  if (state.kind === 'signedOut') return <LoginScreen adminConfigured={state.adminConfigured} notice={state.notice} onSignedIn={onSignedIn} />

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-zinc-950 p-8 text-center">
      <BrandMark size="lg" />
      {state.kind === 'checking' ? (
        <p className="flex items-center gap-2 text-zinc-400">
          <LoaderCircle className="size-5 animate-spin" aria-hidden /> Connecting to the till…
        </p>
      ) : (
        <>
          <p className="flex items-center gap-2 text-lg font-semibold text-rose-200">
            <WifiOff className="size-5" aria-hidden /> {state.message}
          </p>
          <p className="max-w-md text-sm text-zinc-400">Start the POS API on this machine (npm run api), then retry.</p>
          <button type="button" autoFocus onClick={() => dispatch({ type: 'retry' })} className={buttonClass('secondary', 'lg')}>
            <RefreshCw className="size-5" aria-hidden /> Retry
          </button>
        </>
      )}
    </div>
  )
}
