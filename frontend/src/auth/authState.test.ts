import { describe, expect, it } from 'vitest'
import { authReducer, initialAuth } from './authState'

const admin = { id: 'a1', displayName: 'Super Admin', role: 'ADMIN' } as const

describe('authReducer', () => {
  it('goes from checking to the sign-in screen or straight in', () => {
    expect(authReducer(initialAuth, { type: 'session', session: { authenticated: false, adminConfigured: false } })).toEqual({ kind: 'signedOut', adminConfigured: false, notice: null })
    expect(authReducer(initialAuth, { type: 'session', session: { authenticated: true, staff: admin, expiresAt: '2026-10-21T00:00:00Z', adminConfigured: true } })).toEqual({
      kind: 'signedIn',
      staff: admin,
      adminConfigured: true,
    })
  })

  it('drops back to sign-in with a notice when the session expires, and only then', () => {
    const signedIn = authReducer(initialAuth, { type: 'signedIn', staff: admin })
    expect(authReducer(signedIn, { type: 'expired' })).toEqual({ kind: 'signedOut', adminConfigured: true, notice: 'Your session ended. Sign in again to continue.' })
    const signedOut = authReducer(signedIn, { type: 'signedOut' })
    expect(signedOut).toEqual({ kind: 'signedOut', adminConfigured: true, notice: null })
    expect(authReducer(signedOut, { type: 'expired' })).toBe(signedOut)
  })

  it('shows offline before sign-in, but never throws a signed-in till out for a network blip', () => {
    expect(authReducer(initialAuth, { type: 'offline', message: 'cannot reach the POS server' })).toEqual({ kind: 'offline', message: 'cannot reach the POS server' })
    const signedIn = authReducer(initialAuth, { type: 'signedIn', staff: admin })
    expect(authReducer(signedIn, { type: 'offline', message: 'x' })).toBe(signedIn)
    expect(authReducer({ kind: 'offline', message: 'x' }, { type: 'retry' })).toEqual({ kind: 'checking' })
  })
})
