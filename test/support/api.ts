import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach } from 'vitest';
import { type ApiConfig, createApiServer } from '../../server/app.js';
import type { TestContext } from './db.js';

export const MISSING = '00000000-0000-0000-0000-000000000000';

export interface Reply {
  status: number;
  /** Parsed JSON from the wire. */
  body: any;
}

export type Call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Reply>;

/**
 * Registers cleanup and returns `start()`, which serves the API on an ephemeral port against the
 * current test's database (from useSeededDb) and returns a raw node:http caller — raw so tests
 * control every header, including Host.
 */
export function useApi(ctx: () => TestContext) {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  return async function start(config: Partial<Omit<ApiConfig, 'db'>> = {}) {
    const { db, fx } = ctx();
    const server = createApiServer({ db, cashierId: fx.cashier, ...config });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    close = () => new Promise((resolve) => server.close(() => resolve()));
    const { port } = server.address() as AddressInfo;

    const call: Call = (method, path, body, headers = {}) => {
      const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            method,
            path,
            headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
          },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
          },
        );
        req.on('error', reject);
        req.end(payload);
      });
    };
    return { db, fx, call };
  };
}
