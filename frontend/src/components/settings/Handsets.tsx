import { useRef, useState } from 'react'
import { Ban, Check, Copy, Plus, RotateCcw, Smartphone } from 'lucide-react'
import { ApiError, api } from '../../api/client'
import type { Handset, HandsetList, IssuedHandsetToken } from '../../api/types'
import { counterErrorMessage } from '../../billing/errors'
import { Modal } from '../../billing/Modal'
import { handsetFormError, MAX_HANDSET_LABEL, nextHandsetId, pairedOn, sortHandsets } from '../../settings/handsets'
import { buttonClass, CARD, FOCUS_RING } from '../../lib/ui'
import { Badge, Kbd } from '../ui'

const INPUT = `h-12 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-lg hover:border-zinc-500 focus:border-amber-400 ${FOCUS_RING}`

const failure = (err: unknown) => (err instanceof ApiError ? err.message : counterErrorMessage(err))

/**
 * Staff & PINs → Captain handsets: the waiter-app phones allowed to send orders. Pairing issues a
 * token that is shown once (the till keeps only its hash); re-issuing replaces it, revoking stops it.
 */
export function HandsetsSection({
  list,
  error,
  onPair,
  onReissue,
  onRevoke,
}: {
  list: HandsetList | null
  error: string | null
  onPair: () => void
  onReissue: (handset: Handset) => void
  onRevoke: (handset: Handset) => void
}) {
  const handsets = list ? sortHandsets(list.handsets) : []
  return (
    <section className="flex flex-col gap-3" aria-label="Captain handsets">
      <div className="flex items-center gap-3">
        <h2 className="flex items-center gap-2 text-sm font-bold tracking-wide text-zinc-300 uppercase">
          <Smartphone className="size-4 text-amber-400" aria-hidden /> Captain handsets
        </h2>
        {list && (
          <span className="text-sm text-zinc-400">
            {list.serverUrls.length > 0 ? (
              <>
                Server <span className="font-mono text-zinc-200">{list.serverUrls.join(' · ')}</span>
              </>
            ) : (
              'Captain server starts when the first handset is paired'
            )}
          </span>
        )}
        <button type="button" onClick={onPair} disabled={!list} className={`ml-auto ${buttonClass('secondary', 'sm')}`}>
          <Plus className="size-4" aria-hidden /> Pair handset
        </button>
      </div>
      {error && <p className="text-sm font-semibold text-rose-300">{error}</p>}
      {list && handsets.length === 0 && (
        <p className={`${CARD} px-4 py-5 text-sm text-zinc-400`}>No handsets yet. Pair one, then enter its server address and token in the app’s POS Settings.</p>
      )}
      {handsets.length > 0 && (
        <ul className={`${CARD} divide-y divide-zinc-800 overflow-hidden`} aria-label="Handsets">
          {handsets.map((h) => (
            <li key={h.id} className={`flex items-center gap-4 px-4 py-3 ${h.active ? '' : 'opacity-60'}`}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-lg font-bold">{h.label}</span>
                  <Badge tone={h.active ? 'emerald' : 'neutral'}>{h.active ? 'Active' : 'Revoked'}</Badge>
                </span>
                <span className="mt-1 block text-sm text-zinc-400">
                  <span className="font-mono">{h.id}</span> · paired {pairedOn(h.pairedAt)}
                </span>
              </span>
              {h.active && (
                <>
                  <button type="button" onClick={() => onReissue(h)} className={buttonClass('secondary', 'sm')}>
                    <RotateCcw className="size-4" aria-hidden /> New token
                  </button>
                  <button type="button" onClick={() => onRevoke(h)} className={buttonClass('ghost', 'sm')} aria-label={`Revoke ${h.label}`}>
                    <Ban className="size-4" aria-hidden /> Revoke
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function PairHandsetDialog({ handsets, onClose, onIssued }: { handsets: readonly Handset[]; onClose: () => void; onIssued: (issued: IssuedHandsetToken) => void }) {
  const [id, setId] = useState(() => nextHandsetId(handsets))
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const problem = handsetFormError(id, label, handsets)

  const save = () => {
    if (saving || problem) return
    setSaving(true)
    api
      .pairHandset(id, label.trim())
      .then(onIssued)
      .catch((err: unknown) => {
        setSaving(false)
        setServerError(failure(err))
      })
  }

  return (
    <Modal
      title="Pair a Captain handset"
      onClose={onClose}
      width="max-w-md"
      onKey={(e) => {
        if (e.key !== 'Enter' || e.target instanceof HTMLButtonElement) return false
        save()
        return true
      }}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass('secondary')}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving || problem !== null} className={buttonClass('primary')}>
            Pair &amp; show token <Kbd>Enter</Kbd>
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-zinc-300">Name</span>
          <input
            className={INPUT}
            value={label}
            maxLength={MAX_HANDSET_LABEL}
            placeholder="Captain 1"
            onChange={(e) => {
              setLabel(e.target.value)
              setServerError(null)
            }}
            data-autofocus
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-zinc-300">Handset ID</span>
          <input
            className={`${INPUT} font-mono`}
            value={id}
            maxLength={63}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setId(e.target.value.toLowerCase())
              setServerError(null)
            }}
          />
        </label>
        <p className={`text-sm font-semibold ${serverError ? 'text-rose-300' : 'text-zinc-400'}`} role={serverError ? 'alert' : undefined}>
          {serverError ?? problem ?? 'Every order this handset sends is recorded with its ID. Revoked IDs can’t be reused.'}
        </p>
      </div>
    </Modal>
  )
}

/** Re-issue or revoke, after a confirmation that says what stops working. */
export function ConfirmHandsetDialog({
  action,
  handset,
  onClose,
  onIssued,
  onRevoked,
}: {
  action: 'reissue' | 'revoke'
  handset: Handset
  onClose: () => void
  onIssued: (issued: IssuedHandsetToken) => void
  onRevoked: (handset: Handset) => void
}) {
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const reissue = action === 'reissue'

  const run = () => {
    if (saving) return
    setSaving(true)
    const done = reissue ? api.reissueHandsetToken(handset.id).then(onIssued) : api.revokeHandset(handset.id).then(onRevoked)
    done.catch((err: unknown) => {
      setSaving(false)
      setServerError(failure(err))
    })
  }

  return (
    <Modal
      title={`${reissue ? 'New token' : 'Revoke'} · ${handset.label}`}
      onClose={onClose}
      width="max-w-md"
      onKey={(e) => {
        if (e.key !== 'Enter' || e.target instanceof HTMLButtonElement) return false
        run()
        return true
      }}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass('secondary')}>
            Cancel
          </button>
          <button type="button" onClick={run} disabled={saving} className={buttonClass(reissue ? 'primary' : 'danger')} data-autofocus>
            {reissue ? 'Issue new token' : 'Revoke handset'} <Kbd>Enter</Kbd>
          </button>
        </div>
      }
    >
      <p className="text-zinc-300">
        {reissue
          ? `${handset.label}’s current token stops working at once. Enter the new one in the app’s POS Settings.`
          : `${handset.label} (${handset.id}) can no longer send orders. Its past orders keep their handset ID; the ID can’t be paired again.`}
      </p>
      {serverError && (
        <p className="mt-3 text-sm font-semibold text-rose-300" role="alert">
          {serverError}
        </p>
      )}
    </Modal>
  )
}

/** The token, shown this once, with a copy button and the server address the app needs. */
export function HandsetTokenDialog({ issued, onClose }: { issued: IssuedHandsetToken; onClose: () => void }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  const tokenRef = useRef<HTMLElement>(null)

  const copy = () => {
    const selectToken = () => {
      const node = tokenRef.current
      if (!node) return
      const range = document.createRange()
      range.selectNodeContents(node)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    }
    if (!navigator.clipboard) {
      selectToken()
      setCopied('failed')
      return
    }
    navigator.clipboard.writeText(issued.token).then(
      () => setCopied('yes'),
      () => {
        selectToken()
        setCopied('failed')
      },
    )
  }

  return (
    <Modal
      title={`Token · ${issued.handset.label}`}
      onClose={onClose}
      width="max-w-lg"
      onKey={(e) => {
        if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey) {
          copy()
          return true
        }
        return false
      }}
      footer={
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={copy} className={buttonClass('secondary')}>
            {copied === 'yes' ? <Check className="size-4 text-emerald-400" aria-hidden /> : <Copy className="size-4" aria-hidden />} {copied === 'yes' ? 'Copied' : 'Copy token'} <Kbd>C</Kbd>
          </button>
          <button type="button" onClick={onClose} className={buttonClass('primary')} data-autofocus>
            Done
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-zinc-300">
          In the app, open <strong>POS Settings</strong> and enter the server address and this token for <span className="font-mono">{issued.handset.id}</span>.
        </p>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-zinc-300">Device token</span>
          <code ref={tokenRef} className="rounded-lg border border-amber-400/40 bg-zinc-950 px-3 py-3 font-mono text-lg break-all text-amber-100 select-all">
            {issued.token}
          </code>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-zinc-300">Server address</span>
          {issued.serverUrls.length > 0 ? (
            <span className="font-mono text-zinc-100">{issued.serverUrls.join(' · ')}</span>
          ) : (
            <span className="text-sm text-zinc-400">The Captain server is starting; its address shows above the handset list in a moment.</span>
          )}
        </div>
        <p className={`text-sm font-semibold ${copied === 'failed' ? 'text-rose-300' : 'text-amber-300'}`} role={copied === 'failed' ? 'alert' : undefined}>
          {copied === 'failed'
            ? 'Couldn’t reach the clipboard: the token is selected, press Ctrl+C.'
            : 'This token is not stored and won’t be shown again. If it’s lost, issue a new one.'}
        </p>
      </div>
    </Modal>
  )
}
