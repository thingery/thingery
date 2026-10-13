import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DB-backed test files share one database: schema.test.ts drops and
    // re-applies the oauth tables, so files must not run in parallel.
    // CI applies scripts/migrate.ts before npm test to guarantee the tables
    // exist regardless of file order.
    fileParallelism: false,
  },
});
