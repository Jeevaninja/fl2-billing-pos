import { describe, expect, it } from 'vitest'
import type { StaffSummary } from '../api/types'
import { canSubmit, feedbackFor, formatCountdown, initialPinPad, initials, pinPadReducer, type PinPadAction, type PinPadState } from './pinPad'

const ravi: StaffSummary = { id: 's1', displayName: 'Ravi Kumar', role: 'CASHIER' }
const mgr: StaffSummary = { id: 's2', displayName: 'Manager', role: 'MANAGER' }

const run = (actions: PinPadAction[], from: PinPadState = initialPinPad) => actions.reduce(pinPadReducer, from)
const digits = (pin: string): PinPadAction[] => [...pin].map((digit) => ({ type: 'digit', digit }))

describe('pinPadReducer', () => {
  it('skips the picker when only one person holds a PIN', () => {
    expect(run([{ type: 'holders', holders: [ravi] }]).picked).toEqual(ravi)
    expect(run([{ type: 'holders', holders: [ravi, mgr] }]).picked).toBeNull()
    expect(run([{ type: 'holders', holders: [ravi] }, { type: 'unpick' }]).picked).toEqual(ravi)
  })

  it('takes 4–6 digits only, and submits only with someone picked', () => {
    let s = run([{ type: 'holders', holders: [ravi, mgr] }, ...digits('123')])
    expect(canSubmit(s)).toBe(false)
    s = run([{ type: 'pick', staff: mgr }, ...digits('1234567'), { type: 'digit', digit: 'x' }], s)
    expect(s.digits).toBe('123456')
    expect(canSubmit(s)).toBe(true)
    s = run([{ type: 'backspace' }, { type: 'backspace' }, { type: 'backspace' }], s)
    expect([s.digits, canSubmit(s)]).toEqual(['123', false])
  })

  it('ignores keys while the check is in flight', () => {
    const s = run([{ type: 'pick', staff: ravi }, ...digits('1234'), { type: 'submit' }, ...digits('9'), { type: 'backspace' }, { type: 'unpick' }])
    expect([s.busy, s.digits, s.picked]).toEqual([true, '1234', ravi])
    expect(run([{ type: 'submit' }], s)).toBe(s)
  })

  it('a wrong PIN clears the digits, shakes, and keeps the attempts-left note while retyping', () => {
    const wrong = { kind: 'wrong', message: 'Wrong PIN — 3 attempts left', attemptsLeft: 3 } as const
    const s = run([{ type: 'pick', staff: ravi }, ...digits('1111'), { type: 'submit' }, { type: 'failed', feedback: wrong }, ...digits('2')])
    expect([s.busy, s.digits, s.shake, s.feedback]).toEqual([false, '2', 1, wrong])
  })

  it('a lock blocks typing until unlocked', () => {
    const locked = { kind: 'locked', message: 'locked', until: 1000 } as const
    let s = run([{ type: 'pick', staff: ravi }, ...digits('1111'), { type: 'submit' }, { type: 'failed', feedback: locked }, ...digits('22')])
    expect([s.digits, canSubmit(s)]).toEqual(['', false])
    s = run([{ type: 'unlocked' }, ...digits('2222')], s)
    expect(canSubmit(s)).toBe(true)
  })
})

describe('PIN pad helpers', () => {
  it('maps API errors to pad feedback', () => {
    expect(feedbackFor({ code: 'INVALID_PIN', message: 'Wrong PIN — 4 attempts left', attemptsLeft: 4 }, 0)).toEqual({ kind: 'wrong', message: 'Wrong PIN — 4 attempts left', attemptsLeft: 4 })
    expect(feedbackFor({ code: 'LOCKED', message: 'locked', retryAfterSeconds: 300 }, 10_000)).toEqual({ kind: 'locked', message: 'locked', until: 310_000 })
    expect(feedbackFor({ code: 'PS007', message: 'business day 2026-10-20 is already open' }, 0)).toEqual({ kind: 'error', message: 'business day 2026-10-20 is already open' })
  })

  it('formats a countdown and initials', () => {
    expect([formatCountdown(299_001), formatCountdown(60_000), formatCountdown(-5)]).toEqual(['5:00', '1:00', '0:00'])
    expect([initials('Ravi Kumar'), initials('Counter 1'), initials('manager')]).toEqual(['RK', 'C1', 'MA'])
  })
})
