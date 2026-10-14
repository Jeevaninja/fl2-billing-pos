# FL2 POS Build Instructions - Phase 1 (Whole Bottle MVP)

## Core Stack
TS, React, Node.js, PostgreSQL, Vitest.

## STRICT NEGATIVE CONSTRAINTS (DO NOT BUILD)
* NO peg, cutting, or open-bottle milliliter (ml) tracking.
* NO tax, GST, or VAT engines.
* NO table mapping or restaurant layouts.
* NO mandatory KYC/member gates at counter billing.
* NO floating-point numbers. Use whole paise (₹1=100) and whole integers for inventory.
* NO destructive DB ops. Use append-only reversing records for settled bills.

## Architecture & Logic
* **Inventory:** Track stock strictly by whole sealed bottles. Use distinct SKUs for sizes (Full, Half, Quarter).
* **Sync:** Local PostgreSQL primary. Append-only transactional outbox to cloud.
* **Billing Modes:**
  - *Normal:* Scan -> Pay (Cash/UPI).
  - *Peak:* Scan -> 'Peak_Unsettled'. Bypass payment screen. Require Start/End cash/UPI reconciliation to calculate variance.
* **Waiter/Captain App:**
  - *Trusted:* Enable 'collect later' (credit), allow partial payments.
  - *Untrusted:* Strict bill-on-bill settlement.
  - *KOT:* Auto-route liquor orders to counter thermal printer.
* **Compliance:** Run `autoAssignBills` to attach unassigned bills to active members randomly/round-robin before generating F.Ac.2 reports.

## UI Guidelines
* Clean, Petpooja-style grid layout.
* Keyboard-first (F1=New, F2=Member, F9=Pay).
* Touch-friendly CRUD modals for Expense/PO.

## Execution Protocol
1. Await explicit approval on DB schema or component plans before writing implementations.
2. Write unit tests for core state transitions (Peak Mode math, Waiter partial payments) before completing tasks.
3. Run `npx vitest run` and `npx tsc --noEmit` to self-verify.
