/** Minimal route table shared by the counter API (app.ts) and the Captain API (captain-api.ts). */
import type { Body } from './json.js';

export interface Request {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Body;
}

export type Handler = (req: Request) => Promise<{ status?: number; body: unknown }>;

export interface Route {
  method: 'GET' | 'POST' | 'PUT';
  pattern: RegExp;
  handler: Handler;
}

/** A transport-level failure with an explicit status and error code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** `/api/bills/:billId` → a pattern with a named group per `:param`. */
export function route(method: Route['method'], path: string, handler: Handler): Route {
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
  return { method, pattern, handler };
}

export const ok = (body: unknown) => ({ body });
export const created = (body: unknown) => ({ status: 201, body });
