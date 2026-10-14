import type {
  Bill,
  BillDetail,
  BillingMode,
  BillLine,
  CounterContext,
  CounterPayment,
  MemberSummary,
  Paise,
  SkuLookup,
  Tender,
  WaiterSettlement,
  WaiterSummary,
} from './types'

/** A failed API call. `code` is the server's error code (PS001–PS009, NOT_FOUND, …) or NETWORK. */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const PAISE_STRING = /^-?\d+$/

/** JSON.parse reviver: every `…Paise` field arrives as a decimal string and becomes a bigint. */
export function reviveJson(key: string, value: unknown): unknown {
  return key.endsWith('Paise') && typeof value === 'string' && PAISE_STRING.test(value) ? BigInt(value) : value
}

/** JSON.stringify replacer: bigint paise go out as decimal strings, never JS numbers. */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
}

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : encodeJson(body ?? {}),
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'cannot reach the POS server')
  }
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text, reviveJson) : undefined
  } catch {
    // The Vite proxy answers with a non-JSON 5xx when the API process is down.
    throw new ApiError(res.status, res.status >= 500 ? 'NETWORK' : 'BAD_RESPONSE', 'unexpected response from the POS server')
  }
  if (!res.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error
    throw new ApiError(res.status, error?.code ?? 'INTERNAL', error?.message ?? `HTTP ${res.status}`)
  }
  return parsed as T
}

const bill = (billId: string) => `/api/bills/${encodeURIComponent(billId)}`

export const api = {
  context: () => call<CounterContext>('GET', '/api/context'),
  lookupSku: (code: string) => call<SkuLookup>('GET', `/api/skus/lookup?code=${encodeURIComponent(code)}`),
  searchMembers: (q: string) => call<MemberSummary[]>('GET', `/api/members?q=${encodeURIComponent(q)}&limit=12`),
  listWaiters: () => call<WaiterSummary[]>('GET', '/api/waiters'),
  getBill: (billId: string) => call<BillDetail>('GET', bill(billId)),

  createBill: (mode: BillingMode, memberId?: string) =>
    call<Bill>('POST', '/api/bills', memberId === undefined ? { mode } : { mode, memberId }),
  addItem: (billId: string, skuId: string, quantity: number) =>
    call<BillLine>('POST', `${bill(billId)}/items`, { skuId, quantity }),
  cancelItem: (billId: string, itemId: string, quantity: number) =>
    call<BillLine>('POST', `${bill(billId)}/items/${encodeURIComponent(itemId)}/cancel`, { quantity }),
  setMember: (billId: string, memberId: string | null) => call<Bill>('PUT', `${bill(billId)}/member`, { memberId }),
  tagWaiter: (billId: string, waiterId: string) => call<Bill>('PUT', `${bill(billId)}/waiter`, { waiterId }),
  settle: (billId: string, payments: CounterPayment[]) => call<{ bill: Bill }>('POST', `${bill(billId)}/settle`, { payments }),
  settleWaiter: (billId: string, waiterId: string, tender: Tender, amount?: Paise) =>
    call<WaiterSettlement>('POST', `${bill(billId)}/settle-waiter`, amount === undefined ? { waiterId, tender } : { waiterId, tender, amount }),
  closeEmpty: (billId: string) => call<Bill>('POST', `${bill(billId)}/close-empty`),
  reverse: (billId: string, reason: string) => call<{ reversal: Bill }>('POST', `${bill(billId)}/reverse`, { reason }),
  peakSale: (sessionId: string, skuId: string, quantity: number) =>
    call<BillLine>('POST', '/api/peak/sales', { sessionId, skuId, quantity }),
}
