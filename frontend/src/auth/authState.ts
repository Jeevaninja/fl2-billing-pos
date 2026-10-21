/**
 * Phase 25 (D1, D3): what the app shows before the counter — checking the session, the sign-in
 * screen, or the POS. Any call that finds the session gone drops back to sign-in with a notice.
 */
import type { AuthSession, StaffSummary } from '../api/types'

export type AuthState =
  | { kind: 'checking' }
  | { kind: 'offline'; message: string }
  | { kind: 'signedOut'; adminConfigured: boolean; notice: string | null }
  | { kind: 'signedIn'; staff: StaffSummary; adminConfigured: boolean }

export type AuthAction =
  | { type: 'session'; session: AuthSession }
  | { type: 'offline'; message: string }
  | { type: 'retry' }
  | { type: 'signedIn'; staff: StaffSummary }
  | { type: 'signedOut' }
  /** A 401 from any call while signed in: the session expired, or the API restarted. */
  | { type: 'expired' }

export const initialAuth: AuthState = { kind: 'checking' }

export function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'session':
      return action.session.authenticated
        ? { kind: 'signedIn', staff: action.session.staff, adminConfigured: action.session.adminConfigured }
        : { kind: 'signedOut', adminConfigured: action.session.adminConfigured, notice: null }
    case 'offline':
      return state.kind === 'signedIn' ? state : { kind: 'offline', message: action.message }
    case 'retry':
      return { kind: 'checking' }
    case 'signedIn':
      return { kind: 'signedIn', staff: action.staff, adminConfigured: true }
    case 'signedOut':
      return { kind: 'signedOut', adminConfigured: true, notice: null }
    case 'expired':
      return state.kind === 'signedIn' ? { kind: 'signedOut', adminConfigured: state.adminConfigured, notice: 'Your session ended. Sign in again to continue.' } : state
  }
}
