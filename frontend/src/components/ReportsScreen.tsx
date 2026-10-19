import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowLeft, ChartColumn, Download, Printer, RefreshCw, WifiOff } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type {
  BankDepositLog,
  DayEndLog,
  ExpenseSummary,
  FullReport,
  MemberSales,
  OrderSummaryReport,
  PurchaseSummary,
  RangeAnchor,
  ReportHeader,
  ReportRange,
  SalesSummary,
  StockSummary,
} from '../api/types'
import { counterErrorMessage } from '../billing/errors'
import { FOCUS_RING, keepFocus } from '../lib/ui'
import { bankDepositsCsv, dayEndCsv, expensesCsv, fullReportCsv, memberSalesCsv, ordersCsv, purchasesCsv, salesSummaryCsv, stockSummaryCsv } from '../reports/csv'
import { PRESETS, presetRange, rangeError, rangeLabel, formatBusinessDate, type PresetId } from '../reports/dateRange'
import { isReportTab, REPORT_TABS, stepReportTab, type ReportTab } from '../reports/registerView'
import { BankDepositsView, DayEndView, ExpensesView, FullReportView, PurchasesView } from './reports/LedgerViews'
import { OrdersView } from './reports/OrdersView'
import { printStamp, timeOf } from '../reports/format'
import { SalesSummaryView, type SalesMode } from './reports/SalesSummaryView'
import { StockSummaryView } from './reports/StockSummaryView'
import { Kbd, LiveClock } from './ui'

/**
 * Settings → Reports (Phase 24): one business-date range drives eight modules — Sales (by item and
 * member-wise), Orders, Stock (the TN FL2 register with valuations and ML), Expenses, Purchases, Bank
 * deposits, Day End & Variance, and the Full Report. Read-only; CSV and Print on every tab; grouped
 * ledger totals only, no profit figure anywhere.
 */

type Loaded =
  | { tab: 'sales'; data: SalesSummary; members: MemberSales }
  | { tab: 'orders'; data: OrderSummaryReport }
  | { tab: 'stock'; data: StockSummary }
  | { tab: 'expenses'; data: ExpenseSummary }
  | { tab: 'purchases'; data: PurchaseSummary }
  | { tab: 'bank'; data: BankDepositLog }
  | { tab: 'dayEnd'; data: DayEndLog }
  | { tab: 'full'; data: FullReport }

const RANGE_KEY = 'fl2.reports.range'
const TAB_KEY = 'fl2.reports.tab'

interface Remembered {
  preset: PresetId
  custom: ReportRange
}

function remembered(): Remembered | null {
  try {
    const raw = localStorage.getItem(RANGE_KEY)
    const value = raw ? (JSON.parse(raw) as Partial<Remembered>) : null
    if (!value || !PRESETS.some((p) => p.id === value.preset) || typeof value.custom?.startDate !== 'string' || typeof value.custom?.endDate !== 'string') return null
    return { preset: value.preset!, custom: value.custom }
  } catch {
    return null
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private window / storage blocked: the choice just isn't remembered
  }
}

function rememberedTab(): ReportTab {
  try {
    const tab = localStorage.getItem(TAB_KEY)
    return isReportTab(tab) ? tab : 'sales'
  } catch {
    return 'sales'
  }
}

/** Expenses / Purchases can be narrowed to one revenue center (or Shared for expenses). */
interface Filters {
  expenseCenter: string | null
  purchaseCenter: string | null
}

function fetchReport(tab: ReportTab, range: ReportRange, filters: Filters): Promise<Loaded> {
  switch (tab) {
    case 'sales':
      return Promise.all([api.reportSalesSummary(range), api.reportMemberSales(range)]).then(([data, members]) => ({ tab, data, members }))
    case 'orders':
      return api.reportOrders(range).then((data) => ({ tab, data }))
    case 'stock':
      return api.reportStockSummary(range).then((data) => ({ tab, data }))
    case 'expenses':
      return api.reportExpenses(range, filters.expenseCenter).then((data) => ({ tab, data }))
    case 'purchases':
      return api.reportPurchases(range, filters.purchaseCenter).then((data) => ({ tab, data }))
    case 'bank':
      return api.reportBankDeposits(range).then((data) => ({ tab, data }))
    case 'dayEnd':
      return api.reportDayEnd(range).then((data) => ({ tab, data }))
    case 'full':
      return api.reportFull(range).then((data) => ({ tab, data }))
  }
}

function csvFor(loaded: Loaded, salesMode: SalesMode): string {
  switch (loaded.tab) {
    case 'sales':
      return salesMode === 'members' ? memberSalesCsv(loaded.members, timeOf) : salesSummaryCsv(loaded.data)
    case 'orders':
      return ordersCsv(loaded.data, timeOf)
    case 'stock':
      return stockSummaryCsv(loaded.data)
    case 'expenses':
      return expensesCsv(loaded.data, timeOf)
    case 'purchases':
      return purchasesCsv(loaded.data)
    case 'bank':
      return bankDepositsCsv(loaded.data, timeOf)
    case 'dayEnd':
      return dayEndCsv(loaded.data, timeOf)
    case 'full':
      return fullReportCsv(loaded.data)
  }
}

function downloadCsv(name: string, text: string): void {
  // The BOM makes spreadsheet apps read ₹ / — as UTF-8.
  const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const keyOf = (tab: ReportTab, range: ReportRange, filters: Filters) =>
  `${tab}|${range.startDate}|${range.endDate}|${tab === 'expenses' ? (filters.expenseCenter ?? '') : tab === 'purchases' ? (filters.purchaseCenter ?? '') : ''}`

export default function ReportsScreen({ onExit }: { onExit: () => void }) {
  const [anchor, setAnchor] = useState<RangeAnchor | null>(null)
  const [preset, setPreset] = useState<PresetId>(() => remembered()?.preset ?? 'today')
  const [custom, setCustom] = useState<ReportRange>(() => remembered()?.custom ?? { startDate: '', endDate: '' })
  const [tab, setTab] = useState<ReportTab>(rememberedTab)
  const [loaded, setLoaded] = useState<{ key: string; report: Loaded } | null>(null)
  const [status, setStatus] = useState<{ kind: 'loading' | 'ready' } | { kind: 'error'; message: string; offline: boolean }>({ kind: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [filters, setFilters] = useState<Filters>({ expenseCenter: null, purchaseCenter: null })
  const [salesMode, setSalesMode] = useState<SalesMode>('items')
  const [centers, setCenters] = useState<Array<{ code: string; name: string }>>([])
  const cache = useRef(new Map<string, Loaded>())

  // Revenue centers for the Expenses / Purchases filters (inactive ones too: history can name them).
  useEffect(() => {
    api
      .listDepartments(true)
      .then((list) => setCenters(list.map((d) => ({ code: d.code, name: d.name }))))
      .catch(() => setCenters([]))
  }, [])

  const range: ReportRange | null = useMemo(() => {
    if (preset === 'custom') return custom
    return anchor ? presetRange(preset, anchor.currentBusinessDate) : null
  }, [preset, custom, anchor])
  const invalid = range ? rangeError(range) : null

  const loadAnchor = useCallback(() => {
    api
      .reportAnchor()
      .then((a) => {
        setAnchor(a)
        // First visit to Custom: start it on this month.
        setCustom((c) => (c.startDate === '' ? presetRange('thisMonth', a.currentBusinessDate) : c))
      })
      .catch((err: unknown) => setStatus({ kind: 'error', message: counterErrorMessage(err), offline: err instanceof ApiError && err.code === 'NETWORK' }))
  }, [])
  useEffect(loadAnchor, [loadAnchor])

  useEffect(() => remember(RANGE_KEY, JSON.stringify({ preset, custom })), [preset, custom])
  useEffect(() => remember(TAB_KEY, tab), [tab])

  // Load the current tab for the range (cached per tab and range until R).
  useEffect(() => {
    if (!range || invalid) return
    const key = keyOf(tab, range, filters)
    const hit = cache.current.get(key)
    if (hit) {
      setLoaded({ key, report: hit })
      setStatus({ kind: 'ready' })
      return
    }
    let live = true
    setStatus({ kind: 'loading' })
    fetchReport(tab, range, filters)
      .then((report) => {
        cache.current.set(key, report)
        if (!live) return
        setLoaded({ key, report })
        setStatus({ kind: 'ready' })
      })
      .catch((err: unknown) => live && setStatus({ kind: 'error', message: counterErrorMessage(err), offline: err instanceof ApiError && err.code === 'NETWORK' }))
    return () => {
      live = false
    }
  }, [tab, range, invalid, reloadToken, filters])

  const refresh = useCallback(() => {
    cache.current.clear()
    loadAnchor()
    setReloadToken((t) => t + 1)
  }, [loadAnchor])

  const current = range && loaded?.key === keyOf(tab, range, filters) ? loaded.report : null

  const exportCsv = useCallback(() => {
    if (!current || !range) return
    const name = current.tab === 'sales' && salesMode === 'members' ? 'member-sales' : current.tab
    downloadCsv(`fl2-${name}-${range.startDate}_${range.endDate}.csv`, csvFor(current, salesMode))
  }, [current, range, salesMode])

  // Page keys; typing in a field keeps its keys (Esc leaves the field).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
        if (event.key === 'Escape') {
          event.preventDefault()
          target.blur()
        }
        return
      }
      if (/^[1-8]$/.test(event.key)) {
        event.preventDefault()
        setTab(REPORT_TABS[Number(event.key) - 1]!.id)
        return
      }
      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          onExit()
          return
        case 'ArrowLeft':
        case 'ArrowRight':
          event.preventDefault()
          setTab((t) => stepReportTab(t, event.key === 'ArrowLeft' ? -1 : 1))
          return
        case 'r':
        case 'R':
          event.preventDefault()
          refresh()
          return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onExit, refresh])

  const tabInfo = REPORT_TABS.find((t) => t.id === tab)
  const tabLabel = tab === 'sales' && salesMode === 'members' ? 'Member-wise Sales' : (tabInfo?.title ?? '')
  const printedAt = usePrintedAt()
  return (
    <div className="flex h-full min-h-screen flex-col print:block print:min-h-0 print:bg-white print:text-black">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b-2 border-emerald-500 bg-zinc-900 px-5 print:hidden">
        <button type="button" {...keepFocus} onClick={onExit} className="flex items-center gap-2 rounded px-1 text-zinc-300 hover:text-zinc-50" aria-label="Back to dashboard (Esc)">
          <ArrowLeft className="size-5" aria-hidden />
          <span className="rounded bg-amber-400 px-2 py-0.5 text-lg font-black tracking-tight text-zinc-950">FL2</span>
        </button>
        <h1 className="flex items-center gap-2 text-lg font-bold tracking-wide uppercase">
          <ChartColumn className="size-5 text-emerald-400" aria-hidden /> Reports
        </h1>
        <div className="ml-auto flex items-center gap-4 text-sm">
          <LiveClock />
          <span className="flex items-center gap-1 text-zinc-400">
            <Kbd>Esc</Kbd> Dashboard
          </span>
        </div>
      </header>

      <section className="flex shrink-0 flex-wrap items-center gap-2 border-b-2 border-zinc-800 bg-zinc-900 px-5 py-2 print:hidden" aria-label="Date range">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            {...keepFocus}
            aria-pressed={preset === p.id}
            onClick={() => setPreset(p.id)}
            className={`min-h-11 rounded-md border-2 px-3 font-bold ${preset === p.id ? 'border-emerald-400 bg-emerald-400 text-zinc-950' : 'border-zinc-700 text-zinc-300 hover:border-zinc-400'} ${FOCUS_RING}`}
          >
            {p.label}
          </button>
        ))}
        {preset === 'custom' && (
          <span className="flex items-center gap-2">
            <input
              type="date"
              aria-label="From"
              value={custom.startDate}
              max={custom.endDate || undefined}
              onChange={(e) => setCustom((c) => ({ ...c, startDate: e.target.value }))}
              className="min-h-11 rounded-md border-2 border-zinc-700 bg-zinc-950 px-2 font-mono outline-none focus:border-amber-400 [color-scheme:dark]"
            />
            <span className="text-zinc-400">→</span>
            <input
              type="date"
              aria-label="To"
              value={custom.endDate}
              min={custom.startDate || undefined}
              onChange={(e) => setCustom((c) => ({ ...c, endDate: e.target.value }))}
              className="min-h-11 rounded-md border-2 border-zinc-700 bg-zinc-950 px-2 font-mono outline-none focus:border-amber-400 [color-scheme:dark]"
            />
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" {...keepFocus} onClick={refresh} className={`flex min-h-11 items-center gap-2 rounded-md border-2 border-zinc-700 px-3 font-bold text-zinc-300 hover:border-zinc-400 ${FOCUS_RING}`} title="Reload (R)">
            <RefreshCw className="size-4" aria-hidden /> Reload
          </button>
          <button type="button" {...keepFocus} onClick={exportCsv} disabled={!current} className={`flex min-h-11 items-center gap-2 rounded-md border-2 border-zinc-700 px-3 font-bold text-zinc-300 hover:border-zinc-400 disabled:opacity-40 ${FOCUS_RING}`}>
            <Download className="size-4" aria-hidden /> CSV
          </button>
          <button type="button" {...keepFocus} onClick={() => window.print()} disabled={!current} className={`flex min-h-11 items-center gap-2 rounded-md border-2 border-zinc-700 px-3 font-bold text-zinc-300 hover:border-zinc-400 disabled:opacity-40 ${FOCUS_RING}`}>
            <Printer className="size-4" aria-hidden /> Print
          </button>
        </div>
      </section>

      <nav className="flex shrink-0 flex-wrap items-center gap-2 border-b-2 border-zinc-800 bg-zinc-900 px-5 py-2 print:hidden" role="tablist" aria-label="Reports">
        {REPORT_TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            {...keepFocus}
            onClick={() => setTab(t.id)}
            className={`flex min-h-11 items-center gap-2 rounded-md border-2 px-3 font-bold ${t.id === tab ? 'border-zinc-200 bg-zinc-200 text-zinc-950' : 'border-zinc-700 text-zinc-300 hover:border-zinc-400'} ${FOCUS_RING}`}
          >
            <span className="font-mono text-xs opacity-60">{i + 1}</span>
            {t.label}
          </button>
        ))}
        {range && !invalid && <span className="ml-auto text-sm text-zinc-400">{rangeLabel(range)}</span>}
      </nav>

      {/* Print header: what and when, since the screen chrome is hidden on paper. */}
      {range && (
        <div className="hidden print:block print:px-2 print:pb-2">
          <p className="text-lg font-bold">FL2 — {tabLabel}</p>
          <p className="text-sm">
            Business dates {rangeLabel(range)}{printedAt ? ` · Printed ${printedAt}` : ''}
            {current?.tab === 'expenses' && current.data.center ? ` · Center: ${centers.find((c) => c.code === current.data.center)?.name ?? (current.data.center === 'SHARED' ? 'Shared' : current.data.center)}` : ''}
            {current?.tab === 'purchases' && current.data.center ? ` · Center: ${centers.find((c) => c.code === current.data.center)?.name ?? current.data.center}` : ''}
          </p>
          {current?.data.provisional && <p className="mt-1 border-2 border-black px-2 py-1 text-sm font-black">PROVISIONAL — a day in this range is still open; figures change until Day End.</p>}
        </div>
      )}

      {invalid && preset === 'custom' && <Note title={invalid} />}
      {!invalid && status.kind === 'loading' && <Note title="Loading report…" />}
      {status.kind === 'error' && (
        <Note title={status.offline ? 'POS server unreachable' : status.message} icon={status.offline ? <WifiOff className="size-10 text-rose-400" aria-hidden /> : undefined}>
          <button type="button" onClick={refresh} className="mt-2 inline-flex items-center gap-2 rounded-md border-2 border-zinc-600 px-4 py-2 font-bold hover:border-zinc-300">
            <RefreshCw className="size-4" aria-hidden /> Retry now
          </button>
        </Note>
      )}

      {!invalid && status.kind === 'ready' && current && (
        <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 print:overflow-visible print:p-2" aria-label={tabLabel}>
          <DaysLine header={current.data} />
          {current.tab === 'sales' && <SalesSummaryView summary={current.data} members={current.members} mode={salesMode} onMode={setSalesMode} />}
          {current.tab === 'orders' && <OrdersView report={current.data} />}
          {current.tab === 'stock' && <StockSummaryView report={current.data} />}
          {current.tab === 'expenses' && (
            <ExpensesView report={current.data} centers={centers} center={filters.expenseCenter} onCenter={(c) => setFilters((f) => ({ ...f, expenseCenter: c }))} />
          )}
          {current.tab === 'purchases' && (
            <PurchasesView report={current.data} centers={centers} center={filters.purchaseCenter} onCenter={(c) => setFilters((f) => ({ ...f, purchaseCenter: c }))} />
          )}
          {current.tab === 'bank' && <BankDepositsView report={current.data} />}
          {current.tab === 'dayEnd' && <DayEndView report={current.data} />}
          {current.tab === 'full' && <FullReportView report={current.data} />}
          <Signatures />
          <p className="text-sm text-zinc-500 print:hidden">
            Dates are business (trading) days: a bill rung after midnight counts on the evening it was sold. <Kbd>1</Kbd>–<Kbd>8</Kbd> or <Kbd>←</Kbd>/<Kbd>→</Kbd> switch
            reports · <Kbd>R</Kbd> reload · <Kbd>Esc</Kbd> dashboard.
          </p>
        </main>
      )}
    </div>
  )
}

function Note({ title, icon, children }: { title: string; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center print:hidden">
      {icon}
      <p className="text-xl font-bold text-zinc-300">{title}</p>
      {children}
    </div>
  )
}

function DaysLine({ header }: { header: ReportHeader }) {
  const open = header.days.filter((d) => d.status === 'OPEN').length
  return (
    <>
      <p className="text-sm text-zinc-400 print:text-black">
        {header.days.length === 0
          ? 'No trading days in this range.'
          : `${header.days.length} trading day${header.days.length === 1 ? '' : 's'} · ${header.days.length - open} closed${open ? ` · ${open} open` : ''}`}
      </p>
      {header.provisional && (
        <p className="flex items-center gap-2 rounded-md border-2 border-amber-500 bg-amber-500/10 px-3 py-2 font-semibold text-amber-200 print:hidden">
          <AlertTriangle className="size-5 shrink-0 text-amber-400" aria-hidden />
          {header.days.find((d) => d.status === 'OPEN')?.businessDate === undefined
            ? 'A day in this range is still open'
            : `${formatBusinessDate(header.days.find((d) => d.status === 'OPEN')!.businessDate)} is still open`}{' '}
          — its figures will change until Day End.
        </p>
      )}
    </>
  )
}

/** The moment the page was last sent to the printer (stamped on `beforeprint`, never during render). */
function usePrintedAt(): string {
  const [at, setAt] = useState<string>('')
  useEffect(() => {
    const stamp = () => setAt(printStamp(new Date()))
    window.addEventListener('beforeprint', stamp)
    return () => window.removeEventListener('beforeprint', stamp)
  }, [])
  return at
}

/** On paper only: sign-off lines for the auditor / excise officer copy. */
function Signatures() {
  return (
    <div className="hidden print:mt-10 print:grid print:grid-cols-3 print:gap-10 print:break-inside-avoid">
      {['Prepared by', 'Checked by', 'Manager'].map((label) => (
        <div key={label} className="border-t border-black pt-1 text-sm">
          {label}
        </div>
      ))}
    </div>
  )
}
