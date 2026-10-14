/**
 * Minimal SQL client surface shared by PGlite (tests, embedded) and node-postgres (server).
 * Integer columns may arrive as `number`, `bigint` or `string` depending on the driver;
 * money crosses into the domain only through `toPaise()` (src/domain/money.ts).
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

/** A client that can run a callback inside a single database transaction. */
export interface SqlDatabase extends SqlClient {
  /** Commits when the callback resolves, rolls back when it throws. Use only `tx` inside. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}
