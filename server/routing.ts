/**
 * JSON request handling shared by the counter API (app.ts, loopback) and the Captain API
 * (captain-server.ts, Wi-Fi). Each server supplies its routes and an `admit` check that runs before
 * routing — the loopback Host guard, or device-token authentication.
 */
import type { IncomingMessage, RequestListener } from 'node:http';
import { IdempotencyConflictError, InactiveError, NotFoundError, PosError } from '../src/services/index.js';
import { BadRequestError, type Body, parseBody, toJson } from './json.js';

const MAX_BODY_BYTES = 64 * 1024;

/** Who is calling, as established by `admit`. */
export interface RequestContext {
  /** Paired Captain handset (Captain server only). */
  deviceId?: string;
}

export interface Request {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Body;
  context: RequestContext;
}

export type Handler = (req: Request) => Promise<{ status?: number; body: unknown }>;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  pattern: RegExp;
  handler: Handler;
}

/** A transport-level failure with an explicit status and error code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface ErrorReply {
  status: number;
  body: { error: Record<string, unknown> };
  headers?: Record<string, string>;
}

/** Maps any thrown error to an HTTP status and a `{ error: { code, message, … } }` body. */
export function errorResponse(err: unknown): ErrorReply {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } }, headers: err.headers };
  }
  if (err instanceof BadRequestError || err instanceof RangeError) {
    return { status: 400, body: { error: { code: 'BAD_REQUEST', message: err.message } } };
  }
  if (err instanceof InactiveError) {
    return { status: 400, body: { error: { code: 'INACTIVE', message: err.message, entity: err.entity, id: err.id } } };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: err.message, entity: err.entity, id: err.id } } };
  }
  if (err instanceof IdempotencyConflictError) {
    return { status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT', message: err.message, requestId: err.requestId } } };
  }
  if (err instanceof PosError) {
    return {
      status: 409,
      body: { error: { code: err.code, message: err.message, ...(err.constraint ? { constraint: err.constraint } : {}) } },
    };
  }
  console.error('[fl2-api] unhandled error', err);
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'internal error' } } };
}

/** Admits the request (or throws HttpError), routes it, and writes a JSON response. */
export function createJsonHandler(routes: Route[], admit: (req: IncomingMessage) => RequestContext): RequestListener {
  async function handle(req: IncomingMessage): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
    const context = admit(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const matches = routes
      .map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
      .filter((x): x is { r: Route; m: RegExpExecArray } => x.m !== null);
    if (matches.length === 0) throw new HttpError(404, 'NOT_FOUND', `no route for ${url.pathname}`);
    const match = matches.find((x) => x.r.method === req.method);
    if (!match) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method ?? ''} not allowed on ${url.pathname}`);

    let body: Body = {};
    if (req.method !== 'GET') {
      // Requiring JSON forces a CORS preflight for cross-origin pages, which these servers never approve.
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'send Content-Type: application/json');
      }
      body = parseBody(await readBody(req));
    }

    // Path params are only ever UUIDs, validated by each handler, so they are used undecoded.
    const result = await match.r.handler({ params: { ...match.m.groups }, query: url.searchParams, body, context });
    return { status: result.status ?? 200, body: result.body };
  }

  return (req, res) => {
    handle(req)
      .catch(errorResponse)
      .then(({ status, body, headers }) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
        res.end(toJson(body));
      });
  };
}
