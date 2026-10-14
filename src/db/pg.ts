import type { Pool, PoolClient } from 'pg';
import type { SqlClient, SqlDatabase } from './client.js';

/**
 * node-postgres adapter. BIGINT arrives as a decimal string and passes through toPaise() in the
 * mappers, so no type parser is registered and no value is ever routed through a float.
 */
export function pgClient(client: Pool | PoolClient): SqlClient {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[] };
    },
    exec: (sql: string) => client.query(sql),
  };
}

/** A pool-backed SqlDatabase: each transaction runs on one checked-out connection. */
export function pgDatabase(pool: Pool): SqlDatabase {
  return {
    ...pgClient(pool),
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      const conn = await pool.connect();
      try {
        await conn.query('BEGIN');
        const result = await fn(pgClient(conn));
        await conn.query('COMMIT');
        return result;
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        conn.release();
      }
    },
  };
}
