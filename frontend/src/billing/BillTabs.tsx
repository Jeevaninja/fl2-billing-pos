import { Plus, X } from 'lucide-react'
import { Kbd } from '../components/ui'
import { formatPaise } from '../lib/money'
import { keepFocus } from '../lib/ui'
import type { BillTab } from './billingReducer'

/**
 * Chrome-style strip of held bills above the scan bar: click a tab to switch, × to close or cancel
 * it, + (F3) for a new customer. Buttons keep focus where it is, so the scanner never loses keys.
 */
export function BillTabs({
  tabs,
  activeTabId,
  newBlock,
  onSwitch,
  onClose,
  onNew,
}: {
  tabs: BillTab[]
  activeTabId: number
  /** Why + is disabled, or null. */
  newBlock: string | null
  onSwitch: (tabId: number) => void
  onClose: (tabId: number) => void
  onNew: () => void
}) {
  return (
    <div className="flex items-end gap-1 border-b-2 border-zinc-800 bg-zinc-950 px-2 pt-2" role="tablist" aria-label="Held bills">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        const detail = tab.bill
        const waiter = detail?.waiter ?? tab.pendingWaiter
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={`-mb-0.5 flex max-w-60 min-w-28 flex-1 items-center rounded-t-lg border-2 border-b-0 ${
              active
                ? 'border-zinc-700 border-t-amber-400 bg-zinc-900 text-zinc-50'
                : 'border-transparent bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            <button
              type="button"
              {...keepFocus}
              onClick={() => onSwitch(tab.id)}
              title={`Bill ${tab.label}${detail ? ` · #${detail.bill.billNo}` : ''}`}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-3 text-left"
            >
              <span className="text-sm font-bold whitespace-nowrap">Bill {tab.label}</span>
              <span className="min-w-0 truncate font-mono text-xs text-zinc-400">
                {detail ? `#${detail.bill.billNo}` : 'New'}
                {waiter && ` · ${waiter.code}`}
              </span>
              {detail && (
                <span className={`ml-auto font-mono text-xs font-bold whitespace-nowrap tabular-nums ${active ? 'text-amber-300' : ''}`}>
                  {formatPaise(detail.bill.totalPaise)}
                </span>
              )}
            </button>
            <button
              type="button"
              {...keepFocus}
              onClick={() => onClose(tab.id)}
              aria-label={detail ? `Cancel Bill ${tab.label} (#${detail.bill.billNo})` : `Close Bill ${tab.label}`}
              title={detail ? 'Cancel this bill' : 'Close tab'}
              className="mr-1 shrink-0 rounded-full p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        {...keepFocus}
        onClick={onNew}
        disabled={newBlock !== null}
        aria-label="New bill tab (F3)"
        title={newBlock ?? 'New bill tab (F3)'}
        className="mb-1 ml-0.5 shrink-0 rounded-full p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
      >
        <Plus className="size-5" aria-hidden />
      </button>
      <span className="mb-2 ml-auto hidden shrink-0 items-center gap-1 pl-2 text-xs whitespace-nowrap text-zinc-500 xl:flex">
        <Kbd>F3</Kbd> new · <Kbd>PgUp</Kbd>
        <Kbd>PgDn</Kbd> switch
      </span>
    </div>
  )
}
