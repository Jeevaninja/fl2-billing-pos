import { ApiError } from '../api/client'

/** An error raised by the screen itself (unknown barcode, inactive SKU…), shown as-is. */
export class CounterError extends Error {
  override readonly name = 'CounterError'
}

const LABELS: Record<string, string> = {
  PS001: 'Bill is closed',
  PS002: 'Not allowed',
  PS003: 'Out of stock',
  PS004: 'Credit not allowed',
  PS005: "Payment doesn't match",
  PS006: 'Correction refused',
  PS007: 'Day / peak',
  PS008: 'Waiter balance',
  PS010: 'Bill-on-bill',
  PS011: 'Duplicate invoice',
  BAD_REQUEST: 'Invalid input',
  NOT_FOUND: 'Not found',
}

/** One line of cashier-facing text for any failure. */
export function counterErrorMessage(err: unknown): string {
  if (err instanceof CounterError) return err.message
  if (err instanceof ApiError) {
    if (err.code === 'NETWORK') return "Can't reach the POS server — is `npm run api:dev` running?"
    const label = LABELS[err.code]
    return label ? `${label}: ${err.message}` : "Couldn't save — try again"
  }
  console.error('[FL2] unexpected error', err)
  return "Couldn't save — try again"
}
