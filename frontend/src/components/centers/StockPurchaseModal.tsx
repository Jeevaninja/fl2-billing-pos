import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { Plus, X } from 'lucide-react'
import { api } from '../../api/client'
import { Modal } from '../../billing/Modal'
import {
  clearEntry,
  countText,
  entryCount,
  entryError,
  lineCost,
  moveHighlight,
  perPackPaise,
  pick,
  pickFromResults,
  removeStockLine,
  setCost,
  setCount,
  setQuery,
  setResults,
  stageLine,
  stockTotals,
  type StockPurchaseForm,
} from '../../centers/stockPurchase'
import { departmentChip } from '../../lib/departments'
import { formatPaise, parseRupeesToPaise } from '../../lib/money'
import { FOCUS_RING, unitLabel } from '../../lib/ui'

const SEARCH_DELAY_MS = 150

/**
 * Revenue Centers → New purchase → Stock items (Phase 26): buy a stock-tracked center's items in
 * their purchase units (2 Packets, 1 Case + 6) and see the selling units they add to the shelf. Saved
 * as one GRN tagged with the center. Keyboard: item ↵ → count ↵ → loose ↵ → cost ↵ stages a line;
 * F9 saves; Esc closes.
 */
export function StockPurchaseModal({
  form,
  centers,
  peakRunning,
  error,
  serverError,
  saving,
  modeToggle,
  onChange,
  onEntryError,
  onSave,
  onClose,
}: {
  form: StockPurchaseForm
  /** Active stock-tracked centers (not Liquor). */
  centers: Array<{ code: string; name: string }>
  peakRunning: boolean
  error: string | null
  serverError: boolean
  saving: boolean
  /** Stock items | Supplies switch. */
  modeToggle: ReactNode
  onChange: (form: StockPurchaseForm) => void
  onEntryError: (message: string) => void
  onSave: () => void
  onClose: () => void
}) {
  const formRef = useRef(form)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    formRef.current = form
    onChangeRef.current = onChange
  })
  const searchRef = useRef<HTMLInputElement>(null)
  const casesRef = useRef<HTMLInputElement>(null)
  const looseRef = useRef<HTMLInputElement>(null)
  const costRef = useRef<HTMLInputElement>(null)

  // Item search, limited to the center's items; a late reply for an old query is dropped by setResults.
  const query = form.picked ? '' : form.query.trim()
  const department = form.department
  useEffect(() => {
    if (query === '') return
    const timer = setTimeout(() => {
      api
        .searchSkus(query, department)
        .then((results) => onChangeRef.current(setResults(formRef.current, query, results)))
        .catch(() => onChangeRef.current(setResults(formRef.current, query, [])))
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [query, department])

  const choose = (next: StockPurchaseForm) => {
    onChange(next)
    if (next.picked) setTimeout(() => casesRef.current?.focus(), 0)
  }
  const stage = () => {
    const result = stageLine(formRef.current)
    if (typeof result === 'string') {
      onEntryError(result)
      return
    }
    onChange(result)
    setTimeout(() => searchRef.current?.focus(), 0)
  }

  const sku = form.picked
  const count = entryCount(form)
  const cost = parseRupeesToPaise(form.cost)
  const center = centers.find((c) => c.code === form.department)
  const totals = stockTotals(form.lines)
  const entryProblem = sku ? entryError(form) : null

  return (
    <Modal
      title={`New purchase — ${center?.name ?? form.department}`}
      width="max-w-5xl"
      onClose={onClose}
      onKey={(e) => {
        if (e.key !== 'F9') return false
        onSave()
        return true
      }}
      footer={
        <div className="flex items-center gap-3">
          <p className={`min-w-0 flex-1 text-sm font-semibold ${serverError ? 'text-rose-300' : 'text-amber-300'}`}>{error ?? 'F9 saves · Esc cancels'}</p>
          <span className="text-right text-sm text-zinc-400">
            {totals.lineCount} item{totals.lineCount === 1 ? '' : 's'} · <span className="font-mono tabular-nums">{totals.units}</span> units in
          </span>
          <span className="font-mono text-2xl font-black tabular-nums">{formatPaise(totals.totalPaise)}</span>
          <button type="button" onClick={onClose} className="min-h-12 rounded-md border-2 border-zinc-600 px-5 font-bold hover:border-zinc-400 hover:bg-zinc-800">
            Cancel (Esc)
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || error !== null}
            className="min-h-12 rounded-md bg-emerald-500 px-5 font-black text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-400 enabled:hover:brightness-110"
          >
            {saving ? 'Saving…' : 'Save (F9)'}
          </button>
        </div>
      }
    >
      {modeToggle}
      <div className="mt-3">
        <span className="text-sm font-semibold text-zinc-300">Revenue center</span>
        <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label="Revenue center">
          {centers.map((c) => (
            <button
              key={c.code}
              type="button"
              role="radio"
              aria-checked={form.department === c.code}
              onClick={() => c.code !== form.department && onChange({ ...clearEntry(form), department: c.code, lines: [] })}
              className={`min-h-12 rounded-md border-2 px-4 font-bold ${form.department === c.code ? departmentChip(c.code) : 'border-zinc-600 text-zinc-200 hover:border-zinc-400'} ${FOCUS_RING}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[1fr_12rem_auto] gap-4">
        <TextField label="Vendor (optional)" value={form.vendor} maxLength={100} placeholder="e.g. Ravi Agencies, ITC distributor" onChange={(vendor) => onChange({ ...form, vendor })} />
        <TextField label="Bill no. (optional)" value={form.invoiceNo} maxLength={60} placeholder="auto-numbered" onChange={(invoiceNo) => onChange({ ...form, invoiceNo })} mono />
        <div>
          <span className="text-sm font-semibold text-zinc-300">Paid from</span>
          <div className="mt-1 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Paid from">
            {(['DRAWER', 'OUTSIDE'] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={form.paidFrom === p}
                disabled={p === 'DRAWER' && peakRunning}
                onClick={() => onChange({ ...form, paidFrom: p })}
                className={`min-h-[3.25rem] rounded-md border-2 px-5 text-lg font-black disabled:cursor-not-allowed disabled:opacity-40 ${
                  form.paidFrom === p ? 'border-emerald-400 bg-emerald-400 text-zinc-950' : 'border-zinc-600 text-zinc-200'
                } ${FOCUS_RING}`}
              >
                {p === 'DRAWER' ? 'Drawer' : 'Outside'}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-1 text-sm text-zinc-400">
        {peakRunning
          ? 'A peak is running: drawer purchases wait until it ends (the peak count would miss them).'
          : form.paidFrom === 'DRAWER'
            ? 'Cash from the till: Day End expects that much less in the drawer.'
            : 'Paid by the owner, bank, credit or UPI: the drawer is not touched.'}
      </p>

      <section className="mt-4 rounded-lg border-2 border-zinc-700 p-3" aria-label="Add an item">
        <div className="relative">
          <label className="block">
            <span className="text-sm font-semibold text-zinc-300">Item</span>
            <input
              ref={searchRef}
              data-autofocus
              value={form.query}
              autoComplete="off"
              placeholder={`Search ${center?.name ?? ''} items or scan`}
              onChange={(e) => onChange(setQuery(form, e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  onChange(moveHighlight(form, e.key === 'ArrowDown' ? 1 : -1))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  if (form.picked) casesRef.current?.focus()
                  else {
                    const found = pickFromResults(form)
                    if (found) choose(pick(form, found))
                    else if (form.query.trim() !== '') onEntryError(`No active ${center?.name ?? ''} item matches “${form.query.trim()}”`)
                  }
                }
              }}
              className="mt-1 w-full rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 py-3 text-lg outline-none focus:border-amber-400"
            />
          </label>
          {!form.picked && form.results.length > 0 && (
            <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border-2 border-zinc-600 bg-zinc-900 shadow-xl" role="listbox" aria-label="Matching items">
              {form.results.map((s, i) => (
                <li key={s.id} role="option" aria-selected={i === form.highlighted}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(pick(form, s))}
                    className={`flex min-h-11 w-full items-center gap-3 px-3 text-left ${i === form.highlighted ? 'bg-amber-400/15' : 'hover:bg-zinc-800'}`}
                  >
                    <span className="min-w-0 flex-1 truncate font-semibold">{s.displayName}</span>
                    <span className="text-sm text-zinc-400">
                      {s.purchaseUnitName} × {s.caseSize}
                    </span>
                    <span className="w-24 text-right font-mono text-sm text-zinc-500 tabular-nums">{s.onHandQty} on hand</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {sku && (
          <>
            <p className="mt-2 text-sm text-zinc-300">
              <span className="font-mono text-zinc-500">{sku.skuCode}</span> · bought as{' '}
              <span className="font-semibold text-zinc-100">
                {sku.purchaseUnitName} of {sku.caseSize} {unitLabel(sku.saleUnitName, sku.caseSize).toLowerCase()}
              </span>{' '}
              · {sku.onHandQty} on hand
              <button type="button" onClick={() => onChange(clearEntry(form))} className="ml-3 text-zinc-400 underline hover:text-zinc-100">
                clear
              </button>
            </p>
            <div className="mt-2 grid grid-cols-[9rem_9rem_10rem_1fr_auto] items-end gap-3">
              <CountField label={unitLabel(sku.purchaseUnitName, 2)} value={form.cases} inputRef={casesRef} onChange={(t) => onChange(setCount(form, 'cases', t))} onEnter={() => looseRef.current?.focus()} />
              <CountField label={`Loose ${unitLabel(sku.saleUnitName, 2).toLowerCase()}`} value={form.loose} inputRef={looseRef} onChange={(t) => onChange(setCount(form, 'loose', t))} onEnter={() => costRef.current?.focus()} />
              <label className="block">
                <span className="block truncate text-sm font-semibold text-zinc-300">Cost ₹ / {sku.saleUnitName.toLowerCase()}</span>
                <input
                  ref={costRef}
                  value={form.cost}
                  inputMode="decimal"
                  autoComplete="off"
                  onChange={(e) => onChange(setCost(form, e.target.value))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      stage()
                    }
                  }}
                  className="mt-1 w-full rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 py-2.5 font-mono text-lg tabular-nums outline-none focus:border-amber-400"
                />
              </label>
              <p className="pb-2 text-sm" aria-live="polite">
                {count && count.total > 0 ? (
                  <>
                    <span className="block font-bold text-sky-200">
                      = {count.total} {unitLabel(sku.saleUnitName, count.total).toLowerCase()} into stock
                    </span>
                    {cost !== null && (
                      <span className="block text-zinc-400">
                        {formatPaise(perPackPaise(sku.caseSize, cost))} per {sku.purchaseUnitName.toLowerCase()} · line {formatPaise(lineCost({ quantity: count.total, unitCostPaise: cost }))}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-zinc-500">{entryProblem}</span>
                )}
              </p>
              <button
                type="button"
                onClick={stage}
                disabled={entryProblem !== null}
                className={`flex min-h-12 items-center gap-2 rounded-md bg-sky-500 px-4 font-black text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-400 ${FOCUS_RING}`}
              >
                <Plus className="size-5" aria-hidden /> Add ↵
              </button>
            </div>
          </>
        )}
      </section>

      <ul className="mt-3 flex max-h-64 flex-col overflow-y-auto rounded-lg border border-zinc-800" aria-label="Items on this purchase">
        {form.lines.map((line) => (
          <li key={line.sku.id} className="flex min-h-12 items-center gap-3 border-b border-zinc-800 px-3 last:border-b-0">
            <span className="min-w-0 flex-1 truncate font-semibold">{line.sku.displayName}</span>
            <span className="text-sm text-zinc-300">{countText(line, line.sku)}</span>
            <span className="w-24 text-right font-mono text-sm text-zinc-400 tabular-nums">@ {formatPaise(line.unitCostPaise)}</span>
            <span className="w-28 text-right font-mono font-bold tabular-nums">{formatPaise(lineCost(line))}</span>
            <button
              type="button"
              aria-label={`Remove ${line.sku.displayName}`}
              onClick={() => onChange(removeStockLine(form, line.sku.id))}
              className={`flex size-10 items-center justify-center rounded-md border-2 border-zinc-700 text-zinc-300 hover:border-rose-400 hover:text-rose-300 ${FOCUS_RING}`}
            >
              <X className="size-4" aria-hidden />
            </button>
          </li>
        ))}
        {form.lines.length === 0 && <li className="px-3 py-4 text-center text-sm text-zinc-500">Pick an item, enter how many {sku ? unitLabel(sku.purchaseUnitName, 2).toLowerCase() : 'cases or packets'} came in, and press Enter.</li>}
      </ul>
    </Modal>
  )
}

function TextField({ label, value, onChange, maxLength, placeholder, mono = false }: { label: string; value: string; onChange: (value: string) => void; maxLength: number; placeholder: string; mono?: boolean }) {
  return (
    <label className="block min-w-0">
      <span className="text-sm font-semibold text-zinc-300">{label}</span>
      <input
        value={value}
        maxLength={maxLength}
        autoComplete="off"
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 w-full rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 py-3 text-lg outline-none focus:border-amber-400 ${mono ? 'font-mono' : ''}`}
      />
    </label>
  )
}

function CountField({
  label,
  value,
  inputRef,
  onChange,
  onEnter,
}: {
  label: string
  value: string
  inputRef: RefObject<HTMLInputElement | null>
  onChange: (text: string) => void
  onEnter: () => void
}) {
  return (
    <label className="block min-w-0">
      <span className="block truncate text-sm font-semibold text-zinc-300">{label}</span>
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
        className="mt-1 w-full rounded-md border-2 border-zinc-600 bg-zinc-950 px-3 py-2.5 font-mono text-lg tabular-nums outline-none focus:border-amber-400"
      />
    </label>
  )
}
