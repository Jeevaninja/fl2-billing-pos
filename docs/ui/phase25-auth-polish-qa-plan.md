# Phase 25 — Authentication, Dashboard Polish & QA (approved 2026-10-20, D1–D9 as recommended; built)

Goal: a Super Admin sign-in that gates the whole counter API and UI, a PIN-authorised Day Open, the dashboard
grid with a two-row Billing tile and a Reports tile, a premium visual pass, and a QA sweep over the critical
paths.

## Current state (verified 2026-10-20)

- The counter API (`server/app.ts`) admits any loopback request (`admitLocal`). There is no login: every write
  is attributed to `FL2_CASHIER_ID` ("Counter 1").
- `staff.pin_hash` exists in `0001` but nothing reads or writes it. `staff` rows go to `sync_outbox` on every
  INSERT / UPDATE (`pos_outbox_capture`), so a hash stored there would sync to the cloud.
- `POST /api/days` opens the day as the till cashier, with no PIN.
- Dashboard: a `lg:grid-cols-5 lg:grid-rows-2` grid with 8 equal tiles, so two slots are empty after Day End.
  Reports sits in the header Settings menu (Phase 23).
- Baseline: backend 36 files / 413 tests ✓, `tsc --noEmit` ✓. Frontend 24 files / 244 tests ✓, `tsc -b` ✓,
  oxlint ✓. There is no browser E2E framework; `test/server/*` drives the real HTTP handler on PGlite.

## Decisions for approval

**D1 — What login means.** The Super Admin sign-in unlocks the *terminal*. Bills, expenses and other writes
stay attributed to the till cashier (`FL2_CASHIER_ID`), as today. Only Day Open is attributed to the person
whose PIN authorised it. Per-cashier shift login is a later phase.

**D2 — Credentials table, local only (migration `0018_staff_credentials`).**
`staff_credentials (staff_id PK → staff, username citext UNIQUE NULL, password_hash NULL, pin_hash NULL,
failed_attempts int, locked_until timestamptz NULL, updated_at)`.
- A username and password are allowed only for `ADMIN` staff. A PIN (4–6 digits) is for CASHIER, MANAGER or
  ADMIN.
- The table has **no outbox trigger**, so hashes never leave the till. DELETE and TRUNCATE are blocked, like
  every other domain table. To revoke a credential, null its hash.
- `staff.pin_hash` stays in place and unused; it is commented as superseded. No column is dropped.
- Hashing uses Node's built-in `crypto.scrypt` with a per-secret random salt, stored as
  `scrypt$N$r$p$salt$hash`, and compared with `timingSafeEqual`. No new dependency.

**D3 — Sessions: in memory, HttpOnly cookie.**
- `POST /api/auth/login` issues a 256-bit random token. The server keeps only its SHA-256 in an in-memory
  map, with a 16-hour absolute lifetime.
- The token is sent as `Set-Cookie: fl2_session=…; HttpOnly; SameSite=Strict; Path=/api`.
- An API restart signs everyone out. That is acceptable on one till, and it means no session rows are synced.
- The auth middleware lives in `admitLocal`. Every counter route answers `401 UNAUTHENTICATED` without a valid
  session, except `GET /api/health`, `POST /api/auth/login` and `GET /api/auth/session`.
- `POST /api/auth/logout` signs out. The Captain server is unchanged (it keeps its device tokens).

**D4 — Brute-force limits.**
- Password: 5 failures lock the account for 5 minutes.
- PIN: 5 failures lock that staff member's PIN for 5 minutes.
- Lock status is stored in `staff_credentials`, so it survives a restart.
- Error messages never say whether the username or the password was wrong.

**D5 — Day Open PIN (atomic).**
- `POST /api/days` now takes `{ openingFloat, staffId, pin }`. In the same transaction, the server verifies the
  PIN for an active CASHIER, MANAGER or ADMIN and inserts the day with `opened_by_staff_id = staffId`.
- There is no separate "PIN token" step, so a PIN check can't be replayed.
- UI: Open Day → float → **PIN modal**. The modal shows staff who have a PIN as large touch tiles, then a
  numeric keypad (keys 0–9, Backspace, Enter). After 5 failures it shows "Locked — try again in m:ss".
- `GET /api/staff/pin-holders` lists `{ id, displayName, role }` only.

**D6 — Bootstrapping credentials.**
- New CLI `npm run staff -- set-admin <username>` prompts for the password with no echo. It creates or updates
  an ADMIN staff row plus its credential. Lost-password recovery therefore needs physical access to the till
  machine, which is the right trust boundary.
- New CLI `npm run staff -- set-pin <staff name>` sets a PIN.
- New admin-only screen **Settings → Staff & PINs**: set or reset a PIN for each staff member, and add a
  cashier or manager. Staff can be deactivated, never deleted.
- Dev seed (empty database only): `admin` / `fl2-admin-dev`; Counter 1 and Manager get PIN `1234`. (The planned
  `fl2admin` is shorter than the 10-character minimum.)
- The live `.data/pglite` database has staff but no admin, so the API will log a startup warning:
  "no admin credential — run npm run staff -- set-admin". The login screen shows the same hint.

**D7 — Dashboard grid.**
- Large screens: 5 columns × 2 rows. Billing is `row-span-2` in column 1 and is the yellow primary tile.
  - Row 1: Waiter Ledger · Expense · Bank Deposit · Purchase.
  - Row 2: Revenue Centers · Orders · Day End · **Reports**.
- Narrow screens: 2 columns × 5 rows, with Billing also spanning 2 rows. The tiles fill every cell exactly.
- Reports leaves the Settings menu and keeps its icon and hint. When no day is open, the Day End tile ("Open
  Day") becomes the primary tile, as today.
- ⚠ Conflict: this fills the two slots kept free for HR / Payroll (roadmap). When that phase comes, the grid
  grows to 6 columns or HR goes into the Settings menu. This is flagged now, not designed around.

**D8 — Visual polish scope.**
- A token layer in `index.css` (`@theme`): surface levels (950 / 900 / 850 / 800), border and text contrast
  steps meeting WCAG AA (≥ 4.5:1 for body text), radii, elevation shadows, and motion durations of
  120 / 180 / 240 ms. A `prefers-reduced-motion` override turns motion off.
- Shared primitives in `components/ui.tsx`: `Button` (primary / secondary / danger / ghost), `Card`, `Badge`,
  `IconTile`, plus the existing `Kbd`. Each has hover, active and focus-visible states.
- Applied in depth to the Login, PIN pad, Dashboard (tile lift and shadow on hover, a press state, an accent
  stripe, Billing tile hero typography), app headers, `Modal` (fade and scale in) and the Settings menu.
- Every other screen gets a consistency sweep through the shared primitives: header bars, buttons, spacing,
  tabular numerals and truncation. Layouts are not redesigned.
- The theme stays dark (counter lighting), and keyboard-first flows are unchanged.

**D9 — QA approach.**
- No Playwright. Adding it would mean a new devDependency and a browser download.
- Instead, new **journey tests** in `test/e2e/*.test.ts` drive the real HTTP API on PGlite, including sign-in.
  They cover these critical paths:
  1. Universal billing search: barcode, code and name lookup → add → pay.
  2. KOT routing: liquor lines to the counter, kitchen lines to the KITCHEN printer, cancel tickets.
  3. ML summary math, which is the Phase 24 excise conversion: bottles × `volume_ml` → litres, integers only.
     This is not ml stock tracking, which CLAUDE.md forbids.
  4. Revenue Center P&L.
  5. Peak mode: start, scans, end, variance.
  6. Waiter partial payments.
  7. Day End: variance, PIN open → close → reopen.
  8. All eight reports across a two-day range.
- Then a scripted Chrome walkthrough of every screen against a **copy** of the live database. It checks for
  console errors and warnings.
- Every bug found is logged in the plan doc with its fix and a regression test.
- "Terminal warnings" means warnings from vitest, tsc, oxlint, the Vite build and the browser console. Each one
  is fixed or explained.

## Build order (after approval)

1. Migration 0018, `AuthService`, scrypt helpers, unit tests (hash/verify, lockout, PIN rules).
2. Session store and middleware in `server/app.ts`, the `/api/auth/*` routes, and the PIN-checked
   `POST /api/days`. The `useApi` test helper signs in by default, and new auth API tests are added.
3. Staff CLI and the dev-seed credentials.
4. Frontend: `AuthGate` (session check → `LoginScreen` | `App`), a 401 handler in the API client that returns to
   login, `PinPadDialog`, the Open Day wiring, and Settings → Staff & PINs.
5. Dashboard grid and Reports tile, design tokens, primitives, polish pass.
6. QA: journey tests, Chrome walkthrough, bug log, `npx vitest run`, `npx tsc --noEmit`, frontend
   `vitest` / `tsc -b` / `oxlint` / `build`, and updates to `backend_state.md`, `frontend_state.md` and the
   memory notes.

## Out of scope

Per-cashier shift login, a PIN on peak start / Day End close / voids, password complexity rules beyond a
minimum of 10 characters, and HTTPS. The API is loopback-only.

## As built

**Backend**
- `migrations/0018_staff_credentials.sql`
- `src/services/secrets.ts` (scrypt, N = 2^15)
- `src/services/auth.service.ts`: `AuthService` and `checkPin`
- `DayEndService.openBusinessDayWithPin`
- `server/sessions.ts`, plus the `admitCounter` middleware and the `/api/auth/*` and `/api/staff*` routes in
  `server/app.ts`
- `server/staff-cli.ts` (`npm run staff`) and `server/database.ts`, which the API and the CLI share

**Frontend**
- `auth/`: `AuthGate`, `LoginScreen`, `PinPadDialog`, and the reducers `authState` and `pinPad`
- `components/StaffScreen.tsx` (Settings → Staff & PINs) and `settings/staffForm.ts`
- Dashboard: the Billing hero tile and the Reports tile
- Design tokens in `index.css`, and the primitives `buttonClass`, `badgeClass` and `CARD` (`lib/ui.ts`) with
  `Button`, `Badge` and `BrandMark` (`components/ui.tsx`)
- `lib/lazyScreen.tsx`

**Tests**
- Backend: `test/services/auth.test.ts`, `test/server/auth-api.test.ts`, and the journeys in
  `test/e2e/critical-paths.test.ts`
- Frontend: `auth/*.test.ts`, `settings/staffForm.test.ts` and `components/dashboard/actions.test.ts`

**Upgrading the live till**
1. Restart the API to apply 0018. It logs a hint while no admin exists.
2. Stop the API: embedded PGlite allows one process.
3. Run `npm run staff -- set-admin <username>`.
4. Optionally run `npm run staff -- set-pin "<name>"`, or set PINs later in Settings → Staff & PINs.
5. Start the API.

## QA log (2026-10-20)

**Method**
- Ran the journey tests (D9).
- Ran a scripted headless Chrome walkthrough on a copy of the live `.data/pglite` database (QA API on :4320,
  Vite on :5180). It covered sign-in, a wrong password, the dashboard at 1600 / 1280 / 900 / 820 px, Day End
  close, PIN Day Open with a wrong PIN first, every tile and Settings screen, and Staff & PINs.
- Applying 0018 to the copy of the real data succeeded.

| # | Found | Fix |
|---|---|---|
| 1 | Login: after a refused password, focus did not return to the password field (it was still `disabled` while busy), so the next keystrokes went nowhere | Focus in an effect after the re-enabling render |
| 2 | Dashboard below 1024 px: the header's day chip and Start peak wrapped onto three lines; tile hints clipped | No-wrap chips, "open since" from `xl`, rail from `xl`, content-height rows and a scrolling grid on narrow screens, `line-clamp-2` hints |
| 3 | Staff & PINs header: "Add staff" wrapped and pushed the clock off-screen | Shared buttons are `whitespace-nowrap shrink-0` |
| 4 | 23 buttons across older screens had no hover state | Hover added (secondary: border/bg lift; filled: `enabled:hover:brightness-110`) |
| 5 | Secondary text (`zinc-500`) was 3.7:1 on panels, below WCAG AA | Token retuned to 5.3:1 on screen; print keeps the original |
| 6 | `vite build` warned of a 679 kB chunk | Back-office screens lazy-loaded: startup chunk 359 kB, no warning |
| 7 | Staff CLI with piped stdin lost the second line (one readline per prompt) | One shared line reader |

- **Business logic:** the journeys found no defects. Expected cash, the peak and Day End variances, waiter
  part-payments, bill-on-bill, the center P&L, the ML litres, the stock register and the cash book all matched
  the hand-computed figures.
- **Console:** no errors or warnings on any screen. The only entries were the network log lines for the
  deliberate 401 (wrong password) and 403 (wrong PIN).
- **Remaining terminal output:** the frontend's Vitest prints an informational `isolate: false` speed hint.
  It is not a warning, and isolation is kept deliberately.
