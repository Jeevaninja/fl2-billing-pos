import { createContext, useContext } from 'react'
import type { StaffSummary } from '../api/types'

export interface AuthContextValue {
  staff: StaffSummary
  signOut: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

/** The signed-in admin (Phase 25). Only rendered inside AuthGate, so it is always set there. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth() outside AuthGate')
  return value
}
