// Cross-run database serialization (THI-1005).
//
// Why: DB-backed test files TRUNCATE shared tables (orders, items, sellers,
// ...). Inside one vitest run the files are already sequential
// (fileParallelism: false in vitest.config.ts), but two CONCURRENT runs on
// the same database — e.g. two agent checkouts or two shells sharing the
// default localhost Postgres on a dev host — interleave those TRUNCATEs with
// the other run's pool transactions (createOrder, applyTransition, ...).
// Postgres then detects a genuine lock cycle (TRUNCATE's ACCESS EXCLUSIVE vs
// the other transaction's row locks on the same tables) and kills statements
// with "error: deadlock detected", plus cascading FK / not-found failures.
// Reproduced on 2026-11-18 by running the suite while a second process
// cycled the same TRUNCATEs; the lock dumps showed every victim run's own
// sessions idle — the competing TRUNCATE came from the foreign run.
//
// Fix: this globalSetup holds one session-level advisory lock for the whole
// vitest invocation, so a second run against the same database queues at
// startup instead of corrupting/locking against the first. Whole-run
// granularity (not per-file) on purpose: one acquire/release pair, no
// per-file hook plumbing, and identical aggregate throughput since a run's
// files are sequential anyway. Session-scoped: if the run dies, its
// connection drops and Postgres releases the lock — no stale-holder state.
// In CI the database is per-job (ci.yml service container), so the lock is
// always uncontended there.
//
// Runs without a reachable database (pure suites, no-DB environments) must
// keep working unchanged: the probe below degrades to a no-op, and the
// DB-backed suites keep skipping via their own dbAvailable checks.
import pg from "pg";

// hashtext('thingery-test-db-serial') — one fixed key for every run, so all
// suites serialize against each other (a single resource cannot deadlock).
// Never use this key for other locks.
const LOCK_KEY = 1581149487;

const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

// Bound the wait so a stuck-but-alive holder (e.g. a paused debugger) cannot
// hang every other run forever. Per-attempt and total budgets are sized well
// above a full suite (~4 min): 3 × 10 min attempts ≈ 30 min of queueing.
const LOCK_ATTEMPT_TIMEOUT_MS = 10 * 60_000;
const LOCK_ATTEMPTS = 3;

export async function setup(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1000 });
  try {
    await client.connect();
  } catch {
    // No database reachable: run as before (pure tests, DB suites skip).
    return async () => undefined;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query(`SET statement_timeout = ${LOCK_ATTEMPT_TIMEOUT_MS}`);
      await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
      break;
    } catch (err) {
      // statement_timeout fires while queued; retry with the same session
      // (the statement is aborted, not the connection).
      if (attempt >= LOCK_ATTEMPTS) {
        await client.end().catch(() => undefined);
        throw new Error(
          `Could not acquire the test-suite advisory lock (${LOCK_KEY}) within ` +
            `${Math.round((LOCK_ATTEMPT_TIMEOUT_MS * LOCK_ATTEMPTS) / 60_000)} min: another run on this ` +
            "database appears stuck (its vitest process must exit for the lock to release).",
          { cause: err },
        );
      }
      process.stderr.write(
        `[db-serial-lock] another test run still holds the database (waited ${Math.round(
          (LOCK_ATTEMPT_TIMEOUT_MS * attempt) / 60_000,
        )} min); retrying…\n`,
      );
    }
  }
  await client.query("SET statement_timeout = 0");
  return async () => {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    await client.end().catch(() => undefined);
  };
}
