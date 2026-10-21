import { describe, expect, it } from 'vitest'
import type { StaffMember } from '../api/types'
import { formFor, NEW_STAFF, pinError, sortStaff, staffChips, staffFormError, staffPatch } from './staffForm'

const member = (over: Partial<StaffMember>): StaffMember => ({
  id: 'x',
  displayName: 'Ravi',
  role: 'CASHIER',
  isActive: true,
  hasPin: false,
  username: null,
  hasPassword: false,
  pinLockedForSeconds: null,
  ...over,
})

const ravi = member({ id: 'r', displayName: 'Ravi' })
const owner = member({ id: 'o', displayName: 'Super Admin', role: 'ADMIN', hasPassword: true, username: 'owner' })

describe('staff form', () => {
  it('needs a unique name and, for a first PIN, two matching 4–6 digit entries', () => {
    expect(staffFormError({ ...NEW_STAFF, displayName: '  ' }, [ravi])).toBe('Enter a name')
    expect(staffFormError({ ...NEW_STAFF, displayName: ' ravi ' }, [ravi])).toBe('ravi is already on the staff list')
    expect(staffFormError({ ...formFor(ravi), displayName: 'RAVI' }, [ravi])).toBeNull()
    expect(staffFormError({ ...NEW_STAFF, displayName: 'Anu', pin: '12' }, [ravi])).toBe('A PIN is 4 to 6 digits')
    expect(staffFormError({ ...NEW_STAFF, displayName: 'Anu', pin: '1234', pinConfirm: '1243' }, [ravi])).toBe('The two PINs don’t match')
    expect(staffFormError({ ...NEW_STAFF, displayName: 'Anu', pin: '1234', pinConfirm: '1234' }, [ravi])).toBeNull()
    expect(staffFormError({ ...NEW_STAFF, displayName: 'Anu' }, [ravi])).toBeNull()
    expect(pinError('12a4', '12a4')).toBe('A PIN is 4 to 6 digits')
  })

  it('patches only what changed, and never an admin’s role', () => {
    expect(staffPatch(ravi, { ...formFor(ravi), displayName: ' Ravi  K ', role: 'MANAGER' })).toEqual({ displayName: 'Ravi K', role: 'MANAGER' })
    expect(staffPatch(ravi, formFor(ravi))).toEqual({})
    expect(staffPatch(owner, { ...formFor(owner), isActive: false })).toEqual({ isActive: false })
  })

  it('shows status chips, counting a PIN lock down from when the list loaded', () => {
    const locked = member({ hasPin: true, pinLockedForSeconds: 120 })
    expect(staffChips(locked, 61_000, 1_000).map((c) => c.label)).toEqual(['PIN locked 1:00', 'PIN set'])
    expect(staffChips(locked, 200_000, 1_000).map((c) => c.label)).toEqual(['PIN set'])
    expect(staffChips(member({ isActive: false }), 0, 0).map((c) => c.label)).toEqual(['Inactive', 'No PIN'])
    expect(staffChips(owner, 0, 0).map((c) => c.label)).toEqual(['No PIN', 'Signs in as owner'])
  })

  it('sorts active cashiers, managers, then admins', () => {
    const mgr = member({ id: 'm', displayName: 'Manager', role: 'MANAGER' })
    const gone = member({ id: 'g', displayName: 'Aaron', isActive: false })
    expect(sortStaff([owner, gone, mgr, ravi]).map((s) => s.id)).toEqual(['r', 'm', 'o', 'g'])
  })
})
