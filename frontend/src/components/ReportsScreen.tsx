import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowLeft, ChartColumn, Download, Printer, RefreshCw, Search, WifiOff } from 'lucide-react'
import { ApiError, api } from '../api/client'
import type { LedgerReport, Paise, PaymentsReport, RangeAnchor, ReportHeader, ReportRange, SalesRegister, StockRegister } from '../api/types'
import { counterErrorMessage } from '../billing/errors'
import { departmentChip } from '../lib/departments'
import { formatPaise } from '../lib/money'
import { FOCUS_RING, keepFocus } from '../lib/ui'
import { ledgerCsv, paymentsCsv, salesCsv, stockCsv } from '../reports/csv'
import { PRESETS, presetRange, rangeError, rangeLabel, formatBusinessDate, type PresetId } from '../reports/dateRange'
import {
  filterSales,
  grandTotals,
  groupStock,
  isReportTab,
  itemsSummary,
  PAGE_SIZE,
  pageCount,
  paidByLabel,
  REPORT_TABS,
  stepReportTab,
  type ReportTab,
  type StockTotals,
} from '../reports/registerView'
import { Kbd, LiveClock } from './ui'

/**
 * Settings → Reports (Phase 23): one business-date range drives four tabs — ledger balances for
 * manual Tally entry, the sales register, the stock register and the payment split. Read-only;
 * no net-profit figure anywhere.
 */

type Loaded =
  | { tab: 'ledger'; data: LedgerReport }
  | { tab: 'sales'; data: SalesRegister }
  | { tab: 'stock'; data: StockRegister }
  | { tab: 'payments'; data: PaymentsReport }

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
    return isReportTab(tab) ? tab : 'ledger'
  } catch {
    return 'ledger'
  }
}

const IST_TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
const timeOf = (iso: string) => IST_TIME.format(new Date(iso))

function fetchReport(tab: ReportTab, range: ReportRange): Promise<Loaded> {
  switch (tab) {
    case 'ledger':
      return api.reportLedger(range).then((data) => ({ tab, data }))
    case 'sales':
      return api.reportSales(range).then((data) => ({ tab, data }))
    case 'stock':
      return api.reportStock(range).then((data) => ({ tab, data }))
    case 'payments':
      return api.reportPayments(range).then((data) => ({ tab, data }))
  }
}

function csvFor(loaded: Loaded): string {
  switch (loaded.tab) {
    case 'ledger':
      return ledgerCsv(loaded.data)
    case 'sales':
      return salesCsv(loaded.data, timeOf)
    case 'stock':
      return stockCsv(loaded.data)
    case 'payments':
      return paymentsCsv(loaded.data)
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

const keyOf = (tab: ReportTab, range: ReportRange) => `${tab}|${range.startDate}|${range.endDate}`

export default function ReportsScreen({ onExit }: { onExit: () => void }) {
  const [anchor, setAnchor] = useState<RangeAnchor | null>(null)
  const [preset, setPreset] = useState<PresetId>(() => remembered()?.preset ?? 'today')
  const [custom, setCustom] = useState<ReportRange>(() => remembered()?.custom ?? { startDate: '', endDate: '' })
  const [tab, setTab] = useState<ReportTab>(rememberedTab)
  const [loaded, setLoaded] = useState<{ key: string; report: Loaded } | null>(null)
  const [status, setStatus] = useState<{ kind: 'loading' | 'ready' } | { kind: 'error'; message: string; offline: boolean }>({ kind: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const cache = useRef(new Map<string, Loaded>())

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
    const key = keyOf(tab, range)
    const hit = cache.current.get(key)
    if (hit) {
      setLoaded({ key, report: hit })
      setStatus({ kind: 'ready' })
      return
    }
    let live = true
    setStatus({ kind: 'loading' })
    fetchReport(tab, range)
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
  }, [tab, range, invalid, reloadToken])

  const refresh = useCallback(() => {
    cache.current.clear()
    loadAnchor()
    setReloadToken((t) => t + 1)
  }, [loadAnchor])

  const current = range && loaded?.key === keyOf(tab, range) ? loaded.report : null

  const exportCsv = useCallback(() => {
    if (!current || !range) return
    downloadCsv(`fl2-${current.tab}-${range.startDate}_${range.endDate}.csv`, csvFor(current))
  }, [current, range])

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
      if (/^[1-4]$/.test(event.key)) {
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

  const tabLabel = REPORT_TABS.find((t) => t.id === tab)?.label ?? ''
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
          <p className="text-sm">Business dates {rangeLabel(range)}{current?.data.provisional ? ' · PROVISIONAL (a day is still open)' : ''}</p>
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
          {current.tab === 'ledger' && <LedgerView report={current.data} />}
          {current.tab === 'sales' && <SalesView report={current.data} />}
          {current.tab === 'stock' && <StockView report={current.data} />}
          {current.tab === 'payments' && <PaymentsView report={current.data} />}
          <p className="text-sm text-zinc-500 print:hidden">
            Dates are business (trading) days: a bill rung after midnight counts on the evening it was sold. <Kbd>1</Kbd>–<Kbd>4</Kbd> or <Kbd>←</Kbd>/<Kbd>→</Kbd> switch
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
        <p className="flex items-center gap-2 rounded-md border-2 border-amber-500 bg-amber-500/10 px-3 py-2 font-semibold text-amber-200 print:text-black">
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

const money = (p: Paise) => formatPaise(p)

function Card({ title, children, total, totalLabel = 'Total' }: { title: string; children: ReactNode; total?: Paise; totalLabel?: string }) {
  return (
    <section className="flex flex-col rounded-lg border-2 border-zinc-800 bg-zinc-900 print:break-inside-avoid print:border-zinc-400 print:bg-white" aria-label={title}>
      <h2 className="border-b border-zinc-800 px-4 py-2 text-xs font-bold tracking-widest text-zinc-400 uppercase print:text-black">{title}</h2>
      <div className="flex flex-1 flex-col">{children}</div>
      {total !== undefined && (
        <div className="flex items-baseline justify-between border-t-2 border-zinc-700 px-4 py-3 text-lg font-black">
          <span>{totalLabel}</span>
          <span className="font-mono tabular-nums">{money(total)}</span>
        </div>
      )}
    </section>
  )
}

function Line({ label, value, hint, strong = false }: { label: ReactNode; value: Paise; hint?: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-800/60 px-4 py-2 last:border-b-0">
      <span className="flex min-w-0 flex-col">
        <span className={strong ? 'font-bold' : ''}>{label}</span>
        {hint && <span className="text-xs text-zinc-500 print:text-black">{hint}</span>}
      </span>
      <span className={`shrink-0 font-mono tabular-nums ${strong ? 'font-black' : 'font-semibold'}`}>{money(value)}</span>
    </div>
  )
}

const Empty = ({ text }: { text: string }) => <p className="px-4 py-3 text-sm text-zinc-500">{text}</p>

function LedgerView({ report }: { report: LedgerReport }) {
  const { sales, purchases, expenses, contra } = report
  return (
    <>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Sales accounts" total={sales.totalPaise}>
          {sales.byCenter.map((c) => (
            <Line key={c.code} label={<span className={`rounded border px-2 py-0.5 font-bold ${departmentChip(c.code)} print:border-0 print:bg-transparent print:p-0 print:text-black`}>{c.name} Sales</span>} value={c.salesPaise} />
          ))}
          {sales.unallocatedPaise !== 0n && <Line label="Not yet split (open day)" hint="Part-paid tabs and a running peak; split once settled" value={sales.unallocatedPaise} />}
        </Card>
        <Card title="Purchase accounts" total={purchases.totalPaise}>
          <Line label="Liquor purchases" hint="Stock received (GRN)" value={purchases.liquorGrnPaise} />
          {purchases.byCenter.map((c) => (
            <Line
              key={c.code}
              label={`${c.name} purchases`}
              hint={`GRN ${money(c.grnPaise)} · supplies ${money(c.suppliesPaise)}${c.suppliesDrawerPaise !== 0n ? ` (${money(c.suppliesDrawerPaise)} from the drawer)` : ''}`}
              value={c.totalPaise}
            />
          ))}
        </Card>
        <Card title="Expense accounts (petty cash)" total={expenses.totalPaise}>
          {expenses.byCategory.length === 0 && <Empty text="No expenses in this range." />}
          {expenses.byCategory.map((e) => (
            <Line key={e.categoryId} label={e.name} hint={`${e.centerName ?? 'Shared'} · ${e.count} entr${e.count === 1 ? 'y' : 'ies'}`} value={e.amountPaise} />
          ))}
        </Card>
      </div>
      <Card title="Contra">
        <Line label="Cash deposited to bank" hint="Cash → bank; not an expense" value={contra.bankDepositsPaise} />
      </Card>
      <p className="text-sm text-zinc-500 print:hidden">
        Grouped totals for manual Tally entry. Sales follow each bill line&rsquo;s revenue center; GRN cost follows the item&rsquo;s current center. No profit line is
        calculated.
      </p>
    </>
  )
}

function SalesView({ report }: { report: SalesRegister }) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const rows = useMemo(() => filterSales(report.rows, query), [report.rows, query])
  const pages = pageCount(rows.length)
  const at = Math.min(page, pages - 1)
  const showDate = report.range.startDate !== report.range.endDate
  return (
    <section className="flex flex-col gap-3" aria-label="Sales register">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <label className="flex min-h-11 flex-1 items-center gap-2 rounded-md border-2 border-zinc-700 bg-zinc-950 px-3 focus-within:border-amber-400">
          <Search className="size-4 text-zinc-500" aria-hidden />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
            placeholder="Bill no., item or waiter"
            className="min-w-0 flex-1 bg-transparent outline-none"
            aria-label="Search the sales register"
          />
        </label>
        {pages > 1 && (
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => setPage(Math.max(0, at - 1))} disabled={at === 0} className="min-h-11 rounded-md border-2 border-zinc-700 px-3 font-bold disabled:opacity-40">
              ‹ Prev
            </button>
            <span className="text-sm text-zinc-400">
              Page {at + 1} of {pages}
            </span>
            <button type="button" onClick={() => setPage(Math.min(pages - 1, at + 1))} disabled={at >= pages - 1} className="min-h-11 rounded-md border-2 border-zinc-700 px-3 font-bold disabled:opacity-40">
              Next ›
            </button>
          </span>
        )}
      </div>
      <table className="w-full rounded-lg border-2 border-zinc-800 bg-zinc-900 text-sm print:border-zinc-400 print:bg-white">
        <thead className="text-xs tracking-widest text-zinc-500 uppercase print:text-black">
          <tr className="border-b border-zinc-800">
            {showDate && <th className="px-3 py-2 text-left">Date</th>}
            <th className="px-3 py-2 text-right">Bill</th>
            <th className="px-3 py-2 text-left">Time</th>
            <th className="px-3 py-2 text-left">Items</th>
            <th className="px-3 py-2 text-left">Paid by</th>
            <th className="px-3 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={showDate ? 6 : 5} className="px-3 py-4 text-zinc-500">
                {report.rows.length === 0 ? 'No bills in this range.' : 'No bill matches.'}
              </td>
            </tr>
          )}
          {/* On screen one page; on paper every bill. */}
          {rows.map((r, i) => {
            const reversal = r.kind === 'REVERSAL'
            const onPage = Math.floor(i / PAGE_SIZE) === at
            return (
              <tr key={r.billId} className={`border-b border-zinc-800/60 align-top ${onPage ? '' : 'hidden print:table-row'} ${reversal ? 'text-rose-300 print:text-black' : ''}`}>
                {showDate && <td className="px-3 py-2 whitespace-nowrap text-zinc-400 print:text-black">{formatBusinessDate(r.businessDate)}</td>}
                <td className="px-3 py-2 text-right font-mono font-bold tabular-nums">#{r.billNo}</td>
                <td className="px-3 py-2 font-mono tabular-nums">{timeOf(r.createdAt)}</td>
                <td className="px-3 py-2">
                  {reversal && (
                    <span className="mr-2 rounded bg-rose-500/20 px-1.5 py-0.5 text-xs font-black uppercase">
                      Void of #{r.reverses?.billNo}
                      {r.reverses && r.reverses.businessDate !== r.businessDate ? ` (${formatBusinessDate(r.reverses.businessDate)})` : ''}
                    </span>
                  )}
                  {r.voidedBy && <span className="mr-2 rounded bg-zinc-700 px-1.5 py-0.5 text-xs font-bold uppercase text-zinc-300">Voided by #{r.voidedBy.billNo}</span>}
                  <span className={r.voidedBy ? 'line-through decoration-zinc-500' : ''}>{itemsSummary(r.items)}</span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-zinc-300 print:text-black">
                  {paidByLabel(r)}
                  {r.waiterName ? ` · ${r.waiterName}` : ''}
                </td>
                <td className="px-3 py-2 text-right font-mono font-bold whitespace-nowrap tabular-nums">{money(r.totalPaise)}</td>
              </tr>
            )
          })}
        </tbody>
        <tfoot className="font-bold">
          <tr className="border-t-2 border-zinc-700">
            <td colSpan={showDate ? 5 : 4} className="px-3 py-2 text-right">
              {report.totals.billCount} bills
            </td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">{money(report.totals.salesPaise)}</td>
          </tr>
          <tr>
            <td colSpan={showDate ? 5 : 4} className="px-3 py-1 text-right text-rose-300 print:text-black">
              {report.totals.reversalCount} void{report.totals.reversalCount === 1 ? '' : 's'}
            </td>
            <td className="px-3 py-1 text-right font-mono text-rose-300 tabular-nums print:text-black">{money(report.totals.reversalsPaise)}</td>
          </tr>
          <tr className="text-lg font-black">
            <td colSpan={showDate ? 5 : 4} className="px-3 py-2 text-right">
              Net sales
            </td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">{money(report.totals.netPaise)}</td>
          </tr>
        </tfoot>
      </table>
      {report.openBillCount > 0 && (
        <p className="text-sm text-amber-300 print:text-black">
          {report.openBillCount} open tab{report.openBillCount === 1 ? '' : 's'} not listed: not a sale until settled.
        </p>
      )}
    </section>
  )
}

const QTY_COLUMNS: ReadonlyArray<{ key: keyof StockTotals; label: string }> = [
  { key: 'openingQty', label: 'Opening' },
  { key: 'inwardQty', label: 'Inward' },
  { key: 'salesQty', label: 'Sales' },
  { key: 'otherQty', label: 'Other' },
  { key: 'closingQty', label: 'Closing' },
]

function QtyCells({ totals, strong = false }: { totals: StockTotals; strong?: boolean }) {
  return (
    <>
      {QTY_COLUMNS.map((c) => (
        <td key={c.key} className={`px-3 py-1.5 text-right font-mono tabular-nums ${strong || c.key === 'closingQty' ? 'font-bold' : ''} ${totals[c.key] === 0 && !strong ? 'text-zinc-600 print:text-black' : ''}`}>
          {totals[c.key]}
        </td>
      ))}
    </>
  )
}

function StockView({ report }: { report: StockRegister }) {
  const [hideIdle, setHideIdle] = useState(true)
  const [query, setQuery] = useState('')
  const groups = useMemo(() => groupStock(report.rows, { hideIdle, query }), [report.rows, hideIdle, query])
  const totals = grandTotals(groups)
  return (
    <section className="flex flex-col gap-3" aria-label="Stock register">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <label className="flex min-h-11 flex-1 items-center gap-2 rounded-md border-2 border-zinc-700 bg-zinc-950 px-3 focus-within:border-amber-400">
          <Search className="size-4 text-zinc-500" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Item or code" className="min-w-0 flex-1 bg-transparent outline-none" aria-label="Search the stock register" />
        </label>
        <label className="flex min-h-11 items-center gap-2 font-semibold text-zinc-300">
          <input type="checkbox" checked={hideIdle} onChange={(e) => setHideIdle(e.target.checked)} className="size-5 accent-emerald-500" />
          Hide items with no stock and no movement
        </label>
      </div>
      <table className="w-full rounded-lg border-2 border-zinc-800 bg-zinc-900 text-sm print:border-zinc-400 print:bg-white">
        <thead className="text-xs tracking-widest text-zinc-500 uppercase print:text-black">
          <tr className="border-b border-zinc-800">
            <th className="px-3 py-2 text-left">Item</th>
            <th className="px-3 py-2 text-left">Center</th>
            {QTY_COLUMNS.map((c) => (
              <th key={c.key} className="px-3 py-2 text-right">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-4 text-zinc-500">
                Nothing to show for this range.
              </td>
            </tr>
          )}
          {groups.map((g) => [
            <tr key={`h-${g.categoryName}`} className="bg-zinc-800/60 print:bg-white">
              <td colSpan={2} className="px-3 py-1.5 text-xs font-black tracking-widest uppercase">
                {g.categoryName}
              </td>
              <QtyCells totals={g.totals} strong />
            </tr>,
            ...g.rows.map((r) => (
              <tr key={r.skuId} className="border-b border-zinc-800/60">
                <td className="px-3 py-1.5">
                  {r.name}
                  <span className="ml-2 font-mono text-xs text-zinc-500">{r.skuCode}</span>
                  {!r.isActive && <span className="ml-2 text-xs text-zinc-500">(inactive)</span>}
                </td>
                <td className="px-3 py-1.5 text-zinc-400 print:text-black">{r.centerName}</td>
                <QtyCells totals={r} />
              </tr>
            )),
          ])}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-zinc-700 text-base">
            <td colSpan={2} className="px-3 py-2 font-black">
              All items (bottles / units)
            </td>
            <QtyCells totals={totals} strong />
          </tr>
        </tfoot>
      </table>
      <p className="text-sm text-zinc-500 print:hidden">
        Closing = Opening + Inward (GRN) − Sales + Other. Sales are net of voids put back on the shelf; Other is a new item&rsquo;s opening count. Untracked centers (e.g.
        Kitchen) are not listed.
      </p>
    </section>
  )
}

function PaymentsView({ report }: { report: PaymentsReport }) {
  const { revenue, split, waiterLedger, received } = report
  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <Card title="Sales by tender" total={revenue.totalSalesPaise} totalLabel="Total sales">
          <Line label="Cash" value={revenue.cashPaise} />
          <Line label="UPI" value={revenue.upiPaise} />
          <Line label="Waiter credit" hint="Settled “collect later” through the waiter ledger" value={revenue.waiterCreditPaise} />
        </Card>
        <Card title="Where it came from">
          <Line label="Counter & Captain — cash" hint="After tally adjustments" value={split.normal.cashPaise} />
          <Line label="Counter & Captain — UPI" value={split.normal.upiPaise} />
          <Line label={`Peak — cash (${split.peak.sessionCount} session${split.peak.sessionCount === 1 ? '' : 's'})`} hint="From the peak readings; any variance sits here" value={split.peak.cashPaise} />
          <Line label="Peak — UPI" value={split.peak.upiPaise} />
        </Card>
        <Card title="Waiter ledger">
          <Line label="Credit given" value={waiterLedger.creditGivenPaise} />
          <Line label="Repaid in cash" value={waiterLedger.repaidCashPaise} />
          <Line label="Repaid in UPI" value={waiterLedger.repaidUpiPaise} />
          <Line label="Change in outstanding" hint="Zero once every day is closed" value={waiterLedger.outstandingChangePaise} strong />
        </Card>
        <Card title="Money received">
          <Line label="Cash received" hint="Cash sales + waiter cash repayments" value={received.cashPaise} strong />
          <Line label="UPI received" hint="UPI sales + waiter UPI repayments" value={received.upiPaise} strong />
        </Card>
      </div>
      {report.byDay.length > 1 && (
        <table className="w-full rounded-lg border-2 border-zinc-800 bg-zinc-900 text-sm print:border-zinc-400 print:bg-white">
          <thead className="text-xs tracking-widest text-zinc-500 uppercase print:text-black">
            <tr className="border-b border-zinc-800">
              <th className="px-3 py-2 text-left">Day</th>
              <th className="px-3 py-2 text-right">Cash</th>
              <th className="px-3 py-2 text-right">UPI</th>
              <th className="px-3 py-2 text-right">Waiter credit</th>
              <th className="px-3 py-2 text-right">Total sales</th>
              <th className="px-3 py-2 text-right">Repaid (cash / UPI)</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {report.byDay.map((d) => (
              <tr key={d.businessDate} className="border-b border-zinc-800/60">
                <td className="px-3 py-1.5 font-sans">
                  {formatBusinessDate(d.businessDate)}
                  {d.status === 'OPEN' && <span className="ml-2 text-xs font-bold text-amber-300 uppercase">open</span>}
                </td>
                <td className="px-3 py-1.5 text-right">{money(d.cashPaise)}</td>
                <td className="px-3 py-1.5 text-right">{money(d.upiPaise)}</td>
                <td className="px-3 py-1.5 text-right">{money(d.waiterCreditPaise)}</td>
                <td className="px-3 py-1.5 text-right font-bold">{money(d.totalSalesPaise)}</td>
                <td className="px-3 py-1.5 text-right text-zinc-400 print:text-black">
                  {money(d.repaidCashPaise)} / {money(d.repaidUpiPaise)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
