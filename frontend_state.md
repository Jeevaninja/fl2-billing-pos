# FL2 POS — Frontend State Reference

As of commit `9a83f72` on `main` (Phase 3 dashboard, Phase 4 billing screen). Backend contract: `backend_state.md`. Billing screen design: `docs/ui/phase4-billing-screen-plan.md`.

- **Stack:** Vite 8, React 19, TypeScript, Tailwind CSS 4 (`@tailwindcss/vite`), Lucide icons, Vitest. No router, no state library.
- **Run:** `npm run api:dev` at the repo root (API on `127.0.0.1:4310`), then `npm run dev` in `frontend/` (http://localhost:5173). Vite proxies `/api` to the API.
- **Check:** `npm test` (Vitest, 66 tests), `npx tsc -b`, `npx oxlint src`, `npm run build`.
- **Money:** `bigint` paise end to end. The API client decodes every `…Paise` JSON string to `bigint` and encodes `bigint` back to strings. Display goes through `formatPaise`; cashier input goes through `parseRupeesToPaise`. No floats.
- **Server is the source of truth:** bills enter screen state only as `BillDetail` responses, so the UI never adds up prices to get a total.

---

## 1. Component tree

```
main.tsx                      StrictMode → <App/>, imports index.css (Tailwind)
└─ App                        view: 'dashboard' | 'billing'; holds the Recently Used list
   ├─ Dashboard               module tiles + Recently Used rail + key legend footer
   │  ├─ ModuleTile ×6        Billing Screen, KOTs, Expense, Purchase, Day End, Reports
   │  ├─ RailButton ×≤6       most-recently-used actions
   │  └─ LiveClock, Kbd       (components/ui.tsx)
   └─ BillingScreen           useReducer(billingReducer); serial write queue; all API calls
      ├─ header               ModeBadge (NORMAL / PEAK #n), bill no, cashier, day, LiveClock
      ├─ CenterNote           LOADING / OFFLINE (retry) / BLOCKED (no open business day)
      ├─ main (left pane)
      │  ├─ ScanBar           scan buffer display, qty-prefix chip, FlashLine (ok / error)
      │  ├─ ItemsGrid         NORMAL: rows grouped by SKU+price, pending "adding…" rows,
      │  │                    EmptyBill (hint or last-settled receipt with change)
      │  ├─ PeakTicker        PEAK: this visit's scans newest first, undone rows struck out
      │  └─ GridFooter        key legend for the current mode
      ├─ aside (right pane)
      │  ├─ SidePanel         NORMAL: Card(Member F2), Card(Waiter F4, TrustBadge), totals, Pay F9
      │  └─ PeakSide          PEAK: session card, expected-so-far, Undo last scan (Ctrl+Z)
      └─ dialogs (one at a time, all built on Modal)
         ├─ PaymentDialog     option radios C/U/S/P/L, rupee input, change / split / credit preview
         ├─ MemberDialog      Picker: debounced member search; Enter on empty = walk-in
         ├─ WaiterDialog      Picker: filter waiters, TrustBadge, outstanding / limit
         └─ abandon confirm   Modal: cancel every line, then close the ₹0 bill
```

| File | Exports |
|---|---|
| `App.tsx` | `App` (view switch) |
| `components/Dashboard.tsx` | `Dashboard({ recent, onUse, onOpenBilling })` |
| `components/dashboard/actions.ts` | `ACTIONS`, `MODULE_TILES`, `DEFAULT_RECENT`, `BILLING_ACTIONS`, `pushRecent`, `runStub`, `PosActionId` |
| `components/ui.tsx` | `Kbd`, `LiveClock` |
| `billing/BillingScreen.tsx` | `BillingScreen({ onExit })` |
| `billing/BillingPanels.tsx` | `ScanBar`, `ItemsGrid`, `GridFooter`, `SidePanel`, `PeakTicker`, `PeakSide`, `SizeChip` |
| `billing/PaymentDialog.tsx` | `PaymentDialog({ detail, busy, onConfirm, onClose })` |
| `billing/PickerDialogs.tsx` | `MemberDialog`, `WaiterDialog`, `TrustBadge` |
| `billing/Modal.tsx` | `Modal({ title, onClose, onKey?, footer?, width? })` |

Dashboard tiles other than Billing (and the F1/F2/F9 actions, which open billing) still call `runStub`.

---

## 2. Hooks

| Hook | File | What it does |
|---|---|---|
| `useGlobalShortcuts(map, enabled = true)` | `hooks/useGlobalShortcuts.ts` | Binds `F1`, `F2`, `F4`, `F9` on `window` (bubble phase). Prevents the browser default and ignores auto-repeat. Handlers are read through a ref, so a fresh map each render does not re-subscribe. |
| `useScanBuffer(enabled, onEffect)` | `hooks/useScanBuffer.ts` | Keyboard-wedge scanner capture on `window` (**capture** phase). Feeds keys to the pure `scanKey` state machine and returns `ScanState` for display. Skips editable targets (`isEditableTarget`) and does nothing while `enabled` is false. |
| `useReducer(billingReducer)` | `billing/BillingScreen.tsx` | All billing screen state (§3). |
| Built-in only | | `useState` / `useEffect` (clock, dialogs, member search debounce), `useRef` (synchronous mirrors, write queue), `useMemo`, `useCallback`. No custom context providers. |

`Modal` also installs a window capture-phase `keydown` listener while it's open. Esc closes it, `onKey` gets first refusal, and F-keys are swallowed. This keeps dialog shortcuts working even after the focused field unmounts.

---

## 3. Billing state (`billing/billingReducer.ts`)

```ts
interface BillingState {
  load: 'loading' | 'ready' | 'offline'; offlineMessage: string | null;
  context: Omit<CounterContext, 'openBill'> | null;   // cashier, business day, running peak session
  bill: BillDetail | null;                            // open NORMAL bill (created on first scan)
  pendingMember: MemberSummary | null; pendingWaiter: WaiterSummary | null;  // chosen before the first scan
  selectedKey: string | null; pending: PendingScan[]; ticker: PeakEntry[];   // ticker capped at 50
  receipt: Receipt | null; dialog: 'payment' | 'member' | 'waiter' | 'abandon' | null; flash: Flash | null;
}
```

- **Actions:** `contextLoaded` (`resume` adopts the server's `openBill`), `contextFailed`, `billLoaded` (`focusSkuId` selects that row), `billFinished`, `pendingMember`, `pendingWaiter`, `scanQueued` / `scanDone`, `peakSale` / `peakUndone`, `select`, `move`, `dialog`, `flash`.
- **Selectors:**
  - `screenMode(state)` → `LOADING | OFFLINE | BLOCKED | NORMAL | PEAK`. It is PEAK only when a peak session is running **and** there is no open NORMAL bill, so a bill started before the peak finishes as NORMAL.
  - `groupItems(items)` → `ItemRow[]`: rows keyed by SKU + unit price, holding remaining quantity, Σ line totals, and `cancelItemId` (the newest line with bottles left).
  - `totals(detail)` → `{ lines, bottles }`.

**`BillingScreen` orchestration**
- **Context.** Fetched on mount and polled every 15 s. The open bill is resumed only on the first successful load, including after a stretch offline.
- **Writes.** Every API write goes through `run(task)`, a promise-chain queue, so scans and edits apply in order.
  - On failure the scan bar flashes the error.
  - `PS007` refreshes the context.
  - Other API errors re-read the bill (`resync`).
- **Synchronous mirrors.** `billRef`, `contextRef` and `stateRef` let queued tasks see the latest bill before React re-renders. Bill changes always go through `setBill` and `finishBill`, which update the ref and dispatch together.
- **First NORMAL scan.** The screen calls `createBill` (with any pending member), then `tagWaiter` (if a waiter is pending), then `getBill` to start tracking the bill, then `addItem`. The bill is tracked before the first line is added, so a failed line leaves no orphan bill.
- **PEAK scan.** `peakSale` adds a ticker entry and refreshes the context, which updates the expected-so-far total.

---

## 4. Keyboard model

| Key | NORMAL | PEAK | In a dialog |
|---|---|---|---|
| Printable chars + Enter | Scan / typed SKU code → add | Scan → one peak bill | Typed into the field |
| `N*` | Quantity prefix (1–99) | Same | — |
| ↑ / ↓ | Select row (empty buffer) | — | Move picker highlight |
| `+` / `−` / Delete | Add / cancel one bottle on the selected row (empty buffer) | — | — |
| F1 | New bill (close an empty bill or confirm abandon) | — | Swallowed |
| F2 / F4 | Member / waiter dialog (waiter locked after the first tender) | Refused with a message | Swallowed |
| F9 | Pay (closes a ₹0 bill instead) | Refused: peak bills reconcile at session end | Confirm (payment) |
| Ctrl+Z | — | Undo last scan (`reverseBill`) | — |
| Esc | Clear buffer, else back to the dashboard | Same | Close dialog |
| C / U / S / P / L | — | — | Payment option |

No element needs focus for scanning. Screen buttons use `keepFocus` (`onMouseDown` preventDefault), so a click doesn't move focus. Enter with an empty buffer is left alone, so a focused button still works.

---

## 5. API client and pure modules

| File | Contents |
|---|---|
| `api/client.ts` | `api.*` (`context`, `lookupSku`, `searchMembers`, `listWaiters`, `getBill`, `createBill`, `addItem`, `cancelItem`, `setMember`, `tagWaiter`, `settle`, `settleWaiter`, `closeEmpty`, `reverse`, `peakSale`), `ApiError` (`status`, `code`; `NETWORK` when unreachable or the proxy answers non-JSON 5xx), `reviveJson`, `encodeJson` |
| `api/types.ts` | Frontend mirrors of the API DTOs (`Bill`, `BillDetail`, `CounterContext`, `SkuLookup`, …) with `Paise = bigint`; dates stay ISO strings |
| `billing/payment.ts` | `payOptions(detail)`, `planPayment(detail, input)` → counter tenders or waiter settle steps plus change, credit-limit pre-check, `describePlan` |
| `billing/errors.ts` | `CounterError` (screen-raised), `counterErrorMessage(err)` (PS code → cashier wording) |
| `hooks/scanBuffer.ts` | `scanKey(state, input)` pure state machine; `IDLE_RESET_MS` = 2 s; max 64 chars |
| `lib/money.ts` | `formatPaise` (₹1,00,000.00 Indian grouping, bigint), `parseRupeesToPaise` |
| `lib/ui.ts` | `FOCUS_RING`, `formatTime`, `keepFocus` |
| `lib/beep.ts` | WebAudio scan feedback; silent if audio is unavailable |

**Tests** (`*.test.ts`, Node environment, no DOM):
- `billingReducer.test.ts` and `payment.test.ts`, with fixtures in `testData.ts`
- `scanBuffer.test.ts`
- `money.test.ts`, which also covers the JSON codec

---

## 6. Known gaps

- The peak ticker holds only this visit's scans, so Ctrl+Z can't undo a scan made before a reload. Server totals are always complete.
- No screen yet lists or settles a waiter's Captain-app bills; the API supports it (`/api/captain/waiter/:id/bills`, `settle-waiter`).
- No receipt printing. No Day End, Expense, Purchase, KOT or Reports screens (dashboard stubs).
- The cashier is fixed by the API's `FL2_CASHIER_ID`; there's no login.
- The headless-Chrome end-to-end script used to verify Phase 4 is not in the repo.
