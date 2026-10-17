import { useCallback, useEffect, useReducer, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from 'react'
import { ArrowLeft, PackagePlus, RefreshCw, ScanBarcode, Sunrise, WifiOff, X } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { StockReceipt } from '../api/types'
import { FlashLine, SizeChip } from '../billing/BillingPanels'
import { counterErrorMessage } from '../billing/errors'
import { Modal } from '../billing/Modal'
import { beep } from '../lib/beep'
import { formatPaise } from '../lib/money'
import { FOCUS_RING, keepFocus, SIZE_NAME } from '../lib/ui'
import {
  countLabel,
  entryCount,
  initialPurchaseState,
  lineError,
  lineTotal,
  pickFromSearch,
  purchaseReducer,
  stagedTotals,
  submitError,
  submitPayload,
} from '../purchase/purchaseReducer'
import { RupeeField } from './RupeeField'
import { Kbd, LiveClock } from './ui'

const POLL_MS = 15_000
const SEARCH_DEBOUNCE_MS = 150
/** A second Esc within this window leaves even with lines staged. */
const DISCARD_WINDOW_MS = 3_000

interface PurchaseScreenProps {
  onExit: () => void
  onOpenDayEnd: () => void
}

/**
 * Stock inwarding (GRN): enter a supplier invoice line by line (SKU → cases → loose bottles → unit
 * cost, all on Enter; the cost is pre-filled from the catalog), review the staging list, and post
 * it with F9. Bottles = cases × the SKU's case size + loose. The server raises stock for every line in
 * one transaction; a posted receipt is final (append-only), and a repeated invoice is refused.
 */
export default function PurchaseScreen({ onExit, onOpenDayEnd }: PurchaseScreenProps) {
  const [state, dispatch] = useReducer(purchaseReducer, initialPurchaseState)
  const invoiceRef = useRef<HTMLInputElement>(null)
  const vendorRef = useRef<HTMLInputElement>(null)
  const skuRef = useRef<HTMLInputElement>(null)
  const casesRef = useRef<HTMLInputElement>(null)
  const looseRef = useRef<HTMLInputElement>(null)
  const costRef = useRef<HTMLInputElement>(null)
  const escAt = useRef(0)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  const flash = useCallback((kind: 'ok' | 'error', text: string) => {
    beep(kind)
    dispatch({ type: 'flash', kind, text })
  }, [])

  const refresh = useCallback(async () => {
    try {
      const context = await api.context()
      dispatch({ type: 'till', cashier: context.cashier.displayName, date: context.businessDay?.businessDate ?? null })
      if (!context.businessDay) {
        dispatch({ type: 'noDay' })
        return
      }
      dispatch({ type: 'loaded', receipts: await api.listPurchases() })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_FOUND') dispatch({ type: 'noDay' })
      else dispatch({ type: 'failed', message: counterErrorMessage(err) })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // Focus the invoice number once the form first appears.
  const formShown = state.load === 'ready'
  useEffect(() => {
    if (formShown) invoiceRef.current?.focus()
  }, [formShown])

  // Debounced SKU search while typing (not once a SKU is picked).
  const { query, picked } = state
  useEffect(() => {
    const text = query.trim()
    if (picked || text === '') return
    const timer = setTimeout(() => {
      api
        .searchSkus(text)
        .then((results) => dispatch({ type: 'results', query: text, results }))
        .catch(() => undefined) // the poll reports an unreachable server
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, picked])

  /** Enter in the SKU field: resolve a scan or the highlighted result, then move to cases. */
  const resolveSku = useCallback(async () => {
    const current = stateRef.current
    if (current.picked) {
      casesRef.current?.focus()
      return
    }
    const text = current.query.trim()
    if (text === '') return
    let results = current.results
    if (results.length === 0 || pickFromSearch(text, results, current.highlighted) === null) {
      try {
        results = await api.searchSkus(text)
      } catch (err) {
        flash('error', counterErrorMessage(err))
        return
      }
    }
    const sku = pickFromSearch(text, results, stateRef.current.highlighted)
    if (!sku) {
      flash('error', `No SKU matches “${text}”`)
      return
    }
    dispatch({ type: 'pick', sku })
    if (sku.isActive) casesRef.current?.focus()
    else beep('error')
  }, [flash])

  const addLine = useCallback(() => {
    const current = stateRef.current
    const next = purchaseReducer(current, { type: 'addLine' })
    dispatch({ type: 'addLine' })
    if (next.lines !== current.lines) {
      beep('ok')
      skuRef.current?.focus()
    } else {
      beep('error')
      if (lineError(current) === 'Pick a SKU') skuRef.current?.focus()
    }
  }, [])

  const askPost = useCallback(() => {
    const current = stateRef.current
    if (current.submitting) return
    const error = submitError(current)
    if (error) {
      flash('error', error)
      if (error === 'Enter the invoice number') invoiceRef.current?.focus()
      return
    }
    dispatch({ type: 'confirm', on: true })
  }, [flash])

  const post = useCallback(() => {
    const current = stateRef.current
    const payload = submitPayload(current)
    if (!payload || current.submitting) return
    dispatch({ type: 'submitting', on: true })
    api
      .postPurchase(payload.invoiceNo, payload.vendorName, payload.lines)
      .then(({ receipt }) => {
        dispatch({ type: 'posted' })
        flash('ok', `GRN ${receipt.invoiceNo} posted · ${receipt.bottles} bottle(s) added to stock`)
        invoiceRef.current?.focus()
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === 'PS011') {
          dispatch({ type: 'duplicate' })
          flash('error', `Invoice ${payload.invoiceNo}${payload.vendorName ? ` from ${payload.vendorName}` : ''} was already received — check the number`)
          invoiceRef.current?.focus()
          return
        }
        dispatch({ type: 'submitting', on: false })
        dispatch({ type: 'confirm', on: false })
        flash('error', counterErrorMessage(err))
      })
      .finally(() => void refresh())
  }, [flash, refresh])

  // Page keys (a dialog owns the keyboard while open): F9 post, Esc clear / leave, Del remove line.
  const dialogOpen = state.confirming
  useEffect(() => {
    if (dialogOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const current = stateRef.current
      if (event.key === 'F9') {
        event.preventDefault()
        if (current.load === 'ready') askPost()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        if (current.query !== '' || current.cases !== '' || current.loose !== '' || current.cost !== '') {
          dispatch({ type: 'clearEntry' })
          skuRef.current?.focus()
          return
        }
        const now = Date.now()
        if (current.lines.length > 0 && now - escAt.current > DISCARD_WINDOW_MS) {
          escAt.current = now
          flash('error', `${current.lines.length} staged line(s) not posted — press Esc again to discard and leave`)
          return
        }
        onExit()
        return
      }
      const inField = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
      if (event.key === 'Delete' && !inField && current.selectedLine !== null) {
        event.preventDefault()
        dispatch({ type: 'removeLine', index: current.selectedLine })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen, askPost, flash, onExit])

  const onSkuKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      dispatch({ type: 'highlight', delta: e.key === 'ArrowDown' ? 1 : -1 })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void resolveSku()
    }
  }

  const { till } = state
  const staged = stagedTotals(state.lines)
  const today = { count: state.receipts.length, bottles: state.receipts.reduce((sum, r) => sum + r.bottles, 0) }
  const entryError = state.picked ? lineError(state) : null
  const postError = submitError(state)

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
        <h1 className="text-lg font-bold tracking-wide uppercase">Purchase · GRN</h1>
        {till && (
          <span className="text-sm text-zinc-400">
            {till.date ? `Day ${till.date} · ` : ''}Received by: {till.cashier}
          </span>
        )}
        {state.load === 'ready' && (
          <span className="rounded bg-violet-400 px-2.5 py-1 text-sm font-black tracking-widest text-zinc-950 uppercase">
            Today {today.count} receipt{today.count === 1 ? '' : 's'} · {today.bottles} btl
          </span>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm">
          <LiveClock />
          <span className="flex items-center gap-1 text-zinc-400">
            <Kbd>Esc</Kbd> Dashboard
          </span>
        </div>
      </header>

      {state.load === 'loading' && <CenterNote title="Loading purchases…" />}
      {state.load === 'offline' && (
        <CenterNote title="POS server unreachable" icon={<WifiOff className="size-10 text-rose-400" aria-hidden />}>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-2 inline-flex items-center gap-2 rounded-md border-2 border-zinc-600 px-4 py-2 font-bold hover:border-zinc-300"
          >
            <RefreshCw className="size-4" aria-hidden /> Retry now
          </button>
        </CenterNote>
      )}
      {state.load === 'noDay' && (
        <CenterNote title="No business day is open" icon={<Sunrise className="size-10 text-amber-400" aria-hidden />}>
          <p className="text-zinc-300">Stock is received into the open day. Open the day first.</p>
          <button type="button" onClick={onOpenDayEnd} className="mt-2 rounded-md bg-amber-400 px-5 py-3 text-lg font-bold text-zinc-950 hover:bg-amber-300">
            Go to Day End
          </button>
        </CenterNote>
      )}

      {state.load === 'ready' && (
        <>
          <div className="flex shrink-0 flex-wrap items-end gap-4 border-b-2 border-zinc-800 bg-zinc-900 px-5 py-3" aria-label="Invoice">
            <TextField
              label="Invoice no"
              value={state.invoiceNo}
              onChange={(text) => dispatch({ type: 'invoiceNo', text })}
              onEnter={() => vendorRef.current?.focus()}
              inputRef={invoiceRef}
              maxLength={60}
              placeholder="e.g. INV-4471"
              invalid={state.invoiceError}
              className="w-64"
            />
            <TextField
              label="Vendor (optional)"
              value={state.vendorName}
              onChange={(text) => dispatch({ type: 'vendorName', text })}
              onEnter={() => skuRef.current?.focus()}
              inputRef={vendorRef}
              maxLength={100}
              placeholder="e.g. Sri Balaji Distributors"
              invalid={state.invoiceError}
              className="w-96"
            />
            {state.invoiceError && <p className="pb-3 text-sm font-semibold text-rose-300">Already received — check the invoice number or vendor.</p>}
          </div>

          <div className="flex min-h-0 flex-1">
            <section className="flex w-[40%] max-w-xl min-w-96 shrink-0 flex-col gap-4 overflow-y-auto border-r-2 border-zinc-800 bg-zinc-900 p-5" aria-label="Add line">
              <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">Add line</h2>
              <div className="relative">
                <label className="block">
                  <span className="text-sm font-semibold text-zinc-300">SKU — scan, or type a name / code</span>
                  <div className="mt-1 flex items-center rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 focus-within:border-amber-400">
                    <ScanBarcode className="size-6 shrink-0 text-amber-400" aria-hidden />
                    <input
                      ref={skuRef}
                      value={state.query}
                      autoComplete="off"
                      role="combobox"
                      aria-expanded={state.results.length > 0}
                      aria-controls="sku-results"
                      onChange={(e) => dispatch({ type: 'query', text: e.target.value })}
                      onKeyDown={onSkuKeyDown}
                      placeholder="e.g. house whisky"
                      className="w-full bg-transparent px-2 py-3 text-xl outline-none"
                    />
                    {state.picked && <SizeChip size={state.picked.sizeCode} />}
                  </div>
                </label>
                {state.results.length > 0 && (
                  <ul id="sku-results" role="listbox" className="absolute inset-x-0 z-10 mt-1 max-h-80 overflow-y-auto rounded-md border-2 border-zinc-600 bg-zinc-950 shadow-2xl">
                    {state.results.map((s, i) => (
                      <li key={s.id} role="option" aria-selected={i === state.highlighted}>
                        <button
                          type="button"
                          {...keepFocus}
                          onClick={() => {
                            dispatch({ type: 'pick', sku: s })
                            if (s.isActive) casesRef.current?.focus()
                          }}
                          className={`flex min-h-12 w-full items-center gap-3 px-3 text-left ${i === state.highlighted ? 'bg-amber-400/15' : 'hover:bg-zinc-800'} ${
                            s.isActive ? '' : 'text-zinc-500'
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate font-semibold">{s.displayName}</span>
                          <SizeChip size={s.sizeCode} />
                          <span className="w-20 shrink-0 text-right font-mono text-xs text-zinc-500 tabular-nums">case {s.caseSize}</span>
                          <span className="w-24 shrink-0 text-right font-mono text-sm text-zinc-400 tabular-nums">{s.isActive ? `${s.onHandQty} on hand` : 'inactive'}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {state.picked && (
                <p className="-mt-2 text-sm text-zinc-400">
                  {state.picked.skuCode} · {SIZE_NAME[state.picked.sizeCode]} · <span className="font-semibold text-zinc-200">case of {state.picked.caseSize}</span> ·{' '}
                  {state.picked.onHandQty} on hand · sells at {formatPaise(state.picked.pricePaise)}
                </p>
              )}
              <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-4">
                <CountField label="Cases" value={state.cases} onChange={(text) => dispatch({ type: 'cases', text })} onEnter={() => looseRef.current?.focus()} inputRef={casesRef} />
                <CountField label="Loose bottles" value={state.loose} onChange={(text) => dispatch({ type: 'loose', text })} onEnter={() => costRef.current?.focus()} inputRef={looseRef} />
                <BottleTotal count={entryCount(state)} />
              </div>
              <RupeeField
                label={state.picked?.purchasePricePaise != null ? 'Unit cost per bottle (catalog default — editable)' : 'Unit cost per bottle (₹0 = free)'}
                value={state.cost}
                onChange={(text) => dispatch({ type: 'cost', text })}
                onEnter={addLine}
                inputRef={costRef}
              />
              <button
                type="button"
                onClick={addLine}
                disabled={!state.picked}
                className={`flex min-h-14 items-center justify-between rounded-lg border-2 border-violet-400 px-5 text-lg font-black text-violet-300 hover:bg-violet-400/10 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:text-zinc-500 ${FOCUS_RING}`}
              >
                <span>Add line</span>
                <Kbd>Enter</Kbd>
              </button>
              {entryError && <p className="-mt-2 text-center text-sm text-amber-300">{entryError}</p>}
              <p className="mt-auto text-sm text-zinc-500">
                Scan or type → <Kbd>Enter</Kbd> → cases <Kbd>Enter</Kbd> → loose <Kbd>Enter</Kbd> → cost <Kbd>Enter</Kbd>. <Kbd>Esc</Kbd> clears the line.
              </p>
            </section>

            <main className="flex min-w-0 flex-1 flex-col" aria-label="Staged lines">
              <div className="flex min-h-16 items-center border-b-2 border-zinc-800 bg-zinc-900 px-4 py-2">
                <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">This invoice</h2>
                <span className="ml-auto" />
                <FlashLine flash={state.flash} />
              </div>
              <div className="grid grid-cols-[2.5rem_1fr_5rem_9rem_8rem_9rem_3.5rem] items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs font-bold tracking-widest text-zinc-500 uppercase">
                <span>#</span>
                <span>SKU</span>
                <span>Size</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Unit</span>
                <span className="text-right">Line</span>
                <span />
              </div>
              <ul className="min-h-0 flex-1 overflow-y-auto">
                {state.lines.map((line, i) => (
                  <li
                    key={line.sku.id}
                    aria-selected={state.selectedLine === i}
                    onClick={() => dispatch({ type: 'selectLine', index: i })}
                    className={`grid min-h-14 cursor-pointer grid-cols-[2.5rem_1fr_5rem_9rem_8rem_9rem_3.5rem] items-center gap-2 border-b border-zinc-800 px-4 ${
                      state.selectedLine === i ? 'bg-amber-400/10' : ''
                    }`}
                  >
                    <span className="font-mono text-zinc-500">{i + 1}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{line.sku.displayName}</span>
                      <span className="block font-mono text-xs text-zinc-500">{line.sku.skuCode}</span>
                    </span>
                    <span>
                      <SizeChip size={line.sku.sizeCode} />
                    </span>
                    <span className="text-right font-mono tabular-nums">
                      <span className="block text-lg font-bold">{line.quantity}</span>
                      {line.cases > 0 && <span className="block text-xs text-zinc-500">{countLabel(line)} · case {line.caseSize}</span>}
                    </span>
                    <span className="text-right font-mono tabular-nums">{line.unitCostPaise === 0n ? <span className="text-emerald-300">FREE</span> : formatPaise(line.unitCostPaise)}</span>
                    <span className="text-right font-mono font-bold tabular-nums">{formatPaise(lineTotal(line))}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        dispatch({ type: 'removeLine', index: i })
                      }}
                      aria-label={`Remove ${line.sku.displayName}`}
                      className={`flex size-11 items-center justify-center rounded-md border-2 border-zinc-700 text-zinc-400 hover:border-rose-400 hover:text-rose-300 ${FOCUS_RING}`}
                    >
                      <X className="size-5" aria-hidden />
                    </button>
                  </li>
                ))}
                {state.lines.length === 0 && <li className="p-12 text-center text-lg text-zinc-500">No lines yet — scan the first bottle on the invoice.</li>}
              </ul>
              <div className="flex items-center gap-6 border-t-2 border-zinc-800 bg-zinc-900 px-4 py-3 whitespace-nowrap">
                <span className="text-zinc-300">
                  {staged.lineCount} line{staged.lineCount === 1 ? '' : 's'} · <span className="font-bold">{staged.bottles}</span> bottle{staged.bottles === 1 ? '' : 's'}
                </span>
                <span className="text-zinc-300">
                  Invoice total <span className="font-mono text-2xl font-black tabular-nums">{formatPaise(staged.totalPaise)}</span>
                </span>
                <span className="ml-auto min-w-0 truncate text-xs text-zinc-500">
                  <Kbd>Del</Kbd> removes the selected line
                </span>
                <button
                  type="button"
                  onClick={askPost}
                  disabled={state.submitting || postError !== null}
                  title={postError ?? undefined}
                  className={`flex min-h-14 shrink-0 items-center gap-4 rounded-lg bg-violet-400 px-5 text-xl font-black text-zinc-950 hover:bg-violet-300 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-400 ${FOCUS_RING}`}
                >
                  <PackagePlus className="size-6" aria-hidden /> {state.submitting ? 'Posting…' : 'Post GRN'}
                  <Kbd>F9</Kbd>
                </button>
              </div>
            </main>
          </div>

          <TodayReceipts receipts={state.receipts} />
        </>
      )}

      {state.confirming && (
        <Modal
          title={`Post GRN ${state.invoiceNo.trim()}?`}
          width="max-w-2xl"
          onClose={() => dispatch({ type: 'confirm', on: false })}
          onKey={(e) => {
            if (e.key !== 'Enter' && e.key !== 'F9') return false
            post()
            return true
          }}
          footer={
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => dispatch({ type: 'confirm', on: false })} className="min-h-12 rounded-md border-2 border-zinc-600 px-5 font-bold">
                Back (Esc)
              </button>
              <button type="button" onClick={post} disabled={state.submitting} className="min-h-12 rounded-md bg-violet-400 px-5 font-bold text-zinc-950 disabled:bg-zinc-700">
                {state.submitting ? 'Posting…' : 'Post (Enter)'}
              </button>
            </div>
          }
        >
          <p className="text-zinc-300">
            Vendor: <span className="font-semibold text-zinc-100">{state.vendorName.trim() || '—'}</span>
          </p>
          <ul className="mt-3 divide-y divide-zinc-800 rounded-md border border-zinc-700">
            {state.lines.map((line) => (
              <li key={line.sku.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate">{line.sku.displayName}</span>
                <span className="font-mono tabular-nums">
                  {line.cases > 0 ? `${countLabel(line)} = ` : ''}
                  {line.quantity} × {line.unitCostPaise === 0n ? 'free' : formatPaise(line.unitCostPaise)}
                </span>
                <span className="w-32 text-right font-mono font-bold tabular-nums">{formatPaise(lineTotal(line))}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 flex justify-between text-lg">
            <span>
              {staged.lineCount} line{staged.lineCount === 1 ? '' : 's'} · <span className="font-bold">{staged.bottles}</span> bottle{staged.bottles === 1 ? '' : 's'}
            </span>
            <span className="font-mono font-black tabular-nums">{formatPaise(staged.totalPaise)}</span>
          </p>
          <p className="mt-3 text-sm text-zinc-400">Stock goes up as soon as you post. A posted GRN is final and can't be edited.</p>
        </Modal>
      )}
    </div>
  )
}

interface CountFieldProps {
  label: string
  value: string
  onChange: (text: string) => void
  onEnter: () => void
  inputRef: Ref<HTMLInputElement>
}

/** Whole-number field (digits only; empty means 0). Enter moves on. */
function CountField({ label, value, onChange, onEnter, inputRef }: CountFieldProps) {
  return (
    <label className="block">
      <span className="text-sm font-semibold text-zinc-300">{label}</span>
      <input
        ref={inputRef}
        value={value}
        inputMode="numeric"
        autoComplete="off"
        placeholder="0"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onEnter()
          }
        }}
        className="mt-1 w-full rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 py-2 font-mono text-2xl tabular-nums outline-none placeholder:text-zinc-700 focus:border-amber-400"
      />
    </label>
  )
}

/** The live whole-bottle total for the entry fields ("= 131 bottles"). */
function BottleTotal({ count }: { count: { total: number } | null }) {
  const total = count && Number.isSafeInteger(count.total) ? count.total : 0
  return (
    <p className="min-w-36 pb-2.5 text-right whitespace-nowrap" aria-live="polite" aria-label="Bottles on this line">
      <span className="text-zinc-500">= </span>
      <span className="font-mono text-2xl font-black tabular-nums">{total}</span>
      <span className="text-zinc-400"> bottle{total === 1 ? '' : 's'}</span>
    </p>
  )
}

interface TextFieldProps {
  label: string
  value: string
  onChange: (text: string) => void
  onEnter: () => void
  inputRef: Ref<HTMLInputElement>
  maxLength: number
  placeholder: string
  invalid: boolean
  className: string
}

function TextField({ label, value, onChange, onEnter, inputRef, maxLength, placeholder, invalid, className }: TextFieldProps) {
  return (
    <label className={`block ${className}`}>
      <span className="text-sm font-semibold text-zinc-300">{label}</span>
      <input
        ref={inputRef}
        value={value}
        maxLength={maxLength}
        autoComplete="off"
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onEnter()
          }
        }}
        className={`mt-1 w-full rounded-md border-2 bg-zinc-950 px-3 py-2 text-lg outline-none focus:border-amber-400 ${invalid ? 'border-rose-500' : 'border-zinc-600'}`}
      />
    </label>
  )
}

function TodayReceipts({ receipts }: { receipts: readonly StockReceipt[] }) {
  return (
    <section className="max-h-44 shrink-0 overflow-y-auto border-t-2 border-zinc-800 bg-zinc-900 px-5 py-2" aria-label="Today's receipts">
      <h2 className="text-xs font-bold tracking-widest text-zinc-400 uppercase">Today's receipts</h2>
      {receipts.length === 0 && <p className="py-2 text-sm text-zinc-500">Nothing received today yet.</p>}
      <ul>
        {receipts.map((r) => (
          <li key={r.id} className="flex items-center gap-4 border-b border-zinc-800 py-1.5 text-sm last:border-0">
            <span className="w-12 shrink-0 font-mono text-zinc-400">
              {new Date(r.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
            </span>
            <span className="w-36 shrink-0 truncate font-bold">{r.invoiceNo}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-300">{r.vendorName ?? '—'}</span>
            <span className="shrink-0 text-zinc-400">
              {r.lineCount} line{r.lineCount === 1 ? '' : 's'} · {r.bottles} btl
            </span>
            <span className="w-32 shrink-0 text-right font-mono font-bold tabular-nums">{formatPaise(r.totalCostPaise)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
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
