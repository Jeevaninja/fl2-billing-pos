import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { seed, type Fixture } from './fixtures.js';

export interface TestContext {
  db: PGliteInterface;
  fx: Fixture;
}

/**
 * Registers hooks that give every test its own migrated + seeded database.
 * The template is migrated and seeded once per file and cloned per test (~150 ms).
 * After each test, the nightly invariant view must be empty.
 */
export function useSeededDb(): () => TestContext {
  let template: { db: PGlite; fx: Fixture } | undefined;
  let current: TestContext | undefined;

  beforeEach(async () => {
    if (!template) {
      const db = new PGlite();
      await runMigrations(db);
      template = { db, fx: await seed(db) };
    }
    current = { db: await template.db.clone(), fx: template.fx };
  });

  afterEach(async () => {
    if (!current) return;
    const { rows } = await current.db.query('SELECT check_name, detail FROM v_invariant_violations');
    await current.db.close();
    current = undefined;
    expect(rows, 'v_invariant_violations must be empty').toEqual([]);
  });

  afterAll(async () => {
    await template?.db.close();
  });

  return () => {
    if (!current) throw new Error('useSeededDb() context accessed outside a test');
    return current;
  };
}

/** Asserts that a promise rejects with the given SQLSTATE (and optionally a message pattern). */
export async function expectSqlError(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(err).toMatchObject({ code });
  if (message) expect((err as Error).message).toMatch(message);
}
