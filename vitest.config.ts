import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each test file boots an in-process PostgreSQL (PGlite) and applies the migrations once.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
