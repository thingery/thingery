// Intent retention sweeps (spec THI-360 rev 2 §3.4, THI-380): read matches
// are kept 30 days, everything 180 days — match rows are notifications, not
// records. Mirrors src/oauth-sweep.ts: bounded, idempotent rules run at boot
// and daily; a failing rule logs and does not stop the others.

import { pool } from "./db.js";

const RULES: { name: string; sql: string }[] = [
  {
    name: "read_matches_retention",
    sql: `DELETE FROM intent_matches WHERE read_at < now() - interval '30 days'`,
  },
  {
    name: "all_matches_retention",
    sql: `DELETE FROM intent_matches WHERE created_at < now() - interval '180 days'`,
  },
];

/** Runs every rule once. Bounded, idempotent, safe at boot and to re-run;
 * a failing rule logs and does not stop the others. */
export async function runIntentSweeps(): Promise<void> {
  for (const rule of RULES) {
    try {
      await pool.query(rule.sql);
    } catch (e) {
      console.error(JSON.stringify({ sweep_error: rule.name, message: (e as Error).message }));
    }
  }
}

/** Boot run + daily interval (unref'd: never keeps the process alive). */
export function startIntentSweepTimer(): void {
  runIntentSweeps().catch(() => {});
  const timer = setInterval(() => {
    runIntentSweeps().catch(() => {});
  }, 24 * 60 * 60 * 1000);
  timer.unref();
}
