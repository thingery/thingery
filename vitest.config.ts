import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The whole vitest invocation holds a session-level Postgres advisory
    // lock (tests/setup/db-serial-lock.ts, THI-1005): a second concurrent
    // run (two checkouts/shells on one shared dev database) queues at
    // startup instead of deadlocking against this run's TRUNCATEs.
    globalSetup: ["tests/setup/db-serial-lock.ts"],
    // DB-backed test files share one database: schema.test.ts drops and
    // re-applies the oauth tables, so files must not run in parallel.
    // CI applies scripts/migrate.ts before npm test to guarantee the tables
    // exist regardless of file order.
    fileParallelism: false,
    // Type-level assertions (THI-133): *.test-d.ts files are typechecked
    // with tsc as part of `npm test`, using tsconfig.typecheck.json — which
    // deliberately lists only the tsc-clean test files (the main tsconfig
    // excludes tests/). Add more files there as they are cleaned up.
    typecheck: {
      enabled: true,
      include: ["tests/**/*.test-d.ts"],
      tsconfig: "./tsconfig.typecheck.json",
    },
  },
});
