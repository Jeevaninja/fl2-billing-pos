import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import type { MemberSummary, WaiterSummary } from '../api/types'
import { Kbd } from '../components/ui'
import { formatPaise } from '../lib/money'
import { counterErrorMessage } from './errors'
import { Modal } from './Modal'

interface PickerProps<T> {
  title: string
  placeholder: string
  query: string
  onQuery: (q: string) => void
  items: T[]
  status: string | null
  onPick: (item: T) => void
  onEmptyEnter?: () => void
  onClose: () => void
  render: (item: T) => ReactNode
  itemKey: (item: T) => string
  footer: ReactNode
}

/** Search box + arrow-key list; Enter picks the highlighted row. */
function Picker<T>(p: PickerProps<T>) {
  const [index, setIndex] = useState(0)
  const active = Math.min(index, Math.max(0, p.items.length - 1))
  return (
    <Modal
      title={p.title}
      onClose={p.onClose}
      footer={p.footer}
      onKey={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          setIndex(Math.min(p.items.length - 1, Math.max(0, active + (e.key === 'ArrowDown' ? 1 : -1))))
          return true
        }
        if (e.key === 'Enter') {
          const item = p.items[active]
          if (item) p.onPick(item)
          else if (p.query.trim() === '') p.onEmptyEnter?.()
          return true
        }
        return false
      }}
    >
      <input
        data-autofocus
        value={p.query}
        onChange={(e) => {
          p.onQuery(e.target.value)
          setIndex(0)
        }}
        placeholder={p.placeholder}
        autoComplete="off"
        className="w-full rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 py-2 text-lg outline-none focus:border-amber-400"
      />
      <ul className="mt-3 flex flex-col gap-1" role="listbox">
        {p.items.map((item, i) => (
          <li key={p.itemKey(item)} role="option" aria-selected={i === active}>
            <button
              type="button"
              onClick={() => p.onPick(item)}
              onMouseEnter={() => setIndex(i)}
              className={`w-full rounded-md border-2 px-3 py-2 text-left ${
                i === active ? 'border-amber-400 bg-zinc-800' : 'border-transparent bg-zinc-950'
              }`}
            >
              {p.render(item)}
            </button>
          </li>
        ))}
      </ul>
      {p.status && <p className="mt-3 text-sm text-zinc-400">{p.status}</p>}
    </Modal>
  )
}

const MEMBER_HINT = 'Type a membership number or name. Enter on an empty box = walk-in.'

export function MemberDialog({ onPick, onClose }: { onPick: (m: MemberSummary | null) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MemberSummary[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const q = query.trim()
    const mine = ++seq.current
    if (q === '') return
    const timer = setTimeout(() => {
      api
        .searchMembers(q)
        .then((found) => {
          if (mine !== seq.current) return
          setItems(found)
          setStatus(found.length === 0 ? 'No active member matches' : null)
        })
        .catch((err: unknown) => mine === seq.current && setStatus(counterErrorMessage(err)))
    }, 150)
    return () => clearTimeout(timer)
  }, [query])

  return (
    <Picker
      title="Member (optional)"
      placeholder="M-0001 or name"
      query={query}
      onQuery={setQuery}
      items={query.trim() === '' ? [] : items}
      status={query.trim() === '' ? MEMBER_HINT : status}
      onPick={onPick}
      onEmptyEnter={() => onPick(null)}
      onClose={onClose}
      itemKey={(m) => m.id}
      render={(m) => (
        <span className="flex justify-between gap-3">
          <span className="font-bold">{m.displayName}</span>
          <span className="font-mono text-zinc-400">{m.membershipNo}</span>
        </span>
      )}
      footer={
        <div className="flex items-center justify-between">
          <span className="text-sm text-zinc-400">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> select · <Kbd>Enter</Kbd> attach
          </span>
          <button type="button" onClick={() => onPick(null)} className="rounded-md border-2 border-zinc-600 px-4 py-2 font-bold hover:border-zinc-300">
            Walk-in (no member)
          </button>
        </div>
      }
    />
  )
}

export function WaiterDialog({ onPick, onClose }: { onPick: (w: WaiterSummary) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [all, setAll] = useState<WaiterSummary[]>([])
  const [status, setStatus] = useState<string | null>('Loading waiters…')

  useEffect(() => {
    api
      .listWaiters()
      .then((w) => {
        setAll(w)
        setStatus(w.length === 0 ? 'No active waiters' : null)
      })
      .catch((err: unknown) => setStatus(counterErrorMessage(err)))
  }, [])

  const q = query.trim().toLowerCase()
  const items = q === '' ? all : all.filter((w) => w.code.toLowerCase().includes(q) || w.displayName.toLowerCase().includes(q))

  return (
    <Picker
      title="Tag waiter"
      placeholder="Code or name"
      query={query}
      onQuery={setQuery}
      items={items}
      status={status}
      onPick={onPick}
      onClose={onClose}
      itemKey={(w) => w.id}
      render={(w) => (
        <span className="flex items-center justify-between gap-3">
          <span>
            <span className="font-mono text-zinc-400">{w.code}</span> <span className="font-bold">{w.displayName}</span>
          </span>
          <span className="flex items-center gap-3 text-sm">
            <TrustBadge trusted={w.isTrusted} />
            <span className="font-mono text-zinc-300">
              {formatPaise(w.outstandingPaise)}
              {w.creditLimitPaise !== null && <span className="text-zinc-500"> / {formatPaise(w.creditLimitPaise)}</span>}
            </span>
          </span>
        </span>
      )}
      footer={
        <span className="text-sm text-zinc-400">
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> select · <Kbd>Enter</Kbd> tag · trusted waiters may pay later; untrusted pay bill-on-bill
        </span>
      }
    />
  )
}

export function TrustBadge({ trusted }: { trusted: boolean }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-black tracking-wider uppercase ${
        trusted ? 'bg-emerald-500 text-zinc-950' : 'bg-zinc-700 text-zinc-200'
      }`}
    >
      {trusted ? 'Trusted' : 'Untrusted'}
    </span>
  )
}
