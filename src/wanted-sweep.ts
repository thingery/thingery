// Wanted expiry + retention sweeps (spec THI-439 rev 1 §3.2/§3.3 — B1):
// bounded, idempotent rules that mirror src/oauth-sweep.ts and the intent
// sweep. Every public read also lazily guards `expires_at > now()`
// (searchWanted/getWantedById), so sweep lag never surfaces stale demand —
// the sweep is what makes the state durable (my_wanted shows `expired`
// promptly, renewal grace windows start from the real flip, and the
// retention purge eventually reclaims rows).

import { pool } from "./db.js";
import { WANTED_RETENTION_DAYS } from "./wanted.js";

/** Boot + hourly: flip past-due actives to expired. Idempotent — the WHERE
 *  clause is the state machine's sweep edge (§3.2), so a re-run finds
 *  nothing. Returns how many rows flipped (logged as a count-only line;
 *  per-buyer wanted_write/expire events belong to the interactive path —
 *  a bulk sweep has no buyer context to attribute). */
export async function expirePastDueWanted(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE wanted_items SET status = 'expired', updated_at = now()
     WHERE status = 'active' AND expires_at <= now()`,
  );
  return rowCount ?? 0;
}

/** Boot + daily: purge expired rows older than the retention horizon
 *  (responses cascade). Hard delete, by design — §3.3: rows are demand
 *  data, not user data; 180 d mirrors intent_matches retention. */
export async function purgeExpiredWantedRetention(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM wanted_items
     WHERE status = 'expired'
       AND expires_at < now() - ($1 || ' days')::interval`,
    [String(WANTED_RETENTION_DAYS)],
  );
  return rowCount ?? 0;
}

/** Runs both rules once. A failing rule logs and does not stop the other
 *  (sweep_error convention from oauth-sweep). */
export async function runWantedSweeps(): Promise<void> {
  try {
    const flipped = await expirePastDueWanted();
    if (flipped > 0) console.log(JSON.stringify({ type: "wanted_sweep", rule: "expire_past_due", count: flipped }));
  } catch (e) {
    console.error(JSON.stringify({ sweep_error: "wanted_expire_past_due", message: (e as Error).message }));
  }
  try {
    const purged = await purgeExpiredWantedRetention();
    if (purged > 0) console.log(JSON.stringify({ type: "wanted_sweep", rule: "retention_purge", count: purged }));
  } catch (e) {
    console.error(JSON.stringify({ sweep_error: "wanted_retention_purge", message: (e as Error).message }));
  }
}

/** Boot run; expire hourly, retention daily (unref'd: never keeps the
 *  process alive — same posture as every sweep timer in this repo). */
export function startWantedSweepTimer(): void {
  runWantedSweeps().catch(() => {});
  const hourly = setInterval(() => {
    expirePastDueWanted()
      .then((n) => { if (n > 0) console.log(JSON.stringify({ type: "wanted_sweep", rule: "expire_past_due", count: n })); })
      .catch((e) => console.error(JSON.stringify({ sweep_error: "wanted_expire_past_due", message: (e as Error).message })));
  }, 60 * 60 * 1000);
  hourly.unref();
  const daily = setInterval(() => {
    purgeExpiredWantedRetention()
      .then((n) => { if (n > 0) console.log(JSON.stringify({ type: "wanted_sweep", rule: "retention_purge", count: n })); })
      .catch((e) => console.error(JSON.stringify({ sweep_error: "wanted_retention_purge", message: (e as Error).message })));
  }, 24 * 60 * 60 * 1000);
  daily.unref();
}
