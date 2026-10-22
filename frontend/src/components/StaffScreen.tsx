import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, KeyRound, Pencil, Plus, ShieldCheck, Users, WifiOff } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { CounterRole, Handset, HandsetList, IssuedHandsetToken, StaffMember } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { initials, ROLE_LABEL } from '../auth/pinPad'
import { FlashLine } from '../billing/BillingPanels'
import type { Flash } from '../billing/billingReducer'
import { counterErrorMessage } from '../billing/errors'
import { Modal } from '../billing/Modal'
import { beep } from '../lib/beep'
import { buttonClass, CARD, FOCUS_RING, keepFocus } from '../lib/ui'
import { formFor, MAX_STAFF_NAME, NEW_STAFF, pinError, sortStaff, staffChips, staffFormError, staffPatch, type StaffForm } from '../settings/staffForm'
import { ConfirmHandsetDialog, HandsetsSection, HandsetTokenDialog, PairHandsetDialog } from './settings/Handsets'
import { CenterNote, Toggle } from './settings/SettingsControls'
import { Badge, Kbd, LiveClock } from './ui'

type Dialog =
  | { kind: 'form'; form: StaffForm }
  | { kind: 'pin'; member: StaffMember }
  | { kind: 'pair' }
  | { kind: 'reissue' | 'revoke'; handset: Handset }
  | { kind: 'token'; issued: IssuedHandsetToken }
  | null

const INPUT = `h-12 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-lg hover:border-zinc-500 focus:border-amber-400 ${FOCUS_RING}`

/**
 * Settings → Staff & PINs (Phase 25, D6). Add cashiers and managers, set or reset the PIN that
 * authorises Day Open, rename, switch role, deactivate. Staff are never deleted. Admins sign in with
 * a password set on the till (npm run staff -- set-admin), so their role and password aren't edited here.
 * Below the staff list: Captain handsets (waiter-app phones), paired with a token shown once.
 */
export default function StaffScreen({ onExit }: { onExit: () => void }) {
  const { staff: me } = useAuth()
  const [staff, setStaff] = useState<StaffMember[] | null>(null)
  const [loadedAt, setLoadedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [offline, setOffline] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [handsets, setHandsets] = useState<HandsetList | null>(null)
  const [handsetError, setHandsetError] = useState<string | null>(null)

  const say = useCallback((kind: Flash['kind'], text: string) => {
    beep(kind)
    setFlash((f) => ({ kind, text, seq: (f?.seq ?? 0) + 1 }))
  }, [])

  const loaded = useCallback((members: StaffMember[]) => {
    const list = sortStaff(members)
    setStaff(list)
    setLoadedAt(Date.now())
    setOffline(false)
    setSelectedId((id) => (list.some((s) => s.id === id) ? id : (list[0]?.id ?? null)))
  }, [])
  const failed = useCallback(
    (err: unknown) => {
      setOffline(true)
      say('error', counterErrorMessage(err))
    },
    [say],
  )
  const refresh = useCallback(() => api.listStaff().then(loaded, failed), [loaded, failed])

  const handsetsLoaded = useCallback((list: HandsetList) => {
    setHandsets(list)
    setHandsetError(null)
  }, [])
  const handsetsFailed = useCallback((err: unknown) => {
    setHandsetError(err instanceof ApiError && err.code === 'CAPTAIN_NOT_CONFIGURED' ? 'Handset pairing isn’t set up on this till.' : `Handsets: ${counterErrorMessage(err)}`)
  }, [])
  const refreshHandsets = useCallback(() => api.listHandsets().then(handsetsLoaded, handsetsFailed), [handsetsLoaded, handsetsFailed])
  const issued = (result: IssuedHandsetToken) => {
    setDialog({ kind: 'token', issued: result })
    void refreshHandsets()
  }

  useEffect(() => {
    let live = true
    api.listStaff().then(
      (members) => live && loaded(members),
      (err: unknown) => live && failed(err),
    )
    api.listHandsets().then(
      (list) => live && handsetsLoaded(list),
      (err: unknown) => live && handsetsFailed(err),
    )
    return () => {
      live = false
    }
  }, [loaded, failed, handsetsLoaded, handsetsFailed])

  // Tick PIN-lock countdowns while any are showing.
  const anyLocked = staff?.some((s) => s.pinLockedForSeconds !== null) ?? false
  useEffect(() => {
    if (!anyLocked) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [anyLocked])

  const keys = useRef({ staff, selectedId, dialog, onExit })
  useEffect(() => {
    keys.current = { staff, selectedId, dialog, onExit }
  })
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const s = keys.current
      if (s.dialog || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const list = s.staff ?? []
      const at = list.findIndex((m) => m.id === s.selectedId)
      const current = list[at]
      if (event.key === 'Escape') {
        event.preventDefault()
        s.onExit()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const next = list[Math.min(list.length - 1, Math.max(0, at + (event.key === 'ArrowUp' ? -1 : 1)))]
        if (next) setSelectedId(next.id)
      } else if (event.key === 'Insert') {
        event.preventDefault()
        setDialog({ kind: 'form', form: NEW_STAFF })
      } else if ((event.key === 'p' || event.key === 'P') && current?.isActive && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault()
        setDialog({ kind: 'pin', member: current })
      } else if (event.key === 'Enter' && current && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault()
        setDialog({ kind: 'form', form: formFor(current) })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const withPins = staff?.filter((s) => s.isActive && s.hasPin).length ?? 0

  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b-2 border-amber-400 bg-zinc-900 px-5">
        <button type="button" {...keepFocus} onClick={onExit} className={`flex items-center gap-2 rounded px-1 text-zinc-300 hover:text-zinc-50 ${FOCUS_RING}`} aria-label="Back to dashboard (Esc)">
          <ArrowLeft className="size-5" aria-hidden />
          <span className="rounded bg-amber-400 px-2 py-0.5 text-lg font-black tracking-tight text-zinc-950">FL2</span>
        </button>
        <h1 className="text-lg font-bold tracking-wide uppercase">Staff &amp; PINs</h1>
        {staff && (
          <span className="text-sm text-zinc-400">
            {staff.filter((s) => s.isActive).length} active · {withPins} can open the day
          </span>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm">
          <FlashLine flash={flash} />
          <button type="button" onClick={() => setDialog({ kind: 'form', form: NEW_STAFF })} className={buttonClass('primary', 'sm')}>
            <Plus className="size-4" aria-hidden /> Add staff <Kbd>Ins</Kbd>
          </button>
          <LiveClock />
        </div>
      </header>

      {offline && staff === null && <CenterNote title="Cannot reach the POS server" icon={<WifiOff className="size-12 text-rose-400" aria-hidden />} />}
      {!offline && staff === null && <CenterNote title="Loading staff…" icon={<Users className="size-12 text-zinc-500" aria-hidden />} />}

      {staff && (
        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            <p className="flex items-start gap-2 text-sm text-zinc-400">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-hidden />
              A cashier’s or manager’s PIN authorises Day Open. Five wrong PINs lock that person’s PIN for five minutes; setting a new PIN unlocks it.
              PINs are stored hashed on this till and never synced.
            </p>
            <ul className={`${CARD} divide-y divide-zinc-800 overflow-hidden`} aria-label="Staff">
              {staff.map((member) => {
                const selected = member.id === selectedId
                return (
                  <li key={member.id}>
                    <div
                      onClick={() => setSelectedId(member.id)}
                      className={`flex items-center gap-4 px-4 py-3 ${selected ? 'bg-amber-400/[0.07] shadow-[inset_3px_0_0_0_var(--color-amber-400)]' : 'hover:bg-zinc-850'} ${member.isActive ? '' : 'opacity-60'}`}
                    >
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-zinc-800 font-black text-zinc-200 ring-1 ring-zinc-700">{initials(member.displayName)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-lg font-bold">{member.displayName}</span>
                          {member.id === me.id && <span className="text-xs font-semibold text-amber-300">(you)</span>}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="text-sm text-zinc-400">{ROLE_LABEL[member.role]}</span>
                          {staffChips(member, now, loadedAt).map((chip) => (
                            <Badge key={chip.label} tone={chip.tone}>
                              {chip.label}
                            </Badge>
                          ))}
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={!member.isActive}
                        onClick={() => setDialog({ kind: 'pin', member })}
                        className={buttonClass(member.hasPin ? 'secondary' : 'primary', 'sm')}
                        title={member.isActive ? undefined : 'Activate this person first'}
                      >
                        <KeyRound className="size-4" aria-hidden /> {member.hasPin ? 'Reset PIN' : 'Set PIN'}
                      </button>
                      <button type="button" onClick={() => setDialog({ kind: 'form', form: formFor(member) })} className={buttonClass('ghost', 'sm')} aria-label={`Edit ${member.displayName}`}>
                        <Pencil className="size-4" aria-hidden /> Edit
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
            <p className="text-xs text-zinc-500">
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> select · <Kbd>Enter</Kbd> edit · <Kbd>P</Kbd> set PIN · <Kbd>Ins</Kbd> add · <Kbd>Esc</Kbd> back
            </p>
            <HandsetsSection
              list={handsets}
              error={handsetError}
              onPair={() => setDialog({ kind: 'pair' })}
              onReissue={(handset) => setDialog({ kind: 'reissue', handset })}
              onRevoke={(handset) => setDialog({ kind: 'revoke', handset })}
            />
          </div>
        </main>
      )}

      {dialog?.kind === 'form' && staff && (
        <StaffDialog
          form={dialog.form}
          staff={staff}
          isMe={dialog.form.id === me.id}
          onClose={() => setDialog(null)}
          onSaved={(saved, verb) => {
            setDialog(null)
            setSelectedId(saved.id)
            say('ok', `${saved.displayName} ${verb}`)
            void refresh()
          }}
        />
      )}
      {dialog?.kind === 'pin' && (
        <SetPinDialog
          member={dialog.member}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null)
            say('ok', saved.hasPin ? `PIN set for ${saved.displayName}` : `PIN cleared for ${saved.displayName}`)
            void refresh()
          }}
        />
      )}
      {dialog?.kind === 'pair' && handsets && <PairHandsetDialog handsets={handsets.handsets} onClose={() => setDialog(null)} onIssued={issued} />}
      {(dialog?.kind === 'reissue' || dialog?.kind === 'revoke') && (
        <ConfirmHandsetDialog
          action={dialog.kind}
          handset={dialog.handset}
          onClose={() => setDialog(null)}
          onIssued={issued}
          onRevoked={(revoked) => {
            setDialog(null)
            say('ok', `${revoked.label} revoked`)
            void refreshHandsets()
          }}
        />
      )}
      {dialog?.kind === 'token' && (
        <HandsetTokenDialog
          issued={dialog.issued}
          onClose={() => {
            setDialog(null)
            void refreshHandsets()
          }}
        />
      )}
    </div>
  )
}

function StaffDialog({
  form: initial,
  staff,
  isMe,
  onClose,
  onSaved,
}: {
  form: StaffForm
  staff: StaffMember[]
  isMe: boolean
  onClose: () => void
  onSaved: (saved: StaffMember, verb: string) => void
}) {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const original = staff.find((s) => s.id === form.id)
  const isAdmin = original?.role === 'ADMIN'
  const problem = staffFormError(form, staff)
  const edit = (patch: Partial<StaffForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    setServerError(null)
  }

  const save = () => {
    if (saving || problem) return
    setSaving(true)
    const request = original
      ? (() => {
          const patch = staffPatch(original, form)
          return Object.keys(patch).length === 0 ? Promise.resolve(original) : api.updateStaff(original.id, patch)
        })()
      : api.createStaff({ displayName: form.displayName, role: form.role, pin: form.pin === '' ? null : form.pin })
    request
      .then((saved) => onSaved(saved, original ? (original.isActive && !saved.isActive ? 'deactivated' : 'saved') : 'added'))
      .catch((err: unknown) => {
        setSaving(false)
        setServerError(err instanceof ApiError ? err.message : counterErrorMessage(err))
      })
  }

  return (
    <Modal
      title={original ? `Edit ${original.displayName}` : 'Add staff'}
      onClose={onClose}
      onKey={(e) => {
        if (e.key !== 'Enter' && e.key !== 'F9') return false
        if (e.key === 'Enter' && e.target instanceof HTMLButtonElement) return false
        save()
        return true
      }}
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className={`text-sm font-semibold ${serverError ? 'text-rose-300' : 'text-zinc-400'}`} role={serverError ? 'alert' : undefined}>
            {serverError ?? problem ?? (original && original.isActive && !form.isActive ? 'They will no longer be able to open the day.' : '')}
          </p>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={onClose} className={buttonClass('secondary')}>
              Cancel
            </button>
            <button type="button" onClick={save} disabled={saving || problem !== null} className={buttonClass(original && original.isActive && !form.isActive ? 'danger' : 'primary')}>
              {original && original.isActive && !form.isActive ? 'Deactivate & save' : 'Save'} <Kbd>Enter</Kbd>
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-zinc-300">Name</span>
          <input className={INPUT} value={form.displayName} maxLength={MAX_STAFF_NAME} onChange={(e) => edit({ displayName: e.target.value })} data-autofocus autoFocus />
        </label>
        {isAdmin ? (
          <p className="rounded-lg border border-violet-400/40 bg-violet-400/10 px-3 py-2 text-sm text-violet-100">
            Admin · signs in as <strong>{original?.username}</strong>. The role and password are managed on the till: <code className="font-mono">npm run staff -- set-admin</code>
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-zinc-300">Role</span>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Role">
              {(['CASHIER', 'MANAGER'] as const satisfies readonly CounterRole[]).map((role) => (
                <button
                  key={role}
                  type="button"
                  role="radio"
                  aria-checked={form.role === role}
                  onClick={() => edit({ role })}
                  className={`h-12 rounded-lg border-2 font-bold ${form.role === role ? 'border-amber-400 bg-amber-400/15 text-amber-100' : 'border-zinc-700 bg-zinc-950 hover:border-zinc-500'} ${FOCUS_RING}`}
                >
                  {ROLE_LABEL[role]}
                </button>
              ))}
            </div>
          </div>
        )}
        {original && !isMe && (
          <Toggle on={form.isActive} onClick={() => edit({ isActive: !form.isActive })} title={form.isActive ? 'Active' : 'Inactive'} hint="Inactive staff keep their history but can’t authorise anything." />
        )}
        {!original && (
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-zinc-300">PIN (optional)</span>
              <input className={`${INPUT} font-mono tracking-[0.4em]`} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={form.pin} onChange={(e) => edit({ pin: e.target.value.replace(/\D/g, '') })} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-zinc-300">Repeat PIN</span>
              <input className={`${INPUT} font-mono tracking-[0.4em]`} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={form.pinConfirm} onChange={(e) => edit({ pinConfirm: e.target.value.replace(/\D/g, '') })} />
            </label>
          </div>
        )}
      </div>
    </Modal>
  )
}

function SetPinDialog({ member, onClose, onSaved }: { member: StaffMember; onClose: () => void; onSaved: (saved: StaffMember) => void }) {
  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const problem = pin === '' && confirm === '' ? 'Type the new PIN twice' : pinError(pin, confirm)

  const run = (value: string | null) => {
    if (saving || (value !== null && problem)) return
    setSaving(true)
    api
      .setStaffPin(member.id, value)
      .then(onSaved)
      .catch((err: unknown) => {
        setSaving(false)
        setServerError(err instanceof ApiError ? err.message : counterErrorMessage(err))
      })
  }

  return (
    <Modal
      title={`${member.hasPin ? 'Reset' : 'Set'} PIN · ${member.displayName}`}
      onClose={onClose}
      width="max-w-md"
      onKey={(e) => {
        if (e.key !== 'Enter' || e.target instanceof HTMLButtonElement) return false
        run(pin)
        return true
      }}
      footer={
        <div className="flex items-center justify-between gap-3">
          {member.hasPin ? (
            <button type="button" onClick={() => run(null)} disabled={saving} className={buttonClass('ghost', 'sm')}>
              Clear PIN
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={buttonClass('secondary')}>
              Cancel
            </button>
            <button type="button" onClick={() => run(pin)} disabled={saving || problem !== null} className={buttonClass('primary')}>
              Save PIN <Kbd>Enter</Kbd>
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-zinc-300">New PIN</span>
            <input className={`${INPUT} font-mono tracking-[0.4em]`} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => {
                setPin(e.target.value.replace(/\D/g, ''))
                setServerError(null)
              }} data-autofocus autoFocus />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-zinc-300">Repeat PIN</span>
            <input className={`${INPUT} font-mono tracking-[0.4em]`} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={confirm} onChange={(e) => {
                setConfirm(e.target.value.replace(/\D/g, ''))
                setServerError(null)
              }} />
          </label>
        </div>
        <p className={`text-sm font-semibold ${serverError ? 'text-rose-300' : 'text-zinc-400'}`} role={serverError ? 'alert' : undefined}>
          {serverError ?? problem ?? (member.pinLockedForSeconds !== null ? 'Saving a new PIN also lifts the lock.' : '4–6 digits. Avoid 1234 and birthdays.')}
        </p>
      </div>
    </Modal>
  )
}
