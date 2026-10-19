import type { BankDepositLog, DayEndLog, ExpenseSummary, FullReport, PurchaseSummary } from '../../api/types'
import { departmentChip } from '../../lib/departments'
import { formatBusinessDate } from '../../reports/dateRange'
import { money, timeOf } from '../../reports/format'
import { Card, CELL, CenterFilter, Empty, GROUP_ROW, Line, NUM, ROW, TABLE, THEAD, Variance } from './parts'

/** Tabs 4–8 (Phase 24): Expenses, Purchases, Bank deposits, Day End & Variance, Full Report. */

type Centers = ReadonlyArray<{ code: string; name: string }>

const status = (isVoid: boolean, voided: boolean) =>
  isVoid ? <span className="rounded bg-rose-500/20 px-1.5 text-xs font-black print:border print:border-black">VOID</span> : voided ? <span className="text-xs font-bold text-zinc-500 print:text-black">VOIDED</span> : null

// ── 4 · Expenses ──

export function ExpensesView({ report, centers, center, onCenter }: { report: ExpenseSummary; centers: Centers; center: string | null; onCenter: (c: string | null) => void }) {
  const multiDay = report.range.startDate !== report.range.endDate
  return (
    <section className="flex flex-col gap-4" aria-label="Expenses summary">
      <CenterFilter centers={centers} value={center} onChange={onCenter} shared />
      <div className="flex flex-wrap gap-2">
        {report.byCenter.map((c) => (
          <span key={c.code} className={`rounded-md border-2 px-3 py-1.5 font-bold ${c.code === 'SHARED' ? 'border-zinc-600 text-zinc-300' : departmentChip(c.code)} print:border-zinc-400 print:bg-white print:text-black`}>
            {c.name} <span className="font-mono tabular-nums">{money(c.amountPaise)}</span>
          </span>
        ))}
      </div>
      <table className={TABLE}>
        <thead className={THEAD}>
          <tr className="border-b border-zinc-800">
            <th className="px-3 py-2 text-left">{multiDay ? 'Date · time' : 'Time'}</th>
            <th className="px-3 py-2 text-left">Description</th>
            <th className="px-3 py-2 text-left">By</th>
            <th className="px-3 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {report.byCategory.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-4 text-zinc-500">
                No petty-cash payouts in this range{center ? ' for this center' : ''}.
              </td>
            </tr>
          )}
          {report.byCategory.map((g) => [
            <tr key={`h-${g.categoryId}`} className={GROUP_ROW}>
              <td className={CELL} colSpan={3}>
                {g.name} <span className="ml-2 text-xs font-normal text-zinc-400 print:text-black">{g.centerName ?? 'Shared'} · {g.count} entr{g.count === 1 ? 'y' : 'ies'}</span>
              </td>
              <td className={NUM}>{money(g.amountPaise)}</td>
            </tr>,
            ...g.entries.map((e) => (
              <tr key={e.id} className={`${ROW} ${e.isVoid || e.voided ? 'text-zinc-500 print:text-black' : ''}`}>
                <td className={`${CELL} pl-6 font-mono whitespace-nowrap tabular-nums`}>
                  {multiDay ? `${formatBusinessDate(e.businessDate)} · ` : ''}
                  {timeOf(e.at)}
                </td>
                <td className={CELL}>
                  {e.description} {status(e.isVoid, e.voided)}
                </td>
                <td className={CELL}>{e.byName}</td>
                <td className={NUM}>{money(e.amountPaise)}</td>
              </tr>
            )),
          ])}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-zinc-700 text-lg font-black">
            <td className={CELL} colSpan={3}>
              Total expenses
            </td>
            <td className={NUM}>{money(report.totalPaise)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  )
}

// ── 5 · Purchases ──

export function PurchasesView({ report, centers, center, onCenter }: { report: PurchaseSummary; centers: Centers; center: string | null; onCenter: (c: string | null) => void }) {
  return (
    <section className="flex flex-col gap-4" aria-label="Purchase summary">
      <CenterFilter centers={centers} value={center} onChange={onCenter} />
      {report.centers.map((c) => (
        <Card key={c.code} title={`${c.name} — inwards`} total={c.totalPaise}>
          {c.grn.length === 0 && c.supplies.length === 0 && <Empty text="No purchases in this range." />}
          {c.grn.length > 0 && (
            <table className="w-full text-sm">
              <thead className={THEAD}>
                <tr className="border-b border-zinc-800">
                  <th className="px-3 py-2 text-left">Stock received (GRN)</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Unit cost</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {c.grn.map((g) => [
                  <tr key={`h-${g.receiptId}`} className={GROUP_ROW}>
                    <td className={CELL} colSpan={3}>
                      {formatBusinessDate(g.businessDate)} · Invoice {g.invoiceNo}
                      {g.vendorName ? ` · ${g.vendorName}` : ''} <span className="text-xs font-normal text-zinc-400 print:text-black">received by {g.receivedByName}</span>
                    </td>
                    <td className={NUM}>{money(g.amountPaise)}</td>
                  </tr>,
                  ...g.lines.map((l, i) => (
                    <tr key={`${g.receiptId}-${i}`} className={ROW}>
                      <td className={`${CELL} pl-6`}>{l.name}</td>
                      <td className={NUM}>{l.qty}</td>
                      <td className={NUM}>{l.unitCostPaise === 0n ? 'free' : money(l.unitCostPaise)}</td>
                      <td className={NUM}>{money(l.amountPaise)}</td>
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          )}
          {c.supplies.length > 0 && (
            <table className="w-full text-sm">
              <thead className={THEAD}>
                <tr className="border-b border-zinc-800">
                  <th className="px-3 py-2 text-left">Supplies / raw material</th>
                  <th className="px-3 py-2 text-left">Paid from</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {c.supplies.map((s) => (
                  <tr key={s.purchaseId} className={`${ROW} ${s.isVoid || s.voided ? 'text-zinc-500 print:text-black' : ''}`}>
                    <td className={CELL}>
                      {formatBusinessDate(s.businessDate)} · {s.vendorName ?? 'No vendor'} {status(s.isVoid, s.voided)}
                      {s.lines.length > 0 && <span className="block text-xs text-zinc-400 print:text-black">{s.lines.map((l) => `${l.description}${l.quantity ? ` (${l.quantity})` : ''} ${money(l.amountPaise)}`).join(' · ')}</span>}
                    </td>
                    <td className={CELL}>{s.paidFrom === 'DRAWER' ? 'Drawer cash' : 'Outside'}</td>
                    <td className={NUM}>{money(s.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="px-4 py-2 text-xs text-zinc-400 print:text-black">
            GRN {money(c.grnPaise)} · supplies {money(c.suppliesPaise)}
            {c.suppliesDrawerPaise !== 0n ? ` (${money(c.suppliesDrawerPaise)} from the drawer)` : ''}
          </p>
        </Card>
      ))}
      <div className="flex items-baseline justify-between rounded-lg border-2 border-zinc-200 px-4 py-3 text-lg font-black print:border-black">
        <span>Total purchases{center ? '' : ' (all centers)'}</span>
        <span className="font-mono tabular-nums">{money(report.totalPaise)}</span>
      </div>
      <p className="text-sm text-zinc-500 print:hidden">A GRN line belongs to its item&rsquo;s revenue center, so one invoice can appear under two centers.</p>
    </section>
  )
}

// ── 6 · Bank deposits ──

export function BankDepositsView({ report }: { report: BankDepositLog }) {
  return (
    <section className="flex flex-col gap-3" aria-label="Bank deposits">
      <table className={TABLE}>
        <thead className={THEAD}>
          <tr className="border-b border-zinc-800">
            <th className="px-3 py-2 text-left">Date</th>
            <th className="px-3 py-2 text-left">Time</th>
            <th className="px-3 py-2 text-left">Reference no.</th>
            <th className="px-3 py-2 text-left">Depositor</th>
            <th className="px-3 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-4 text-zinc-500">
                No cash moved to the bank in this range.
              </td>
            </tr>
          )}
          {report.rows.map((d) => (
            <tr key={d.id} className={`${ROW} ${d.isVoid || d.voided ? 'text-zinc-500 print:text-black' : ''}`}>
              <td className={`${CELL} whitespace-nowrap`}>{formatBusinessDate(d.businessDate)}</td>
              <td className={`${CELL} font-mono tabular-nums`}>{timeOf(d.at)}</td>
              <td className={`${CELL} font-mono`}>
                {d.reference ?? '—'} {status(d.isVoid, d.voided)}
              </td>
              <td className={CELL}>{d.depositorName}</td>
              <td className={NUM}>{money(d.amountPaise)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-zinc-700 text-lg font-black">
            <td className={CELL} colSpan={4}>
              Total deposited (net of voids)
            </td>
            <td className={NUM}>{money(report.totalPaise)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="text-sm text-zinc-500 print:text-black">Contra entries: cash moved from the till to the bank. Depositor is the staff member who recorded it at the till.</p>
    </section>
  )
}

// ── 7 · Day End & Variance ──

export function DayEndView({ report }: { report: DayEndLog }) {
  const t = report.totals
  return (
    <section className="flex flex-col gap-3" aria-label="Day End and variance">
      <div className="overflow-x-auto print:overflow-visible">
        <table className={TABLE}>
          <thead className={THEAD}>
            <tr className="border-b border-zinc-800">
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-2 py-2 text-right">Float</th>
              <th className="px-2 py-2 text-right">Expected cash</th>
              <th className="px-2 py-2 text-right">Actual cash</th>
              <th className="px-2 py-2 text-right">Variance</th>
              <th className="px-2 py-2 text-right">Peak var.</th>
              <th className="px-2 py-2 text-right">Total UPI</th>
              <th className="px-2 py-2 text-right">Total sales</th>
              <th className="px-3 py-2 text-left">Closed by</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-4 text-zinc-500">
                  No trading days in this range.
                </td>
              </tr>
            )}
            {report.rows.map((d) => (
              <tr key={d.businessDate} className={ROW}>
                <td className={`${CELL} whitespace-nowrap`}>
                  {formatBusinessDate(d.businessDate)}
                  {d.status === 'OPEN' && <span className="ml-2 text-xs font-bold text-amber-300 uppercase print:text-black">open</span>}
                </td>
                <td className={NUM}>{money(d.openingFloatPaise)}</td>
                <td className={NUM}>{money(d.expectedCashPaise)}</td>
                <td className={NUM}>{d.countedCashPaise === null ? '—' : money(d.countedCashPaise)}</td>
                <td className={`${NUM} font-bold`}>
                  <Variance value={d.variancePaise} />
                </td>
                <td className={NUM}>{d.peakVariancePaise === 0n ? '—' : <Variance value={d.peakVariancePaise} />}</td>
                <td className={NUM}>{money(d.upiPaise)}</td>
                <td className={`${NUM} font-bold`}>{money(d.totalSalesPaise)}</td>
                <td className={`${CELL} whitespace-nowrap`}>
                  {d.closedByName ? (
                    <>
                      {d.closedByName} <span className="text-xs text-zinc-500 print:text-black">{d.closedByRole?.toLowerCase()}</span>
                      {d.closedAt && <span className="ml-1 font-mono text-xs text-zinc-500 print:text-black">{timeOf(d.closedAt)}</span>}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-zinc-700 font-black">
              <td className={CELL} colSpan={2}>
                Total
              </td>
              <td className={NUM}>{money(t.expectedCashPaise)}</td>
              <td className={NUM}>{money(t.countedCashPaise)}</td>
              <td className={NUM}>
                <Variance value={t.variancePaise} />
              </td>
              <td className={NUM}>
                <Variance value={t.peakVariancePaise} />
              </td>
              <td className={NUM}>{money(t.upiPaise)}</td>
              <td className={NUM}>{money(t.totalSalesPaise)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-sm text-zinc-500 print:text-black">
        Expected and actual cash are the figures frozen at Day End. Variance = actual − expected (short is negative). Peak variances are already inside expected cash. UPI
        includes waiter UPI repayments.
      </p>
    </section>
  )
}

// ── 8 · Full report ──

export function FullReportView({ report }: { report: FullReport }) {
  const c = report.cash
  return (
    <>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 print:grid-cols-2">
        <Card title="Cash book" total={c.closingBalancePaise} totalLabel="Closing cash balance">
          <Line label="Opening cash balance" hint="First day's opening float" value={c.openingBalancePaise} strong />
          <Line label="Cash sales" hint="Counter (after tally adjustments) + peak" value={c.cashSalesPaise} tone="in" />
          {c.waiterCashRepaidPaise !== 0n && <Line label="Waiter cash repayments" value={c.waiterCashRepaidPaise} tone="in" />}
          <Line label="Cash expenses" value={c.cashExpensesPaise} tone="out" />
          {c.drawerPurchasesPaise !== 0n && <Line label="Purchases paid from the drawer" value={c.drawerPurchasesPaise} tone="out" />}
          <Line label="Bank deposits (contra)" value={c.bankDepositsPaise} tone="out" />
          {c.peakVariancePaise !== 0n && <Line label="Peak session variance" hint="Short is negative" value={c.peakVariancePaise} />}
          {c.unreconciledPaise !== 0n && <Line label="Unreconciled (stored Day End)" hint="A day closed before a later change to the cash formula" value={c.unreconciledPaise} />}
          <Line label="Day End variance" hint="Actual − expected; short is negative" value={c.dayEndVariancePaise} />
          {c.betweenDaysPaise > 0n && <Line label="Cash taken out between days" hint="A day's count − the next day's opening float" value={c.betweenDaysPaise} tone="out" />}
          {c.betweenDaysPaise < 0n && <Line label="Cash added between days" hint="A next-day opening float above the previous count" value={-c.betweenDaysPaise} tone="in" />}
          {c.runningPeakExpensesPaise !== 0n && <Line label="Not yet counted: expenses inside the running peak" hint="Counted when the peak ends" value={c.runningPeakExpensesPaise} />}
        </Card>
        <Card title="Sales by department" total={report.sales.totalPaise} totalLabel="Total sales">
          {report.sales.byCenter.map((s) => (
            <Line key={s.code} label={s.name} value={s.salesPaise} />
          ))}
          {report.sales.unallocatedPaise !== 0n && <Line label="Not yet split (open day)" value={report.sales.unallocatedPaise} />}
          <div className="border-t border-zinc-800 px-4 pt-2 text-xs font-bold tracking-widest text-zinc-500 uppercase print:text-black">Paid by</div>
          <Line label="Cash" value={report.payments.cashPaise} />
          <Line label="UPI" value={report.payments.upiPaise} />
          {report.payments.waiterCreditPaise !== 0n && <Line label="Waiter credit (collect later)" value={report.payments.waiterCreditPaise} />}
        </Card>
        <Card title="Expenses by department" total={report.expenses.totalPaise} totalLabel="Total expenses">
          {report.expenses.byCenter.length === 0 && <Empty text="No expenses in this range." />}
          {report.expenses.byCenter.map((e) => (
            <Line key={e.code} label={e.name} value={e.amountPaise} />
          ))}
        </Card>
        <Card title="Purchases by department" total={report.purchases.totalPaise} totalLabel="Total purchases">
          {report.purchases.byCenter.map((p) => (
            <Line key={p.code} label={p.name} hint={`GRN ${money(p.grnPaise)} · supplies ${money(p.suppliesPaise)}`} value={p.totalPaise} />
          ))}
        </Card>
        <Card title="Bank deposits">
          <Line label="Cash deposited to bank" hint="Contra: cash → bank" value={report.bankDepositsPaise} strong />
        </Card>
        <Card title="Stock valuation (at purchase rate)">
          <Line label="Opening stock" value={report.stock.openingValuePaise} />
          <Line label="Closing stock" value={report.stock.closingValuePaise} strong />
          {report.stock.unratedCount > 0 && <Empty text={`${report.stock.unratedCount} item(s) without a purchase rate are not valued — see Stock.`} />}
        </Card>
      </div>
      <p className="text-sm text-zinc-500 print:text-black">
        Grouped ledger totals for Tally. The cash book balances to the paisa: opening + cash in − cash out ± variances − cash taken out between days = closing. No profit
        figure is calculated.
      </p>
    </>
  )
}
