import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, RefreshCw, WifiOff } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { BillDetail, CounterContext, KotStatus, MemberSummary, PeakSessionView, SkuLookup, WaiterSummary } from '../api/types'
import { Kbd, LiveClock } from '../components/ui'
import { keepFocus } from '../lib/ui'
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts'
import { useScanBuffer, type QtyTarget } from '../hooks/useScanBuffer'
import type { ScanEffect } from '../hooks/scanBuffer'
import { beep } from '../lib/beep'
import { formatPaise } from '../lib/money'
import { GridFooter, ItemsGrid, PeakSide, PeakTicker, ScanBar, SidePanel } from './BillingPanels'
import { BillTabs } from './BillTabs'
import {
  activeTab,
  billingReducer,
  cancelPlan,
  findTab,
  groupItems,
  initialBillingState,
  kitchenKotPending,
  kotMessage,
  newTabBlock,
  screenMode,
  stockLeft,
  totals,
  type BillingAction,
  type Receipt,
} from './billingReducer'
import { CounterError, counterErrorMessage } from './errors'
import { EMPTY_SEARCH, highlightedFor, SEARCH_DEBOUNCE_MS, SEARCH_LIMIT, searchQuery, searchView, skuSearchReducer } from './skuSearch'
import { Modal } from './Modal'
import { describePlan, type PayPlan } from './payment'
import { PaymentDialog } from './PaymentDialog'
import { MemberDialog } from './PickerDialogs'
import { WaiterSidebar } from './WaiterSidebar'
import { PeakBanner, PeakEndDialog, PeakStartDialog } from '../components/peak/PeakControls'
import { describeVariance } from '../peak/peakMath'

/** The end dialog keeps its own session snapshot: it stays up to show the result after the session ends. */
type PeakDialog = { kind: 'start'; businessDayId: string } | { kind: 'end'; session: PeakSessionView } | null

const CONTEXT_POLL_MS = 15_000

/**
 * Counter billing. Keys come from window-level listeners (scan buffer + F-keys), so no input ever
 * needs focus. Every write runs through one serial queue, so a scanner burst is applied in order.
 */
export default function BillingScreen({ onExit, focusBillId = null }: { onExit: () => void; focusBillId?: string | null }) {
  const [state, dispatch] = useReducer(billingReducer, initialBillingState)
  const [peakDialog, setPeakDialog] = useState<PeakDialog>(null)
  /** The abandon confirm came from a tab's ×: close the tab once the bill is cancelled. */
  const [abandonClosesTab, setAbandonClosesTab] = useState(false)
  const tab = activeTab(state)
  const mode = screenMode(state)
  const rows = useMemo(() => groupItems(tab.bill?.items ?? []), [tab.bill])
  const pendingHere = useMemo(() => state.pending.filter((p) => p.tabId === tab.id), [state.pending, tab.id])
  const { lines, bottles } = totals(tab.bill)

  // Synchronous mirror for queued work, which may run before React re-renders. Every action goes
  // through `apply`, which folds it into the mirror with the same pure reducer, so the mirror is
  // always the newest state (React's own state catches up with the identical result).
  const stateRef = useRef(state)
  const contextRef = useRef<CounterContext | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const scanSeq = useRef(0)
  // Phase 21 type-to-search: results for the typed text, read by Enter through a ref.
  const [searchState, dispatchSearch] = useReducer(skuSearchReducer, EMPTY_SEARCH)
  const searchRef = useRef(searchState)
  useEffect(() => {
    searchRef.current = searchState
  })
  const searchOpenFor = useCallback((text: string) => searchView(searchRef.current, text).open, [])
  const loadedOnce = useRef(false)
  /** Orders → "Jump to bill": focused once, on the first load that resumes the held bills. */
  const pendingFocus = useRef(focusBillId)
  const busyRef = useRef(0)

  const apply = useCallback((action: BillingAction) => {
    stateRef.current = billingReducer(stateRef.current, action)
    dispatch(action)
  }, [])

  /** The newest bill of a tab (null before its first scan, or once settled). */
  const billOf = useCallback((tabId: number): BillDetail | null => findTab(stateRef.current, tabId)?.bill ?? null, [])
  const currentTabId = () => stateRef.current.activeTabId

  const setBill = useCallback(
    (tabId: number, detail: BillDetail, focusSkuId?: string) =>
      apply(focusSkuId === undefined ? { type: 'billLoaded', tabId, detail } : { type: 'billLoaded', tabId, detail, focusSkuId }),
    [apply],
  )

  const finishBill = useCallback((tabId: number, receipt: Receipt | null) => apply({ type: 'billFinished', tabId, receipt }), [apply])

  const flash = useCallback(
    (kind: 'ok' | 'error', text: string) => {
      beep(kind)
      apply({ type: 'flash', kind, text })
    },
    [apply],
  )

  const refreshContext = useCallback(async () => {
    try {
      const context = await api.context()
      // Resume the cashier's open bills only on the first successful load (also after being offline).
      const resume = !loadedOnce.current && busyRef.current === 0
      loadedOnce.current = true
      contextRef.current = context
      apply({ type: 'contextLoaded', context, resume })
      const focus = pendingFocus.current
      if (resume && focus) {
        pendingFocus.current = null
        apply({ type: 'focusBill', billId: focus })
        const tab = activeTab(stateRef.current)
        if (tab.bill?.bill.id === focus) apply({ type: 'flash', kind: 'ok', text: `Bill ${tab.label} · #${tab.bill.bill.billNo} — continue billing` })
        else apply({ type: 'flash', kind: 'error', text: 'That bill is no longer open on this till' })
      }
    } catch (err) {
      loadedOnce.current = false
      apply({ type: 'contextFailed', message: counterErrorMessage(err) })
    }
  }, [apply])

  useEffect(() => {
    void refreshContext()
    const timer = setInterval(() => void refreshContext(), CONTEXT_POLL_MS)
    return () => clearInterval(timer)
  }, [refreshContext])

  /** Re-reads a tab's bill after a failed write, in case the failure means it changed elsewhere. */
  const resync = useCallback(
    async (tabId: number) => {
      const current = billOf(tabId)
      if (!current) return
      try {
        const detail = await api.getBill(current.bill.id)
        if (detail.bill.status === 'OPEN') setBill(tabId, detail)
        else finishBill(tabId, null)
      } catch {
        // Leave the screen as it is; the next action or poll will surface the problem.
      }
    },
    [billOf, setBill, finishBill],
  )

  /** Runs a write after every earlier one, reporting failures on the scan bar. */
  const run = useCallback(
    (task: () => Promise<void>, tabId?: number) => {
      busyRef.current += 1
      queue.current = queue.current
        .then(task)
        .catch(async (err: unknown) => {
          flash('error', counterErrorMessage(err))
          if (err instanceof ApiError && err.code === 'PS007') await refreshContext()
          else if (err instanceof ApiError && tabId !== undefined) await resync(tabId)
        })
        .finally(() => {
          busyRef.current -= 1
        })
      return queue.current
    },
    [flash, refreshContext, resync],
  )

  // ── Actions ────────────────────────────────────────────────────────────────
  // Each one captures its tab when the key is pressed, so its writes land on that tab's bill even if
  // the cashier switches tabs before the queue gets to them.

  /**
   * Resolves what Enter means (Phase 21, D1): an exact barcode / SKU code first (scanner speed), else
   * the highlighted search result for this text (the first unless ↑/↓ moved it), else not found.
   */
  const resolveSku = useCallback(async (code: string): Promise<SkuLookup> => {
    try {
      return await api.lookupSku(code)
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'NOT_FOUND')) throw err
    }
    const hit = highlightedFor(searchRef.current, code) ?? (searchQuery(code) ? (await api.searchActiveSkus(code, 1))[0] : undefined)
    if (!hit) throw new CounterError(`Not found: ${code}`)
    return hit
  }, [])

  const scan = useCallback(
    (code: string, quantity: number, picked?: SkuLookup) => {
      const id = ++scanSeq.current
      const tabId = currentTabId()
      apply({ type: 'scanQueued', scan: { id, tabId, code, quantity } })
      void run(async () => {
        try {
          const context = contextRef.current
          if (!context?.businessDay) throw new CounterError('No open business day — open the day in Day End first')

          const sku = picked ?? (await resolveSku(code))
          if (!sku.isActive) throw new CounterError(`${sku.displayName} is not on sale (inactive)`)

          const session = context.peakSession
          if (session && !billOf(tabId)) {
            const { bill, item, kots } = await api.peakSale(session.id, sku.id, quantity)
            apply({
              type: 'peakSale',
              entry: {
                billId: bill.id,
                billNo: bill.billNo,
                displayName: item.displayName,
                sizeCode: item.sizeCode,
                quantity: item.quantity,
                amountPaise: bill.totalPaise,
                at: bill.createdAt,
                undone: false,
              },
            })
            const kot = kotMessage(kots, bill.billNo)
            flash(kot?.kind ?? 'ok', `Peak #${bill.billNo}: ${quantity} × ${sku.displayName} · ${kot ? kot.text : stockLeft(sku.onHandQty, quantity)}`)
            void refreshContext()
            return
          }

          let billId = billOf(tabId)?.bill.id
          if (!billId) {
            const held = findTab(stateRef.current, tabId)
            billId = (await api.createBill('NORMAL', held?.pendingMember?.id)).id
            if (held?.pendingWaiter) await api.tagWaiter(billId, held.pendingWaiter.id)
            // Track the bill before adding to it, so a failed first line (e.g. out of stock) leaves
            // an open bill the next scan reuses rather than an orphan.
            setBill(tabId, await api.getBill(billId))
          }
          await api.addItem(billId, sku.id, quantity)
          setBill(tabId, await api.getBill(billId), sku.id)
          flash('ok', `Added ${quantity} × ${sku.displayName} · ${sku.tracksStock ? stockLeft(sku.onHandQty, quantity) : 'Kitchen — F6 sends the KOT'}`)
        } finally {
          apply({ type: 'scanDone', id })
        }
      }, tabId)
    },
    [apply, run, billOf, flash, refreshContext, setBill, resolveSku],
  )

  const adjustSelected = useCallback(
    (delta: 1 | -1) => {
      const tabId = currentTabId()
      const selectedKey = findTab(stateRef.current, tabId)?.selectedKey
      const row = groupItems(billOf(tabId)?.items ?? []).find((r) => r.key === selectedKey)
      if (!row) return
      void run(async () => {
        const billId = billOf(tabId)?.bill.id
        if (!billId) return
        let kots: KotStatus[] | undefined
        if (delta === 1) await api.addItem(billId, row.skuId, 1)
        else if (row.cancelItemId) kots = (await api.cancelItem(billId, row.cancelItemId, 1)).kots
        const updated = await api.getBill(billId)
        setBill(tabId, updated, row.skuId)
        const kot = kotMessage(kots, updated.bill.billNo)
        flash(kot?.kind ?? 'ok', `${delta === 1 ? 'Added' : 'Removed'} 1 × ${row.displayName}${kot ? ` · ${kot.text}` : ''}`)
      }, tabId)
    },
    [run, billOf, setBill, flash],
  )

  const pickMember = useCallback(
    (member: MemberSummary | null) => {
      apply({ type: 'dialog', dialog: null })
      const tabId = currentTabId()
      const billId = billOf(tabId)?.bill.id
      if (!billId) {
        apply({ type: 'pendingMember', tabId, member })
        return
      }
      void run(async () => {
        await api.setMember(billId, member?.id ?? null)
        setBill(tabId, await api.getBill(billId))
        flash('ok', member ? `Member ${member.displayName} attached` : 'Member removed (walk-in)')
      }, tabId)
    },
    [apply, run, billOf, setBill, flash],
  )

  const pickWaiter = useCallback(
    (waiter: WaiterSummary) => {
      apply({ type: 'dialog', dialog: null })
      const tabId = currentTabId()
      const label = findTab(stateRef.current, tabId)?.label
      const billId = billOf(tabId)?.bill.id
      if (!billId) {
        apply({ type: 'pendingWaiter', tabId, waiter })
        flash('ok', `${waiter.displayName} on Bill ${label} — scan the first bottle`)
        return
      }
      void run(async () => {
        await api.tagWaiter(billId, waiter.id)
        setBill(tabId, await api.getBill(billId))
        flash('ok', `Bill ${label} tagged to ${waiter.displayName}`)
      }, tabId)
    },
    [apply, run, billOf, setBill, flash],
  )

  const pay = useCallback(
    (plan: PayPlan) => {
      const tabId = currentTabId()
      const detail = billOf(tabId)
      if (!detail) return
      apply({ type: 'dialog', dialog: null }) // closing first makes a double Enter harmless
      void run(async () => {
        const billId = detail.bill.id
        // Settling sends any Kitchen lines still pending (Phase 19).
        const kots: KotStatus[] = []
        if (plan.kind === 'counter') {
          kots.push(...(await api.settle(billId, plan.payments)).kots)
        } else {
          for (const step of plan.steps) kots.push(...((await api.settleWaiter(billId, plan.waiterId, step.tender, step.amount)).kots ?? []))
        }
        finishBill(tabId, { billNo: detail.bill.billNo, totalPaise: detail.bill.totalPaise, changePaise: plan.changePaise, summary: describePlan(plan, detail) })
        const kot = kotMessage(kots, detail.bill.billNo)
        flash(
          kot?.kind ?? 'ok',
          `Bill #${detail.bill.billNo} settled${plan.changePaise > 0n ? ` · change ${formatPaise(plan.changePaise)}` : ''}${kot ? ` · ${kot.text}` : ''}`,
        )
      }, tabId)
    },
    [apply, run, billOf, finishBill, flash],
  )

  const closeDialog = useCallback(() => {
    setAbandonClosesTab(false)
    apply({ type: 'dialog', dialog: null })
  }, [apply])

  const abandonBill = useCallback(() => {
    const tabId = currentTabId()
    const closesTab = abandonClosesTab
    closeDialog()
    void run(async () => {
      const detail = billOf(tabId)
      if (!detail) return
      for (const item of detail.items) {
        if (item.quantity > 0 && item.remainingQuantity > 0) await api.cancelItem(detail.bill.id, item.id, item.remainingQuantity)
      }
      await api.closeEmpty(detail.bill.id)
      finishBill(tabId, null)
      if (closesTab) apply({ type: 'tabClosed', tabId })
      flash('ok', `Bill #${detail.bill.billNo} cancelled`)
    }, tabId)
  }, [abandonClosesTab, closeDialog, run, billOf, finishBill, apply, flash])

  /** Ctrl+Z in peak: the server finds this till's newest scan, so it works after a reload too. */
  const undoPeak = useCallback(() => {
    void run(async () => {
      const { undone, kots } = await api.undoLastPeak().catch((err: unknown) => {
        throw err instanceof ApiError && err.code === 'NOT_FOUND' ? new CounterError('Nothing left to undo in this peak') : err
      })
      apply({ type: 'peakUndone', billId: undone.billId })
      const kot = kotMessage(kots, undone.billNo)
      flash(kot?.kind ?? 'ok', `Last scan voided: ${undone.displayName} ×${undone.quantity} (peak bill #${undone.billNo})${kot ? ` · ${kot.text}` : ''}`)
      void refreshContext()
    })
  }, [run, apply, flash, refreshContext])

  // ── Tabs ───────────────────────────────────────────────────────────────────

  const openTab = useCallback(() => {
    const block = newTabBlock(stateRef.current)
    if (block) {
      flash('error', block)
      return
    }
    const held = activeTab(stateRef.current)
    apply({ type: 'tabOpened' })
    flash('ok', `Bill ${held.label} held · Bill ${activeTab(stateRef.current).label} ready — scan the first bottle`)
  }, [apply, flash])

  const switchTab = useCallback((tabId: number) => apply({ type: 'tabSwitched', tabId }), [apply])
  const cycleTab = useCallback((delta: 1 | -1) => apply({ type: 'tabCycled', delta }), [apply])

  /** ×: an empty tab just closes; a bill is cancelled first (confirm), unless it is part-paid. */
  const closeTab = useCallback(
    (tabId: number) => {
      const s = stateRef.current
      const target = findTab(s, tabId)
      if (!target) return
      if (s.pending.some((p) => p.tabId === tabId)) {
        flash('error', `Bill ${target.label} is still adding bottles — try again in a moment`)
        return
      }
      const detail = target.bill
      if (!detail) {
        apply({ type: 'tabClosed', tabId })
        return
      }
      if (detail.tenderedPaise > 0n) {
        flash('error', `Bill #${detail.bill.billNo} is part-paid — settle it with F9`)
        return
      }
      if (groupItems(detail.items).length === 0) {
        void run(async () => {
          await api.closeEmpty(detail.bill.id)
          finishBill(tabId, null)
          apply({ type: 'tabClosed', tabId })
        }, tabId)
        return
      }
      apply({ type: 'tabSwitched', tabId })
      setAbandonClosesTab(true)
      apply({ type: 'dialog', dialog: 'abandon' })
    },
    [apply, flash, run, finishBill],
  )

  // ── Keyboard ───────────────────────────────────────────────────────────────

  const keysLive = state.dialog === null && peakDialog === null && (mode === 'NORMAL' || mode === 'PEAK')
  const peakSession = state.context?.peakSession ?? null

  const togglePeak = useCallback(() => {
    const context = contextRef.current
    if (context?.peakSession) setPeakDialog({ kind: 'end', session: context.peakSession })
    else if (context?.businessDay) setPeakDialog({ kind: 'start', businessDayId: context.businessDay.id })
  }, [])
  const canEditBill = mode === 'NORMAL'

  /** F6: print the current bill's pending Kitchen lines (and cancels) now, e.g. for a held tab. */
  const sendKot = useCallback(() => {
    const tabId = currentTabId()
    const detail = billOf(tabId)
    if (!detail) {
      flash('error', 'No bill — scan an item first')
      return
    }
    const pending = kitchenKotPending(detail.items)
    if (pending.send === 0 && pending.cancel === 0) {
      flash('error', detail.items.some((i) => i.kotStation === 'KITCHEN') ? 'The kitchen already has every item on this bill' : 'No Kitchen items on this bill')
      return
    }
    void run(async () => {
      const { kots } = await api.sendKot(detail.bill.id)
      setBill(tabId, await api.getBill(detail.bill.id))
      const kot = kotMessage(kots, detail.bill.billNo)
      if (kot) flash(kot.kind, kot.text)
    }, tabId)
  }, [billOf, flash, run, setBill])

  const openPayment = useCallback(() => {
    const tabId = currentTabId()
    const detail = billOf(tabId)
    if (!detail || groupItems(detail.items).length === 0) {
      if (detail && detail.bill.totalPaise === 0n) {
        void run(async () => {
          await api.closeEmpty(detail.bill.id)
          finishBill(tabId, null)
          flash('ok', `Empty bill #${detail.bill.billNo} closed`)
        }, tabId)
      } else flash('error', 'Scan a bottle first')
      return
    }
    apply({ type: 'dialog', dialog: 'payment' })
  }, [billOf, run, finishBill, flash, apply])

  const newBill = useCallback(() => {
    const tabId = currentTabId()
    const detail = billOf(tabId)
    if (!detail) {
      flash('ok', 'Ready — scan the first bottle')
      return
    }
    if (detail.bill.totalPaise === 0n && detail.tenderedPaise === 0n) {
      void run(async () => {
        await api.closeEmpty(detail.bill.id)
        finishBill(tabId, null)
      }, tabId)
      return
    }
    apply({ type: 'dialog', dialog: 'abandon' })
  }, [billOf, run, finishBill, flash, apply])

  useGlobalShortcuts(
    {
      F1: () => canEditBill && newBill(),
      F2: () => (canEditBill ? apply({ type: 'dialog', dialog: 'member' }) : flash('error', 'Members are not tagged during peak')),
      F3: openTab,
      F4: () => {
        if (!canEditBill) flash('error', 'Waiters are not tagged during peak')
        else if ((billOf(currentTabId())?.tenderedPaise ?? 0n) > 0n) flash('error', 'Waiter is locked after the first payment')
        else apply({ type: 'dialog', dialog: 'waiter' })
      },
      F6: () => (canEditBill ? sendKot() : flash('error', 'Peak scans send their KOT straight away')),
      F8: togglePeak,
      F9: () => (canEditBill ? openPayment() : flash('error', 'Peak bills take no payment — they reconcile at session end')),
    },
    keysLive,
  )

  /** Enter → qty → Enter: brings the selected row to `quantity` bottles, then opens Payment (as F9). */
  const setQuantity = useCallback(
    (quantity: number) => {
      if (quantity < 1) {
        flash('error', 'Quantity must be at least 1 — use − to remove the line')
        return
      }
      const tabId = currentTabId()
      const key = findTab(stateRef.current, tabId)?.selectedKey
      void run(async () => {
        const detail = billOf(tabId)
        const row = groupItems(detail?.items ?? []).find((r) => r.key === key)
        if (!detail || !row) return
        if (quantity !== row.quantity) {
          const kots: KotStatus[] = []
          if (quantity > row.quantity) await api.addItem(detail.bill.id, row.skuId, quantity - row.quantity)
          else {
            for (const c of cancelPlan(detail.items, row.key, row.quantity - quantity)) kots.push(...((await api.cancelItem(detail.bill.id, c.itemId, c.quantity)).kots ?? []))
          }
          setBill(tabId, await api.getBill(detail.bill.id), row.skuId)
          const kot = kotMessage(kots, detail.bill.billNo)
          flash(kot?.kind ?? 'ok', `${row.displayName} × ${quantity}${kot ? ` · ${kot.text}` : ''}`)
        }
        // Payment opens on the current tab; skip it if the cashier has moved to another bill meanwhile.
        if (currentTabId() === tabId) openPayment()
      }, tabId)
    },
    [run, billOf, setBill, flash, openPayment],
  )

  const onScanEffect = useCallback(
    (effect: ScanEffect) => {
      if (effect.type === 'commit') {
        scan(effect.code, effect.quantity)
        return
      }
      if (effect.type === 'setQty') {
        setQuantity(effect.quantity)
        return
      }
      if (effect.type === 'highlight') {
        dispatchSearch({ type: 'move', delta: effect.delta })
        return
      }
      if (!canEditBill) return
      if (effect.command === 'up') apply({ type: 'move', delta: -1 })
      else if (effect.command === 'down') apply({ type: 'move', delta: 1 })
      else adjustSelected(effect.command === 'increment' ? 1 : -1)
    },
    [scan, adjustSelected, setQuantity, canEditBill, apply],
  )
  const selectedRow = canEditBill ? rows.find((r) => r.key === tab.selectedKey) : undefined
  // Keyed by tab too, so a quantity edit never carries over to the same SKU on another bill.
  const qtyTarget: QtyTarget | null = selectedRow ? { key: `${tab.id}:${selectedRow.key}`, quantity: selectedRow.quantity } : null
  const [scanState, clearScan] = useScanBuffer(keysLive, onScanEffect, qtyTarget, searchOpenFor)
  const search = searchView(searchState, scanState.text)

  // Type-to-search: fetch the matches for the typed text (debounced); a stale answer is ignored.
  const query = keysLive ? search.query : null
  useEffect(() => {
    if (query === null) return
    const timer = setTimeout(() => {
      api
        .searchActiveSkus(query, SEARCH_LIMIT)
        .then((results) => dispatchSearch({ type: 'results', query, results }))
        .catch(() => undefined) // the context poll reports an unreachable server
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  /** A tapped search result: add it at once, with any "N*" prefix. */
  const pickResult = useCallback(
    (sku: SkuLookup) => {
      scan(sku.skuCode, scanState.quantity ?? 1, sku)
      clearScan()
    },
    [scan, scanState.quantity, clearScan],
  )

  // The scan buffer listens in the capture phase, so a non-empty buffer consumes Esc before this.
  useEffect(() => {
    if (state.dialog !== null) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      const ctrl = event.ctrlKey || event.metaKey
      if (event.key === 'Escape') {
        event.preventDefault()
        onExit()
      } else if (ctrl && event.key.toLowerCase() === 'z' && mode === 'PEAK') {
        event.preventDefault()
        if (!event.repeat) undoPeak() // a held key voids one scan, not a run of them
      } else if (!keysLive) {
        return
      } else if (event.key === 'PageDown' || event.key === 'PageUp' || (ctrl && event.key === 'Tab')) {
        // Ctrl+T / Ctrl+Tab only reach the page when Chrome runs in kiosk / --app mode.
        event.preventDefault()
        if (!event.repeat) cycleTab(event.key === 'PageUp' || event.shiftKey ? -1 : 1)
      } else if (ctrl && event.key.toLowerCase() === 't') {
        event.preventDefault()
        if (!event.repeat) openTab()
      } else if (event.altKey && !ctrl && /^Digit[1-9]$/.test(event.code)) {
        event.preventDefault()
        const target = stateRef.current.tabs[Number(event.code.slice(5)) - 1]
        if (target) switchTab(target.id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state.dialog, mode, keysLive, onExit, undoPeak, cycleTab, openTab, switchTab])

  // ── Layout ─────────────────────────────────────────────────────────────────

  const billNo = tab.bill?.bill.billNo
  const showTabs = mode === 'NORMAL' || state.tabs.length > 1

  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b-2 border-amber-400 bg-zinc-900 px-5">
        <button
          type="button"
          {...keepFocus}
          onClick={onExit}
          className="flex items-center gap-2 rounded px-1 text-zinc-300 hover:text-zinc-50"
          aria-label="Back to dashboard (Esc)"
        >
          <ArrowLeft className="size-5" aria-hidden />
          <span className="rounded bg-amber-400 px-2 py-0.5 text-lg font-black tracking-tight text-zinc-950">FL2</span>
        </button>
        <h1 className="text-lg font-bold tracking-wide uppercase">Billing</h1>
        <ModeBadge mode={mode} sessionNo={state.context?.peakSession?.sessionNo} />
        {mode === 'NORMAL' && (
          <span className="font-mono text-lg text-zinc-300">
            Bill {tab.label} · {billNo !== undefined ? `#${billNo}` : 'new'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm">
          {state.context && <span className="text-zinc-400">Cashier: {state.context.cashier.displayName}</span>}
          {state.context?.businessDay && <span className="text-zinc-400">Day {state.context.businessDay.businessDate}</span>}
          <LiveClock />
          <span className="flex items-center gap-1 text-zinc-400">
            <Kbd>Esc</Kbd> Dashboard
          </span>
        </div>
      </header>

      {peakSession && (mode === 'NORMAL' || mode === 'PEAK') && <PeakBanner session={peakSession} onEnd={togglePeak} />}

      {mode === 'LOADING' && <CenterNote title="Connecting to the POS server…" />}
      {mode === 'OFFLINE' && (
        <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />}>
          <p className="text-zinc-300">{state.offlineMessage}</p>
          <p className="mt-1 text-sm text-zinc-400">
            Start it from the repo root with <code className="rounded bg-zinc-800 px-1">npm run api:dev</code>. Retrying every 15 s.
          </p>
          <button
            type="button"
            onClick={() => void refreshContext()}
            className="mt-4 inline-flex items-center gap-2 rounded-md border-2 border-zinc-600 px-4 py-2 font-bold hover:border-zinc-300"
          >
            <RefreshCw className="size-4" aria-hidden /> Retry now
          </button>
        </CenterNote>
      )}
      {mode === 'BLOCKED' && (
        <CenterNote title="No open business day">
          <p className="text-zinc-300">Billing starts once a manager opens the day in Day End.</p>
        </CenterNote>
      )}

      {(mode === 'NORMAL' || mode === 'PEAK') && (
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col" aria-label={mode === 'PEAK' ? 'Peak scans' : 'Bill items'}>
            {showTabs && (
              <BillTabs
                tabs={state.tabs}
                activeTabId={tab.id}
                newBlock={newTabBlock(state)}
                onSwitch={switchTab}
                onClose={closeTab}
                onNew={openTab}
              />
            )}
            <ScanBar scan={scanState} flash={state.flash} enabled={keysLive} qtyLabel={selectedRow?.displayName} search={search} onPick={pickResult} />
            {mode === 'PEAK' ? (
              <PeakTicker ticker={state.ticker} pending={pendingHere} />
            ) : (
              <ItemsGrid
                rows={rows}
                pending={pendingHere}
                selectedKey={tab.selectedKey}
                onSelect={(key) => apply({ type: 'select', key })}
                receipt={tab.receipt}
                qtyEdit={scanState.qtyEdit}
              />
            )}
            <GridFooter mode={mode} />
          </main>
          {mode === 'PEAK' && state.context?.peakSession ? (
            <PeakSide
              session={state.context.peakSession}
              scans={state.ticker.filter((e) => !e.undone).length}
              onUndo={undoPeak}
              canUndo
            />
          ) : (
            <SidePanel
              detail={tab.bill}
              pendingMember={tab.pendingMember}
              pendingWaiter={tab.pendingWaiter}
              lines={lines}
              bottles={bottles}
              onMember={() => apply({ type: 'dialog', dialog: 'member' })}
              onWaiter={() => apply({ type: 'dialog', dialog: 'waiter' })}
              onPay={openPayment}
              kot={tab.bill ? kitchenKotPending(tab.bill.items) : { send: 0, cancel: 0 }}
              onSendKot={sendKot}
              onStartPeak={peakSession ? undefined : togglePeak}
            />
          )}
        </div>
      )}

      {state.dialog === 'payment' && tab.bill && (
        <PaymentDialog detail={tab.bill} busy={pendingHere.length > 0} onConfirm={pay} onClose={closeDialog} />
      )}
      {state.dialog === 'member' && <MemberDialog onPick={pickMember} onClose={closeDialog} />}
      {peakDialog?.kind === 'start' && (
        <PeakStartDialog
          businessDayId={peakDialog.businessDayId}
          onStarted={(session) => {
            setPeakDialog(null)
            flash('ok', `Peak #${session.sessionNo} started${billOf(currentTabId()) ? ' — finish this bill, then scans go to peak' : ''}`)
            void refreshContext()
          }}
          onClose={() => setPeakDialog(null)}
        />
      )}
      {peakDialog?.kind === 'end' && (
        <PeakEndDialog
          session={peakDialog.session}
          onEnded={(r) => {
            flash('ok', `Peak #${r.session.sessionNo} ended · ${describeVariance(r.breakdown.variancePaise).label}`)
            void refreshContext()
          }}
          onClose={() => setPeakDialog(null)}
        />
      )}
      {state.dialog === 'waiter' && (
        <WaiterSidebar currentWaiterId={tab.bill?.waiter?.id ?? tab.pendingWaiter?.id ?? null} onPick={pickWaiter} onClose={closeDialog} />
      )}
      {state.dialog === 'abandon' && tab.bill && (
        <Modal
          title={`Cancel Bill ${tab.label} (#${tab.bill.bill.billNo})?`}
          onClose={closeDialog}
          onKey={(e) => {
            if (e.key !== 'Enter') return false
            abandonBill()
            return true
          }}
          footer={
            <div className="flex justify-end gap-3">
              <button type="button" onClick={closeDialog} className="rounded-md border-2 border-zinc-600 px-4 py-2 font-bold hover:border-zinc-400 hover:bg-zinc-800">
                Keep bill (Esc)
              </button>
              <button type="button" onClick={abandonBill} className="rounded-md bg-rose-500 px-4 py-2 font-bold text-zinc-950 enabled:hover:brightness-110">
                Cancel all &amp; close (Enter)
              </button>
            </div>
          }
        >
          <p>
            All {bottles} bottle(s) go back into stock as cancellation lines, then the ₹0 bill is closed
            {abandonClosesTab ? ' and its tab with it' : ''}. Nothing is deleted — the audit trail keeps every line.
          </p>
        </Modal>
      )}
    </div>
  )
}

function ModeBadge({ mode, sessionNo }: { mode: string; sessionNo: number | undefined }) {
  if (mode === 'PEAK') {
    return <span className="rounded bg-violet-500 px-2.5 py-1 text-sm font-black tracking-widest text-zinc-950 uppercase">Peak #{sessionNo}</span>
  }
  if (mode === 'NORMAL') {
    return <span className="rounded bg-emerald-500 px-2.5 py-1 text-sm font-black tracking-widest text-zinc-950 uppercase">Normal</span>
  }
  return null
}

function CenterNote({ title, icon, children }: { title: string; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      {icon}
      <h2 className="text-2xl font-bold">{title}</h2>
      {children}
    </div>
  )
}
